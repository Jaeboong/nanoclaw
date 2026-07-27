#!/usr/bin/env bash
#
# upstream-catchup.sh — replay this customized fork onto a newer upstream base.
#
# Automates steps 1–6 of UPGRADING.md (fetch, isolated worktree, rebase --onto,
# rerere, dependency/lockfile reconcile, instance stash-pop, and the
# boundaries+types+build+test gate). Steps 7 (DB migration gate) and 8 (live
# cutover) are IRREVERSIBLE and are intentionally NOT automated — they are
# printed at the end as a manual checklist with inline verification snippets.
#
# Idempotent / re-runnable: safe to run again after fixing a conflict or a
# failed gate. It reuses an existing upgrade worktree/branch instead of failing.
#
# Usage:
#   UPSTREAM_TARGET=v2.1.17 LAST_MERGED_BASE=<sha-or-tag> ./upstream-catchup.sh
#
# Optional env:
#   FORK_BRANCH        (default: current branch)
#   UPSTREAM_REMOTE    (default: upstream)
#   WORKTREE_DIR       (default: ../fork-upgrade-<UPSTREAM_TARGET>)
#   DIRECT_DEPS        space-separated "pkg@version" pins to align before install
#                      (e.g. "@chat-adapter/discord@4.29.0")
#   INSTANCE_STASH     stash ref to pop for instance patches (default: newest stash)
#   SKIP_TESTS=1       skip the test suite (gate still runs typecheck+build+boundaries)
#
set -Eeuo pipefail

# ---- config ---------------------------------------------------------------
: "${UPSTREAM_TARGET:?set UPSTREAM_TARGET (e.g. v2.1.17 or upstream/main)}"
: "${LAST_MERGED_BASE:?set LAST_MERGED_BASE (upstream commit the fork stack sits on)}"
UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
FORK_BRANCH="${FORK_BRANCH:-$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)}"
SAFE_TARGET="${UPSTREAM_TARGET//\//-}"
WORKTREE_DIR="${WORKTREE_DIR:-$REPO_ROOT/../fork-upgrade-$SAFE_TARGET}"
UPGRADE_BRANCH="upgrade/$SAFE_TARGET"

say() { printf '\n=== %s ===\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# ---- preconditions --------------------------------------------------------
say "0. Preconditions"
# rerere: records each conflict resolution once, replays it on every future
# upgrade. Shared across worktrees via the single .git.
git -C "$REPO_ROOT" config rerere.enabled true
git -C "$REPO_ROOT" config rerere.autoUpdate true
git -C "$REPO_ROOT" remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1 \
  || die "remote '$UPSTREAM_REMOTE' not configured (git remote add $UPSTREAM_REMOTE <url>)"

# Confirm we know the package manager. This harness is pnpm-only.
command -v pnpm >/dev/null 2>&1 || die "pnpm not found (this fork uses pnpm; do not substitute npm)"

# ---- 1. fetch -------------------------------------------------------------
say "1. Fetch upstream + tags"
git -C "$REPO_ROOT" fetch "$UPSTREAM_REMOTE" --tags --prune
# Validate both refs explicitly (don't infer from the log pipeline: under
# pipefail, `head` closing the pipe SIGPIPEs git on large ranges and would
# misreport a valid range as an error).
git -C "$REPO_ROOT" rev-parse --verify -q "$LAST_MERGED_BASE^{commit}" >/dev/null \
  || die "bad LAST_MERGED_BASE: $LAST_MERGED_BASE"
git -C "$REPO_ROOT" rev-parse --verify -q "$UPSTREAM_TARGET^{commit}" >/dev/null \
  || die "bad UPSTREAM_TARGET: $UPSTREAM_TARGET"
git -C "$REPO_ROOT" log --oneline "$LAST_MERGED_BASE..$UPSTREAM_TARGET" | head -n 40 || true

# ---- 2. isolated worktree + rebase --onto ---------------------------------
say "2. Isolated worktree + rebase --onto"
# Re-runnable: reuse the worktree/branch if it already exists.
if git -C "$REPO_ROOT" worktree list --porcelain | grep -qF "worktree $(cd "$WORKTREE_DIR" 2>/dev/null && pwd || echo "$WORKTREE_DIR")"; then
  echo "Reusing existing worktree: $WORKTREE_DIR"
else
  if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$UPGRADE_BRANCH"; then
    git -C "$REPO_ROOT" worktree add "$WORKTREE_DIR" "$UPGRADE_BRANCH"
  else
    git -C "$REPO_ROOT" worktree add "$WORKTREE_DIR" -b "$UPGRADE_BRANCH" "$FORK_BRANCH"
  fi
fi

cd "$WORKTREE_DIR"

# If a rebase is already in progress (re-run after resolving a conflict), let
# the operator continue it manually rather than clobbering their resolution.
if [ -d "$(git rev-parse --git-path rebase-merge 2>/dev/null)" ] || \
   [ -d "$(git rev-parse --git-path rebase-apply 2>/dev/null)" ]; then
  die "a rebase is in progress in $WORKTREE_DIR — resolve conflicts, 'git add', 'git rebase --continue', then re-run this script."
fi

# Only rebase if we're not already replayed onto the target.
if git merge-base --is-ancestor "$UPSTREAM_TARGET" HEAD; then
  echo "Already replayed onto $UPSTREAM_TARGET — skipping rebase."
else
  say "2b. git rebase --onto $UPSTREAM_TARGET $LAST_MERGED_BASE $UPGRADE_BRANCH"
  # rerere auto-resolves previously-seen conflicts. New conflicts stop the
  # rebase; resolve PRESERVING fork additions on upstream's evolved structure,
  # 'git add', 'git rebase --continue', then re-run this script.
  if ! git rebase --onto "$UPSTREAM_TARGET" "$LAST_MERGED_BASE" "$UPGRADE_BRANCH"; then
    say "Rebase paused on conflicts"
    git rerere status || true
    die "resolve conflicts (keep fork behavior on new upstream structure), 'git add', 'git rebase --continue', then re-run."
  fi
fi

# ---- 4. dependency reconcile + lockfile -----------------------------------
# (Step 3 = conflict resolution, handled inside the rebase above.)
say "4. Dependency reconcile + lockfile (pnpm)"
# A bumped transitive dep can force a direct dep to move in lockstep (e.g.
# @chat-adapter/discord must track chat@<minor>). Pin any such deps here.
if [ -n "${DIRECT_DEPS:-}" ]; then
  # shellcheck disable=SC2086
  pnpm add $DIRECT_DEPS
fi
pnpm install   # regenerate pnpm-lock.yaml against the merged package.json

# ---- 5. reapply INSTANCE patches (host-only, uncommitted) -----------------
say "5. Reapply INSTANCE patches from stash"
# Instance patches are NEVER committed. They live as a host stash and are
# popped back after the merged tree is in place. Skipped automatically if there
# is no stash (e.g. clean CI run).
if git -C "$REPO_ROOT" stash list | grep -q .; then
  STASH_REF="${INSTANCE_STASH:-$(git -C "$REPO_ROOT" stash list --format='%gd' | head -n1)}"
  echo "Popping instance stash: $STASH_REF (resolve any conflicts by hand)"
  echo ">>> MANUAL: run in the LIVE tree:  git stash pop \"$STASH_REF\""
  echo ">>> then verify the three instance patches (UPGRADING.md §5):"
  echo "      INSTANCE-A OneCLI bridge address   -> src/container-runtime.ts"
  echo "      INSTANCE-B status-line disabled     -> module enable/config"
  echo "      INSTANCE-C docker.sock passthrough  -> src/container-runner.ts"
else
  echo "No stash present — no instance patches to reapply (verify this is expected)."
fi

# ---- 6. gate: boundaries + types + build + tests --------------------------
say "6. Gate: boundaries + typecheck + build + tests"
# Boundary gate is a FORK-maintained module; upstream v2 does not ship it, so a
# replay can drop the script + the package.json "check:boundaries" alias.
if pnpm run 2>/dev/null | grep -q 'check:boundaries'; then
  pnpm run check:boundaries
elif [ -f scripts/check-boundaries.sh ]; then
  bash scripts/check-boundaries.sh
else
  echo "WARNING: boundary gate (scripts/check-boundaries.sh + check:boundaries alias) missing after replay."
  echo "         Re-carry it from the fork stack before publishing."
fi

pnpm run typecheck
pnpm run build
if [ "${SKIP_TESTS:-0}" != "1" ]; then
  pnpm test
else
  echo "SKIP_TESTS=1 — skipping test suite (typecheck+build still ran)."
fi

say "Steps 1–6 complete on $WORKTREE_DIR ($UPGRADE_BRANCH)"

# ===========================================================================
# 7 + 8 BELOW ARE MANUAL AND IRREVERSIBLE — NOT AUTOMATED.
# ===========================================================================
cat <<'MANUAL'

############################################################################
# STEP 7 — DB MIGRATION GATE (SQLite, manual, run against a THROWAWAY copy) #
############################################################################
#
# Migrations: ordered array (src/db/migrations/index.ts) = execution order.
# Applied-ness keyed by `name` (UNIQUE) in schema_version; `version` col is
# auto MAX+1 at insert, NOT a numeric prefix. Merged code MUST ship upstream's
# FK-aware runMigrations; any fork-only migration MUST be appended AFTER the
# upstream migration that recreates its parent table. Do NOT hardcode a count —
# assert the DELTA (only genuinely-new migrations apply).
#
#   LIVE_DB=<path to live messages/central .db>
#   BUILD_DIR="$PWD"   # the built worktree (has dist/ + native better-sqlite3)
#
#   # WAL-safe consistent copy (checkpoints WAL into the copy; live file untouched)
#   sqlite3 "$LIVE_DB" ".backup '/tmp/verify.db'"
#
#   node --input-type=module - "$BUILD_DIR" /tmp/verify.db <<'NODE'
#   import Database from 'better-sqlite3';
#   const [, , buildDir, copyPath] = process.argv;
#   const { runMigrations, migrations } = await import(
#     new URL('dist/db/migrations/index.js', 'file://' + buildDir + '/').href);
#   const db = new Database(copyPath); db.pragma('foreign_keys = ON');
#   const names = () => db.prepare('SELECT name FROM schema_version ORDER BY version').all().map(r => r.name);
#   const rows  = () => Object.fromEntries(db.prepare('SELECT name,version,applied FROM schema_version').all().map(r => [r.name, r]));
#   const before = new Set(names()); const beforeRows = rows();
#   const expectedNew = migrations.map(m => m.name).filter(n => !before.has(n));
#   runMigrations(db);
#   const after = names(); const actualNew = after.filter(n => !before.has(n));
#   const eq = (a,b) => a.length===b.length && a.every((x,i)=>x===b[i]);
#   if (!eq([...expectedNew].sort(), [...actualNew].sort())) throw new Error('unexpected applied set '+JSON.stringify(actualNew));
#   for (const n of before) { const a = rows()[n]; if (!a || a.version!==beforeRows[n].version || a.applied!==beforeRows[n].applied) throw new Error('original row mutated '+n); }
#   const fk = db.pragma('foreign_key_check'); if (fk.length) throw new Error('fk '+JSON.stringify(fk));
#   const ic = db.pragma('integrity_check'); if (!(ic.length===1 && ic[0].integrity_check==='ok')) throw new Error('integrity '+JSON.stringify(ic));
#   runMigrations(db); if (!eq(names(), after)) throw new Error('not idempotent');
#   db.close(); console.log('OK gate: +'+actualNew.length+' ['+actualNew.join(', ')+'], originals intact, fk=[], integrity ok, idempotent');
#   NODE
#
#   # Fresh empty DB must build the FULL schema incl. fork tables:
#   rm -f /tmp/fresh.db
#   node --input-type=module - "$BUILD_DIR" /tmp/fresh.db <<'NODE'
#   import Database from 'better-sqlite3';
#   const [, , buildDir, p] = process.argv;
#   const { runMigrations } = await import(new URL('dist/db/migrations/index.js','file://'+buildDir+'/').href);
#   const db = new Database(p); db.pragma('foreign_keys = ON'); runMigrations(db);
#   const has = t => db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t);
#   for (const t of ['collab_sessions','responder_state']) if (!has(t)) throw new Error('missing fork table '+t);
#   db.close(); console.log('OK fresh: full schema incl. fork tables');
#   NODE
#   rm -f /tmp/verify.db /tmp/fresh.db
#
############################################################################
# STEP 8 — CUTOVER (LIVE, IRREVERSIBLE, manual)                             #
############################################################################
#
#   <stop service>
#   sqlite3 "$LIVE_DB" "PRAGMA wal_checkpoint(TRUNCATE);"   # fold WAL into main file
#   cp "$LIVE_DB" "$LIVE_DB.pre-<TARGET>.bak"               # rollback artifact = THESE bytes
#   <deploy merged build>
#   <start service>                                        # boot runs runMigrations ONCE
#   sqlite3 "$LIVE_DB" ".backup '/tmp/postboot.db'"         # re-assert §7 invariants read-only
#
#   Rollback is ASYMMETRIC (forward migrations already ran):
#   <stop service>; <restore previous code>; cp "$LIVE_DB.pre-<TARGET>.bak" "$LIVE_DB"; <start service>
#
############################################################################
MANUAL
