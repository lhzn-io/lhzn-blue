/** The NWS marine warnings and advisories in force on the Sound, in the masthead of every Sound page: the advisory
 * in capitals in brick red, the parts of the Sound it covers, and when it ends. A link, not an alarm of our own:
 * it switches to the Wind view (without scrolling), where the advisories run along "Wind across the Sound". Shown
 * only while one is in force; the file is refreshed hourly from api.weather.gov. */

import { getJson } from "./series";

interface ZoneSpan { issued: string | null; from: string | null; until: string | null }
export interface Alert {
  event: string; kind: string; zones: string[]; ends: string | null;
  updated?: string | null; // NWS's latest message for it
  issued?: string; // first issued for these zones (IEM's record of the event)
  by_zone?: Record<string, ZoneSpan>;
}
export interface AlertsNow { generated_at: string; zones: Record<string, string>; alerts: Alert[] }
let latest: AlertsNow | null = null;
/** The alerts file as last fetched (null before the first fetch, or when it failed). */
export const alertsNow = (): AlertsNow | null => latest;

const fmtEnd = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });
// Most severe first, so a gale warning leads a small craft advisory.
const RANK = ["HF.W", "HU.W", "TR.W", "SR.W", "GL.W", "SE.W", "SC.Y", "MA.W", "MF.Y", "UP.Y", "LO.Y"];
export const WIND_STRIP_HASH = "#wind-strip";
export const WIND_VIEW_URL = "/long-island-sound/?view=wind";

function listParts(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Fetch the alerts in force and show them in the masthead; `onOpen` handles the click on the Sound page itself
 * (switch to the Wind view), elsewhere the link navigates. */
export async function mountAdvisories(mast: Element, onOpen?: () => void): Promise<void> {
  let now: AlertsNow;
  try {
    now = await getJson<AlertsNow>("/data/v1/advisories-now.json");
    latest = now;
  } catch {
    return; // no file (or no network): no banner, never a guess
  }
  const t = Date.now();
  const live = now.alerts.filter((a) => !a.ends || Date.parse(a.ends) > t);
  mast.querySelector(".mast-advisory")?.remove();
  if (!live.length) return;
  // One line per event and end time; the zones it covers named west to east.
  const order = Object.keys(now.zones);
  const lines = new Map<string, { a: Alert; zones: Set<string>; issued: string[]; updated: string[]; spans: [string, ZoneSpan][] }>();
  for (const a of live) {
    const key = `${a.event}|${a.ends}`;
    if (!lines.has(key)) lines.set(key, { a, zones: new Set(), issued: [], updated: [], spans: [] });
    const l = lines.get(key)!;
    a.zones.forEach((z) => l.zones.add(z));
    if (a.issued) l.issued.push(a.issued);
    if (a.updated) l.updated.push(a.updated);
    for (const [z, sp] of Object.entries(a.by_zone ?? {})) l.spans.push([z, sp]);
  }
  const first = (ts: string[]) => ts.reduce((m, t) => (Date.parse(t) < Date.parse(m) ? t : m));
  const last = (ts: string[]) => ts.reduce((m, t) => (Date.parse(t) > Date.parse(m) ? t : m));
  const rows = [...lines.values()].sort((x, y) => RANK.indexOf(x.a.kind) - RANK.indexOf(y.a.kind));
  const link = document.createElement("a");
  link.className = "mast-advisory";
  link.href = WIND_VIEW_URL;
  link.setAttribute("role", "status");
  link.innerHTML = rows
    .map(({ a, zones, issued, updated }) => {
      const parts = order.filter((z) => zones.has(z));
      const where = parts.length === order.length ? "the whole Sound" : listParts(parts.map((z) => now.zones[z]));
      const until = a.ends ? `until ${fmtEnd.format(new Date(a.ends))}` : "";
      const when = [
        issued.length ? `issued ${fmtEnd.format(new Date(first(issued)))}` : "",
        updated.length ? `updated ${fmtEnd.format(new Date(last(updated)))}` : "",
      ].filter(Boolean).join(" &middot; ");
      return `<span class="ma-row"><b>${a.event}</b><span class="ma-sub">${where}${until ? ` &middot; ${until}` : ""}</span>` +
        `<span class="ma-when">${when}${when ? " &middot; " : ""}NWS</span></span>`;
    })
    .join("");
  // The tooltip: each zone's own span (an advisory can start at different times along the Sound).
  const detail = [...lines.values()].flatMap(({ a, spans }) =>
    order.flatMap((z) => spans.filter(([zz]) => zz === z).map(([, sp]) =>
      `${a.event}, ${now.zones[z]} (${z}): issued ${sp.issued ? fmtEnd.format(new Date(sp.issued)) : "?"}, in force ${sp.from ? fmtEnd.format(new Date(sp.from)) : "?"} to ${sp.until ? fmtEnd.format(new Date(sp.until)) : "?"}`)));
  link.title = ["Issued by the National Weather Service (New York).", ...detail].join("\n");
  if (onOpen) {
    link.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      onOpen();
    });
  }
  mast.append(link);
}
