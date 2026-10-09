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

// Two pages: the landing page and one page per waterway.
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
      },
    },
  },
});
