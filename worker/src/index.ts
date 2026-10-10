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
  "v1/history-turbidity.json": 300,
  "v1/shore.json": 300,
  "v1/shore-history.json": 300,
  "v1/rivers.json": 300,
  "v1/rivers-history.json": 300,
  "v1/fields/sst.json": 3600,
  "v1/fields/chl.json": 3600,
  "v1/fields/kd490.json": 3600,
  "v1/fields/currents.json": 3600,
  "v1/fields/currents-mesh.json": 86400,
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
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${seconds}`,
      "x-robots-tag": "noindex",
    },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/data/")) return data(req, env, url.pathname);
    return env.ASSETS.fetch(req);
  },
};
