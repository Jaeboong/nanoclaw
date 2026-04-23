#!/usr/bin/env bash
# Interactive shell inside the agent container with the real bot's mounts/env.
#
# Inside the container:
#   cd /workspace/group && claude                     # fresh session
#   cd /workspace/group && claude --resume <id>       # resume Discord session
#   ls /home/node/.claude/projects/-workspace-group/  # list session ids
#
# Usage:
#   ./scripts/dev-shell.sh                # defaults to discord_main
#   ./scripts/dev-shell.sh discord_be

set -euo pipefail

GROUP="${1:-discord_main}"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

if [[ ! -f .env ]]; then
  echo "error: .env not found at $PROJECT_ROOT/.env" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

IMAGE="${CONTAINER_IMAGE:-nanoclaw-agent:latest}"
TZ_VAL="${TZ:-$(cat /etc/timezone 2>/dev/null || echo UTC)}"

# Pull the group row (is_main + additional mounts) from SQLite via better-sqlite3.
GROUP_JSON=$(node -e "
  const Database = require('$PROJECT_ROOT/node_modules/better-sqlite3');
  const db = new Database('$PROJECT_ROOT/store/messages.db', {readonly:true});
  const row = db.prepare('SELECT folder, is_main, container_config FROM registered_groups WHERE folder = ?').get('$GROUP');
  if (!row) { console.error('group not found: $GROUP'); process.exit(2); }
  process.stdout.write(JSON.stringify(row));
")
IS_MAIN=$(node -e "console.log(JSON.parse(process.argv[1]).is_main ? 1 : 0)" "$GROUP_JSON")

GROUP_DIR="$PROJECT_ROOT/groups/$GROUP"
SESSIONS_DIR="$PROJECT_ROOT/data/sessions/$GROUP"
CLAUDE_DIR="$SESSIONS_DIR/.claude"
AGENT_RUNNER_DIR="$SESSIONS_DIR/agent-runner-src"
IPC_DIR="$PROJECT_ROOT/data/ipc/$GROUP"

mkdir -p "$CLAUDE_DIR" "$IPC_DIR/messages" "$IPC_DIR/tasks" "$IPC_DIR/input"

if [[ ! -d "$AGENT_RUNNER_DIR" ]]; then
  cp -r "$PROJECT_ROOT/container/agent-runner/src" "$AGENT_RUNNER_DIR"
fi

NAME="nanoclaw-dev-${GROUP//[^a-zA-Z0-9-]/-}-$$"

ARGS=(run --rm -it --name "$NAME" --entrypoint /bin/bash)
ARGS+=(-e "TZ=$TZ_VAL")

# Mirror production user mapping: if host uid != 0 and != 1000, map into container
HOST_UID=$(id -u)
HOST_GID=$(id -g)
if [[ "$HOST_UID" != "0" && "$HOST_UID" != "1000" ]]; then
  ARGS+=(--user "$HOST_UID:$HOST_GID" -e "HOME=/home/node")
fi

# OneCLI gateway env (credential injection) — graceful degrade if unreachable.
ONECLI_ARGS=$(node -e "
  const {OneCLI} = require('$PROJECT_ROOT/node_modules/@onecli-sh/sdk');
  const c = new OneCLI({url: process.env.ONECLI_URL, apiKey: process.env.ONECLI_API_KEY});
  const args = [];
  (async () => {
    const ok = await c.applyContainerConfig(args, {addHostMapping: false});
    if (!ok) process.stderr.write('warn: OneCLI unreachable; container will have no credentials\n');
    process.stdout.write(JSON.stringify(args));
  })().catch(e => { process.stderr.write('warn: OneCLI error: ' + e.message + '\n'); process.stdout.write('[]'); });
")
while IFS= read -r arg; do
  [[ -n "$arg" ]] && ARGS+=("$arg")
done < <(node -e "console.log(JSON.parse(process.argv[1]).join('\n'))" "$ONECLI_ARGS")

# Runtime host gateway (Linux docker)
ARGS+=(--add-host "host.docker.internal:host-gateway")

# --- Mounts (mirror buildVolumeMounts in src/container-runner.ts) ---
if [[ "$IS_MAIN" == "1" ]]; then
  ARGS+=(-v "$PROJECT_ROOT:/workspace/project:ro")
  [[ -f "$PROJECT_ROOT/.env" ]] && ARGS+=(-v "/dev/null:/workspace/project/.env:ro")
  ARGS+=(-v "$PROJECT_ROOT/store:/workspace/project/store")
  ARGS+=(-v "$GROUP_DIR:/workspace/group")
  [[ -d "$PROJECT_ROOT/groups/global" ]] && ARGS+=(-v "$PROJECT_ROOT/groups/global:/workspace/global")
else
  ARGS+=(-v "$GROUP_DIR:/workspace/group")
  [[ -d "$PROJECT_ROOT/groups/global" ]] && ARGS+=(-v "$PROJECT_ROOT/groups/global:/workspace/global:ro")
fi

ARGS+=(-v "$CLAUDE_DIR:/home/node/.claude")
ARGS+=(-v "$IPC_DIR:/workspace/ipc")
ARGS+=(-v "$AGENT_RUNNER_DIR:/app/src")

# Additional mounts from container_config (all land under /workspace/extra/<name>)
DOCKER_SOCK_HOST=""
while IFS=$'\t' read -r HP CP RO; do
  [[ -z "$HP" ]] && continue
  FLAG="$HP:/workspace/extra/$CP"
  [[ "$RO" == "true" ]] && FLAG="$FLAG:ro"
  ARGS+=(-v "$FLAG")
  [[ "$(basename "$HP")" == "docker.sock" ]] && DOCKER_SOCK_HOST="$HP"
done < <(node -e "
  const cfg = JSON.parse(process.argv[1]).container_config;
  if (!cfg) process.exit(0);
  const parsed = JSON.parse(cfg);
  for (const m of parsed.additionalMounts || []) {
    process.stdout.write(m.hostPath + '\t' + m.containerPath + '\t' + (m.readonly ? 'true' : 'false') + '\n');
  }
" "$GROUP_JSON")

# Docker socket passthrough
if [[ -n "$DOCKER_SOCK_HOST" ]]; then
  ARGS+=(-e "DOCKER_HOST=unix:///workspace/extra/docker.sock")
  SOCK_GID=$(stat -c '%g' "$DOCKER_SOCK_HOST")
  ARGS+=(--group-add "$SOCK_GID")
fi

ARGS+=("$IMAGE")
# Motd + drop into bash
ARGS+=(-c 'cat <<"EOF"
╭─────────────────────────────────────────────────────────────╮
│  NanoClaw dev-shell: '"$GROUP"'
│  cd /workspace/group && claude              # fresh
│  cd /workspace/group && claude --resume ID  # resume Discord
│  ls ~/.claude/projects/-workspace-group/    # list session ids
╰─────────────────────────────────────────────────────────────╯
EOF
exec bash')

exec docker "${ARGS[@]}"
