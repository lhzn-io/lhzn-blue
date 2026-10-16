#!/usr/bin/env python3
"""Render the site's references page from docs/references.bib.

Writes apps/web/references/index.html (committed, so the site build needs no Python) and copies the .bib to
apps/web/public/references.bib for download. Run after editing the .bib:

    python3 scripts/build-references.py

Each entry's `keywords` names its section, `annote` says what it supports on the site, and an optional `sortkey`
puts an entry ahead of the alphabetical order in its section. Entries are anchored by
key (/references/#shin2021waves), so pages cite them with a link to the anchor.
"""

import html
import re
import shutil
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
BIB = REPO / "docs" / "references.bib"
OUT = REPO / "apps" / "web" / "references" / "index.html"

# Site-wide sections first (they apply to every waterway), then one heading per waterway with its own sections.
GENERAL = [("fields", "Methods behind the map, its fields and the tides")]
# After the waterways: the books behind how the plots are drawn.
CLOSING = [("design", "How the plots are drawn")]
WATERWAYS = [
    {
        "id": "long-island-sound",
        "name": "Long Island Sound",
        "intro": (
            "The buoy observations at the heart of the Long Island Sound page come from LISICOS, the Long Island Sound "
            "Integrated Coastal Observing System at the University of Connecticut, and from the work of James O'Donnell and "
            "his colleagues there."
        ),
        "sections": [
            ("observing", "The observing system"),
            ("sound", "The Sound"),
            ("hypoxia", "Oxygen and hypoxia"),
            ("programs", "Monitoring programs"),
        ],
    },
]
CONTACT = "hello@longhorizon.blue"


def parse(text: str) -> list[dict]:
    """Entries in this file's own layout: `@type{key,` then one `name = {value},` per line, then `}`."""
    entries = []
    for block in re.findall(r"@(\w+)\{([^,]+),\n(.*?)\n\}", text, re.S):
        kind, key, body = block
        fields = {m.group(1): m.group(2) for m in re.finditer(r"^\s*(\w+) = \{(.*)\},?$", body, re.M)}
        entries.append({"type": kind.lower(), "key": key.strip(), **fields})
    return entries


def person(name: str) -> str:
    """'Family, Given Names' to 'Family, G. N.'; an organisation in double braces stays whole."""
    name = name.strip()
    if name.startswith("{") and name.endswith("}"):
        return name.strip("{}")
    family, _, given = name.partition(",")
    initials = " ".join(f"{p[0]}." for p in re.split(r"[\s.]+", given.strip()) if p)
    return f"{family.strip()}, {initials}".strip(", ")


def people(field: str, max_names: int = 4) -> str:
    field = field.strip()
    if field.startswith("{") and field.endswith("}"):
        return field[1:-1]  # an organisation, kept whole (its name may contain "and")
    names = [person(n) for n in re.split(r"\s+and\s+", field) if n.strip()]
    if len(names) > max_names:
        return f"{names[0]}, {names[1]}, {names[2]} et al."
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]


def cite(e: dict) -> str:
    h = html.escape
    who = e.get("author") or e.get("editor", "")
    who_txt = people(who) + (" (eds.)" if not e.get("author") and e.get("editor") else "")
    year = e.get("year", "n.d.")
    title = e.get("title", "")
    if e["type"] == "misc" and e.get("url"):
        return (
            f'{h(who_txt)}{f" ({h(year)})" if e.get("year") else ""}. <a href="{h(e["url"])}">{h(title)}</a>. '
            f'{h(e["note"]) + ". " if e.get("note") else ""}<span class="ref-accessed">Accessed {h(e.get("urldate", ""))}</span>'
        )
    parts = [f"{h(who_txt)} ({h(year)}). {h(title)}."]
    if e["type"] == "article":
        vol = e.get("volume", "")
        num = f"({e['number']})" if e.get("number") else ""
        pages = f", {e['pages']}" if e.get("pages") else ""
        parts.append(f" <i>{h(e.get('journal', ''))}</i> {h(vol)}{h(num)}{h(pages)}.")
    elif e["type"] == "incollection":
        eds = people(e["editor"]) + " (eds.)" if e.get("editor") else ""
        pages = f", pp. {e['pages']}" if e.get("pages") else ""
        parts.append(f" In {h(eds)}, <i>{h(e.get('booktitle', ''))}</i>{h(pages)}. {h(e.get('publisher', ''))}.")
    elif e["type"] == "book":
        series = f" {h(e['series'])}." if e.get("series") else ""
        edition = f" {h(e['edition'])} edition." if e.get("edition") else ""
        parts.append(f"{series}{edition} {h(e.get('publisher', ''))}.")
    elif e["type"] == "misc":
        parts.append(f" {h(e.get('publisher', ''))}.")
    if e.get("doi"):
        parts.append(f' <a href="https://doi.org/{h(e["doi"])}">doi:{h(e["doi"])}</a>')
    return "".join(parts)


def section(entries: list[dict], group: str, heading: str, level: int) -> str:
    items = [e for e in entries if e.get("keywords") == group]
    if not items:
        return ""
    # sortkey first (entries given one lead their section), then by first author.
    items.sort(key=lambda e: (e.get("sortkey", "9"), (e.get("author") or e.get("editor") or "").strip("{}").lower()))
    rows = "\n".join(
        f'        <li id="{html.escape(e["key"])}"><p class="ref">{cite(e)}</p>'
        f'<p class="ref-note">{html.escape(e.get("annote", ""))}</p></li>'
        for e in items
    )
    return f'      <h{level}>{heading}</h{level}>\n      <ol class="refs">\n{rows}\n      </ol>'


def render(entries: list[dict]) -> str:
    parts = [section(entries, g, h, 3) for g, h in GENERAL]
    for w in WATERWAYS:
        inner = "\n\n".join(filter(None, (section(entries, g, h, 3) for g, h in w["sections"])))
        parts.append(
            f'      <section class="refs-waterway" id="{w["id"]}" aria-labelledby="{w["id"]}-title">\n'
            f'      <h2 id="{w["id"]}-title">{html.escape(w["name"])}</h2>\n'
            f'      <p class="prose">{html.escape(w["intro"])}</p>\n\n{inner}\n      </section>'
        )
    parts += [section(entries, g, h, 2) for g, h in CLOSING]  # its own heading level, not under the last waterway
    # Room for the next waterway: left visibly open, as an invitation.
    parts.append(
        '      <section class="refs-waterway refs-open" aria-labelledby="next-title">\n'
        '      <h2 id="next-title">Next waterway</h2>\n'
        '      <p class="prose">If you work on, study or monitor a coastal water and would lik'
        'e to help bring its observations and academic literature here, write to '
        f'<a href="mailto:{CONTACT}">{CONTACT}</a>.</p>\n'
        "      </section>"
    )
    body = "\n\n".join(filter(None, parts))
    return f"""<!doctype html>
<html lang="en" data-theme="light">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="canonical" href="https://longhorizon.blue/references/" />
    <title>References | longhorizon.blue</title>
    <meta name="description" content="Papers and monitoring programs behind longhorizon.blue: the methods behind the map's fields, then each waterway's science and monitoring." />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      rel="stylesheet"
      href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Josefin+Sans:wght@300;400;600;700&family=Martian+Mono:wght@300;400;500&display=swap"
    />
  </head>
  <!-- Generated by scripts/build-references.py from docs/references.bib; edit the .bib, not this file. -->
  <body class="terms">
    <header class="mast">
      <a class="wordmark wm-one" href="/" aria-label="longhorizon.blue home">LONGHORIZON.BLUE</a>
    </header>
    <main>
      <h1>References</h1>
      <p class="prose">
        The papers and monitoring programs behind these pages, with a note on what each supports: the methods behind the map's fields
        first, then each waterway. As BibTeX: <a href="/references.bib">references.bib</a>.
      </p>

{body}

      <footer class="credits">
        <p><a href="/">longhorizon.blue</a> &middot; <a href="/terms/">Terms</a> &middot; Long Horizon Observatory</p>
      </footer>
    </main>
    <script type="module" src="../src/landing.ts"></script>
  </body>
</html>
"""


def main() -> None:
    entries = parse(BIB.read_text(encoding="utf-8"))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(render(entries), encoding="utf-8")
    shutil.copyfile(BIB, REPO / "apps" / "web" / "public" / "references.bib")
    print(f"wrote {OUT.relative_to(REPO)} ({len(entries)} entries) and apps/web/public/references.bib")


if __name__ == "__main__":
    main()
