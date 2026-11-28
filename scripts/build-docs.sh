#!/usr/bin/env bash
# Build the methods and sources site (docs/src) into docs/_build/html, warnings failing the build.
#
#   bash scripts/build-docs.sh            # build
#   bash scripts/build-docs.sh --regen    # first rewrite the generated pages from methods.ts and references.bib
#
# The Sphinx environment lives outside the repository (DOCS_VENV, default ~/.venvs/lhzn-blue-docs) and is created
# from docs/requirements-docs.txt when missing. The output uses dirhtml (one folder per page), so its links end in a
# slash like the rest of the site.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
VENV="${DOCS_VENV:-$HOME/.venvs/lhzn-blue-docs}"

if [[ "${1:-}" == "--regen" ]]; then
  node "$REPO/scripts/build-docs-methods.mjs"
  python3 "$REPO/scripts/build-references.py"
fi

if [[ ! -x "$VENV/bin/sphinx-build" ]]; then
  if command -v uv >/dev/null; then # as for the jobs; python3 -m venv needs the distribution's venv package
    uv venv --quiet --allow-existing "$VENV"
    uv pip install --quiet --python "$VENV/bin/python" -r "$REPO/docs/requirements-docs.txt"
  else
    python3 -m venv "$VENV"
    "$VENV/bin/pip" install --quiet -r "$REPO/docs/requirements-docs.txt"
  fi
fi

rm -rf "$REPO/docs/_build/html" # a fresh tree: deploy-web.sh copies all of it to /docs/
"$VENV/bin/sphinx-build" -b dirhtml -W --keep-going -q -d "$REPO/docs/_build/doctrees" "$REPO/docs/src" "$REPO/docs/_build/html"
echo "built $REPO/docs/_build/html"
