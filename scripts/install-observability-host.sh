#!/usr/bin/env bash
set -euo pipefail

SRC_DIR="${SRC_DIR:-/home/ubuntu/nanoclaw/ops/observability-host}"
DST_DIR="${DST_DIR:-/home/ubuntu/observability}"
NANO_ENV="${NANO_ENV:-/home/ubuntu/nanoclaw/.env}"
SKIP_DASHBOARD_DOWNLOAD="${SKIP_DASHBOARD_DOWNLOAD:-0}"

if [[ ! -f "$NANO_ENV" ]]; then
  echo "missing $NANO_ENV" >&2
  exit 1
fi

WEBHOOK_TOKEN="$(awk -F= '$1=="WEBHOOK_TOKEN"{print substr($0, index($0, "=") + 1)}' "$NANO_ENV" | tail -n 1)"
if [[ -z "$WEBHOOK_TOKEN" ]]; then
  echo "WEBHOOK_TOKEN not found in $NANO_ENV" >&2
  exit 1
fi

mkdir -p "$DST_DIR"
cp -a "$SRC_DIR"/. "$DST_DIR"/

cat > "$DST_DIR/.env" <<EOF
WEBHOOK_TOKEN=$WEBHOOK_TOKEN
EOF

if [[ "$SKIP_DASHBOARD_DOWNLOAD" != "1" ]]; then
  "$DST_DIR/grafana/dashboards/fetch-dashboards.sh"
else
  echo "Skipping dashboard download (SKIP_DASHBOARD_DOWNLOAD=1)"
fi

cat <<EOF
Observability files installed to $DST_DIR

Next steps:
  cd $DST_DIR
  docker compose config
  docker compose up -d
EOF
