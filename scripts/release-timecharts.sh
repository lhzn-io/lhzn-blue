#!/bin/bash
# Pack @lhzn-io/timecharts (npm pack) for a `timecharts-v<version>` release, into dist/timecharts-v<version>/.
# packages/timecharts/package.json must already carry <version>.
#   scripts/release-timecharts.sh 0.1.0             pack only
#   scripts/release-timecharts.sh 0.1.0 --publish   also tag HEAD, push the tag and create the GitHub release
# Other sites install the tarball from the release by URL. (The Python side is insitukit, on PyPI.)
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:?usage: release-timecharts.sh <version> [--publish]}"
TAG="timecharts-v${VERSION}"
OUT="$REPO/dist/$TAG"

js_version="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$REPO/packages/timecharts/package.json")"
[ "$js_version" = "$VERSION" ] || { echo "package.json has $js_version, not $VERSION" >&2; exit 1; }

rm -rf "$OUT" && mkdir -p "$OUT"
(cd "$REPO/packages/timecharts" && npm pack --pack-destination "$OUT")
ls -l "$OUT"

[ "${2:-}" = "--publish" ] || exit 0
[ -z "$(git -C "$REPO" status --porcelain -- packages/timecharts)" ] || { echo "packages/timecharts has uncommitted changes" >&2; exit 1; }
git -C "$REPO" tag -a "$TAG" -m "@lhzn-io/timecharts $VERSION"
git -C "$REPO" push origin "$TAG"
gh release create "$TAG" "$OUT"/* --repo lhzn-io/lhzn-blue --title "timecharts $VERSION" \
  --notes "@lhzn-io/timecharts $VERSION (TypeScript source for Vite), built from $(git -C "$REPO" rev-parse --short HEAD)."
