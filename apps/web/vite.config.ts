import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";

const REPO = resolve(import.meta.dirname, "../..");

// In development, serve /data/v1/* from the jobs' local output (`lhzn-blue-jobs ... --out out`).
// In production the Worker proxies /data/v1/* from the public data bucket.
function localData(stationPages: string[]): Plugin {
  return {
    name: "local-data",
    configureServer(server) {
      // A waterway's station pages (<base><station>/) are its own page, as the Worker serves them; a path with a page
      // of its own (the Sound's forecast, tides and models) stays that page. A page's address without its trailing
      // slash is redirected to it, as in production.
      const hasPage = (path: string) => existsSync(resolve(import.meta.dirname, `.${path}`, "index.html"));
      const stationBase = (path: string) =>
        !hasPage(path) && stationPages.find((b) => path.startsWith(b) && /^[a-z0-9-]{2,20}\/$/.test(path.slice(b.length)));
      server.middlewares.use((req, res, next) => {
        const [path, query] = (req.url ?? "").split("?");
        if (!path.endsWith("/") && (hasPage(`${path}/`) || stationBase(`${path}/`))) {
          res.writeHead(301, { location: `${path}/${query ? `?${query}` : ""}` });
          res.end();
          return;
        }
        const base = stationBase(path);
        if (base) req.url = base + (query ? `?${query}` : "");
        next();
      });
      server.middlewares.use("/data/", async (req, res, next) => {
        try {
          const body = await readFile(resolve(REPO, "out", (req.url ?? "").replace(/^\/+/, "").split("?")[0]));
          res.setHeader("content-type", "application/json");
          res.end(body);
        } catch {
          next();
        }
      });
    },
  };
}

// Pages: the landing page, one page per waterway, the about page, the terms and the references. Station pages are served
// under /long-island-sound/ and /piscataqua-region/; more bases for local work come from LHZN_STATION_PAGES
// (comma-separated) in a git-ignored .env.local.
export default defineConfig(({ mode }) => ({
  base: "/",
  plugins: [localData(["/long-island-sound/", "/piscataqua-region/", ...(loadEnv(mode, import.meta.dirname, "").LHZN_STATION_PAGES ?? "").split(",").map((s) => s.trim()).filter(Boolean)])],
  server: { fs: { allow: [REPO] } },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1100, // the MapLibre chunk, loaded on demand by the locator map only
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        lis: resolve(import.meta.dirname, "long-island-sound/index.html"),
        terms: resolve(import.meta.dirname, "terms/index.html"),
        references: resolve(import.meta.dirname, "references/index.html"),
        about: resolve(import.meta.dirname, "about/index.html"),
        forecast: resolve(import.meta.dirname, "long-island-sound/forecast/index.html"),
        tides: resolve(import.meta.dirname, "long-island-sound/tides/index.html"),
        models: resolve(import.meta.dirname, "long-island-sound/models/index.html"),
        "portsmouth-harbor": resolve(import.meta.dirname, "portsmouth-harbor/index.html"), // unlisted: noindex, kept out of the sitemap and the nav
        "piscataqua-region": resolve(import.meta.dirname, "piscataqua-region/index.html"), // as above
      },
    },
  },
}));
