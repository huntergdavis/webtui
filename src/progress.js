// src/progress.js — boot progress overlay.
//
// CheerpX streams the disk and engine wasm from inside Web Workers (and via XHR), so those
// requests are invisible to the page's fetch/PerformanceObserver — a main-thread byte meter
// can't see them, and the plan deliberately avoids a Service Worker (R12/R-F4/R-S9). The
// honest no-SW signal: fetched base blocks are cached into the IndexedDB overlay, so
// navigator.storage.estimate().usage climbs as the disk downloads. We surface that as
// MB-downloaded + rate alongside an elapsed clock and an indeterminate bar, and tear the
// overlay down the instant the VM produces its first byte of output.

let timer = null;
let t0 = 0;
let baseUsage = 0;
let lastUsage = 0;
let lastT = 0;
let peakRate = 0;

const $ = (id) => document.getElementById(id);

async function usage() {
  try {
    const { usage } = await navigator.storage.estimate();
    return usage || 0;
  } catch {
    return 0;
  }
}

function fmtMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

async function tick() {
  const now = performance.now();
  const elapsed = (now - t0) / 1000;
  const u = await usage();
  const downloaded = Math.max(0, u - baseUsage);

  // Smooth instantaneous rate; remember the peak so a brief idle doesn't read as "stalled".
  const dt = (now - lastT) / 1000;
  if (dt > 0) {
    const rate = Math.max(0, (u - lastUsage) / dt);
    if (rate > peakRate) peakRate = rate;
  }
  lastUsage = u;
  lastT = now;

  const stats = $("boot-stats");
  if (stats) {
    const rateStr = peakRate > 0 ? ` · ~${(peakRate / (1024 * 1024)).toFixed(1)} MB/s` : "";
    stats.textContent = `${fmtMB(downloaded)} downloaded · ${elapsed.toFixed(0)}s${rateStr}`;
  }
}

/** Show the overlay and start polling. */
export async function startBootProgress(title = "Booting Debian…") {
  const overlay = $("boot-overlay");
  if (overlay) overlay.hidden = false;
  setBootTitle(title);
  t0 = performance.now();
  lastT = t0;
  baseUsage = await usage();
  lastUsage = baseUsage;
  peakRate = 0;
  if (timer) clearInterval(timer);
  timer = setInterval(tick, 300);
  tick();
}

/** Update the overlay's title line (phase). */
export function setBootTitle(title) {
  const el = $("boot-title");
  if (el) el.textContent = title;
}

/** Hide the overlay and stop polling. */
export function stopBootProgress() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const overlay = $("boot-overlay");
  if (overlay) overlay.hidden = true;
}
