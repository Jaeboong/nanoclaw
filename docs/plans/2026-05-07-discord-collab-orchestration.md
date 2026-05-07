# Discord Collab Orchestration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `/collab` Discord command that lets NanoClaw and OpenClaw take bounded turns on one user task, stopping when both agents declare `DONE` or the configured round limit is reached.

**Architecture:** NanoClaw owns the writable collab state and exposes `/collab`. OpenClaw mounts the same NanoClaw config read-only and only uses the state to decide when Codex may process a bot-authored handoff. Bot messages remain read-only outside an active collab session.

**Tech Stack:** TypeScript, Vitest, NanoClaw Discord features, OpenClaw Discord local overrides, JSON state files under NanoClaw config.

---

### Task 1: NanoClaw Collab State Machine

**Files:**
- Create: `src/collab-state.ts`
- Test: `src/collab-state.test.ts`

**Steps:**
1. Write failing tests for starting a session, setting `maxRounds`, recording `DONE`, early completion after both agents are done, and max-round completion.
2. Run `npm test -- src/collab-state.test.ts` and confirm the tests fail because the module is missing.
3. Implement JSON-backed state with `claude` and `codex` agents, default `maxRounds=10`, `round` as one agent turn, and `COLLAB_STATUS` parsing.
4. Re-run the collab state tests and commit.

### Task 2: NanoClaw `/collab` Discord Feature

**Files:**
- Create: `src/channels/discord-features/collab.ts`
- Test: `src/channels/discord-features/collab.test.ts`
- Modify: `src/channels/discord.ts`
- Modify: `src/channels/discord-monitoring.ts`

**Steps:**
1. Write failing tests for slash command registration, default starter `claude`, selected starter `codex`, `/collab max`, `/collab status`, and `/collab stop`.
2. Implement the feature as local NanoClaw functionality, using simple Discord options: `mode`, `agent`, `task`, `value`.
3. On start, write collab state, store a synthetic user task through `ctx.onMessage`, and reply visibly with the kickoff prompt.
4. Re-run feature tests and commit.

### Task 3: NanoClaw Claude Turn Gate

**Files:**
- Modify: `src/index.ts`
- Modify: `src/responder-routing.ts`
- Test: `src/responder-routing.test.ts`
- Test: targeted index-adjacent tests where available

**Steps:**
1. Write failing tests showing active collab overrides the normal responder gate only when `nextAgent=claude`.
2. Update message processing so bot messages are never general triggers, but they can enqueue Claude only inside an active collab session.
3. Wrap Claude prompts with collab protocol instructions requiring final line `COLLAB_STATUS: DONE|CONTINUE|NEEDS_USER|BLOCKED`.
4. Record Claude output before sending it to Discord so OpenClaw sees the updated next-agent state.
5. Re-run targeted NanoClaw tests and commit.

### Task 4: OpenClaw Collab Read-Only Gate

**Files:**
- Create: `extensions/discord/src/local-overrides/collab-state.ts`
- Test: `extensions/discord/src/local-overrides/collab-state.test.ts`
- Modify: `extensions/discord/src/monitor/message-handler.preflight.ts`
- Modify: `extensions/discord/src/monitor/message-handler.ts`
- Modify: `extensions/discord/src/monitor/message-handler.process.ts`

**Steps:**
1. Write failing tests showing Codex accepts a bot-authored handoff only when NanoClaw collab state says `nextAgent=codex`.
2. Implement read-only state parsing in `local-overrides`.
3. Bypass `allowBots=false` and mention-required gating only for the active Codex collab turn.
4. Keep shared responder gating skipped only for active Codex collab turns.
5. Wrap Codex prompts with the same `COLLAB_STATUS` protocol.
6. Re-run targeted OpenClaw tests and commit.

### Task 5: Runtime Wiring and Verification

**Files:**
- Modify: `../openclaw/docker-compose.local.yml`
- Modify: docs as needed

**Steps:**
1. Add `NANOCLAW_COLLAB_STATE_PATH=/host-nanoclaw-config/collab-state.json` to the OpenClaw local compose override.
2. Run NanoClaw targeted tests, OpenClaw targeted tests, TypeScript checks, and boundary checks.
3. Rebuild/restart only the services affected by the change.
4. Verify slash command registration and gateway health without exposing tokens.
