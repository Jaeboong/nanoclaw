#!/usr/bin/env bash
# Boundary harness — best-effort leakage check (see docs/HARNESS.md).
#
# Reports tier leakage in tracked files:
#   1. Tracked files under any instances/ or local/ directory.
#   2. Long numeric IDs (17–20 digits) that look like Discord/Telegram IDs.
#   3. Hardcoded /home/<user>/ absolute paths (excluding known placeholders).
#   4. User-maintained terms from .boundaries-blocklist (gitignored, optional).
#
# Lines containing the literal token `boundary-allow` are exempt.
#
# Compares against .boundaries-baseline (tracked) — exits 1 only on findings
# not present in the baseline. Use --update-baseline to regenerate it after a
# legitimate cleanup.

set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || {
  echo "not inside a git repository" >&2
  exit 2
}

UPDATE_BASELINE=0
case "${1:-}" in
  --update-baseline) UPDATE_BASELINE=1 ;;
  --help|-h)
    cat <<EOF
Usage: scripts/check-boundaries.sh [--update-baseline]

Reports tier leakage in tracked files vs .boundaries-baseline.
Exits 1 if there are findings not in the baseline.

  --update-baseline   Regenerate .boundaries-baseline from current state.
EOF
    exit 0
    ;;
esac

mapfile -t files < <(
  git ls-files \
    | grep -Ev '^(node_modules|dist|agents-sdk-docs)/' \
    | grep -Ev '/(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$' \
    | grep -Ev '\.(png|jpg|jpeg|gif|ico|pdf|zip|tar\.gz|tgz|woff2?|ttf|otf|eot|mp3|mp4|wav|webp)$'
)

current_tmp=$(mktemp)
trap 'rm -f "$current_tmp"' EXIT

{
  for f in "${files[@]}"; do
    case "$f" in
      *"/instances/"*|*"/local/"*|"instances/"*|"local/"*)
        printf '[instance-dir] %s\n' "$f"
        ;;
    esac
  done

  grep -EnH '\b[0-9]{17,20}\b' -- "${files[@]}" 2>/dev/null \
    | grep -v 'boundary-allow' \
    | sed 's/^/[long-id] /'

  grep -EnH '/home/[a-zA-Z0-9_.-]+/' -- "${files[@]}" 2>/dev/null \
    | grep -Ev '/home/(node|agent|user|you)/' \
    | grep -v 'boundary-allow' \
    | sed 's/^/[home-path] /'

  if [ -f .boundaries-blocklist ]; then
    while IFS= read -r term; do
      [ -z "$term" ] && continue
      case "$term" in \#*) continue ;; esac
      grep -nHF -- "$term" "${files[@]}" 2>/dev/null \
        | grep -v 'boundary-allow' \
        | sed "s|^|[blocklist:$term] |"
    done < .boundaries-blocklist
  fi
} | sort -u > "$current_tmp"

count_lines() {
  if [ -s "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi
}

if [ "$UPDATE_BASELINE" -eq 1 ]; then
  cp "$current_tmp" .boundaries-baseline
  echo "baseline updated: $(count_lines .boundaries-baseline) finding(s) recorded"
  exit 0
fi

if [ ! -f .boundaries-baseline ]; then
  if [ -s "$current_tmp" ]; then
    cat "$current_tmp"
    echo "" >&2
    echo "boundary check: $(count_lines "$current_tmp") finding(s); no baseline yet" >&2
    echo "run 'npm run check:boundaries -- --update-baseline' to snapshot the current state, then fix new leaks going forward" >&2
    exit 1
  fi
  echo "boundary check: clean (no baseline)"
  exit 0
fi

new_tmp=$(mktemp)
trap 'rm -f "$current_tmp" "$new_tmp"' EXIT
comm -23 "$current_tmp" <(sort -u .boundaries-baseline) > "$new_tmp"

if [ -s "$new_tmp" ]; then
  cat "$new_tmp"
  echo "" >&2
  echo "boundary check: $(count_lines "$new_tmp") new finding(s) vs baseline — see docs/HARNESS.md" >&2
  exit 1
fi

echo "boundary check: clean (vs baseline)"
