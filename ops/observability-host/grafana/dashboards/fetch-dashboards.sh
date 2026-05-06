#!/usr/bin/env sh
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
FORCE="${1:-}"

download() {
  id="$1"
  out="$2"
  target="$DIR/$out"

  if [ -s "$target" ] && [ "$FORCE" != "--force" ]; then
    echo "skip $out (already present)"
    return
  fi

  tmp="$target.tmp"
  curl -fsSL "https://grafana.com/api/dashboards/$id/revisions/latest/download" -o "$tmp"
  mv "$tmp" "$target"
  echo "downloaded $out"
}

download 1860 node-exporter-full.json
