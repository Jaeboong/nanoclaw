# Webhook ingress (Grafana alerts) — design for a later v2 attach

**Status:** design note, **not implemented**. The v1 Grafana/GitLab webhook
ingress is intentionally **not ported** to v2 — it is coupled to a specific
external stack (Grafana + GitLab + Jira) this instance is dropping. This doc
captures what v1 did and the clean, additive way to re-attach a Grafana (or any
external) alert feed to v2 *when* it's wanted, so the future hookup is thin and
nothing is lost by not porting now.

## What v1 did (for the record)

A single self-contained file, `src/webhook-server.ts`, exporting
`startWebhookServer(opts)`:

- Plain Node `http.createServer` bound to `0.0.0.0:WEBHOOK_PORT` (default 8090;
  the live deploy used 10257). Started from `index.ts` **only** when
  `WEBHOOK_TOKEN` + `WEBHOOK_GRAFANA_JID` were set (opt-in; skipped otherwise).
- Two POST routes:
  - `POST /grafana-alert` — auth `?token=` (constant-time vs `WEBHOOK_TOKEN`).
    Body = Grafana alert payload `{status, alerts:[{labels{alertname}, annotations
    {summary,description}, valueString, startsAt, endsAt, generatorURL}]}`.
    `formatGrafanaAlert` rendered it to Korean markdown with an instruction line
    ("원인 추정 + 영향 범위 + 권장 대응을 보고해라", or a short ack if resolved).
  - `POST /gitlab-webhook` — auth `X-Gitlab-Token`/`?token=` vs
    `WEBHOOK_GITLAB_SECRET`. In production this did **not** inject a chat message;
    it built Jira suggestions and refreshed a Discord pin (`onGitlabEvent`). The
    synthetic-message path was only a crash fallback. This half is GitLab/Jira
    business logic, not a generic ingress.
- **Injection (the reusable core):** the formatted Grafana text was stored as a
  synthetic `messages` row via `storeMessage(...)` — prefixed with the bot
  trigger and `is_from_me=true` so it passed the v1 message-loop trigger gate and
  bypassed the sender allowlist. The polling loop then woke the agent in the
  `WEBHOOK_GRAFANA_JID` Discord channel.
- **Load-bearing precondition:** the target JID had to be a **registered group**
  owned by the Discord channel. If not registered, every alert was silently
  dropped.
- No rate limiting, no dedup (a retried alert double-fired). 256KB body cap.

## Why not port it as-is

- The GitLab/Jira side-channel is instance-specific business logic, not a generic
  capability.
- v2 **already has** a `src/webhook-server.ts`, but it is a *different* feature —
  the Chat SDK adapter webhook router on `:3000` (`/webhook/{adapterName}`).
  A new alert ingress must **not** overwrite or mount onto it. (Its port is
  `WEBHOOK_PORT`, default 3000 — distinct from the `INGRESS_PORT` below.)
- v2's intake model is session/thread-based (`messaging_groups`/`agent_groups`,
  `src/db/sessions.ts`), with no `storeMessage`/`registered_groups`. The v1 inject
  primitive does not exist; the inject must be rebuilt against v2 seams.

## Recommended v2 attach (additive module, when wanted)

A new module `src/modules/webhook-ingress/` that owns **its own** HTTP server on
**its own** port, with zero core logic edited and one ledgered barrel import —
the same shape as background-spawn / collab.

```
src/modules/webhook-ingress/
  config.ts   — env: INGRESS_PORT (own port, NOT WEBHOOK_PORT — that's the
                Chat-SDK server), WEBHOOK_TOKEN, and the target channel mapping
                (see "channel mapping" below) + WEBHOOK_SENDER_ID. isConfigured()
                gates start (opt-in, like v1).
  format.ts   — formatGrafanaAlert(payload) → markdown (port verbatim from v1).
  inject.ts   — injectInbound({channelType, platformId, threadId, text, sender,
                senderId, isMention}) builds an InboundEvent and calls
                routeInbound() — the collab `injectCollabPrompt` pattern.
  server.ts   — startIngressServer(opts): http.createServer, POST /grafana-alert,
                constant-time ?token= auth, 256KB cap, JSON parse → inject.
  index.ts    — onDeliveryAdapterReady(() => { if (isConfigured()) server =
                startIngressServer(...) }); onShutdown(() => server?.close()).
                NEVER listen() at import top-level (the modules barrel loads in
                tests). +1 line in src/modules/index.ts is the only core touch.
```

**Lifecycle seams (existing, no new core):** start the server inside
`onDeliveryAdapterReady` (the de-facto boot signal, as `approvals/index.ts`
does), stop it in `onShutdown`. Request → agent via the upstream-existing
`routeInbound(InboundEvent)` — no new seam needed.

### ⚠ The load-bearing piece — the access gate / `senderId`

This is the part most likely to silently fail, and the v2 reincarnation of v1's
"silently dropped if not registered". `routeInbound` applies the permissions
module's **access gate** (`canAccessAgentGroup`, `src/modules/permissions/access.ts`):
a message whose resolved `userId` is **not** owner / global-admin /
admin-of-group / member is **dropped** (`engages && !accessOk` → no delivery, a
`dropped_messages` row, no error). A synthetic alert has no human sender, so:

- The injected event's content must carry a `senderId` that is an **authorized
  user** of the target agent group — set a configured `WEBHOOK_SENDER_ID` to the
  operator's owner id (`discord:{ownerSnowflake}`), exactly as collab passes the
  session-starter's admin id. This is the v2 analog of v1's `is_from_me` bypass.
- Validate early: at start, if `user_roles` exists and `WEBHOOK_SENDER_ID` is not
  owner/admin (core `isAdmin` is a cheap proxy), **log a loud warning** — that is
  the only pre-cutover signal that the config is wrong. Also `log.warn` when the
  target `platformId` resolves to no messaging group or an unwired group.
- Note: background-spawn/agent-to-agent use `senderId:'system'` and get away with
  it **only because** they inject via the session-targeted `writeSessionMessage`
  path, which bypasses `routeInbound` and the gate. An alert *should* engage like
  a normal channel message, so `routeInbound` (gate applies) is the right
  semantic — hence the configured owner id is required.

### Channel mapping (v1 `dc:` JID → v2)

v1 used `WEBHOOK_GRAFANA_JID = dc:{channelId}`. v2 addresses by `channelType` +
`platformId`. The monitoring channel becomes `channelType='discord'`,
`platformId='discord:{guildId}:{channelId}'`. Provide it via env (e.g.
`WEBHOOK_GRAFANA_PLATFORM_ID`). The monitoring channel (`main_log`) is is_main →
engage `pattern='.'`, so the injected alert engages with no trigger-prefix hack
needed; set `isMention:true` on the event anyway for mention-mode safety and to
allow auto-create if the group is missing.

### Scope / parity calls

- **GitLab path: out.** Jira/pin coupling is instance-specific; not a generic
  ingress concern.
- **Dedup/idempotency: out (parity).** v1 had none; add later only if Grafana
  retry storms become a real problem (fingerprint the alert).
- **Bind host:** v1 used `0.0.0.0` behind a firewall/the ops stack. Decide
  loopback vs `0.0.0.0` based on where Grafana posts from; keep it configurable.

## Effort to attach later

Small: port `formatGrafanaAlert` verbatim, write the four thin files above, add
the `WEBHOOK_SENDER_ID` + `WEBHOOK_GRAFANA_PLATFORM_ID` env, +1 barrel import,
ledger it. The only non-mechanical decision is the authorized `senderId` — which
this doc has already settled.
