# Discord Responder Routing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add channel-level responder routing so one Discord channel can switch between Claude, Codex, or both without requiring @mentions on every message.

**Architecture:** NanoClaw remains the Claude runtime. A small host-local responder state file records `channel_jid -> claude|codex|both`; NanoClaw only triggers on normal messages when the state includes `claude`. `/responder` reads or updates the state, and bot messages can be stored as context without becoming triggers.

**Tech Stack:** TypeScript, Vitest, Discord.js, NanoClaw SQLite message store, host-local JSON under `~/.config/nanoclaw`.

---

### Task 1: Add Responder State Module

**Files:**
- Create: `src/responder-state.ts`
- Modify: `src/config.ts`
- Test: `src/responder-state.test.ts`

**Steps:**
1. Add `RESPONDER_STATE_PATH` to `src/config.ts`, pointing to `~/.config/nanoclaw/responder-state.json`.
2. Implement `Responder = 'claude' | 'codex' | 'both'`.
3. Implement load/get/set helpers with safe fallback to `claude`.
4. Store channel state as JSON, creating parent directories as needed.
5. Test missing file, invalid JSON, valid get, valid set, and invalid responder handling.

**Verification:**
- Run: `npm test -- src/responder-state.test.ts`
- Expected: new responder state tests pass.

### Task 2: Add `/responder` Command

**Files:**
- Modify: `src/index.ts`
- Create: `src/channels/discord-features/responder.ts`
- Test: `src/channels/discord-features/responder.test.ts`
- Test: add coverage where practical through isolated helper or direct state tests.

**Steps:**
1. Register a real Discord `/responder` slash command with optional `mode`.
2. Keep text `/responder` interception as a fallback before normal message storage, similar to `/remote-control`.
3. `/responder` with no argument returns the current channel responder.
4. `/responder claude|codex|both` updates the channel state and returns confirmation.
5. Invalid text arguments return `Usage: /responder [claude|codex|both]`.
6. Restrict updates to senders accepted by the existing sender allowlist for that chat.

**Verification:**
- Run: `npm run typecheck`
- Expected: no TypeScript errors.

### Task 3: Gate Claude Triggering By Responder State

**Files:**
- Modify: `src/index.ts`
- Test: focused unit tests if helper extraction is needed.

**Steps:**
1. Before running Claude for normal messages, read channel responder.
2. If responder is `codex`, do not run Claude and leave the Claude cursor unchanged so later `claude`/`both` mode can read the Codex-mode context.
3. If responder is `claude` or `both`, keep current trigger logic.
4. Do not let `/responder` messages become agent prompts.

**Verification:**
- Run: `npm run typecheck`
- Expected: no TypeScript errors.

### Task 4: Store Discord Bot Messages As Context

**Files:**
- Modify: `src/channels/discord.ts`
- Modify: `src/db.ts`
- Test: `src/channels/discord.test.ts`, `src/db.test.ts`

**Steps:**
1. Stop returning early for all bot messages in Discord ingestion.
2. Still ignore own bot pin notifications.
3. Store other bot messages with `is_bot_message: true`.
4. Add a DB helper option to include bot messages when building prompt context.
5. Keep trigger checks based only on non-bot messages.

**Verification:**
- Run: `npm test -- src/channels/discord.test.ts src/db.test.ts`
- Expected: bot messages are stored with the flag and can be retrieved only when context mode includes bots.

### Task 5: Document User Setup

**Files:**
- Modify: `docs/HARNESS.md` only if a new boundary rule is needed.
- Create or modify ignored instance notes only if needed.

**Steps:**
1. Document that `responder-state.json` and sender allowlist are instance-local.
2. Tell the user to provide Discord user ID, OpenClaw bot token, and OpenClaw install path before Codex-side gating can be wired.
3. Keep OpenClaw work out of NanoClaw until OpenClaw is installed.

**Verification:**
- Run: `npm run check:boundaries`
- Expected: no new boundary findings.

### Task 6: Final Verification

**Commands:**
- `npm test -- src/responder-state.test.ts src/channels/discord.test.ts src/db.test.ts`
- `npm run typecheck`
- `npm run check:boundaries`

**Expected:** all pass.
