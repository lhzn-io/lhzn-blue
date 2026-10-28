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

// In development, a page's stylesheets linked in its <head>, as the build links them: the dev server otherwise adds them
// from JavaScript once every module has loaded, and a page (slowest on a phone over the LAN) first paints unstyled.
// The stylesheets are the ones the page's script imports, followed through its local imports. The modules' own
// imports still add the same rules after, which changes nothing. The build is untouched.
function devStyles(): Plugin {
  const SRC = resolve(import.meta.dirname, "src");
  const cssOf = async (file: string, seen: Set<string>, out: Set<string>): Promise<void> => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = await readFile(file, "utf8").catch(() => "");
    for (const [, spec] of text.matchAll(/^\s*import\s+(?:[^"';]*?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/gm)) {
      const path = resolve(file, "..", spec);
      if (path.endsWith(".css")) out.add(path);
      else if (spec.endsWith(".ts") || !/\.\w+$/.test(spec)) await cssOf(path.endsWith(".ts") ? path : `${path}.ts`, seen, out);
    }
  };
  return {
    name: "dev-styles",
    apply: "serve",
    async transformIndexHtml(html, ctx) {
      // The page's script, written from the site's root ("/src/lis.ts") or from the page's own folder ("../../src/...").
      const src = html.match(/<script type="module" src="([^"]+\.ts)"/)?.[1];
      if (!src) return html;
      const entry = src.startsWith("/") ? resolve(import.meta.dirname, `.${src}`) : resolve(ctx.filename, "..", src);
      const css = new Set<string>();
      await cssOf(entry, new Set(), css);
      // "?direct": the stylesheet itself, whatever the request accepts (a bare /src/x.css can be served as a module).
      const links = [...css].map((p) => `<link rel="stylesheet" href="/src/${p.slice(SRC.length + 1).replace(/\\/g, "/")}?direct" />`).join("\n    ");
      return html.replace("</head>", `    ${links}\n  </head>`);
    },
  };
}

// Pages: the landing page, one page per waterway, the about page, the terms and the references. Station pages are served
// under /long-island-sound/ and /piscataqua-region/; more bases for local work come from LHZN_STATION_PAGES
// (comma-separated) in a git-ignored .env.local.
export default defineConfig(({ mode }) => ({
  base: "/",
  plugins: [devStyles(), localData(["/long-island-sound/", "/piscataqua-region/", ...(loadEnv(mode, import.meta.dirname, "").LHZN_STATION_PAGES ?? "").split(",").map((s) => s.trim()).filter(Boolean)])],
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
