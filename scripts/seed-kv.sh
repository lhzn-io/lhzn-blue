#!/bin/bash
# Upload a local job output directory (default: out/) to the Workers KV namespace with wrangler,
# using your wrangler login rather than an API token. Used to seed KV and for manual refreshes.
#   scripts/seed-kv.sh [out-dir]
# One `kv key put` per file: a bulk put reported success on 2026-10-08 without storing the 2 MB
# history bundle, so each key is written on its own and read back to confirm.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(cd "${1:-$REPO/out}" && pwd)"
set -a; . "$HOME/.config/lhzn-blue/env"; set +a
: "${CLOUDFLARE_ACCOUNT_ID:?}"
WRANGLER="npx --yes wrangler@4"

cd "$REPO/worker"
find "$OUT/v1" -name '*.json' | sort | while read -r path; do
  key="${path#"$OUT"/}"
  $WRANGLER kv key put "$key" --path "$path" --binding DATA --remote >/dev/null
  stored="$($WRANGLER kv key get "$key" --binding DATA --remote 2>/dev/null | wc -c)"
  local_size="$(wc -c < "$path")"
  [ "$stored" -eq "$local_size" ] || { echo "MISMATCH $key: local $local_size, stored $stored"; exit 1; }
  echo "ok $key ($local_size bytes)"
done
