// src/main.js — boot orchestrator (PLAN §4).
//
// Phase 3: isolation gate -> platform probe -> terminal -> overlay storage -> VM -> wire
// I/O -> login shell. Networking (Connect) and the vault (Unlock) arrive in Phases 5/6;
// their buttons stay disabled for now.

import { showBanner, setStatus } from "./ui.js";
import { detectPlatformBudget } from "./platform.js";
import { initTerminal, wireTerminalToVM } from "./terminal.js";
import { initStorage } from "./storage.js";
import { initVM, startShell } from "./vm.js";
import { ENGINE_VERSION } from "./cheerpx.js";

/** Thrown when the page cannot host the VM (e.g. not cross-origin isolated). */
export class BootError extends Error {
  constructor(message) {
    super(message);
    this.name = "BootError";
  }
}

/**
 * Hard-fail (with a readable message) unless the page is cross-origin isolated.
 * CheerpX needs SharedArrayBuffer, granted only under COOP: same-origin +
 * COEP: require-corp on a secure (HTTPS) context. (PLAN §4.1)
 * @throws {BootError}
 */
export function ensureCrossOriginIsolated() {
  if (!self.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
    throw new BootError(
      "Not cross-origin isolated — SharedArrayBuffer is unavailable. " +
        "Check COOP/COEP response headers (_headers), use HTTPS, and load over a " +
        "header-capable host (Cloudflare/Netlify). See PLAN.md §1."
    );
  }
}

async function main() {
  // 1. The gate that blocks everything else.
  try {
    ensureCrossOriginIsolated();
  } catch (err) {
    console.error(err);
    setStatus("status-isolation", "NOT isolated", "error");
    showBanner(err instanceof BootError ? err.message : String(err), "error");
    return;
  }
  console.log("crossOriginIsolated ===", self.crossOriginIsolated);
  setStatus("status-isolation", "isolated", "ok");

  // 2. Measure the per-tab WASM ceiling and choose an image (R-F2/R14).
  const budget = detectPlatformBudget();
  console.log("platform budget:", budget);
  setStatus(
    "status-storage", // reuse the storage slot to show the memory budget until Phase 4
    `${budget.capMB} MB cap · ${budget.image} image`,
    budget.lowMem ? "warn" : "ok"
  );

  // 3. Terminal.
  const { term } = initTerminal(document.getElementById("screen"));

  // 4–7. Storage -> VM -> wire -> shell. First boot is a real download (R9), so narrate.
  try {
    showBanner(`Loading CheerpX ${ENGINE_VERSION} + Debian (first boot downloads blocks)…`, "ok");
    const storage = await initStorage();
    const cx = await initVM(storage, { image: budget.image });
    wireTerminalToVM(cx, term);
    showBanner(null);
    term.focus();
    // Resolves only when the shell exits; if it does, tell the user rather than hang.
    const { status } = await startShell(cx);
    showBanner(`Shell exited (status ${status}). Reload to start a new session.`, "warn");
  } catch (err) {
    console.error(err);
    const msg = String(err && err.message || err);
    if (/memory|RangeError|allocat/i.test(msg)) {
      showBanner(
        "This browser capped WASM memory for the tab. Try the lite image, close other " +
          "tabs, or use a desktop browser / Chromebook. (" + msg + ")",
        "error"
      );
    } else {
      showBanner("Boot failed: " + msg, "error");
    }
  }
}

main();
