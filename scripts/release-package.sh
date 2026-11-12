#!/bin/bash
# Build and pack one of the npm packages under packages/ (timecharts or collect) into dist/<name>-v<version>/, and
# with --publish publish that tarball to npm and tag the release. packages/<name>/package.json must already carry
# <version>.
#   scripts/release-package.sh timecharts 0.2.0             build and pack only
#   scripts/release-package.sh timecharts 0.2.0 --publish   also npm publish, then tag HEAD and push the tag
# Publishing needs `npm login` as a member of the @lhzn-io organization on npmjs.com.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NAME="${1:?usage: release-package.sh <timecharts|collect> <version> [--publish]}"
VERSION="${2:?usage: release-package.sh <timecharts|collect> <version> [--publish]}"
PKG="$REPO/packages/$NAME"
TAG="${NAME}-v${VERSION}"
OUT="$REPO/dist/$TAG"
[ -f "$PKG/package.json" ] || { echo "no package at packages/$NAME" >&2; exit 1; }

js_version="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$PKG/package.json")"
[ "$js_version" = "$VERSION" ] || { echo "package.json has $js_version, not $VERSION" >&2; exit 1; }

# Build with the web app's TypeScript (the same version the package names), then pack what was built.
[ -x "$REPO/apps/web/node_modules/.bin/tsc" ] || (cd "$REPO/apps/web" && npm ci --no-audit --no-fund)
rm -rf "$PKG/dist" "$OUT" && mkdir -p "$OUT"
"$REPO/apps/web/node_modules/.bin/tsc" -p "$PKG"
(cd "$PKG" && npm pack --ignore-scripts --pack-destination "$OUT")
ls -l "$OUT"

[ "${3:-}" = "--publish" ] || exit 0
[ -z "$(git -C "$REPO" status --porcelain -- "packages/$NAME")" ] || { echo "packages/$NAME has uncommitted changes" >&2; exit 1; }
npm publish "$OUT"/*.tgz --access public
git -C "$REPO" tag -a "$TAG" -m "@lhzn-io/$NAME $VERSION"
git -C "$REPO" push origin "$TAG"
