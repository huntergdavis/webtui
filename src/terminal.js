// src/terminal.js — xterm.js setup and the CheerpX <-> terminal wiring (PLAN §7.1).

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

// Real font stack (xterm renders to canvas and can't read CSS vars). Phase 7 swaps this
// for the dyslexia-friendly / sizing options (R-A5).
const TERM_FONT =
  'ui-monospace, "Cascadia Code", "Fira Code", Menlo, Consolas, "DejaVu Sans Mono", monospace';

/** Create the terminal, mount it in `el`, and keep it fitted to the container. */
export function initTerminal(el) {
  const term = new Terminal({
    convertEol: false, // the guest pty already emits CRLF
    cursorBlink: true,
    fontFamily: TERM_FONT,
    fontSize: 14,
    scrollback: 5000,
    allowProposedApi: true,
    theme: { background: "#000000", foreground: "#d6deeb" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  fit.fit();
  // Refit on container resize (window resize, status-bar reflow, etc.).
  const ro = new ResizeObserver(() => {
    try { fit.fit(); } catch { /* ignore transient 0-size */ }
  });
  ro.observe(el);
  return { term, fit };
}

/**
 * Wire VM stdout/stderr -> xterm and keystrokes -> VM stdin.
 * CheerpX 1.2.8: `setCustomConsole(writeFn(buf:Uint8Array, vt), cols, rows)` returns a
 * `send(byteCode)` used to push one input byte at a time (VERIFIED 2026-06).
 * @param {object} cx
 * @param {import("@xterm/xterm").Terminal} term
 * @param {{onFirstOutput?: () => void}} [hooks]
 * @returns {{dispose: () => void, type: (s: string) => void}} teardown + a programmatic
 *   stdin injector (used by the vault buttons to run guest commands). `type` feeds bytes
 *   exactly as if the user typed them — it does not bypass the shell.
 */
export function wireTerminalToVM(cx, term, hooks = {}) {
  let firstSeen = false;
  const write = (buf) => {
    if (!firstSeen && buf && buf.length) {
      firstSeen = true;
      try { hooks.onFirstOutput?.(); } catch { /* non-fatal */ }
    }
    term.write(buf);
  };
  let send = cx.setCustomConsole(write, term.cols, term.rows);

  const enc = new TextEncoder();
  const feed = (str) => {
    const bytes = enc.encode(str); // handle UTF-8 input, not just ASCII
    for (let i = 0; i < bytes.length; i++) send(bytes[i]);
  };
  // Optional one-shot transform for the next real keystroke (sticky Ctrl/Alt from the
  // soft-key bar). Applies to keyboard input only; `type` (programmatic) bypasses it.
  let inputTransform = null;
  const dataSub = term.onData((data) => {
    let d = data;
    if (inputTransform) {
      const t = inputTransform;
      inputTransform = null; // one-shot
      d = t(data);
    }
    feed(d);
  });

  // No setConsoleSize in 1.2.8 — re-register the console at the new geometry on resize so
  // the guest sees the right cols/rows. Swap the live `send`.
  const resizeSub = term.onResize(({ cols, rows }) => {
    send = cx.setCustomConsole(write, cols, rows);
  });

  return {
    dispose: () => { dataSub.dispose(); resizeSub.dispose(); },
    type: feed,
    /** Arm a one-shot transform applied to the next real keystroke (sticky modifiers). */
    setNextKeyTransform: (fn) => { inputTransform = fn; },
  };
}
