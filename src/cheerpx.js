// src/cheerpx.js — single, memoized entry point for the self-hosted CheerpX engine.
//
// The engine is large, proprietary (the trust root, R-S1), and self-hosted under
// /vendor/ (R5/R-F1). We load it with a dynamic import so Vite never tries to bundle or
// transform it (@vite-ignore) — at runtime the browser fetches /vendor/cx.esm.js, and the
// engine resolves cx_esm.js + cxcore.wasm + workers relative to that URL. Pinned to the
// version fetched by scripts/fetch-engine.sh; integrity recorded in engine.manifest.json.

export const ENGINE_VERSION = "1.2.8";
export const ENGINE_URL = "/vendor/cx.esm.js";

let _promise;

/** Load (once) and return the CheerpX module namespace. */
export function loadCheerpX() {
  if (!_promise) {
    // Compute the specifier at runtime: a string literal here makes Vite treat it as a
    // module-graph import (it rewrites it to `/vendor/cx.esm.js?import` and fails, since
    // importing from public/ is unsupported). An opaque runtime URL is left alone, so the
    // browser fetches the self-hosted engine directly and the engine resolves its own
    // relative assets (cx_esm.js, cxcore.wasm, workers) against it.
    const url = new URL(ENGINE_URL, location.origin).href;
    _promise = import(/* @vite-ignore */ url);
  }
  return _promise;
}
