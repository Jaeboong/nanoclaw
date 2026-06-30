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
  the Task 7 framework; the interceptor records Codex turns (inbound) and drives
  Claude turns by injecting a framed prompt as a synthetic inbound message
  (re-uses normal routing for session/gate/typing/wake — no duplicated host
  logic). Claude's own turn is recorded from its delivered output via
  `observeClaudeTurn` (outbound observer) — the v2 analogue of v1's
  `recordClaudeCollabTurnIfNeeded`, so a Claude-initiated DONE/BLOCKED ends the
  session faithfully.
- **Migration:** `src/db/migrations/module-collab-state.ts` — `collab_sessions`
  + `responder_state`, keyed by `messaging_group_id`. Module-owned; additive.
- **Core seams (two, both additive registries beside existing ones):**
  - `router.ts` — additive `registerMessageInterceptor()` registry **alongside**
    the existing single-slot `setMessageInterceptor` (left byte-for-byte
    untouched, so the permissions module's call doesn't conflict on future
    pulls) plus a 3-line loop in `routeInbound` that runs the registered
    interceptors after the single-slot one.
  - `delivery.ts` — additive `registerOutboundObserver()` registry + a
    read-only fire point in `deliverMessage` (after a successful channel
    delivery, before `clearOutbox`). Mirrors the existing `registerDeliveryAction`
    registry idiom. Observers are read-only, wrapped in try/catch, and run
    synchronously (better-sqlite3): a collab turn's `nextAgent` flip commits
    before the delivery returns. Inbound routing is async (fire-and-forget), but
    a peer-bot reply is causally later than the delivery that fires the observer
    (the peer can't reply before the message lands), so it reads the committed
    flip. Fires once per delivered row
    (delivered rows aren't re-drained → no double-count). No Discord/collab
    identifier in core. Both are upstream-PR candidates: a silently-overwriting
    single slot / a missing post-delivery observer hook are generic gaps.
- **Peer-bot ingestion (resolved, was the open blocker):** the collab loop needs
  나붕봇's (a bot's) messages to reach the interceptor. The Chat SDK's
  webhook-forward gateway mode (v2 default — `chat-sdk-bridge.ts` starts a local
  webhook server and passes `webhookUrl` to `startGatewayListener`) forwards bot
  messages, and the SDK's `handleIncomingMessage` filters only `isMe` (self),
  not `isBot`. So the peer bot is ingested while Claude's own output does **not**
  loop back as inbound (recorded via the outbound observer instead). The *legacy*
  gateway path drops all bot messages — collab depends on webhook-forward mode.
- **Known divergence / fidelity gaps (deliberate):**
  - *Claude must end its turn with a `COLLAB_STATUS` line.* The agent writes one
    `messages_out` row per `<message to="">` block, so a turn can span rows;
    `observeClaudeTurn` records on the status-bearing row (guarded on
    `hasExplicitCollabTurnStatus`) rather than defaulting the first row to
    CONTINUE — this avoids missing a late DONE/BLOCKED. Cost vs v1: if Claude
    omits the protocol line entirely the turn won't auto-record (v1's
    final-result path would default it to CONTINUE). The turn prompt mandates
    exactly one such line, so this is an error-path-only divergence.
  - *Accumulate gap.* When the interceptor consumes a message (responder=codex,
    or non-protocol chatter during Codex's turn) it returns true, so the message
    is not stored as trigger=0 context. Benign for collab (each agent sees the
    preceding turn via the injected prompt).
  - *Channel-level only.* Collab injects at the channel (threadId from the peer
    turn / null at kickoff); thread-scoped collab collapses to the channel.
  - *otherBotMention suppression dropped* — v2 inbound carries no
    `mentioned_bot_ids`; responder=codex covers the same intent explicitly.

## Worked example — background spawn_subagent (Task 15)

Long, slow work (deploys, big research) run in a SEPARATE isolated container that
survives the parent's turn and posts its result back to the origin channel — the
v2 port of the v1 fork's `spawn_subagent`. Distinct from the SDK-native Agent/Task
tool (in-process sub-agents that die with the parent container): only this gives a
detached, survives-parent worker.

- **Module:** `src/modules/background-spawn/` — `handler.ts`
  (`handleSpawnSubagent`), `index.ts` (`registerDeliveryAction('spawn_subagent')`).
  Container tool: `container/agent-runner/src/mcp-tools/background-spawn.ts`
  (`spawn_subagent(prompt)` writes a `kind='system'` `{action:'spawn_subagent'}`
  outbound row).
- **Core seams used (no new seam, no inline edit):** the existing
  `registerDeliveryAction` registry routes the system action to the module; the
  handler composes existing primitives only — `createSession`,
  `initSessionFolder`, `writeSessionMessage`, `wakeContainer`, `getMessagingGroup`,
  `getSessionsByAgentGroup`, `updateSession`.
- **Core touches (ledger):** two side-effect imports only —
  `src/modules/index.ts` (+1) and `container/agent-runner/src/mcp-tools/index.ts`
  (+1). No core logic edited.
- **Routing-collision avoidance (the load-bearing design):** the worker session
  reuses the parent's `agent_group_id` but sets `messaging_group_id = NULL`, so
  `findSessionForAgent(agent, channel, thread)` never matches it — the parent
  keeps owning the channel's inbound. The task is injected as an inbound stamped
  with the origin channel routing + the parent's thread, so the worker's reply
  resolves (via `resolveDestinationThread`, reading the inbound) to the origin
  channel/thread. Authorization + addressability to the origin both ride the
  channel's `agent_destinations` wiring row (shared agent_group) — `delivery.ts`
  ACL passes via that row since `isOriginChat` is false for a `mg=null` session.
  Proven end-to-end without a live container by `spawn-pattern.test.ts`.
- **Lifecycle:** the worker stays `active` (the 60s sweep is its reliable delivery
  safety net; re-drains are idempotent). Finished workers (container exited) are
  reaped to `closed` on the next spawn, guarded by a `created_at` age check so a
  concurrent spawn can't reap a still-booting sibling.
- **Known gaps (deliberate / deferred):**
  - *Cross-group targeting dropped* — v1's `spawn_subagent(target_jid)` could aim
    another group; v2 always runs the worker against the parent's own
    agent_group + origin channel (self-scoped, simpler, no ACL surface).
  - *A lone never-followed-up worker lingers as `active`* until the next spawn
    reaps it — harmless (idempotent re-sweep, `mg=null` so no inbound routes to
    it), just untidy.
  - *No concurrency bound (real regression vs v1, deferred system-wide).* The
    handler wakes the worker unconditionally — the same as every other v2 wake
    path (router, host-sweep, scheduling, …). NB: v2 has **no** global container
    cap today (`MAX_CONCURRENT_CONTAINERS` is declared but never read), so this
    matches the rest of the system, **but** `spawn_subagent` is the one
    *agent-controllable* trigger — an agent can emit N spawns in a single turn,
    whereas other triggers are externally rate-limited (one per message / tick /
    approval). v1 gated this via `GroupQueue.enqueueParallelTask`. A real but
    non-blocking gap: a module-local gate is useless (the sweep re-wakes with no
    check), so the fix is a core concurrency gate inside `wakeContainer`/the
    sweep touching all callers — a system-wide follow-up, not an additive
    per-module change.

## Worked example — /compact-everywhere (Task 10)

Uniform `/compact` in **every** channel. v2 dispatches a typed `/compact` only
where the chat message engages — is_main channels (engage_mode `pattern='.'`)
and admin-gated typed commands. In the mention/pattern sub-channels a bare typed
`/compact` is dropped by `evaluateEngage` before it reaches a session. This
module exposes `/compact` as a Discord-native **slash command**, which is
delivered over the gateway-forward interaction path and never touches
`routeInbound`/`evaluateEngage`, so engage_mode is structurally irrelevant.

- **Module:** `src/modules/compact-everywhere/` — `index.ts`
  (`handleCompactEverywhere` + `registerSlashCommand('compact', …)`),
  `index.test.ts` (6 behaviour tests on the real DB layer, I/O boundaries
  mocked).
- **Core seams used (no new seam, no inline edit):** the existing Task 7
  `registerSlashCommand` registry (`requireAdmin: true`, `deferred: true`); the
  handler composes existing primitives only — `getMessagingGroupByPlatform`,
  `getMessagingGroupAgents`, `findSessionForAgent`, `getSession`,
  `writeSessionMessage`, `wakeContainer`.
- **Core touches (ledger):** one side-effect import only — `src/modules/index.ts`
  (+1, `import './compact-everywhere/index.js';`). No core logic edited.
- **Authorization (two layers):** `requireAdmin: true` makes `handleSlash`
  enforce `isAdmin` *before* the handler runs — but that framework gate resolves
  only the channel's **top-priority** agent (`getMessagingGroupAgents(mg.id)[0]`,
  `ORDER BY priority DESC`). Because this command fans out to **every** wired
  agent, the handler **re-checks `isAdmin(inv.userId, agent.agent_group_id)` per
  agent** inside the loop and skips agents the caller isn't admin of — matching
  the per-agent model the typed-command path enforces via `gateCommand` (which
  this session-targeted path deliberately bypasses). A global owner/admin
  (`agent_group_id IS NULL`) passes every check; the framework's single-agent
  pre-gate means a *scoped* admin of a non-top-priority agent is denied entry
  (a benign framework-tier quirk shared by all `requireAdmin` slashes). Net: no
  over-grant (the per-agent re-check is authoritative), enforced pre-inject.
- **Inject (session-targeted, bypasses engage):** resolve the channel's LIVE
  session with the non-creating `findSessionForAgent` (NOT `resolveSession`,
  which would spin up an empty session and leak a wake just to compact nothing),
  then `writeSessionMessage({text:'/compact'}, trigger:1)` stamped with the
  origin routing + `wakeContainer`. Warm container: the poll loop sees
  `isRunnerCommand`, ends the stream, and the outer loop re-dispatches `/compact`
  as a fresh query's first input (native SDK compaction). Mirrors
  background-spawn / agent-to-agent.
- **Known gaps (deliberate / deferred):**
  - *Channel-root only.* A slash invoked inside a Discord thread carries the
    thread id as `channel_id`, so `platformId` becomes `discord:{guild}:{thread}`
    and matches no messaging group → the command reports "not wired". Full
    per-thread coverage needs extending the Task 7 `RawDiscordInteraction` shape
    to read `channel.parent_id` + `channel.type` — a core seam touch beyond this
    module's +1-import budget. Invoke `/compact` from the channel root.
  - *Native-provider only.* `/compact` compacts only on a provider whose runner
    treats it as a native slash command (claude); a non-native session degrades
    to a silent container-side no-op. Not exercised in this fork — all wired
    agent sessions are Claude (codex is only a collab peer, never a wired
    session).
  - *Upstream ack defect (out of scope, see `docs/upstream/compact-boundary-misclassification.md`).*
    After compaction the SDK's `compact_boundary` is mapped to a `result`-with-text
    event, which `dispatchResultText` treats as a failed unwrapped agent turn:
    the "Context compacted" confirmation is swallowed and a spurious "response not
    delivered" nudge is pushed to the agent. This is in **upstream-core**
    (`claude.ts`/`poll-loop.ts`, byte-identical to `upstream/main`), so it is
    reported upstream rather than fork-patched. `/compact-everywhere`'s own
    ephemeral slash reply ("압축을 요청했습니다") is unaffected — it confirms the
    request landed regardless of the in-container ack defect.

## Worked example — agent-activity panel (Task 11)

Interactive Discord panel (`/agents`) showing live agent work-activity: which
sessions are active, which containers are live, and the tool each is running
right now. **First consumer of the Task 7 `registerComponentHandler` seam.**
Jira/GitLab dropped (the v1 "work-ledger" was a Jira/GitLab console — out, same
call as the Grafana webhook in `docs/webhook-ingress-grafana.md`).

- **Module:** `src/modules/agent-activity/` — `index.ts` (slash `/agents` + two
  component handlers `work:refresh` / `work:details`, each admin self-gating),
  `snapshot.ts` (liveness-gated N+1 read assembling
  `{agentName, sessionId, chat, currentTool, elapsed, status}` from
  `getActiveSessions` + `isContainerRunning` + `getContainerState`),
  `render.ts` (pure summary/compact/detail text, budget-clamped). Additive,
  owns no tables, reads only existing DBs.
- **Core seam (one, generic, in the bridge):** `chat-sdk-bridge.ts` — the
  `content.type === 'card'` deliver() branch now renders a callback
  `Button({id,label,value:id})` for a card action that carries an `id` (no
  `url`), beside the existing `LinkButton` (url) path. Generic (no
  fork/Discord/`work:` identifier — renders whatever id it's given, knows no
  prefixes), ~12 lines, reuses the `Card`/`Button`/`Actions` builders already
  imported (the `ncq:` branch uses them). Same file + same seam tier as Task 7's
  `setForwardedInteractionRouter`. Upstream-PR candidate: before Task 7 a
  non-URL action button had nowhere to land; after Task 7 it does, so
  `send_card`-style posts can finally carry one. (Added two type-only imports —
  `ButtonElement`, `LinkButtonElement` — to type the mixed button array, because
  `ReturnType<typeof Button>` resolves to the overload's `ChatElement`.)
- **Core touches (ledger):** one side-effect import — `src/modules/index.ts`
  (+1) — plus the one bridge-card-action seam above. No other core edit.
- **Authorization — GLOBAL owner/admin (not channel-scoped):** the snapshot is
  `getActiveSessions` (global, across ALL agent groups), so every entry point —
  the slash handler and both component handlers — gates on
  `isAdmin(inv.userId, null)` (a `user_roles` row with `agent_group_id IS NULL`).
  `requireAdmin: true` on the slash is a framework pre-filter (channel-scoped);
  the explicit null-gate is authoritative and also covers the component handlers,
  which the framework leaves UNGATED (the known Task 7 gap). A channel-scoped
  admin is denied — this is a global ops view, not a per-channel one. (Review
  found the original channel-agent gate leaked cross-agent telemetry to a scoped
  admin; the global gate closes it and lets the copied `resolveAgentGroupId`
  helper be deleted.)
- **Refresh model — ephemeral views, NOT in-place edit (load-bearing, verified
  against `@chat-adapter/discord@4.26.0`):** a card always renders as message
  `content` (`cardToFallbackText`) + an embed + a component row, and
  `ComponentResult.update` can only PATCH `content`, never the embed. So a
  button cannot refresh the embedded snapshot in place. The public card is
  therefore a compact at-post-time **summary** (header + counts), and the
  buttons deliver the live per-session detail as **ephemeral followups** (plain
  content — no embed, no duplication, no stale board). Re-run `/agents` for a
  fresh public summary.
- **Known gaps (deliberate / deferred):**
  - *No live in-place public board.* Updating the public embed on a click needs
    a SECOND core seam — extend `ComponentResult.update` + `handleComponent` to
    carry an embed/card payload (and re-render it). Deferred to a future task
    that owns that seam; out of this module's one-seam budget.
  - *No per-session control (stop/pause/select).* A session-keyed control set
    must change as the session list changes, which needs `ComponentResult` to
    SET a new components array (Task 7 cannot — `handleComponent` only clears
    components). Same second-seam dependency; deferred. Task 11 is a read-only
    viewer.
  - *Stale `container_state` defended, not fixed.* `container_state` is never
    cleared on container crash/kill; the snapshot gates every tool read on
    `isContainerRunning`, so a dead container shows `⚫ 중지됨`, not a phantom
    tool. The underlying stale row is a v2 issue this module works around.

## Worked example — colored section embeds (outbound rendering)

The v1 fork rendered every agent reply as colored Discord embed boxes, split on
Korean `## 분석/결론/주의/질문/로그` section headers (green/blue/red/yellow/gray,
white default), with markdown pipe tables rendered to PNG embeds and a tool/
timing/model footer. v2 dropped it: the normal-message path posts plain
markdown, and the cross-platform card path is the only embed route —
`@chat-adapter/discord`'s `cardToDiscordPayload` **hard-codes** `embed.color =
5793266` and always returns exactly **one** embed, so it cannot express N
differently-colored section boxes. The adapter is `node_modules` (unpatchable).

- **Module:** `src/channels/discord-features/` (beside the table-render port) —
  `section-embeds.ts` (pure: `parseSections` + `buildSectionEmbeds` → plain
  Discord-REST `APIEmbed[]` + PNG attachments, reusing `table-render.ts`),
  `section-rest.ts` (minimal Discord REST poster, multipart for PNGs, 10-embed
  chunking, degrades to null on token-missing/HTTP-error/rate-limit),
  `section-outbound.ts` (the `deliverRichMessage` hook: encoded-thread-id →
  channel snowflake, render, post, fall back on any failure). Tests:
  `section-embeds.test.ts` (25 cases, ported from v1) + `section-outbound.test.ts`
  (seam branch coverage — handled / non-Discord / blank / REST-failure / throw).
- **Core seam (one, generic, additive):** `chat-sdk-bridge.ts` gains an optional
  `deliverRichMessage?({threadId,text,files}) => {handled, messageId?}` config
  field + a 4-line branch at the top of the normal-message path: tried before
  the markdown delivery; `{handled:true}` returns its id, `{handled:false}` (no
  rich content **or** a delivery failure to fall back from) continues to the
  unchanged markdown+`transformOutboundMessage` path. Discord-free, platform-
  agnostic — any adapter that can emit native rich payloads the card abstraction
  can't express is a consumer. **Upstream-PR candidate.**
- **Wiring:** `src/channels/discord.ts` (a fork/skill file) passes
  `deliverRichMessage: (msg) => deliverSectionEmbeds(msg)`. The existing
  `transformOutboundMessage: renderOutboundTables` stays as the **fallback**
  table renderer for when rich delivery no-ops/fails.
- **Token:** reuses the adapter's `DISCORD_BOT_TOKEN` (read via `readEnvFile`);
  no new credential.
- **Integration guards:** (a) embeds are chunked under BOTH the 10-per-message
  and Discord's 6000-char aggregate-text caps, so long multi-section replies
  split into multiple messages instead of being silently rejected → markdown.
  (b) Because replies now carry empty message `content` (text lives in the embed
  description), `discord.ts extractReplyContext` falls back to the embed
  description (ported `extractEmbedText`) so quoting a reply isn't blanked —
  matches v1. Collab bookkeeping is unaffected: 재붕봇's own turn is recorded
  from the raw outbound row (pre-delivery), and peer (Codex) turns come from the
  peer's own non-embed messages.
- **Known gaps (deliberate / deferred):**
  - *Footer degrades to nothing today.* `buildSectionEmbeds` accepts optional
    `SectionMetadata` (tool counts / elapsed / model) but the v2 outbound path
    does not yet plumb it, so the footer is simply omitted. Wiring the metadata
    source is a separate follow-up; the renderer is ready for it.
  - *Bypasses the adapter's bookkeeping.* The REST post is outside the chat
    adapter, so adapter-level message state isn't updated; the bridge still
    returns the real message id for `outbound.db`. Acceptable for fire-and-post
    replies; not used for editable/streamed messages (those keep their paths).
  - *Live Discord verification is post-cutover only* (same bot token as v1 —
    can't run both gateways at once); covered by host tsc + vitest until then.
