// src/ui.js — small, dependency-free DOM helpers for the status bar and boot banner.
// Kept deliberately tiny: this file is part of the trusted page-code surface (§11/R2),
// so it does only DOM text updates — no network, no eval, no secret handling.

/**
 * Show the top banner. Levels: "ok" | "warn" | "error". Pass null to hide.
 * @param {string|null} message
 * @param {"ok"|"warn"|"error"} [level]
 */
export function showBanner(message, level = "ok") {
  const el = document.getElementById("banner");
  if (!el) return;
  if (message == null) {
    el.hidden = true;
    el.textContent = "";
    el.removeAttribute("data-level");
    return;
  }
  el.hidden = false;
  el.dataset.level = level;
  el.textContent = message;
}

/**
 * Update a single status-bar value by element id, with an optional severity color.
 * @param {string} id  element id, e.g. "status-isolation"
 * @param {string} text
 * @param {"ok"|"warn"|"error"|null} [level]
 */
export function setStatus(id, text, level = null) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  if (level) el.dataset.level = level;
  else el.removeAttribute("data-level");
}

/**
 * Enable/disable a control button by id.
 * @param {string} id
 * @param {boolean} enabled
 */
export function setButtonEnabled(id, enabled) {
  const el = document.getElementById(id);
  if (el) el.disabled = !enabled;
}
