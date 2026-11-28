#!/bin/bash
# Build the site and deploy the Worker (static assets plus /data/v1/* from Workers KV) to Cloudflare.
# Settings come from ~/.config/lhzn-blue/env (never committed): CLOUDFLARE_ACCOUNT_ID.
# Authentication: `npx wrangler@4 login` once.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
set -a; . "$HOME/.config/lhzn-blue/env"; set +a
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID in ~/.config/lhzn-blue/env}"

cd "$REPO/apps/web"
# Reinstall whenever the lockfile is newer than the installed tree.
[ node_modules/.package-lock.json -nt package-lock.json ] || npm ci --no-audit --no-fund
npm run build
# The methods and sources site, served as static assets at /docs/ (Vite has just emptied dist/).
bash "$REPO/scripts/build-docs.sh"
cp -r "$REPO/docs/_build/html" dist/docs
rm -f dist/docs/.buildinfo

cd "$REPO/worker"
npx --yes wrangler@4 deploy "$@"
