/**
 * The wind mark: each of the last seven days' peak wind at the Sound's buoys, as numbers (/mark/wind.json, an open
 * read-only API that other Long Horizon sites draw their own marks from) and as the site's favicon (/favicon.svg: seven
 * bars, newest on top). A day's peak is its highest hourly mean wind (sustained, not a gust), Eastern days, today so
 * far. Day-to-day peaks are not cyclical and vary from one day to the next, unlike the tide or the water temperature.
 * Both are computed from the page's own live file (v1/live.json, the buoys' hourly weather) and cached for an hour.
 * If anything fails, the favicon is the static one in the site's files and the JSON is a 503 its readers fall back on.
 */

export interface MarkEnv {
  DATA: { get(key: string, options: { type: "text"; cacheTtl?: number }): Promise<string | null> };
  ASSETS: { fetch(req: Request): Promise<Response> };
}

interface MetSeries {
  t0: string;
  step: number | string;
  wind_kt: (number | null)[];
}

export interface PeakDay {
  date: string; // Eastern calendar day, YYYY-MM-DD
  peak_kt: number | null; // null: no hourly wind that day
  peak_at: string | null; // the hour of the peak, UTC
  station: string | null; // the buoy it was measured at
  hours: number; // hourly values that day, across the buoys read
  partial: boolean; // today, still under way
}

const DAYS = 7;
const SCALE = { max_kt: 30, curve: "linear" as const };
const CACHE_S = 3600;
const YELLOW = "#decf03";
const dayOf = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

/** The last DAYS Eastern days' peaks, newest first, from the buoys' hourly wind (`only`: one buoy). */
export function windPeaks(met: Record<string, MetSeries>, now: Date, only?: string): PeakDay[] {
  const days: string[] = [];
  for (let i = 0; i < DAYS; i++) days.push(dayOf.format(new Date(now.getTime() - i * 86400_000)));
  // Step back by whole days can repeat or skip a date across a DST change: keep distinct dates, newest first.
  const want = [...new Set(days)];
  while (want.length < DAYS) {
    const [y, m, d] = want[want.length - 1].split("-").map(Number);
    want.push(dayOf.format(new Date(Date.UTC(y, m - 1, d, 12) - 86400_000)));
  }
  const out = new Map<string, PeakDay>(want.map((date, i) => [date, { date, peak_kt: null, peak_at: null, station: null, hours: 0, partial: i === 0 }]));
  const since = now.getTime() - (DAYS + 1) * 86400_000;
  for (const [id, s] of Object.entries(met)) {
    if (only && id !== only) continue;
    const t0 = Date.parse(s.t0);
    const step = Number(s.step) * 1000;
    if (!Number.isFinite(t0) || !(step > 0) || !Array.isArray(s.wind_kt)) continue;
    const first = Math.max(0, Math.floor((since - t0) / step));
    for (let i = first; i < s.wind_kt.length; i++) {
      const v = s.wind_kt[i];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const t = t0 + i * step;
      if (t > now.getTime()) break;
      const day = out.get(dayOf.format(new Date(t)));
      if (!day) continue;
      day.hours++;
      if (day.peak_kt === null || v > day.peak_kt) {
        day.peak_kt = Math.round(v * 10) / 10;
        day.peak_at = new Date(t).toISOString().replace(".000Z", "Z");
        day.station = id;
      }
    }
  }
  return want.map((d) => out.get(d)!);
}

/** The favicon: seven bars on the night tile, newest on top and fading down, each on the fixed linear scale
 * (0 to 30 kt) so a calm week reads calm and a gale reaches the edge. A day with no wind data is a faint stub. */
export function faviconSvg(days: PeakDay[]): string {
  const bars = days
    .slice(0, DAYS)
    .map((d, i) => {
      const y = (5.5 + i * 3.5).toFixed(1);
      const f = d.peak_kt === null ? 0 : Math.min(SCALE.max_kt, Math.max(0, d.peak_kt)) / SCALE.max_kt;
      const w = 2 + 24 * f;
      const op = d.peak_kt === null ? 0.25 : 1 - i * 0.09;
      return `<line x1="4" x2="${(4 + w).toFixed(1)}" y1="${y}" y2="${y}" stroke="${YELLOW}" stroke-width="${(2.2 - i * 0.12).toFixed(2)}" stroke-opacity="${op.toFixed(2)}"/>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#111"/>${bars}</svg>`;
}

async function peaksFrom(env: MarkEnv, only?: string): Promise<PeakDay[]> {
  const text = await env.DATA.get("v1/live.json", { type: "text", cacheTtl: 60 });
  if (!text) throw new Error("no live file");
  const met = (JSON.parse(text) as { met?: Record<string, MetSeries> }).met;
  if (!met || !Object.keys(met).length) throw new Error("no weather in the live file");
  if (only && !met[only]) throw new Error(`no station ${only}`);
  const days = windPeaks(met, new Date(), only);
  if (days.every((d) => d.peak_kt === null)) throw new Error("no wind in the last week");
  return days;
}

interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}
declare const caches: { default: { match(req: Request): Promise<Response | undefined>; put(req: Request, res: Response): Promise<void> } };

/** /mark/wind.json and /favicon.svg; null for any other path. */
export async function mark(req: Request, env: MarkEnv, url: URL, ctx?: Ctx): Promise<Response | null> {
  const json = url.pathname === "/mark/wind.json";
  if (!json && url.pathname !== "/favicon.svg") return null;
  if (req.method === "OPTIONS" && json) return new Response(null, { status: 204, headers: cors() });
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const station = json ? (url.searchParams.get("station") ?? "").toUpperCase() || undefined : undefined;
  // One cached copy per form (the whole Sound, or a station), whatever else the query says.
  const key = new Request(`${url.origin}${url.pathname}${station ? `?station=${station}` : ""}`);
  const hit = await caches.default.match(key).catch(() => undefined);
  if (hit) return req.method === "HEAD" ? new Response(null, hit) : hit;
  try {
    const days = await peaksFrom(env, station);
    const res = json
      ? new Response(JSON.stringify({
          schema: 1,
          series: "daily peak wind",
          place: "Long Island Sound",
          station: station ?? "all buoys",
          unit: "kt",
          timezone: "America/New_York",
          definition: "each day's highest hourly mean wind speed (sustained, not gusts) at the buoys; today so far",
          days,
          scale: SCALE,
          source: "https://longhorizon.blue/long-island-sound/",
          generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": `public, max-age=${CACHE_S}`, ...cors() } })
      : new Response(faviconSvg(days), { headers: { "content-type": "image/svg+xml", "cache-control": `public, max-age=${CACHE_S}` } });
    ctx?.waitUntil(caches.default.put(key, res.clone()).catch(() => undefined));
    return req.method === "HEAD" ? new Response(null, res) : res;
  } catch {
    // Fail soft: the static favicon; for the JSON, a short-lived 503 its readers treat as "keep your own".
    if (!json) return env.ASSETS.fetch(new Request(`${url.origin}/favicon.svg`, req));
    return new Response(JSON.stringify({ schema: 1, error: "unavailable" }), {
      status: 503,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300", "retry-after": "300", ...cors() },
    });
  }
}

function cors(): Record<string, string> {
  return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, HEAD, OPTIONS", "x-robots-tag": "noindex" };
}
