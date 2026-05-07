# NanoClaw Cleanup And Modularization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the customized NanoClaw checkout safe to maintain by disabling accidental upstream pushes, committing the current dirty responder work in small units, and defining the next modularization boundary before any upstream v2 migration.

**Architecture:** Treat `qwibitai/nanoclaw` as upstream, `Jaeboong/nanoclaw` as the only push target, and local behavior as branch/skill-style feature layers rather than OpenClaw-style runtime overrides. First stabilize the current v1.2-based working tree. Then reduce the responder patch surface around clear modules. Only after that decide whether to migrate to upstream v2.

**Tech Stack:** Git remotes/branches, TypeScript, Vitest, NanoClaw channel skills, SQLite migrations, container skills, boundary harness.

---

## Current Baseline

Repository:

```text
$REPO_ROOT
```

Important refs after fetch:

```text
HEAD        60c74f8 fix(dart): bypass proxy for OpenDART requests
origin/main 3b559c9 fix(harness): exclude .boundaries-baseline from its own scan
upstream/main d8d6f6b NanoClaw 2.0.33 era
```

Current divergence:

```text
origin/main...HEAD    0 behind / 5 ahead
upstream/main...HEAD  747 behind / 67 ahead
```

Current dirty files:

```text
M  .gitignore
M  src/channels/discord-monitoring.ts
M  src/channels/discord.test.ts
M  src/channels/discord.ts
M  src/config.ts
M  src/db.test.ts
M  src/db.ts
M  src/index.ts
M  src/types.ts
?? docs/plans/
?? src/channels/discord-features/responder.test.ts
?? src/channels/discord-features/responder.ts
?? src/responder-routing.test.ts
?? src/responder-routing.ts
?? src/responder-state.test.ts
?? src/responder-state.ts
```

Already verified from the dirty state:

```bash
npm run check:boundaries
npm test -- src/responder-state.test.ts src/responder-routing.test.ts src/channels/discord-features/responder.test.ts src/channels/discord.test.ts src/db.test.ts
npm run typecheck
```

Expected current result:

```text
boundary check: clean (vs baseline)
5 test files passed, 84 tests passed
typecheck passed
```

## Boundary Decision

NanoClaw is not OpenClaw. Its intended extension model is:

- Core stays small.
- Channel and capability code is added through skill/fork/branch merges.
- Personal instance data stays out of git.

Therefore this cleanup should not try to create Docker-style local overrides like OpenClaw. It should:

- Keep reusable code as tracked **core** or **module**.
- Keep channel-specific local behavior in focused commits that can later become a `skill/*` branch if needed.
- Keep instance values in ignored host config: `.env`, `~/.config/nanoclaw/*.json`, `groups/*`, `ops/**/instances/`, `ops/**/local/`.

## Stop Conditions

Stop and report before proceeding if any of these happen:

- `git status --short` shows unexpected files not listed in this plan.
- A command would push to `upstream`.
- A command would run `git reset`, `git checkout --`, `git clean`, or otherwise discard changes.
- `npm run typecheck` fails after a task.
- `npm test` fails in a touched area and the cause is not obvious.
- A proposed change requires migrating to upstream v2 in the same batch.

---

### Task 1: Add Remote Safety Guard

**Files:**
- No source files.
- Git remote metadata only.

**Step 1: Confirm remotes**

Run:

```bash
git remote -v
```

Expected before change:

```text
origin   git@github.com:Jaeboong/nanoclaw.git (fetch)
origin   git@github.com:Jaeboong/nanoclaw.git (push)
upstream https://github.com/qwibitai/nanoclaw.git (fetch)
upstream https://github.com/qwibitai/nanoclaw.git (push)
```

**Step 2: Disable upstream push**

Run:

```bash
git remote set-url --push upstream DISABLED
```

**Step 3: Verify upstream push is disabled**

Run:

```bash
git remote -v
```

Expected:

```text
upstream https://github.com/qwibitai/nanoclaw.git (fetch)
upstream DISABLED (push)
```

**Step 4: Commit**

No commit. Remote config is local repo metadata, not a tracked file.

---

### Task 2: Create A Safety Branch Pointer

**Files:**
- No source files.
- Git refs only.

**Step 1: Create a non-destructive rescue branch**

Run:

```bash
git branch backup/nanoclaw-cleanup-start
```

Expected: branch created at the current dirty working tree's `HEAD`. This does not snapshot uncommitted changes; it only protects the current commit pointer.

**Step 2: Verify**

Run:

```bash
git branch --list backup/nanoclaw-cleanup-start
git status --short
```

Expected:

```text
backup/nanoclaw-cleanup-start
```

`git status --short` should still show the same dirty files.

**Step 3: Commit**

No commit. This is local safety metadata.

---

### Task 3: Commit Planning Documents

**Files:**
- Add: `docs/plans/2026-05-06-dart-mcp-tooling.md`
- Add: `docs/plans/2026-05-07-discord-responder-routing.md`
- Add: `docs/plans/2026-05-07-nanoclaw-cleanup-and-modularization.md`

**Step 1: Inspect plan files for instance leaks**

Run:

```bash
rg -n "[0-9]{17,20}|[a-f0-9]{32}|/home/[[:alnum:]_.-]+/|DART_API_KEY=.*|DISCORD.*TOKEN" docs/plans
```

Expected: no real channel IDs, Notion page IDs, host paths, or secrets. Mentions of variable names like `DART_API_KEY` are allowed.

**Step 2: Run boundary check**

Run:

```bash
npm run check:boundaries
```

Expected: clean vs baseline.

**Step 3: Commit**

Run:

```bash
git add docs/plans/2026-05-06-dart-mcp-tooling.md docs/plans/2026-05-07-discord-responder-routing.md docs/plans/2026-05-07-nanoclaw-cleanup-and-modularization.md
git commit -m "docs: plan nanoclaw local cleanup"
```

Expected: one docs-only commit.

---

### Task 4: Commit Local Runtime Hygiene

**Files:**
- Modify: `.gitignore`

**Step 1: Review `.gitignore` diff**

Run:

```bash
git diff -- .gitignore
```

Expected diff:

```diff
+nanoclaw.pid
```

**Step 2: Run boundary check**

Run:

```bash
npm run check:boundaries
```

Expected: clean.

**Step 3: Commit**

Run:

```bash
git add .gitignore
git commit -m "chore: ignore nanoclaw runtime pid"
```

Expected: one hygiene commit.

---

### Task 5: Commit Message Store Metadata Support

**Files:**
- Modify: `src/types.ts`
- Modify: `src/db.ts`
- Modify: `src/db.test.ts`

**Purpose:** Add reusable message metadata primitives needed for cross-agent context: `is_bot_message`, `mentioned_bot_ids`, `mentions_self`, and optional bot-message inclusion in prompt context.

**Step 1: Verify the exact diff**

Run:

```bash
git diff -- src/types.ts src/db.ts src/db.test.ts
```

Expected:

- `NewMessage` has `mentioned_bot_ids?: string[]` and `mentions_self?: boolean`.
- `messages` schema has `mentioned_bot_ids TEXT` and `mentions_self INTEGER`.
- migrations add those columns for existing DBs.
- `storeMessage()` persists those fields.
- `getMessagesSince()` accepts `{ includeBotMessages?: boolean }`.
- tests cover bot context inclusion and mention metadata round-trip.

**Step 2: Run focused tests**

Run:

```bash
npm test -- src/db.test.ts
```

Expected: all `src/db.test.ts` tests pass.

**Step 3: Typecheck**

Run:

```bash
npm run typecheck
```

Expected: pass.

**Step 4: Commit**

Run:

```bash
git add src/types.ts src/db.ts src/db.test.ts
git commit -m "feat(db): persist bot mention metadata"
```

Expected: one core commit.

---

### Task 6: Commit Discord Bot Context Ingestion

**Files:**
- Modify: `src/channels/discord.ts`
- Modify: `src/channels/discord.test.ts`

**Purpose:** Store other bot messages as context and record Discord bot mentions without allowing bot messages to trigger NanoClaw turns.

**Step 1: Verify the exact diff**

Run:

```bash
git diff -- src/channels/discord.ts src/channels/discord.test.ts
```

Expected:

- Own bot messages are still ignored.
- Other bot messages are delivered to `onMessage()` with `is_bot_message: true`.
- `mentioned_bot_ids` includes mentioned bot user IDs.
- `mentions_self` is true only when this NanoClaw bot is mentioned.
- Tests cover other bot context and other-bot mentions.

**Step 2: Run focused tests**

Run:

```bash
npm test -- src/channels/discord.test.ts src/db.test.ts
```

Expected: Discord and DB tests pass.

**Step 3: Typecheck**

Run:

```bash
npm run typecheck
```

Expected: pass.

**Step 4: Commit**

Run:

```bash
git add src/channels/discord.ts src/channels/discord.test.ts
git commit -m "feat(discord): store bot messages as context"
```

Expected: one Discord channel commit.

---

### Task 7: Commit Responder State And Routing Module

**Files:**
- Create: `src/responder-state.ts`
- Create: `src/responder-state.test.ts`
- Create: `src/responder-routing.ts`
- Create: `src/responder-routing.test.ts`
- Modify: `src/config.ts`
- Modify: `src/index.ts`

**Purpose:** Add reusable responder state and pure routing helpers, then wire the message loop to skip Claude when the channel responder is `codex`.

**Step 1: Verify the exact diff**

Run:

```bash
git diff -- src/responder-state.ts src/responder-state.test.ts src/responder-routing.ts src/responder-routing.test.ts src/config.ts src/index.ts
```

Expected:

- `RESPONDER_STATE_PATH` points to `~/.config/nanoclaw/responder-state.json`.
- `Responder` is `claude | codex | both`.
- `/responder` text command is intercepted before message storage.
- `shouldProcessForResponder()` is pure and tested.
- non-main trigger checks use `hasAuthorizedTrigger()`.
- bot messages can be included as context but not trigger turns.

**Step 2: Run focused tests**

Run:

```bash
npm test -- src/responder-state.test.ts src/responder-routing.test.ts src/db.test.ts
```

Expected: responder and DB tests pass.

**Step 3: Typecheck**

Run:

```bash
npm run typecheck
```

Expected: pass.

**Step 4: Commit**

Run:

```bash
git add src/responder-state.ts src/responder-state.test.ts src/responder-routing.ts src/responder-routing.test.ts src/config.ts src/index.ts
git commit -m "feat(responder): gate Claude turns by channel state"
```

Expected: one responder core commit.

---

### Task 8: Commit Discord `/responder` Slash Feature

**Files:**
- Create: `src/channels/discord-features/responder.ts`
- Create: `src/channels/discord-features/responder.test.ts`
- Modify: `src/channels/discord.ts`
- Modify: `src/channels/discord-monitoring.ts`

**Purpose:** Register `/responder` as a Discord feature for both normal Discord and monitoring Discord channel instances.

**Step 1: Verify the exact diff**

Run:

```bash
git diff -- src/channels/discord-features/responder.ts src/channels/discord-features/responder.test.ts src/channels/discord.ts src/channels/discord-monitoring.ts
```

Expected:

- `responderFeature` provides `/responder` with optional `mode`.
- Slash command reads/updates `responder-state.json`.
- Updates are restricted by sender allowlist.
- `discord.ts` and `discord-monitoring.ts` include `responderFeature`.
- No channel IDs or user IDs are hardcoded.

**Step 2: Run focused tests**

Run:

```bash
npm test -- src/channels/discord-features/responder.test.ts src/channels/discord.test.ts
```

Expected: pass.

**Step 3: Typecheck**

Run:

```bash
npm run typecheck
```

Expected: pass.

**Step 4: Commit**

Run:

```bash
git add src/channels/discord-features/responder.ts src/channels/discord-features/responder.test.ts src/channels/discord.ts src/channels/discord-monitoring.ts
git commit -m "feat(discord): add responder slash command"
```

Expected: one Discord feature commit.

---

### Task 9: Full Verification Of Stabilized v1.2 Tree

**Files:**
- No edits expected.

**Step 1: Run focused tests**

Run:

```bash
npm test -- src/responder-state.test.ts src/responder-routing.test.ts src/channels/discord-features/responder.test.ts src/channels/discord.test.ts src/db.test.ts
```

Expected:

```text
Test Files 5 passed
Tests 84 passed
```

**Step 2: Run full typecheck**

Run:

```bash
npm run typecheck
```

Expected: pass.

**Step 3: Run boundary check**

Run:

```bash
npm run check:boundaries
```

Expected: clean vs baseline.

**Step 4: Confirm clean worktree**

Run:

```bash
git status --short
```

Expected: empty output.

**Step 5: Commit**

No commit unless verification required documentation updates.

---

### Task 10: Document The Patch Surface

**Files:**
- Create: `docs/plans/2026-05-07-nanoclaw-local-patch-surface.md`

**Purpose:** Make future agents understand what is intentionally local, what is upstream-trackable, and what should eventually become a skill branch.

**Step 1: Create the document**

Create `docs/plans/2026-05-07-nanoclaw-local-patch-surface.md` with:

```markdown
# NanoClaw Local Patch Surface

## Upstream relation

- `upstream/main` is NanoClaw v2-era and currently far ahead of this v1.2-based checkout.
- Do not merge upstream v2 casually into this working tree.
- Push only to `origin`.

## Local feature layers

| Layer | Commits | Tier | Notes |
|---|---|---|---|
| Discord channel integration | existing history | feature/channel skill | Already carried as local code |
| Observability host | existing history | module + instance templates | Instance values stay ignored |
| DART tooling | existing five commits | module + core env passthrough | API key is instance env |
| Responder routing | new commits | feature/channel module | Shared with OpenClaw responder state |

## Revisit triggers

- If upstream v2 migration is required.
- If Discord channel skill has an upstream branch that supersedes local Discord code.
- If responder routing needs to be shared across multiple channel skills.
- If DART tools should be extracted into a reusable utility skill.
```

**Step 2: Commit**

Run:

```bash
git add docs/plans/2026-05-07-nanoclaw-local-patch-surface.md
git commit -m "docs: record nanoclaw local patch surface"
```

Expected: docs-only commit.

---

### Task 11: Decide Whether To Push The Stabilized Local Branch

**Files:**
- No source edits.

**Step 1: Confirm ahead count**

Run:

```bash
git rev-list --left-right --count origin/main...HEAD
```

Expected: `0 N`, where `N` includes the previous five DART commits plus cleanup commits.

**Step 2: Confirm upstream push guard**

Run:

```bash
git remote -v
```

Expected: `upstream DISABLED (push)`.

**Step 3: Wait for user decision**

Do not push automatically.

If the user explicitly approves, run:

```bash
git push origin main
```

Expected: local branch published only to `Jaeboong/nanoclaw`.

---

### Task 12: Prepare, But Do Not Execute, Upstream v2 Migration

**Files:**
- Create: `docs/plans/2026-05-07-nanoclaw-v2-migration-assessment.md`

**Purpose:** Decide whether v2 migration is worth doing separately. This is intentionally not part of the cleanup implementation.

**Step 1: Create a read-only assessment**

Create `docs/plans/2026-05-07-nanoclaw-v2-migration-assessment.md` with:

```markdown
# NanoClaw v2 Migration Assessment

## Current fact

This checkout is v1.2-based. `upstream/main` is v2.0.33-era and hundreds of commits ahead.

## Do not do in-place migration until these are answered

- Is the current production bot allowed to stop during migration?
- Is Discord channel support in upstream v2 compatible with the local Discord feature set?
- Can DART tooling be applied cleanly to v2 container runner?
- Can responder routing be ported as a channel feature rather than core message-loop patch?
- Are existing SQLite data and group folders compatible or migrated?

## Recommended path

Use a separate worktree:

```bash
git worktree add ../nanoclaw-v2-migration upstream/main
```

Then replay local feature layers one at a time:

1. Discord channel support.
2. Runtime status/ledger formatting.
3. DART env passthrough and MCP tooling.
4. Responder routing.
5. Observability templates.

Do not replace the production checkout until tests and a dry-run bot pass.
```

**Step 2: Commit**

Run:

```bash
git add docs/plans/2026-05-07-nanoclaw-v2-migration-assessment.md
git commit -m "docs: assess nanoclaw v2 migration"
```

Expected: docs-only commit.

---

## Final Verification Checklist

Run:

```bash
git status --short
git remote -v
git log --oneline --decorate -n 20
git rev-list --left-right --count origin/main...HEAD
npm test -- src/responder-state.test.ts src/responder-routing.test.ts src/channels/discord-features/responder.test.ts src/channels/discord.test.ts src/db.test.ts
npm run typecheck
npm run check:boundaries
```

Expected:

- Worktree clean.
- `upstream` push URL is `DISABLED`.
- Only `origin` is a valid push target.
- Focused tests pass.
- Typecheck passes.
- Boundary check passes.

## Recommended Execution Mode

Use one worker to execute Tasks 1-10 sequentially. These tasks are coupled through the same dirty working tree, so parallel implementation workers are not worth the conflict risk.

The head agent should not poll with `wait_agent`. If using subagents, assign one worker the full plan and let it report completion. The head agent verifies the final git state and test output after the notification arrives.

## Not In Scope

- Migrating production NanoClaw to upstream v2.
- Rewriting Discord channel integration against upstream v2.
- Extracting DART into a separate package.
- Pushing to any remote.
- Restarting the running NanoClaw service.
