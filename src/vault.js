// src/vault.js — host-side glue for the guest encrypted vault (PLAN §8.1, §8.3).
//
// The vault itself lives in the guest (vault-init / vault-unlock / vault-lock scripts on
// the disk image); this module only drives those scripts from the page UI and enforces
// lock-on-idle / lock-on-blur (the "in use" mitigations from the §8 threat model).
//
// We drive the guest by typing into the interactive shell (the same stdin path as the
// user), rather than spawning a parallel process — that keeps a single, well-understood
// execution context. LIMITATION: this assumes an idle shell prompt; if a full-screen
// foreground program (vim, less) is active, the injected command goes to that program
// instead. Lock from a clean prompt. (Documented; acceptable for single-user use.)
//
// NOTE (§8 honesty): locking clears keys at rest + in the agent, but cannot protect a
// session whose page code is already compromised — keystrokes (incl. the age passphrase)
// flow through page JS regardless. That residual is why §8.4 short-lived creds matter.

import { setButtonEnabled, showBanner } from "./ui.js";

const IDLE_MS = 5 * 60 * 1000; // auto-lock after 5 min of no input

let _type = null; // stdin injector from wireTerminalToVM
let _locked = true; // best-effort host view of guest vault state
let _idleTimer = null;

/** Submit a command on a clean prompt line: Ctrl-U clears any partial input, then run it. */
function runInShell(cmd) {
  if (_type) _type("\x15" + cmd + "\n");
}

/**
 * Enable + wire the Unlock / Lock buttons and auto-lock triggers.
 * @param {(s:string)=>void} type  the terminal stdin injector
 */
export function wireVault(type) {
  _type = type;

  const unlock = document.getElementById("btn-unlock");
  if (unlock) {
    setButtonEnabled("btn-unlock", true);
    unlock.addEventListener("click", () => {
      // The guest prompts for the age passphrase in the terminal; focus it for the user.
      runInShell("vault-unlock");
      document.getElementById("screen")?.querySelector(".xterm")?.focus();
      _locked = false; // optimistic; vault-lock is idempotent if this was wrong
      resetIdle();
    });
  }

  const lock = document.getElementById("btn-lock");
  if (lock) {
    setButtonEnabled("btn-lock", true);
    lock.addEventListener("click", () => doLock(null));
  }

  // Auto-lock on tab blur and on becoming hidden (R: "in use" exposure).
  window.addEventListener("blur", () => maybeLock("focus lost"));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) maybeLock("tab hidden");
  });

  // Idle auto-lock: any keypress/pointer resets the timer.
  ["keydown", "pointerdown"].forEach((ev) =>
    window.addEventListener(ev, resetIdle, { passive: true })
  );
  resetIdle();
}

function resetIdle() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => maybeLock("idle timeout"), IDLE_MS);
}

function maybeLock(reason) {
  if (_locked) return; // nothing to do; avoid spamming the shell
  doLock(reason);
}

function doLock(reason) {
  runInShell("vault-lock");
  _locked = true;
  showBanner(reason ? `Vault auto-locked (${reason}).` : "Vault locked.", "ok");
}
