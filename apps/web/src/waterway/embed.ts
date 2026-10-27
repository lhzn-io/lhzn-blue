/** Embed mode (?embed=next48&station=WLIS, optionally &theme=dark or light): one station's one figure, live, for
 * another site to frame; the rest of the page is hidden and the map is not drawn. The framing page sizes the iframe to
 * the figure from the message {lhznEmbed: {height}}, sent whenever the content's height changes. */

export type EmbedFig = "next48" | "yoy";

/** What a link asks to embed (the station defaults to the page's choice), with the page set up for it. */
export function embedMode(link: URLSearchParams, defaultStation: string): { fig: EmbedFig | null; station: string } {
  const fig = (["next48", "yoy"] as const).find((k) => k === link.get("embed")) ?? null;
  const station = (link.get("station") ?? defaultStation).toUpperCase();
  if (fig) {
    document.body.classList.add("embed");
    new ResizeObserver(() => {
      if (window.parent !== window) window.parent.postMessage({ lhznEmbed: { fig, station, height: document.querySelector("main")?.scrollHeight ?? document.body.scrollHeight } }, "*");
    }).observe(document.body);
    const th = link.get("theme");
    if (th === "dark") delete document.documentElement.dataset.theme;
    else if (th === "light") document.documentElement.dataset.theme = "light";
  }
  return { fig, station };
}
