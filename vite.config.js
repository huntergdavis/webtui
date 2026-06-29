import { defineConfig } from "vite";
import { createReadStream, statSync } from "node:fs";
import { resolve } from "node:path";

// Cross-origin isolation headers (PLAN §1). The deployed app gets these from
// public/_headers (Cloudflare/Netlify); the dev and preview servers need them set
// here so `crossOriginIsolated === true` locally — otherwise SharedArrayBuffer (and
// thus CheerpX) is unavailable and nothing boots. Keep these in sync with _headers.
const coiHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

// Serve the disk image ourselves so it gets the RIGHT content-type. Vite's static handler
// emits an empty Content-Type for unknown .ext2, and CheerpX fetches the disk via XHR — so
// Firefox runs its XML parser on the binary and logs "not well-formed". We force
// application/octet-stream, support HTTP range, and send Last-Modified/ETag (HttpBytesDevice
// requires a validator). COOP/COEP/CORP are already applied by the headers above.
function diskMiddleware() {
  return (req, res, next) => {
    const url = (req.url || "").split("?")[0];
    // Match "/disk/<name>.ext2" regardless of the configured base (e.g. /webtui/disk/…).
    const idx = url.indexOf("/disk/");
    if (idx === -1 || !url.endsWith(".ext2")) return next();
    let st;
    const file = resolve(process.cwd(), "public", url.slice(idx + 1));
    try {
      st = statSync(file);
    } catch {
      return next();
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Last-Modified", st.mtime.toUTCString());
    res.setHeader("ETag", `"${st.size}-${Math.floor(st.mtimeMs)}"`);
    const range = req.headers.range;
    let start = 0, end = st.size - 1;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      if (m) {
        start = parseInt(m[1], 10);
        if (m[2]) end = parseInt(m[2], 10);
        res.statusCode = 206;
        res.setHeader("Content-Range", `bytes ${start}-${end}/${st.size}`);
      }
    }
    res.setHeader("Content-Length", end - start + 1);
    if (req.method === "HEAD") return res.end();
    createReadStream(file, { start, end }).pipe(res);
  };
}

const diskPlugin = {
  name: "webtui-disk",
  configureServer(server) {
    server.middlewares.use(diskMiddleware());
  },
  configurePreviewServer(server) {
    server.middlewares.use(diskMiddleware());
  },
};

export default defineConfig({
  // GitHub Pages project site serves at https://<user>.github.io/<repo>/, so assets must
  // be base-prefixed. Default to the repo path; override VITE_BASE=/ for a custom domain
  // or user/org page. All runtime URLs (engine, disk, SW) use import.meta.env.BASE_URL.
  base: process.env.VITE_BASE || "/webtui/",
  // public/ holds deploy-time static assets served at <base> and copied to dist/ as-is:
  // _headers, coi-serviceworker.js, the self-hosted vendor/ engine, and the disk/ images.
  publicDir: "public",
  plugins: [diskPlugin],
  server: { headers: coiHeaders },
  preview: { headers: coiHeaders },
  build: {
    target: "es2022", // top-level await + modern WASM APIs CheerpX needs.
    sourcemap: true,
  },
});
