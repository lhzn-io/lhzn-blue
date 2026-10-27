/**
 * longhorizon.blue edge: serves the static site and the page's data files from Workers KV, where
 * the ingest jobs write them. This Worker does no data processing.
 *
 * The data files exist for this site's pages; they are not a supported public API yet. They are
 * same-origin only (no CORS) and throttled per client address, so the free-plan request allowance
 * goes to people reading the page.
 */

interface KV {
  get(key: string, options: { type: "stream"; cacheTtl?: number }): Promise<ReadableStream | null>;
}

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  DATA: KV;
  LIMITER?: RateLimit;
}

// The only data the Worker serves, with edge and browser cache lifetimes in seconds.
const FILES: Record<string, number> = {
  "v1/live.json": 300,
  "v1/history.json": 300,
  "v1/history-salinity.json": 300,
  "v1/history-oxygen.json": 300,
  "v1/history-waves.json": 300,
  "v1/history-met.json": 300,
  "v1/forecast-hrrr.json": 300,
  "v1/forecast-verification.json": 300,
  "v1/history-turbidity.json": 300,
  "v1/shore.json": 300,
  "v1/shore-tides.json": 300,
  "v1/shore-history.json": 300,
  "v1/rivers.json": 300,
  "v1/rivers-history.json": 300,
  "v1/usgs-tidal.json": 300,
  "v1/waves-nwps.json": 1800,
  "v1/advisories.json": 3600,
  "v1/advisories-now.json": 300,
  "v1/piscataqua.json": 300, // the unlisted /portsmouth-harbor/ page
  "v1/panels.json": 300,
  "v1/fields/sst.json": 3600,
  "v1/fields/chl.json": 3600,
  "v1/fields/kd490.json": 3600,
  "v1/fields/currents.json": 3600,
  "v1/fields/piscataqua-currents.json": 3600, // the unlisted /portsmouth-harbor/ page's own box
  "v1/fields/piscataqua-currents-mesh.json": 86400,
  "v1/fields/piscataqua-currents-history.bin": 3600, // the model's past hours, loaded when the time goes back
  "v1/fields/hrrr-wind.json": 600,
  "v1/fields/hrrr-wind-history.json": 3600, // the hours before hrrr-wind.json, loaded when the time bar goes back past it
  "v1/fields/nwps-waves.json": 1800,
  "v1/fields/wind-against-tide.json": 1800,
  "v1/fields/rips.json": 3600,
  "v1/asos.json": 300,
  "v1/current-phase.json": 1800,
  // HRRR's last forecast before each hour, per station (from 2024).
  ...Object.fromEntries(["WLIS", "EXRX", "ARTG", "CLIS", "KPTN", "BRPT", "NWHV", "NLON", "KBDR", "KHVN"].flatMap((id) => [[`v1/hrrr-history/${id}.json`, 3600], [`v1/hrrr-history/${id}-recent.json`, 3600]])),
  "v1/fields/model-grids.json": 3600,
  "v1/fields/currents-mesh.json": 86400,
  "v1/fields/sst-90d.bin": 3600,
  "v1/fields/chl-90d.bin": 3600,
  "v1/fields/kd490-90d.bin": 3600,
  // The /portsmouth-harbor/ page's 3D view: one fixed window (a spring tide), uploaded once with scripts/upload-pane-data.sh.
  ...Object.fromEntries(
    ["mesh.json", "nodes.f32", "tri.u16", "zeta.i16", "u.i16", "v.i16", "profile.json", "tracks.f32", "tracks.json", "dem.bin", "dem.json", "buoy.json"].map((f) => [`v1/piscataqua-pane/${f}`, 86400]),
  ),
  // The /piscataqua-region/ waterway (jobs: region.py), under its own prefix.
  ...Object.fromEntries(
    ([["live.json", 300], ["history.json", 3600], ["fields/currents.json", 3600], ["fields/currents-mesh.json", 86400],
      ["fields/sst.json", 3600], ["fields/sst-90d.bin", 3600], ["fields/hrrr-wind.json", 600]] as const).map(([f, s]) => [`v1/piscataqua-region/${f}`, s]),
  ),
};

async function data(req: Request, env: Env, path: string): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const key = path.slice("/data/".length);
  const seconds = FILES[key];
  if (seconds === undefined) return new Response("Not found", { status: 404 });
  if (env.LIMITER) {
    const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.LIMITER.limit({ key: ip });
    if (!success) {
      return new Response("Too many requests. These files serve the longhorizon.blue pages and are not a public API.", {
        status: 429,
        headers: { "retry-after": "60" },
      });
    }
  }
  // Keep the edge copy of the KV value short (60 s, the minimum), so a new upload shows within a minute;
  // the browser still caches for `seconds`.
  const body = await env.DATA.get(key, { type: "stream", cacheTtl: 60 });
  if (body === null) return new Response("Not found", { status: 404 });
  return new Response(req.method === "HEAD" ? null : body, {
    status: 200,
    headers: {
      // JSON, or binary the page reads itself (the gzipped histories, the 3D view's typed arrays).
      "content-type": key.endsWith(".json") ? "application/json; charset=utf-8" : "application/octet-stream",
      "cache-control": `public, max-age=${seconds}`,
      "x-robots-tag": "noindex",
    },
  });
}

// Waterway pages with a page per station: /<waterway>/<station>/ is the waterway's own page, which reads the station
// from the path (so a station's address can be shared and Back works without page code).
const WATERWAYS = new Set(["piscataqua-region"]);
const STATION_PATH = /^\/([a-z0-9-]+)\/([a-z0-9-]{2,20})\/?$/;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/data/")) return data(req, env, url.pathname);
    const m = STATION_PATH.exec(url.pathname);
    if (m && WATERWAYS.has(m[1])) {
      if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
      const page = new URL(url);
      page.pathname = `/${m[1]}/`;
      return env.ASSETS.fetch(new Request(page, req));
    }
    return env.ASSETS.fetch(req);
  },
};
