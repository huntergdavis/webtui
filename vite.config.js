import { defineConfig } from "vite";

// Cross-origin isolation headers (PLAN §1). The deployed app gets these from
// public/_headers (Cloudflare/Netlify); the dev and preview servers need them set
// here so `crossOriginIsolated === true` locally — otherwise SharedArrayBuffer (and
// thus CheerpX) is unavailable and nothing boots. Keep these in sync with _headers.
const coiHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export default defineConfig({
  // public/ holds deploy-time static assets served at root and copied to dist/ as-is:
  // _headers now, and the self-hosted vendor/ engine + disk/ image in later phases.
  publicDir: "public",
  server: {
    headers: coiHeaders,
  },
  preview: {
    headers: coiHeaders,
  },
  build: {
    target: "es2022", // top-level await + modern WASM APIs CheerpX needs.
    sourcemap: true,
  },
});
