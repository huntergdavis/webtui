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
 *   Online (clone over Tailscale):
 *     { name, description, repo, network (default true), apt:[], install:string|[],
 *       run:string|[], workdir }
 *   Offline (NO Tailscale — the page fetches files over CORS and writes them into an
 *   in-memory device mounted at /opt; for dependency-free apps, or apps whose deps are
 *   vendored into the listed files):
 *     { name, description, offline:true, files:["a.py","sub/b.py"], ref, env:{K:"V"},
 *       run:string|[] }
 */

const RAW = "https://raw.githubusercontent.com";
const APP_MNT = "/opt"; // where the app DataDevice is mounted (see vm.js)

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

  if (manifest.offline) {
    let plan;
    try {
      plan = await buildOfflinePlan(app, params, manifest);
    } catch (err) {
      showLauncherError(
        `Couldn't list files for offline launch (${err.message}). Add an explicit ` +
          `"files": [...] list to webtui.json.`
      );
      return;
    }
    renderOfflinePanel(plan, io);
  } else {
    renderPanel(buildPlan(app, params, manifest), io);
  }
}

// Skip non-code/large assets when auto-discovering a repo's files.
const SKIP = [
  /^\.git/,
  /(^|\/)screenshots?\//i,
  /(^|\/)(LICEN[CS]E|README)(\.|$)/i,
  /^webtui\.json$/,
  /\.(png|jpe?g|gif|webp|bmp|ico|svg|mp4|webm|mov|zip|gz|tgz|tar|7z|rar|pdf|woff2?|ttf|otf|mp3|wav|exe|bin)$/i,
];
const MAX_FILE = 2 * 1024 * 1024; // skip blobs > 2 MB
const MAX_FILES = 300;

function globToRe(g) {
  return new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
}

/** List a repo's code files via the GitHub trees API (CORS-enabled), minus assets. */
async function discoverFiles(gh, ref, m) {
  const res = await fetch(
    `https://api.github.com/repos/${gh.owner}/${gh.repo}/git/trees/${ref}?recursive=1`,
    { mode: "cors" }
  );
  if (!res.ok) throw new Error(`tree HTTP ${res.status}`);
  const data = await res.json();
  const extra = toArray(m.exclude).map(globToRe);
  const files = (data.tree || [])
    .filter((t) => t.type === "blob" && (t.size || 0) <= MAX_FILE)
    .map((t) => t.path)
    .filter((p) => !SKIP.some((re) => re.test(p)) && !extra.some((re) => re.test(p)));
  if (!files.length) throw new Error("no eligible files found");
  if (files.length > MAX_FILES) throw new Error(`too many files (${files.length})`);
  return files;
}

/** Build the offline plan: which files to fetch over CORS and how to run them. */
async function buildOfflinePlan(app, params, m) {
  const gh = parseGitHub(m.repo || app);
  const ref = params.get("ref") || m.ref || "HEAD";
  const base = gh ? `${RAW}/${gh.owner}/${gh.repo}/${ref}/` : null;
  // Two ways to get the app's files offline:
  //  - "bundle": one prebuilt tar/tar.gz committed to the repo (best for vendored deps).
  //  - "files" (explicit) or auto-discovery via the GitHub trees API (stdlib apps).
  const bundle = m.bundle && base ? base + String(m.bundle).replace(/^\/+/, "") : null;
  const files = bundle
    ? []
    : toArray(m.files).length
    ? toArray(m.files)
    : gh
    ? await discoverFiles(gh, ref, m)
    : [];
  const env = m.env && typeof m.env === "object" ? m.env : {};
  const envPrefix = Object.entries(env)
    .map(([k, v]) => `${k}=${v} `)
    .join("");
  const dir = (m.workdir || (gh ? gh.repo : "app")).replace(/[^A-Za-z0-9._-]/g, "_");
  const extractDir = `/root/${dir}`;
  // The page writes the tar into /opt (DataDevice: host-writable, guest-READ-only), so the
  // guest reads it from there but extracts into the writable overlay at /root/<dir>.
  const runLine =
    `mkdir -p ${extractDir} && cd ${extractDir} && ` +
    `tar xf ${APP_MNT}/_webtui_bundle.tar && ${envPrefix}${toArray(m.run).join(" && ")}`;
  return {
    name: m.name || (gh ? `${gh.owner}/${gh.repo}` : "app"),
    description: m.description || "",
    base,
    files,
    bundle,
    extractDir,
    runLine,
  };
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

function renderOfflinePanel(plan, io) {
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
  const n = document.createElement("p");
  n.className = "launcher-net";
  n.style.color = "var(--ok)";
  n.textContent = "Runs fully offline — no Tailscale needed.";
  body.appendChild(n);

  const label = document.createElement("p");
  label.className = "launcher-label";
  label.textContent = plan.bundle
    ? `Fetches a prebuilt bundle into ${plan.extractDir}, then runs:`
    : `Fetches ${plan.files.length} file(s) into ${plan.extractDir}, then runs:`;
  body.appendChild(label);

  const pre = document.createElement("pre");
  pre.className = "launcher-cmds";
  const listing = plan.bundle
    ? `# ${plan.bundle.split("/").pop()}`
    : plan.files.map((f) => `# ${f}`).join("\n");
  pre.textContent = listing + "\n" + plan.runLine;
  body.appendChild(pre);

  const runBtn = el("launcher-run");
  runBtn.hidden = false;
  runBtn.disabled = false;
  runBtn.textContent = "Run";
  runBtn.onclick = () => launchOffline(plan, io, runBtn);
  el("launcher-cancel").onclick = () => panel.setAttribute("hidden", "");
  panel.removeAttribute("hidden");
}

async function launchOffline(plan, io, runBtn) {
  runBtn.disabled = true;
  if (!io.appDev) {
    showBanner("Offline launch unavailable (no app device mounted).", "error");
    return;
  }
  if (!plan.base || (!plan.bundle && !plan.files.length)) {
    showBanner("This offline manifest has nothing to fetch (no bundle or files).", "error");
    return;
  }
  try {
    runBtn.textContent = "Fetching…";
    // The page (which has network even when the VM doesn't) fetches the app bytes over
    // CORS, then writes ONE tar into the in-memory device; the guest extracts it. Either a
    // prebuilt bundle tar(.gz) committed to the repo, or files packed into a tar here.
    let tarBytes;
    if (plan.bundle) {
      const res = await fetch(plan.bundle, { mode: "cors" });
      if (!res.ok) throw new Error(`bundle: HTTP ${res.status}`);
      tarBytes = new Uint8Array(await res.arrayBuffer());
    } else {
      const entries = [];
      for (const f of plan.files) {
        const rel = f.replace(/^\/+/, "");
        const res = await fetch(plan.base + rel, { mode: "cors" });
        if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
        entries.push({ name: rel, bytes: new Uint8Array(await res.arrayBuffer()) });
      }
      tarBytes = buildTar(entries); // DataDevice.writeFile can't mkdir; tar xf can.
    }
    runBtn.textContent = "Unpacking…";
    await io.appDev.writeFile("/_webtui_bundle.tar", tarBytes);

    el("launcher").setAttribute("hidden", "");
    document.getElementById("screen")?.querySelector(".xterm-helper-textarea")?.focus();
    io.type("\x15");
    io.type(plan.runLine + "\n");
    showBanner(
      `Launching ${plan.name} (offline) — watch the terminal. A big app (e.g. a Textual ` +
        `app) can take a minute or two on a fresh boot while the disk streams on demand; ` +
        `it's much faster on later runs.`,
      "ok"
    );
  } catch (err) {
    runBtn.disabled = false;
    runBtn.textContent = "Run";
    showBanner(`Offline launch failed: ${String(err && err.message || err)}`, "error");
  }
}

/** Minimal ustar tar builder. Paths < 100 chars (fine for typical repos). */
function buildTar(entries) {
  const enc = new TextEncoder();
  const put = (buf, str, off) => buf.set(enc.encode(str), off);
  const blocks = [];
  for (const e of entries) {
    const h = new Uint8Array(512);
    put(h, e.name.slice(0, 100), 0);
    put(h, "0000644\0", 100); // mode
    put(h, "0000000\0", 108); // uid
    put(h, "0000000\0", 116); // gid
    put(h, e.bytes.length.toString(8).padStart(11, "0") + "\0", 124); // size[12]
    put(h, "00000000000\0", 136); // mtime[12]
    for (let i = 148; i < 156; i++) h[i] = 0x20; // checksum field = spaces while summing
    h[156] = 0x30; // typeflag '0' (regular file)
    put(h, "ustar\0", 257);
    put(h, "00", 263);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += h[i];
    put(h, sum.toString(8).padStart(6, "0") + "\0 ", 148); // checksum
    blocks.push(h);
    const content = new Uint8Array(Math.ceil(e.bytes.length / 512) * 512);
    content.set(e.bytes, 0);
    blocks.push(content);
  }
  blocks.push(new Uint8Array(512), new Uint8Array(512)); // two zero blocks = EOF
  const total = blocks.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of blocks) {
    out.set(b, o);
    o += b.length;
  }
  return out;
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
