# Upstream-merge discipline (harness rule)

> Fork-only doc (not in `upstream/main`). It exists so that **future `git pull`
> from upstream stays a clean, low-conflict merge** — the prime directive of
> this fork. Read it before adding ANY custom feature.

## Why this exists

This fork tracks `upstream/main` (NanoClaw v2). The original divergence (a v1
fork, 998 commits behind, different architecture) forced a one-time **replay**
onto v2. That cost is paid once. From here on, the goal is the opposite of
divergence: **every custom feature must be shaped so that pulling upstream
never (or barely) conflicts with it.**

Divergence cost is paid at every future merge, by a human resolving conflicts.
A custom feature that edits upstream-core logic taxes every upstream pull
forever. A custom feature that lives in its own module and touches core only
through a generic seam costs nothing at merge time.

## The rule

1. **Custom features are ADDITIVE modules.** New files under `src/modules/`,
   `src/channels/<channel>-*.ts`, `container/skills/`, or `setup/` — never
   inline edits to upstream core logic. A new file can't conflict with an
   upstream change.

2. **Touch upstream core only through a seam, and only minimally.** If the
   feature must hook into core, use (in order of preference):
   - an **existing** upstream registry/hook — `registerChannelAdapter`,
     `registerDeliveryAction`, `setSenderResolver`, `setAccessGate`,
     `setMessageInterceptor`, `registerResponseHandler`, the command-gate, …;
   - failing that, add a **new generic seam** to core in the same `setX(fn)` /
     `registerX(fn)` style upstream already uses (e.g.
     `setForwardedInteractionRouter` in `chat-sdk-bridge.ts`). Keep it generic
     (no fork-specific names/imports in core) so it reads like an upstream
     primitive — and could be sent upstream as a PR.
   - The module wires itself in via a **side-effect import** (one line in the
     channel/module entry). The allowed core delta is the seam declaration plus
     that import — not custom branching logic.

3. **Never put feature logic in core.** Core calls the seam; the module owns
   the behavior. If you find yourself adding an `if (isOurFeature)` branch to an
   upstream function, stop and turn it into a seam + module instead.

4. **Record every upstream-core edit in the divergence ledger.** Any change to
   a file that exists in `upstream/main` goes in the ledger (see
   `project_v2_migration_progress` memory) with one line on what and why. The
   ledger is the merge-cost budget; keep it short and justified.

5. **Prefer upstreaming.** A generic seam that helps any adapter is a candidate
   PR to upstream. Once merged upstream, our delta drops to zero.

## Checklist for a new custom feature

- [ ] Lives in its own file(s); no upstream-core logic edited.
- [ ] If core is touched: it's a generic `setX`/`registerX` seam + a one-line
      side-effect import, nothing more.
- [ ] No fork-specific identifier appears in an upstream-core file.
- [ ] `git diff upstream/main --stat` shows new files, not sprawling core edits.
- [ ] Divergence ledger updated if any `upstream/main` file changed.
- [ ] `npm run check:boundaries` clean (no personal data leaking to git).

## Worked example — slash/interaction framework (Task 7)

- **Module:** `src/channels/discord-interactions.ts` — the whole registry,
  dispatch, auth, REST registration, and Discord callback HTTP. Additive; zero
  merge risk.
- **Core seam:** `chat-sdk-bridge.ts` gains `setForwardedInteractionRouter()`
  (generic, Discord-free) + one `if (router && await router(...)) return;` call.
  That's the entire core delta beyond a correctness fix (gating the existing
  `ncq:` branch on its prefix). `command-gate.ts` exports `isAdmin` (one
  keyword) so module auth matches typed-command auth by construction.
- **Wiring:** `src/channels/discord.ts` (already a fork/skill file) calls
  `setForwardedInteractionRouter(routeForwardedInteraction)` and fires REST
  registration — a few lines in a non-core file.

## Worked example — collab + responder (Task 9)

재붕봇(Claude)↔나붕봇(Codex) bounded collaboration and the per-channel
responder toggle. The two bots are separate Discord identities, so they hand
off via channel messages (Claude's turn is host-injected; Codex's is observed).

- **Module:** `src/modules/collab/` — `state.ts` (pure state machine, ported
  from the v1 fork), `responder.ts` (pure), `db.ts` (module-owned tables),
  `index.ts` (slash commands + router interceptor). Slash commands register via
  the Task 7 framework; the interceptor records Codex turns and drives Claude
  turns by injecting a framed prompt as a synthetic inbound message (re-uses
  normal routing for session/gate/typing/wake — no duplicated host logic).
- **Migration:** `src/db/migrations/module-collab-state.ts` — `collab_sessions`
  + `responder_state`, keyed by `messaging_group_id`. Module-owned; additive.
- **Core seam:** `router.ts` gains an additive `registerMessageInterceptor()`
  registry **alongside** the existing single-slot `setMessageInterceptor` (left
  byte-for-byte untouched, so the permissions module's call doesn't conflict on
  future pulls) plus a 3-line loop in `routeInbound` that runs the registered
  interceptors after the single-slot one. Upstream-PR candidate: a
  silently-overwriting single slot is a latent bug the moment a second module
  wants the hook. No Discord/collab identifier in core.
- **Known divergence / fidelity gaps (deliberate):**
  - *Claude DONE/BLOCKED not captured.* "flip-on-dispatch" models Claude's turn
    as an assumed CONTINUE (round++/next→codex) so alternation and round-counting
    stay correct without observing Claude's outbound. A Claude-initiated DONE
    therefore doesn't end the session early — it runs to max-rounds (bounded).
    Capturing it needs an outbound observer seam or a container-reported signal;
    deferred as a separate decision.
  - *Accumulate gap.* When the interceptor consumes a message (responder=codex,
    or non-protocol chatter during Codex's turn) it returns true, so the message
    is not stored as trigger=0 context. Benign for collab (each agent sees the
    preceding turn via the injected prompt).
  - *Channel-level only.* Collab injects at the channel (threadId from the peer
    turn / null at kickoff); thread-scoped collab collapses to the channel.
  - *otherBotMention suppression dropped* — v2 inbound carries no
    `mentioned_bot_ids`; responder=codex covers the same intent explicitly.
