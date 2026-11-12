# @lhzn-io/collect

"Collect, then ask your AI": visitors pick plots, table rows or a map on a page with a "+" beside each, then from a
tray copy one PNG of what they collected and a prompt scoped to it, to paste into the assistant they already use. When
the page takes suggestions, the tray also opens the visitor's mail app with a note and a link to each item, the image
on the clipboard. Nothing is sent to the site. From longhorizon.blue.

```bash
npm install @lhzn-io/collect
```

## Use

The page puts a "+" beside each item and, optionally, a button that opens the tray:

```html
<button class="collect-open" id="collect-open" type="button" aria-controls="collect-tray" aria-expanded="false">
  Collect<span id="collect-count"></span>
</button>

<figure>
  <figcaption>Water temperature
    <button class="collect-btn" type="button" data-collect="temp" data-title="Water temperature" data-kind="plot">+</button>
  </figcaption>
  <div class="plot" id="temp">...</div>
</figure>
```

```ts
import { mountCollect } from "@lhzn-io/collect";
import "@lhzn-io/collect/collect.css";

mountCollect(
  {
    elementFor: (id) => document.getElementById(id)?.closest("figure") ?? null, // what the image paints
    prompt: (ids, question) => buildPrompt(ids, question), // the numbers as text, ending with the question
    linkFor: (id) => `${location.origin}${location.pathname}#${id}`,
    header: () => `Example Bay, ${new Date().toUTCString()}`,
    credit: "Data: Example Observing System",
    mailTo: "notes@example.org", // leave out for no suggestion panel
    pageName: "Example Bay",
  },
  {
    terms: { href: "/terms/#ai", text: "how this site uses AI" },
    labels: { question: "What stands out this week?" },
  },
);
```

The "+" marks show only while the tray is open (`body.collecting`); a collected item keeps its tick, and its
element (the `itemSelector`, `figure` by default) is outlined. The image is for context: the prompt should carry the
numbers as text.

## Options

- `labels`: any of the tray's words (`DEFAULT_LABELS` lists them); the notes may hold HTML.
- `terms`: a link added at the end of the ask panel's note. None by default.
- `suggest`: show the suggestion button and panel; by default when the host has `mailTo`. `labels.suggestExtra` adds
  a further note under it.
- `itemSelector`, `watch` (ids of sections that re-render; the whole body by default), `fileName` (the downloaded
  image's name), `skip` (selectors left out of the image), `buttonClass` and `quietClass` (the page's own button
  classes, `button` and `tab` by default).

## Styles

`collect.css` styles the "+", the open button and the tray from the page's custom properties (`--ink`, `--ink-soft`,
`--dim`, `--bg`, `--panel`, `--rule`, `--accent`, `--accent-hi`, `--accent-line`, `--button-ink`, `--sans`), the
same names as `@lhzn-io/timecharts/tokens.css`. Its button styles have zero specificity, so the page's own win.

`snapshot` (also exported, and as `@lhzn-io/collect/snapshot`) is the small painter behind the image: SVG drawn as
images, canvases as they are, coloured boxes and every text node in its computed font.

MIT License. Long Horizon Observatory.
