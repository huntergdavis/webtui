// src/main.js — boot orchestrator.
//
// Build status: Phase 1. The full orchestration (terminal → storage → VM → shell →
// networking → vault) is filled in across PLAN.md §4 in later phases. For now main()
// proves the single thing that gates everything else: the page is cross-origin isolated,
// so SharedArrayBuffer (and therefore CheerpX) will be available (PLAN §1, §4.1).

import { showBanner, setStatus } from "./ui.js";

/** Thrown when the page cannot host the VM (e.g. not cross-origin isolated). */
export class BootError extends Error {
  constructor(message) {
    super(message);
    this.name = "BootError";
  }
}

/**
 * Hard-fail (with a readable message) unless the page is cross-origin isolated.
 * CheerpX needs SharedArrayBuffer, which the browser only grants under
 * COOP: same-origin + COEP: require-corp on a secure (HTTPS) context. (PLAN §4.1)
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
  // The one gate that blocks the whole project. Report it loudly either way.
  try {
    ensureCrossOriginIsolated();
  } catch (err) {
    console.error(err);
    setStatus("status-isolation", "NOT isolated", "error");
    showBanner(err instanceof BootError ? err.message : String(err), "error");
    return; // Nothing else can boot without this; stop here with a legible message.
  }

  console.log("crossOriginIsolated ===", self.crossOriginIsolated);
  setStatus("status-isolation", "isolated", "ok");

  // Phase 2+ wiring lands here:
  //   const term = initTerminal(document.getElementById("screen"));   // §7.1
  //   const storage = await initStorage();                            // §5
  //   const cx = await initVM(storage, term);                         // §4.2
  //   wireTerminalToVM(cx, term);                                     // §7.1
  //   setupConnectButton(cx);                                         // §6/§7
  //   await startShell(cx, term);                                     // §4.3
  showBanner(
    "Phase 1 OK: cross-origin isolated. Terminal + VM boot land in Phase 3.",
    "ok"
  );
}

main();
