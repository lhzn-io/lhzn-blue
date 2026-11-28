# Sphinx configuration for the longhorizon.blue methods and sources site.
# Build: scripts/build-docs.sh (dirhtml, warnings fail). Served under longhorizon.blue/docs/.

project = "longhorizon.blue"
copyright = "2026, Long Horizon Observatory"
author = "Long Horizon Observatory"

extensions = ["myst_parser"]
myst_enable_extensions = ["colon_fence", "deflist"]
myst_heading_anchors = 3

exclude_patterns = ["_build"]
language = "en"
smartquotes = False  # keep the methods text exactly as the site shows it ("--" is a placeholder there)

html_theme = "lhzn"
html_title = "longhorizon.blue: methods and sources"
html_baseurl = "https://longhorizon.blue/docs/"
html_theme_options = {
    "source_repository": "https://github.com/lhzn-io/lhzn-blue",
    "source_branch": "main",
    "source_directory": "docs/src/",
}
html_copy_source = False
html_show_sourcelink = False
