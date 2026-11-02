#!/bin/bash
# Build the shared packages for a `kit-v<version>` release: the lhzn-blue-kit wheel and sdist (uv build) and the
# @lhzn-io/viz tarball (npm pack), into dist/kit-v<version>/. Both manifests must already carry <version>.
#   scripts/release-kit.sh 0.1.0             build only
#   scripts/release-kit.sh 0.1.0 --publish   also tag HEAD, push the tag and create the GitHub release with the files
# Other sites install the files from the release by URL, as the jobs install forcingkit from its tag archive.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:?usage: release-kit.sh <version> [--publish]}"
TAG="kit-v${VERSION}"
OUT="$REPO/dist/$TAG"

py_version="$(sed -n 's/^version = "\(.*\)"$/\1/p' "$REPO/packages/lhzn-blue-kit/pyproject.toml")"
init_version="$(sed -n 's/^__version__ = "\(.*\)"$/\1/p' "$REPO/packages/lhzn-blue-kit/src/lhzn_blue_kit/__init__.py")"
js_version="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$REPO/packages/viz/package.json")"
for v in "$py_version" "$init_version" "$js_version"; do
  [ "$v" = "$VERSION" ] || { echo "version mismatch: pyproject $py_version, __init__ $init_version, package.json $js_version" >&2; exit 1; }
done

rm -rf "$OUT" && mkdir -p "$OUT"
(cd "$REPO/packages/lhzn-blue-kit" && uv build --out-dir "$OUT")
(cd "$REPO/packages/viz" && npm pack --pack-destination "$OUT")
ls -l "$OUT"

[ "${2:-}" = "--publish" ] || exit 0
[ -z "$(git -C "$REPO" status --porcelain -- packages)" ] || { echo "packages/ has uncommitted changes" >&2; exit 1; }
git -C "$REPO" tag -a "$TAG" -m "lhzn-blue-kit and @lhzn-io/viz $VERSION"
git -C "$REPO" push origin "$TAG"
gh release create "$TAG" "$OUT"/* --repo lhzn-io/lhzn-blue --title "Shared packages $VERSION" \
  --notes "lhzn-blue-kit (Python) and @lhzn-io/viz (TypeScript source) $VERSION, built from $(git -C "$REPO" rev-parse --short HEAD)."
