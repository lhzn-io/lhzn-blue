/** One station's one figure, alone, two ways:
 * - a plot page (/<waterway>/<station>/<plot>/, the plots in plot-pages.json): the figure filling the screen, with the
 *   time bar, a reading line at the page's time and the way back to the station; its own address, so it can be
 *   bookmarked and shared;
 * - an embed (a plot page's address with &embed=1, or ?embed=next48&station=WLIS; optionally &theme=dark or light):
 *   the figure and a credit line, live, for another site to frame; the rest of the page is hidden and the map is not
 *   drawn. The framing page sizes the iframe to the figure from the message {lhznEmbed: {height}}, sent whenever the
 *   content's height changes. */
import pages from "./plot-pages.json";

/** A plot with a page of its own: its figure, the views it is drawn in (the first unless the link names another),
 * and its short name for the top bar. */
export interface PlotPage {
  fig: string;
  views: string[];
  name: string;
}

/** The plots that have a page of their own, by the address's last segment; the Worker serves the same list. */
export const PLOT_PAGES: Record<string, PlotPage> = pages;

/** The address segment of a figure's page, if it has one. */
export const plotSlug = (fig: string): string | undefined => Object.keys(PLOT_PAGES).find((s) => PLOT_PAGES[s].fig === fig);

/** What the address asks for (the station defaults to the page's choice), with the page set up for it: a plot page
 * when the path names one, an embed when the link asks. */
export function embedMode(link: URLSearchParams, defaultStation: string, path: { fig: string; station: string } | null = null): { fig: string | null; station: string; page: boolean } {
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
