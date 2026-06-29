// src/net.js — Tailscale networking + auth (PLAN §6).
//
// VERIFIED 2026-06 against CheerpX 1.2.8 (cheerpx.io/docs/guides/Networking and the
// vendored tun/ backend):
//   - You pass a `networkInterface` object to CheerpX.Linux.create with the callbacks
//     below. CheerpX hands it to the vendored tun backend's autoConf(), so the field
//     names here must match autoConf's params exactly (loginUrlCb, stateUpdateCb,
//     netmapUpdateCb, controlUrl, authKey, dnsIp).
//   - The Tailscale connection is LAZY: nothing dials out at create() time. It starts
//     when `await cx.networkLogin()` is called — that's the Connect button. So we can
//     always pass the interface at boot and stay offline until the user connects.
//   - Exit-node selection: the vendored auto backend (tailscale_tun_auto.js) picks the
//     FIRST online exit node in the netmap and routes through it; there is no override
//     hook exposed through autoConf. So the picker below records a *preference* (for
//     display + future backends) and surfaces the active node, but does not force a
//     specific one. Documented limitation, not a bug.
//
// No authKey is ever hardcoded; auth is interactive SSO via loginUrlCb. The node is
// registered ephemeral (Tailscale ACL policy, PLAN §10), so re-auth on reload is normal.

import { setStatus, showBanner, setButtonEnabled } from "./ui.js";

/** Tailscale ipn state codes (mirror of tun/ State enum). */
const STATE = {
  0: { label: "no state", level: "warn" },
  1: { label: "in use elsewhere", level: "error" },
  2: { label: "needs login", level: "warn" },
  3: { label: "needs machine auth", level: "warn" },
  4: { label: "stopped", level: "warn" },
  5: { label: "starting…", level: "warn" },
  6: { label: "running", level: "ok" },
};
const RUNNING = 6;

const EXIT_NODE_KEY = "webtui.exitNodePref"; // persisted preferred exit-node name

let _onExitNodes = null; // UI callback: (nodes[], activeName|null) => void
let _connected = false;

/**
 * Register a callback that receives the exit-node list whenever the netmap updates.
 * @param {(nodes: Array<{name:string, ip:string, online:boolean}>, activeName: string|null) => void} cb
 */
export function onExitNodes(cb) {
  _onExitNodes = cb;
}

/** The user's persisted preferred exit-node name (display/auto-select hint), or null. */
export function preferredExitNode() {
  try {
    return localStorage.getItem(EXIT_NODE_KEY) || null;
  } catch {
    return null;
  }
}

/** Persist the preferred exit-node name. */
export function setPreferredExitNode(name) {
  try {
    if (name) localStorage.setItem(EXIT_NODE_KEY, name);
    else localStorage.removeItem(EXIT_NODE_KEY);
  } catch {
    /* storage may be unavailable (private window) — non-fatal */
  }
}

/**
 * Build the networkInterface for CheerpX.Linux.create (PLAN §6.1). Safe to pass at boot:
 * the connection is dormant until connectNetwork() calls cx.networkLogin().
 * @returns {object}
 */
export function buildNetworkInterface() {
  return {
    // controlUrl omitted -> default Tailscale control plane.
    // Headscale self-host would set: controlUrl: "https://headscale.example.ts.net".
    loginUrlCb: (url) => openAuthPopup(url),
    stateUpdateCb: (state) => onState(state),
    netmapUpdateCb: (map) => onNetmap(map),
    dnsIp: "100.100.100.100", // MagicDNS; resolves tailnet names + forwards public DNS.
    // authKey: intentionally absent — interactive SSO only (R-S*).
  };
}

/** State transitions -> status bar. */
function onState(state) {
  const s = STATE[state] || { label: `state ${state}`, level: "warn" };
  setStatus("status-tailscale", s.label, s.level);
  if (state === RUNNING) {
    _connected = true;
    setButtonEnabled("btn-connect", false);
  }
}

/**
 * Netmap update -> exit-node picker + active-node display (PLAN §6.4).
 * The auto backend routes through the first online exit node; we report which peers
 * advertise as exit nodes and which one is live so the status bar is truthful.
 */
function onNetmap(map) {
  if (!map || !Array.isArray(map.peers)) return;
  const nodes = map.peers
    .filter((p) => p.exitNode) // advertises exit-node capability
    .map((p) => ({
      name: p.name || p.hostName || (p.addresses && p.addresses[0]) || "peer",
      ip: (p.addresses && p.addresses[0]) || "",
      online: !!p.online,
    }));

  // The auto backend selects the first ONLINE exit node — mirror that to show "active".
  const active = nodes.find((n) => n.online) || null;
  setStatus(
    "status-exitnode",
    active ? active.name : nodes.length ? "available (none active)" : "none",
    active ? "ok" : "warn"
  );
  if (_onExitNodes) {
    try {
      _onExitNodes(nodes, active ? active.name : null);
    } catch (err) {
      console.warn("[webtui] exit-node UI callback failed:", err);
    }
  }
}

/**
 * Bring the tunnel up (Connect button). Triggers loginUrlCb if not already authed; the
 * promise resolves once CheerpX has kicked off the login flow. State progresses to
 * Running via stateUpdateCb. (PLAN §6.3)
 * @param {object} cx
 */
export async function connectNetwork(cx) {
  if (_connected) return;
  setStatus("status-tailscale", "connecting…", "warn");
  setButtonEnabled("btn-connect", false);
  try {
    await cx.networkLogin();
  } catch (err) {
    console.error("[webtui] networkLogin failed:", err);
    setStatus("status-tailscale", "connect failed", "error");
    showBanner("Tailscale connect failed: " + String(err && err.message || err), "error");
    setButtonEnabled("btn-connect", true); // let them retry
    throw err;
  }
}

/**
 * Open the Tailscale SSO popup. Popup-blocked -> render an inline click-through link so
 * the user is never stuck (PLAN §6.2). The user completes SSO and approves this
 * ephemeral node; the netmap then arrives via netmapUpdateCb.
 * @param {string} url
 */
export function openAuthPopup(url) {
  // NOTE: don't pass "noopener" in the features string — it forces window.open to return
  // null, which we can't distinguish from a blocked popup. We harden the opened window
  // instead (w.opener = null) so the SSO page can't reach back into this context.
  let w = null;
  try {
    w = window.open(url, "ts-auth", "width=520,height=680");
  } catch {
    w = null;
  }
  if (!w) {
    showInlineAuthLink(url);
  } else {
    try { w.opener = null; } catch { /* cross-origin after navigation — fine */ }
    showBanner("Complete Tailscale sign-in in the popup window…", "ok");
  }
}

/** Popup blocked: surface a real, clickable link in the banner (no glyph-only UI, R-A5). */
function showInlineAuthLink(url) {
  const el = document.getElementById("banner");
  if (!el) {
    // Last-ditch: at least log it so the URL is reachable from the console.
    console.warn("[webtui] Tailscale login URL (popup blocked):", url);
    return;
  }
  el.hidden = false;
  el.dataset.level = "warn";
  el.textContent = "Popup blocked — open Tailscale sign-in manually: ";
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = url;
  el.appendChild(a);
}
