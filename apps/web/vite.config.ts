import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const REPO = resolve(import.meta.dirname, "../..");

// In development, serve /data/v1/* from the jobs' local output (`lhzn-blue-jobs ... --out out`).
// In production the Worker proxies /data/v1/* from the public data bucket.
function localData(): Plugin {
  return {
    name: "local-data",
    configureServer(server) {
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

// Pages: the landing page, one page per waterway, the about page, the terms and the references.
export default defineConfig({
  base: "/",
  plugins: [localData()],
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
});
