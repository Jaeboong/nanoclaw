# UPGRADING — replaying a customized fork onto new upstream

Operator runbook for pulling a new upstream release into this fork **without
losing the fork's custom features**. This is the *execution* companion to
`docs/UPSTREAM-MERGE.md` (which is the *authoring* discipline: keep features
additive and seam-only so merges stay cheap). Read that first; this file is
what you run when a new upstream tag lands.

The engine (rebase + rerere + a migration/cutover gate) already exists and has
been exercised once (fork base `v2.0.71` → upstream tip `v2.1.17`). This runbook
codifies it so every future catch-up is the same repeatable procedure.

---

## Overview

The fork is a small stack of **additive-module commits** (~22 at time of
writing; see `features.manifest.json`) sitting on top of an upstream **base
commit**. An upgrade means: take that stack and re-land it on top of a newer
upstream base.

- **Method: REPLAY (`git rebase --onto`), never a raw `git merge`.** Project
  policy. A merge would create a permanent divergence node and re-surface the
  same conflicts every time; a replay keeps the fork as a clean linear delta on
  top of upstream, so `git diff upstream/<tag> --stat` always reads as *new
  files*, not sprawling core edits.
- **rerere makes the replay cheap over time.** Git records how you resolved
  each conflict once and replays that resolution automatically on every future
  upgrade (see Preconditions). The recorded resolutions are shared across all
  worktrees because they live in the single shared `.git`.
- **Two things a code replay does NOT carry and that gate the deploy:**
  1. **INSTANCE patches** — host-only tweaks kept *uncommitted* (never in git).
     Reapplied from a stash. See §5.
  2. **The live SQLite database** — schema migrations are forward-only and run
     at boot. This is the irreversible part. See §7–§8.

---

## Preconditions

- **Clean or triaged working tree** on the fork branch. Committed fork work is
  fine; uncommitted work must be either an intentional instance patch (stashed,
  §5) or committed/discarded. `git status` should show nothing surprising.
- **rerere enabled** (once per clone; it persists in `.git/config`):

  ```bash
  git config rerere.enabled true
  # optional: also auto-stage fully-resolved files
  git config rerere.autoUpdate true
  ```

  rerere records every conflict resolution under `.git/rr-cache` and reuses it
  on any later merge/rebase that hits the same conflict — including future
  upgrades. Because worktrees share one `.git`, a resolution recorded in the
  isolated upgrade worktree is available to the primary tree and to the next
  upgrade.

- **`upstream` remote configured** and fetchable:

  ```bash
  git remote get-url upstream || git remote add upstream <UPSTREAM_URL>
  ```

- **Know your two coordinates:**
  - `LAST_MERGED_BASE` — the upstream commit the current fork stack sits on
    (the parent of the fork's first custom commit). Record it after every
    successful upgrade; it becomes the next upgrade's base.
  - `UPSTREAM_TARGET` — where you're going. Prefer a **tag** (`v2.1.17`) over a
    moving branch tip (`upstream/main`) for reproducibility.

- **Package manager is `pnpm`** (`packageManager: pnpm@…` in `package.json`,
  lockfile is `pnpm-lock.yaml`). Do not mix in `npm`/`npm ci` — a mixed
  invocation regenerates the wrong lockfile.

---

## Step-by-step

The scripted form of steps 1–6 is `upstream-catchup.sh` (re-runnable). Steps 7
and 8 are **deliberately not automated** — they touch the live DB. Run them by
hand with the snippets below.

### 1. Fetch and choose the target

```bash
git fetch upstream --tags
# Inspect what changed since your base:
git log --oneline "$LAST_MERGED_BASE"..upstream/<branch>
```

Pick `UPSTREAM_TARGET` — a tag if one exists at the point you want.

### 2. Isolated worktree + `rebase --onto`

Never rebase in the live/primary working tree. Create a throwaway worktree so a
failed replay can't strand your running install:

```bash
git worktree add ../fork-upgrade -b upgrade/<UPSTREAM_TARGET> <FORK_BRANCH>
cd ../fork-upgrade
git rebase --onto <UPSTREAM_TARGET> "$LAST_MERGED_BASE" upgrade/<UPSTREAM_TARGET>
```

Read `--onto` as: *replay every commit after `LAST_MERGED_BASE` up to the branch
tip, onto `UPSTREAM_TARGET`.* Only the fork's own commits move; upstream history
is not duplicated.

### 3. Resolve conflicts — preserve fork additions on evolved upstream

- rerere auto-resolves anything it has seen before. Trust it, but **eyeball each
  reused resolution** — upstream structure may have shifted under it.
- For genuinely new conflicts, the invariant is: **keep the fork's added
  behavior, re-expressed on top of upstream's new structure.** A conflict almost
  always means an upstream file the fork touched through a seam has moved; port
  the fork's seam call to the new location rather than reverting upstream.
- After resolving a file: `git add <file>`; then `git rebase --continue`.
- If a fork commit has become fully redundant (upstream now ships it natively),
  drop it (`git rebase --skip` / delete during an interactive edit) and record
  the disposition in `features.manifest.json` (`DROP` / `RE-DERIVE`).

### 4. Reconcile dependency versions, regenerate the lockfile

A bumped **transitive** dependency can force a **direct** dependency to move in
lockstep. Concrete case from the reference catch-up: the Discord chat adapter
had to track the core `chat` package's minor —
`@chat-adapter/discord 4.26 → 4.29` to match `chat@4.29`. A stale adapter pin
produces peer/`ERESOLVE`-style install failures.

```bash
# Align any direct dep whose peer moved with upstream (edit package.json), then:
pnpm install          # regenerates pnpm-lock.yaml against the merged package.json
```

Commit the reconciled `package.json` + `pnpm-lock.yaml` as part of the replay.

### 5. Reapply INSTANCE patches (host-only, never committed)

Instance patches are the deployment's private edits. They live **only** in the
live working tree as an uncommitted stash — they are gitignored/untracked by
policy (`docs/HARNESS.md`, instance tier) and must never enter the replayed
history.

```bash
# In the LIVE worktree, before switching to the merged build:
git stash push -m "instance patches" -- <instance files>
# …after the merged build is in place, re-apply and resolve by hand:
git stash pop
```

Then verify the three known instance patches are present and correct. These are
inlined here (rather than referenced by section number) because they are the
fork's actual instance surface; adjust to your deployment:

- **INSTANCE-A — OneCLI bridge address.** The container→host bridge target used
  when the agent reaches the OneCLI gateway. Host/deployment-specific; lives in
  `src/container-runtime.ts`. Verify the value matches *this* host's bridge, not
  the reference host's. (Never commit it — it's a host address.)
- **INSTANCE-B — status-line disable flag.** The `status-line` module is a
  committed module but is toggled **off** on this instance. Verify the disable
  flag/config is still applied after the merge (upstream may have changed the
  module-enable plumbing).
- **INSTANCE-C — docker.sock passthrough.** The privileged-container mount that
  passes the Docker socket into the agent container; lives in
  `src/container-runner.ts`. Verify the passthrough (and its double-guard) is
  intact and scoped to the intended group only.

Cross-check against the instance-tier definition in `docs/HARNESS.md`: anything
identifiable to one host/deployment (addresses, host paths, per-instance
toggles, secrets) stays instance and out of git.

> Note: `docs/HARNESS.md` and `AGENTS.md` are themselves **fork-maintained**
> docs, absent from upstream v2. Like the boundary-gate script (§6), a replay
> can drop them — re-carry them from the fork stack if the merged tree is
> missing them.

### 6. Gate — boundaries, types, build, tests

Run all of these green before going near the DB:

```bash
pnpm run typecheck          # tsc --noEmit
pnpm run build              # tsc
pnpm test                   # full vitest suite

# Boundary gate — the fork's 3-tier leak check (docs/HARNESS.md).
# NOTE: this gate is a FORK-maintained module (scripts/check-boundaries.sh +
# .boundaries-baseline + a package.json "check:boundaries" alias). Upstream v2
# does NOT ship it, so a replay onto v2 can DROP the script and the alias.
# Carry them forward as part of the fork stack. If the alias is missing after
# the replay, invoke the script directly:
bash scripts/check-boundaries.sh   # or: pnpm run check:boundaries if the alias survived
```

If `check-boundaries.sh` is absent from the merged tree, that itself is a replay
regression — restore it from the fork stack before continuing.

---

### 7. DB MIGRATION GATE (critical — SQLite, do by hand)

This gate proves the merged code will migrate the **live** database safely,
*before* you let it touch the live database. Run it against a throwaway,
WAL-safe copy.

**How migrations work here (read before trusting the assertions):**

- Migrations are registered in an **ordered array** (`src/db/migrations/index.ts`
  → `export const migrations`). **Array position is execution order.**
- Applied-ness is keyed by the migration's **`name` string**, tracked in a
  `schema_version` table with a `UNIQUE` index on `name`. The `version` column
  is **auto-assigned `MAX(version)+1` at insert time** (applied-order counter) —
  it is **not** a numeric prefix and not the source of ordering. So two
  migrations can carry the same `version` field; only `name` must be unique.
- The runner (`runMigrations`) is **FK-aware.** A migration that recreates a
  table (SQLite can't `ALTER` away a table-level constraint — it must
  `CREATE new / copy / DROP old / RENAME`) sets `disableForeignKeys: true`. The
  runner toggles `PRAGMA foreign_keys = OFF` **outside** the transaction (the
  pragma is a silent no-op inside one) and runs `PRAGMA foreign_key_check`
  **inside** it, so any FK violation the migration *introduces* rolls the whole
  migration back. Pre-existing latent orphans are snapshotted first and tolerated
  (they must not crash-loop the host at every boot).

**The merge invariant:** the merged code MUST ship upstream's FK-aware
`runMigrations`. Any **fork-only** migration MUST be appended to the array
**after** the upstream migration that creates/recreates its parent table.
(Reference: the fork's `collab-state` migration creates tables that reference
`messaging_groups(id)`, so it sits after upstream's messaging-group migration in
the array. If upstream later moves or recreates that parent table, the fork
migration's array position must move with it.)

**Make a WAL-safe read-only copy of the live DB, then run the gate on the copy:**

```bash
# 1. WAL-safe consistent snapshot of the live DB into a throwaway file.
#    .backup checkpoints the WAL into the copy; the live file is untouched.
sqlite3 "$LIVE_DB" ".backup '/tmp/verify.db'"

# 2. Run the COMPILED runner (built against the merged code + native better-sqlite3)
#    against the copy and assert the invariants.
node --input-type=module - "$PWD" /tmp/verify.db <<'NODE'
import Database from 'better-sqlite3';
const [, , buildDir, copyPath] = process.argv;
const { runMigrations, migrations } = await import(
  new URL('dist/db/migrations/index.js', 'file://' + buildDir + '/').href
);

const db = new Database(copyPath);
db.pragma('foreign_keys = ON');

const names = () =>
  db.prepare('SELECT name FROM schema_version ORDER BY version').all().map((r) => r.name);
const rowsById = () =>
  Object.fromEntries(
    db.prepare('SELECT name, version, applied FROM schema_version').all().map((r) => [r.name, r]),
  );

// Snapshot BEFORE — this is the delta baseline. Do NOT hardcode a count;
// the set of already-applied names is whatever this live DB carries.
const before = new Set(names());
const beforeRows = rowsById();
const expectedNew = migrations.map((m) => m.name).filter((n) => !before.has(n));

runMigrations(db);

const after = names();
const afterSet = new Set(after);
const actualNew = after.filter((n) => !before.has(n));

// (a) exactly the genuinely-new upstream/fork migrations applied — no more, no less
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
if (!eq([...expectedNew].sort(), [...actualNew].sort()))
  throw new Error(`unexpected applied set: +${JSON.stringify(actualNew)} expected ${JSON.stringify(expectedNew)}`);

// (b) originals untouched (same version + applied timestamp)
for (const n of before) {
  const a = rowsById()[n];
  if (!a || a.version !== beforeRows[n].version || a.applied !== beforeRows[n].applied)
    throw new Error(`original migration row mutated: ${n}`);
}

// (c) referential integrity clean and DB not corrupted
const fk = db.pragma('foreign_key_check');
if (fk.length) throw new Error(`foreign_key_check not empty: ${JSON.stringify(fk)}`);
const integ = db.pragma('integrity_check');
if (!(integ.length === 1 && integ[0].integrity_check === 'ok'))
  throw new Error(`integrity_check failed: ${JSON.stringify(integ)}`);

// (d) idempotent — a second run applies nothing
runMigrations(db);
if (!eq(names(), after)) throw new Error('runMigrations is not idempotent');

db.close();
console.log(`OK: applied ${actualNew.length} new [${actualNew.join(', ')}], ${before.size} originals intact, fk=[], integrity ok, idempotent`);
NODE

# 3. Fresh-DB check — a brand-new empty database must build the FULL schema,
#    including the fork-only tables (proves the fork migrations still run on a
#    clean install, not only as increments on this host's DB).
rm -f /tmp/fresh.db
node --input-type=module - "$PWD" /tmp/fresh.db <<'NODE'
import Database from 'better-sqlite3';
const [, , buildDir, freshPath] = process.argv;
const { runMigrations } = await import(
  new URL('dist/db/migrations/index.js', 'file://' + buildDir + '/').href
);
const db = new Database(freshPath);
db.pragma('foreign_keys = ON');
runMigrations(db);
const has = (t) =>
  db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t);
// Assert the fork-owned tables exist on a clean build (adjust list per fork).
for (const t of ['collab_sessions', 'responder_state']) {
  if (!has(t)) throw new Error(`fork table missing on fresh DB: ${t}`);
}
const fk = db.pragma('foreign_key_check');
if (fk.length) throw new Error(`fresh DB fk_check not empty: ${JSON.stringify(fk)}`);
db.close();
console.log('OK: fresh empty DB builds full schema incl. fork tables');
NODE

rm -f /tmp/verify.db /tmp/fresh.db
```

Only proceed to cutover if **both** blocks print `OK`.

> **Smoke-test the snippet itself before your first real cutover.** These
> verification snippets are templates — run them once against a throwaway
> `.backup` copy of a non-critical DB to confirm the import path
> (`dist/db/migrations/index.js` exporting `runMigrations` + `migrations`) and
> pragma shapes match your built tree before you rely on them to gate a live
> deploy.

---

### 8. CUTOVER (irreversible — live DB, do by hand)

Forward migrations run once at boot and rewrite the live schema. There is no
"undo migration." Therefore the rollback artifact is a **byte snapshot of the DB
taken at the exact moment the service is stopped**, and rollback is
**asymmetric** (see below).

```bash
# 1. Stop the service (no writer may touch the DB during snapshot/deploy).
<stop the service>          # e.g. systemctl --user stop <svc> / launchctl unload …

# 2. Fold the WAL into the main DB file so the snapshot is self-contained.
sqlite3 "$LIVE_DB" "PRAGMA wal_checkpoint(TRUNCATE);"

# 3. Snapshot THESE bytes — THIS is the rollback artifact. Keep it until the
#    upgrade has soaked.
cp "$LIVE_DB" "$LIVE_DB.pre-<UPSTREAM_TARGET>.bak"

# 4. Deploy the merged, built code (swap the tree / update the symlink / etc.).
<deploy merged build>

# 5. Start the service. Boot runs runMigrations exactly once against the live DB.
<start the service>

# 6. POST-BOOT RE-ASSERT — read-only, against a fresh copy of the NOW-migrated
#    live DB (same assertions as the gate, but confirming reality post-deploy):
sqlite3 "$LIVE_DB" ".backup '/tmp/postboot.db'"
#   assert: originals still present + exactly the expected new migration rows,
#   foreign_key_check = [], integrity_check = ok.
#   (Re-use the §7 verify snippet, but `before` is now the PRE-cutover applied
#    set you recorded in step 7; there should be NOTHING left pending.)
rm -f /tmp/postboot.db
```

**Rollback (asymmetric — code revert alone is NOT enough):**
Because boot already ran forward migrations, restoring the old code leaves it
pointed at a *newer* schema it doesn't understand. A correct rollback restores
**both**:

```bash
<stop the service>
<restore previous code build>
cp "$LIVE_DB.pre-<UPSTREAM_TARGET>.bak" "$LIVE_DB"   # restore the pre-migration bytes
<start the service>
```

---

## After a successful upgrade

- Record the new base: set `LAST_MERGED_BASE = <UPSTREAM_TARGET's commit>` for
  next time (e.g. in `versions.json` or an upgrade marker).
- Fast-forward the fork branch to the upgrade branch, remove the throwaway
  worktree (`git worktree remove ../fork-upgrade`).
- Re-review `features.manifest.json`: for each feature, re-ask *"does upstream
  now provide this natively?"* and update `disposition` (a feature can graduate
  from `REPLAY` → `RE-DERIVE` → `DROP` over releases).
- Keep the `.pre-<TARGET>.bak` DB snapshot until the release has soaked.
