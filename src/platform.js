// src/platform.js — measure the real per-tab WASM ceiling and size the VM (PLAN §14.1–2).
//
// The limiter is the browser's per-tab WebAssembly memory cap, NOT device RAM, and it
// differs across engines (V8 vs SpiderMonkey, desktop vs Android) — so we PROBE it rather
// than trust the user agent (R-F2). The result picks the full vs lite disk image and is
// surfaced in the status bar so OOM is legible, not a blank crash (R14).

/**
 * Binary-search the largest shared WebAssembly.Memory the browser will grant, in bytes.
 * Each trial reservation is discarded (GC'd) before the next.
 */
export function probeWasmMemoryCeiling() {
  let lo = 16, hi = 65536 /* 4 GiB in 64KiB pages */, ok = 16;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      // eslint-disable-next-line no-new
      new WebAssembly.Memory({ initial: mid, maximum: mid, shared: true });
      ok = mid;
      lo = mid + 1;
    } catch {
      hi = mid - 1;
    }
  }
  return ok * 65536;
}

/**
 * Detect the platform budget and choose an image.
 * @returns {{capMB:number, maxMemoryMB:number, lowMem:boolean, isMobileUA:boolean,
 *            deviceMemory:(number|null), image:("full"|"lite")}}
 */
export function detectPlatformBudget() {
  const cap = probeWasmMemoryCeiling();
  const capMB = Math.floor(cap / (1024 * 1024));
  const isMobileUA = /Android|iPhone|iPad/.test(navigator.userAgent);
  const lowMem = cap < 768 * 1024 * 1024;
  return {
    capMB,
    // Leave headroom under the measured cap; mobiles get a tighter target.
    maxMemoryMB: Math.min(capMB, isMobileUA ? 1024 : 3072),
    lowMem,
    isMobileUA,
    deviceMemory: navigator.deviceMemory || null,
    image: lowMem ? "lite" : "full",
  };
}
