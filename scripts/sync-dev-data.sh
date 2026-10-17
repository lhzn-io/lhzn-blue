#!/usr/bin/env bash
# Copy the live site's data files into out/, which the dev server serves at /data/ (see apps/web/vite.config.ts), so
# the dev page shows what longhorizon.blue shows. The list is the Worker's own (worker/src/index.ts), so a new data
# file is picked up here once the Worker serves it. Files the site does not have yet (404) are skipped and left as
# they are locally.
#
#   bash scripts/sync-dev-data.sh            # every file
#   bash scripts/sync-dev-data.sh fields     # only keys containing "fields"
set -euo pipefail
cd "$(dirname "$0")/.."
SITE="${LHZN_BLUE_SITE:-https://longhorizon.blue}"
filter="${1:-}"
# Plain keys in FILES, and the per-station HRRR history keys the Worker builds from its station list.
mapfile -t keys < <(
  grep -oE '"v1/[^"$]+"' worker/src/index.ts | tr -d '"'
  for id in $(grep -oE 'hrrr-history.*' worker/src/index.ts >/dev/null && grep -oE '\[("[A-Z]{4}"(, )?)+\]' worker/src/index.ts | head -1 | grep -oE '[A-Z]{4}'); do
    echo "v1/hrrr-history/$id.json"
  done
)
ok=0 skipped=0
for key in "${keys[@]}"; do
  [[ -n "$filter" && "$key" != *"$filter"* ]] && continue
  dest="out/$key"
  mkdir -p "$(dirname "$dest")"
  code=$(curl -s -A "longhorizon.blue dev sync" -o "$dest.part" -w "%{http_code}" "$SITE/data/$key" || echo 000)
  if [[ "$code" == 200 ]]; then
    mv "$dest.part" "$dest"
    ok=$((ok + 1))
  else
    rm -f "$dest.part"
    echo "skipped $key ($code)"
    skipped=$((skipped + 1))
  fi
  sleep 0.3 # the Worker throttles per client address
done
echo "synced $ok files into out/ from $SITE ($skipped skipped)"
