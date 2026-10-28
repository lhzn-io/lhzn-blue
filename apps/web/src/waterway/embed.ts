/** One station's one figure, alone, two ways:
 * - a plot page (/<waterway>/<station>/next-48h/): the figure filling the screen, with the time bar, a reading line at
 *   the page's time and the way back to the station; its own address, so it can be bookmarked and shared;
 * - an embed (?embed=next48&station=WLIS, or a plot page's address with &embed=1; optionally &theme=dark or light):
 *   the figure and a credit line, live, for another site to frame; the rest of the page is hidden and the map is not
 *   drawn. The framing page sizes the iframe to the figure from the message {lhznEmbed: {height}}, sent whenever the
 *   content's height changes. */

export type EmbedFig = "next48" | "yoy";

/** The plots that have a page of their own, by the address's last segment. */
export const PLOT_PAGES: Record<string, EmbedFig> = { "next-48h": "next48" };

/** What the address asks for (the station defaults to the page's choice), with the page set up for it: a plot page
 * when the path names one, an embed when the link asks. */
export function embedMode(link: URLSearchParams, defaultStation: string, path: { fig: EmbedFig; station: string } | null = null): { fig: EmbedFig | null; station: string; page: boolean } {
  const asked = (["next48", "yoy"] as const).find((k) => k === link.get("embed")) ?? null;
  const fig = path?.fig ?? asked;
  const station = (path?.station ?? link.get("station") ?? defaultStation).toUpperCase();
  const embed = !!asked || (!!path && link.get("embed") === "1");
  if (fig) {
    document.body.classList.add(embed ? "embed" : "plot-page");
    if (embed)
      new ResizeObserver(() => {
        if (window.parent !== window) window.parent.postMessage({ lhznEmbed: { fig, station, height: document.querySelector("main")?.scrollHeight ?? document.body.scrollHeight } }, "*");
      }).observe(document.body);
    const th = link.get("theme");
    if (th === "dark") delete document.documentElement.dataset.theme;
    else if (th === "light") document.documentElement.dataset.theme = "light";
  }
  return { fig, station, page: !!fig && !embed };
}
