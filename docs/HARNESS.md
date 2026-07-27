# Instance-Level Customizations (this host only)

This file tracks changes that are **specific to this install's host environment** and
are **not meant to be upstreamed**. They modify core files, so when upstream nanoclaw
updates are brought in (via `/update-nanoclaw` or `/migrate-nanoclaw` — never raw
`git merge`, per the CLAUDE.md banner), each entry here must be **re-applied / verified**.

Tier vocabulary: **core** (upstream-owned source), **module** (skill/branch-installed),
**instance** (this host only — listed below).

---

## 1. OneCLI gateway reachable via OneCLI's bridge IP (Linux/UFW)

- **File:** `src/container-runtime.ts` → `hostGatewayArgs()` (+ helper `resolveOnecliBridgeIp()`)
- **Tier:** instance (host-specific Linux/UFW + OneCLI compose-network isolation)
- **Date:** 2026-06-21 (originally found & fixed 2026-04-18 on the v1 install)

**Problem.** The OneCLI gateway runs on its own compose network (`onecli_onecli`).
Agent containers on the default `bridge` network can't reach it through the published
host port (`host.docker.internal` → `172.17.0.1:10255`): UFW (`INPUT` policy `DROP`) +
`DOCKER-ISOLATION-STAGE-2` drop the container→host-gateway / cross-bridge traffic.
Symptom: agent-runner logs spam `Error: API retry (retryable: true)`; channels show
`EHOSTUNREACH`. (Note: the published port shows as `LISTEN 0.0.0.0:10255` on the host,
so the gateway looks healthy — the break is purely in the container→host path.)

**Fix.** Map `host.docker.internal` to OneCLI's IP on the shared default `bridge`
network instead of the host gateway, so agents talk to OneCLI directly over the bridge
and bypass the host firewall. The helper resolves the IP dynamically
(`docker inspect onecli --format '{{.NetworkSettings.Networks.bridge.IPAddress}}'`),
runs `docker network connect bridge onecli` if OneCLI isn't on the bridge yet, and
falls back to `host-gateway` (with a warning) if it still can't resolve. Self-healing
across reboots / container recreation.

**Re-apply check after an upstream update:**
1. Confirm `hostGatewayArgs()` still maps to the OneCLI bridge IP (not plain `host-gateway`).
2. From a running agent container:
   `docker exec <c> getent hosts host.docker.internal` → should be OneCLI's bridge IP (e.g. `172.17.0.2`), not `172.17.0.1`.
3. Send a real message; confirm no `API retry` spam and a reply is delivered.

See memory `feedback_onecli_bridge` for full history.

---

## 2. Live status-line message disabled

- **File:** `src/modules/status-line/index.ts` → `STATUS_LINE_ENABLED = false`
- **Tier:** instance (owner preference)
- **Date:** 2026-06-21

**Why.** The status-line module posts a live channel message ("💭 작업 중…" /
"🔧 Bash · N초") during a turn and deletes it at turn end. The owner finds it
noisy, and the end-of-turn delete occasionally fails, leaving the message
lingering. The native typing indicator already covers "is it alive?".

**Fix.** `startStatusLine()` early-returns when disabled, so no status message is
ever posted (nothing to leak). Flip `STATUS_LINE_ENABLED` to `true` to restore.
Tests force-enable via `__testHooks.setEnabled(true)` to keep covering the live path.

**Re-apply check after an upstream update:** confirm `STATUS_LINE_ENABLED` is still
`false` (upstream ships it `true` / always-on).

---

## 3. Docker socket passthrough for privileged groups (replay of v1)

- **File:** `src/container-runner.ts` (after the volume-mount loop, before `--entrypoint`)
- **Tier:** instance (host-specific: JH_Server #root needs host Docker control)
- **Date:** 2026-07-01 (regression surfaced live after the v2 re-cutover)

**Problem.** v1's `container-runner.ts` had a Docker-socket passthrough block that v2
never replayed. The `container.json` mounts that bind `/var/run/docker.sock` migrated
fine (data), but the spawn-side code that makes the socket *usable* did not. v2 spawns
the container as `--user ${hostUid}:${hostGid}` (here `1001:1001`) with no membership
in the host `docker` group, so the non-root user can't open the `root:docker 0660`
socket. Symptom (reported live by 재붕봇): "uid 1001, sock group 121 owned 0660,
`DOCKER_HOST` 미주입" → all `docker` CLI calls inside the container hit EACCES. The
`/model` restart (blocker-2 fix) merely cycled the container and surfaced it.

**Fix.** Port the v1 block verbatim: when a mount's basename is `docker.sock`, inject
`DOCKER_HOST=unix://<containerPath>` and `--group-add <sockGid>` (gid from
`fs.statSync(sock).gid` — `121` here) so the container user joins the host docker
group. Adds **no mount of its own** — scope stays governed by which `container.json`
carries the docker.sock mount (JH_Server #root + siblings only; never 붕붕이네, per
memory `project_jh_server_privileged`).

**Re-apply check after an upstream update:**
1. Confirm the `docker.sock` block still exists in `container-runner.ts` after the
   mount loop (upstream ships neither the mount nor this block).
2. From a freshly spawned #root container:
   `docker inspect <c> --format '{{.HostConfig.GroupAdd}}'` → contains `121`, and
   `{{range .Config.Env}}` includes `DOCKER_HOST=unix:///var/run/docker.sock`.
3. `docker exec <c> docker ps` → succeeds (no EACCES).

See memory `project_jh_server_privileged`.

---

## Known bug — NOT yet fixed (deferred)

**`send_file` / `send_message` falsely report success on delivery failure.**
The container's MCP tools return `ok()` the moment they write to `outbound.db`
(`container/agent-runner/src/mcp-tools/core.ts`). Actual platform delivery is async
on the host; any failure (e.g. Discord `413 Request entity too large` for files over
the upload limit, network errors) is retried 3× then dropped — and **never fed back
to the container**, so the agent keeps telling the user "sent!" when nothing arrived.
Acute for files (size limits are common). Proper fix: feed host delivery failures
back as an inbound system message so the agent learns the send failed. Evidence:
`logs/nanoclaw.error.log` 2026-06-21 20:17, msg-1782040642257 (40MB PDF → 413).
