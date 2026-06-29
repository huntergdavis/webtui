// src/main.js — boot orchestrator (PLAN §4).
//
// Phase 3: isolation gate -> platform probe -> terminal -> overlay storage -> VM -> wire
// I/O -> login shell. Networking (Connect) and the vault (Unlock) arrive in Phases 5/6;
// their buttons stay disabled for now.

import { showBanner, setStatus, setButtonEnabled, formatBytes } from "./ui.js";
import { detectPlatformBudget } from "./platform.js";
import { initTerminal, wireTerminalToVM } from "./terminal.js";
import { initStorage, clearDisk } from "./storage.js";
import { initVM, startShell } from "./vm.js";
import { ENGINE_VERSION } from "./cheerpx.js";
import { startBootProgress, setBootTitle, stopBootProgress } from "./progress.js";

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

// Surface otherwise-silent failures (uncaught errors, rejected promises from the engine
// or workers) instead of leaving the user with a frozen overlay (R14 legibility).
const _diag = [];
function recordDiag(label, detail) {
  const line = `${label}: ${detail}`;
  _diag.push(line);
  console.error("[webtui]", line);
  // Mirror into a hidden DOM node so headless/inspection can read it.
  let el = document.getElementById("diag");
  if (!el) {
    el = document.createElement("pre");
    el.id = "diag";
    el.style.display = "none";
    document.body.appendChild(el);
  }
  el.textContent = _diag.join("\n");
}
window.addEventListener("error", (e) =>
  recordDiag("window.error", `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`)
);
window.addEventListener("unhandledrejection", (e) =>
  recordDiag("unhandledrejection", String((e.reason && (e.reason.stack || e.reason.message)) || e.reason))
);

/**
 * Reflect persistence + quota/usage in the Storage status item (Phase 4). A denied
 * persistence grant (private window, low-engagement origin) is a warning, not an error:
 * the overlay still works, it's just evictable.
 * @param {{supported:boolean,persisted:boolean,quota:number,usage:number}} p
 */
function reportStorage(p) {
  if (!p || !p.supported) {
    setStatus("status-storage", "unavailable", "warn");
    return;
  }
  const used = formatBytes(p.usage);
  const quota = p.quota ? ` / ${formatBytes(p.quota)}` : "";
  if (p.persisted) {
    setStatus("status-storage", `persistent · ${used}${quota}`, "ok");
  } else {
    setStatus("status-storage", `not persisted (evictable) · ${used}${quota}`, "warn");
    showBanner(
      "Storage is not persistent — the browser may evict this disk under storage " +
        "pressure (expected in a private window). Your files survive a normal reload, " +
        "but don't store anything you can't recreate.",
      "warn"
    );
  }
}

/** Enable + wire the Factory reset button (Phase 4). */
function wireFactoryReset() {
  const btn = document.getElementById("btn-reset");
  if (!btn) return;
  setButtonEnabled("btn-reset", true);
  btn.addEventListener("click", async () => {
    const ok = window.confirm(
      "Factory reset: this permanently deletes everything written to the disk — " +
        "installed packages, files, shell history, and any SSH keys. The tab will " +
        "reload into a pristine system. Continue?"
    );
    if (!ok) return;
    setButtonEnabled("btn-reset", false);
    setStatus("status-storage", "resetting…", "warn");
    try {
      await clearDisk();
    } catch (err) {
      console.error("factory reset failed:", err);
      showBanner("Factory reset failed: " + String(err && err.message || err), "error");
      setButtonEnabled("btn-reset", true);
      return;
    }
    // Whether deleteDatabase completed or is blocked on the running VM's open handles,
    // reloading closes those handles and starts from the base image.
    location.reload();
  });
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
    "status-memory",
    `${budget.capMB} MB cap · ${budget.image} image`,
    budget.lowMem ? "warn" : "ok"
  );

  // 3. Terminal.
  const { term } = initTerminal(document.getElementById("screen"));

  // 4–7. Storage -> VM -> wire -> shell. First boot is a real download (R9): show a live
  // progress overlay (elapsed + MB downloaded via the IDB cache growth) until the VM speaks.
  try {
    await startBootProgress(`Loading CheerpX ${ENGINE_VERSION}…`);
    const storage = await initStorage();
    reportStorage(storage.persistence);
    // The overlay now exists, so a reset is meaningful — enable the button.
    wireFactoryReset();
    setBootTitle("Booting Debian — streaming disk…");
    const cx = await initVM(storage, { image: budget.image });
    // Tear the overlay down the moment the VM produces its first byte of output.
    wireTerminalToVM(cx, term, { onFirstOutput: stopBootProgress });
    term.focus();
    // Resolves only when the shell exits; if it does, tell the user rather than hang.
    const { status } = await startShell(cx);
    stopBootProgress();
    showBanner(`Shell exited (status ${status}). Reload to start a new session.`, "warn");
  } catch (err) {
    console.error(err);
    stopBootProgress();
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
