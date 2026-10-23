#!/bin/bash
# Upload the /portsmouth-harbor/ page's 3D view data (one fixed window, prepared outside this repo) to the Workers KV
# namespace the Worker serves /data/v1/* from, as v1/piscataqua-pane/<file>. The files are not kept in git.
#
#   bash scripts/upload-pane-data.sh <directory holding mesh.json, nodes.f32, ...>
#
# Settings come from ~/.config/lhzn-blue/env (CLOUDFLARE_ACCOUNT_ID); authentication: `npx wrangler@4 login` once.
set -euo pipefail
SRC="${1:?usage: upload-pane-data.sh <data directory>}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
set -a; . "$HOME/.config/lhzn-blue/env"; set +a
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID in ~/.config/lhzn-blue/env}"
NS="$(grep -A2 '^\[\[kv_namespaces\]\]' "$REPO/worker/wrangler.toml" | sed -n 's/^id = "\(.*\)"/\1/p')"
FILES=(mesh.json nodes.f32 tri.u16 zeta.i16 u.i16 v.i16 profile.json tracks.f32 tracks.json dem.bin dem.json buoy.json)
for f in "${FILES[@]}"; do
  [ -f "$SRC/$f" ] || { echo "missing $SRC/$f"; exit 1; }
done
cd "$REPO/worker"
for f in "${FILES[@]}"; do
  npx --yes wrangler@4 kv key put "v1/piscataqua-pane/$f" --path "$SRC/$f" --namespace-id "$NS" --remote >/dev/null
  echo "uploaded v1/piscataqua-pane/$f ($(stat -c %s "$SRC/$f") bytes)"
done
