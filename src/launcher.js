// src/launcher.js — "play this TUI in your browser" via URL parameters.
//
// A repo ships a small `webtui.json` manifest describing how to install + run its TUI.
// Linking to  …/webtui/?app=owner/repo  makes webtui fetch that manifest (over CORS from
// raw.githubusercontent.com — the PAGE fetches it, the VM doesn't), show a launch panel
// with the EXACT commands, and — only after the user clicks Install & Run — type the
// clone/apt/install/run sequence into the shell.
//
// SECURITY (R2): a `?app=` link is untrusted input that ends up running code inside a
// VM that may be joined to the user's tailnet. So nothing auto-runs: the panel shows the
// repo and every command verbatim and requires an explicit click; if the manifest needs
// network it forces a Tailscale connect first. Same trust model as the user typing the
// commands themselves, but with full disclosure before the first keystroke.

import { showBanner } from "./ui.js";
import { isConnected, whenRunning } from "./net.js";

/** Manifest schema (all optional except name):
 *   { name, description, repo, network (default true), apt:[], install:string|[],
 *     run:string|[], workdir }
 */

const RAW = "https://raw.githubusercontent.com";

function toArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v.filter(Boolean) : [String(v)];
}

/** owner/repo (or a github URL) -> { owner, repo } or null. */
function parseGitHub(app) {
  let s = app.trim();
  const m = s.match(/^(?:https?:\/\/github\.com\/)?([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

/** Resolve where to fetch the manifest from the `app` param + optional ref/manifest. */
function manifestUrl(app, params) {
  // Direct manifest URL.
  if (/^https?:\/\/.+\.json(\?.*)?$/i.test(app)) return app;
  const gh = parseGitHub(app);
  if (!gh) return null;
  const ref = params.get("ref") || "HEAD";
  const path = (params.get("manifest") || "webtui.json").replace(/^\/+/, "");
  return `${RAW}/${gh.owner}/${gh.repo}/${ref}/${path}`;
}

/** Build the clone URL + command list to display and run. */
function buildPlan(app, params, m) {
  const gh = parseGitHub(m.repo || app);
  const cloneUrl = m.repo
    ? (m.repo.endsWith(".git") ? m.repo : m.repo + ".git")
    : gh
    ? `https://github.com/${gh.owner}/${gh.repo}.git`
    : null;
  const workdir = m.workdir || (gh ? gh.repo : "app");
  const network = m.network !== false; // cloning/apt needs the tunnel; default on

  const prep = [];
  if (cloneUrl) {
    prep.push("cd ~");
    // Idempotent: clone, or if it already exists pull the latest.
    prep.push(`git clone ${cloneUrl} ${workdir} 2>/dev/null || (cd ${workdir} && git pull)`);
    prep.push(`cd ${workdir}`);
  }
  if (toArray(m.apt).length) {
    prep.push(`apt-get update && apt-get install -y ${toArray(m.apt).join(" ")}`);
  }
  prep.push(...toArray(m.install));

  return {
    name: m.name || (gh ? `${gh.owner}/${gh.repo}` : "app"),
    description: m.description || "",
    cloneUrl,
    workdir,
    network,
    prep, // run as one && chain (stop on first failure)
    run: toArray(m.run),
  };
}

/**
 * Entry point. No-op unless `?app=` is present.
 * @param {{type:(s:string)=>void, connect:()=>Promise<any>}} io
 */
export async function initLauncher(io) {
  const params = new URLSearchParams(location.search);
  const app = params.get("app");
  if (!app) return;

  const url = manifestUrl(app, params);
  if (!url) {
    showLauncherError(`Can't parse app "${app}". Use ?app=owner/repo or a manifest URL.`);
    return;
  }

  let manifest;
  try {
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (err) {
    showLauncherError(
      `Couldn't load the app manifest from ${url} (${err.message}). The repo needs a ` +
        `webtui.json (see the webtui README).`
    );
    return;
  }

  renderPanel(buildPlan(app, params, manifest), io);
}

// ---- UI ------------------------------------------------------------------

function el(id) {
  return document.getElementById(id);
}

function showLauncherError(msg) {
  const panel = el("launcher");
  if (!panel) return;
  el("launcher-title").textContent = "App launcher";
  el("launcher-body").innerHTML = "";
  const p = document.createElement("p");
  p.className = "launcher-err";
  p.textContent = msg;
  el("launcher-body").appendChild(p);
  el("launcher-run").hidden = true;
  panel.removeAttribute("hidden");
}

function renderPanel(plan, io) {
  const panel = el("launcher");
  if (!panel) return;

  el("launcher-title").textContent = `Run “${plan.name}” in your browser`;

  const body = el("launcher-body");
  body.innerHTML = "";

  if (plan.description) {
    const d = document.createElement("p");
    d.className = "launcher-desc";
    d.textContent = plan.description;
    body.appendChild(d);
  }

  if (plan.network) {
    const n = document.createElement("p");
    n.className = "launcher-net";
    n.textContent = isConnected()
      ? "Network: Tailscale connected ✓"
      : "Needs network — you'll be asked to connect Tailscale first.";
    body.appendChild(n);
  }

  const label = document.createElement("p");
  label.className = "launcher-label";
  label.textContent = "These commands will run in the terminal:";
  body.appendChild(label);

  const pre = document.createElement("pre");
  pre.className = "launcher-cmds";
  pre.textContent = [...plan.prep, ...plan.run].join("\n");
  body.appendChild(pre);

  const runBtn = el("launcher-run");
  runBtn.hidden = false;
  runBtn.disabled = false;
  runBtn.textContent = "Install & Run";
  runBtn.onclick = () => launch(plan, io, runBtn);

  el("launcher-cancel").onclick = () => panel.setAttribute("hidden", "");

  panel.removeAttribute("hidden");
}

async function launch(plan, io, runBtn) {
  runBtn.disabled = true;
  try {
    if (plan.network && !isConnected()) {
      runBtn.textContent = "Connecting Tailscale…";
      await io.connect();
      await whenRunning();
    }
    runBtn.textContent = "Running…";
    el("launcher").setAttribute("hidden", "");
    document.getElementById("screen")?.querySelector(".xterm-helper-textarea")?.focus();

    // Clear any partial input, then run everything as one stop-on-error chain so the app
    // only launches if clone + deps + install all succeeded.
    io.type("\x15");
    const chain = [...plan.prep, ...plan.run].join(" && ");
    if (chain) io.type(chain + "\n");
    showBanner(`Launching ${plan.name} — watch the terminal.`, "ok");
  } catch (err) {
    runBtn.disabled = false;
    runBtn.textContent = "Install & Run";
    showBanner(`Launch aborted: ${String(err && err.message || err)}`, "error");
  }
}
