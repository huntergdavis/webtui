# Implementation Plan: Client-Side-Only Browser Linux Terminal with Tailscale Networking

**Goal:** Open a URL on any fresh machine → terminal boots Debian in-browser → click "Connect",
do Tailscale OAuth in a popup → all VM networking routes through your tailnet (via your existing
exit node) → run `apt`, `ssh-keygen`, `git`, real CLI tools. **No installs. No backend you
operate. Static hosting only.**

**Engine decision:** Fork **WebVM** (CheerpX engine). It already integrates the three hard
parts — x86 Debian-in-WASM, IndexedDB-persisted disk, and `tsconnect`/lwIP Tailscale networking.
Building this on raw **v86** would require hand-writing an L2-ethernet→L3-IP bridge into lwIP +
your own relay — weeks of work for a worse result. v86 is the fallback only if "zero proprietary
engine" is a hard line (see §13).

> **API note (✅ VERIFIED 2026-06):** `CloudDevice` has been **removed**; a remote ext2 is now
> loaded with **`CheerpX.HttpBytesDevice.create(url)`** (single file + HTTP range requests, no
> chunking) layered under `OverlayDevice`/`IDBDevice`. Other symbols below are from the 1.2.x docs
> (`CheerpX.Linux.create`, `CheerpX.IDBDevice/OverlayDevice/DataDevice/WebDevice`, the `networkInterface`
> object with `authKey`/`loginUrlCb`/`controlUrl`/`stateUpdateCb`/`netmapUpdateCb`). Exit-node
> *selection* field names should be confirmed against the WebVM source at build time — flagged
> inline as ⚠VERIFY.

---

## 0. Architecture at a glance

```
Browser tab (static assets only)
├─ xterm.js                      ← terminal UI
├─ CheerpX (cx.esm.js + wasm)    ← x86→WASM JIT, Linux syscalls
│   ├─ mounts: OverlayDevice(HttpBytesDevice rootfs, IDBDevice overlay)
│   └─ networkInterface ──┐
├─ tsconnect (Go→WASM)  ←─┘ lwIP TCP/IP (C→WASM), custom TUN
│   └─ WireGuard over DERP (HTTPS/WebSocket)
└─ IndexedDB / OPFS              ← persistent disk + encrypted key vault

        │ (WebSocket/HTTPS only — the one transport browsers allow)
        ▼
   Tailscale DERP relay  ──►  YOUR exit node  ──►  public internet / GitHub
```

Nothing computes server-side. The static host only serves files. The exit node (already yours)
is the only machine doing real TCP/UDP.

---

## 1. Hosting & cross-origin isolation (do this first — it gates everything)

CheerpX needs `SharedArrayBuffer`, which requires the page to be **cross-origin isolated**:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

- **Cloudflare Pages / Netlify / Vercel:** set these via `_headers` file. ✅ Preferred.
- **GitHub Pages:** cannot set response headers → use the **`coi-serviceworker`** shim: a tiny
  service worker that re-fetches the document and injects COOP/COEP client-side. Works, but adds
  a first-load reload and a SW dependency (red-team §R12).
- Must be **HTTPS** (SW + SharedArrayBuffer + WebCrypto all require secure context).
- Every cross-origin asset you load (the CheerpX wasm, disk chunks if on a CDN) must be
  CORP-compatible (`Cross-Origin-Resource-Policy: cross-origin`) or same-origin. **Recommendation:
  self-host all assets** (engine + disk) on the same origin to dodge CORP entirely and reduce
  third-party trust.

**`coi.js` (only if on GH Pages):**
```js
// loaded first, before anything else, via <script src="coi.js">
// registers a SW that adds COOP/COEP; reloads once on first visit.
// Use the published coi-serviceworker.js verbatim; pin its hash via SRI.
```

---

## 2. Repository layout

```
/                       (static root, deployed as-is)
├─ index.html
├─ _headers             # COOP/COEP/CORP/CSP (Cloudflare/Netlify)
├─ coi.js               # SW shim (GH Pages only)
├─ src/
│  ├─ main.js           # boot orchestrator
│  ├─ terminal.js       # xterm wiring
│  ├─ vm.js             # CheerpX setup
│  ├─ storage.js        # IDB/OPFS overlay + quota
│  ├─ net.js            # Tailscale networkInterface + auth
│  ├─ vault.js          # WebCrypto encrypted key store
│  └─ ui.js             # connect modal, status bar, exit-node picker
├─ vendor/
│  ├─ cx.esm.js + cxcore.wasm        # self-hosted CheerpX (pinned ver)
│  ├─ tsconnect.wasm                  # (bundled by CheerpX net build)
│  └─ xterm.* 
└─ disk/
   ├─ debian.ext2.meta                # block index for CloudDevice
   └─ blocks/…                        # split rootfs chunks
```

Build with **Vite** (esbuild). WASM served with correct MIME (`application/wasm`) and
`Content-Type` + caching headers.

---

## 3. Disk image build pipeline (offline, one-time per image revision)

You ship a Debian rootfs as a read-only ext2 image; CheerpX streams blocks on demand and layers
writes in IndexedDB. Build it with a Dockerfile (Mini.WebVM approach) so package choices are
reproducible.

```
Dockerfile (i386)  →  docker export rootfs  →  mkfs.ext2 -d  →  single debian.ext2
```

`scripts/build-disk.sh` (✅ VERIFIED 2026-06 — implemented):
- `docker build --platform linux/386` an i386 image with: `bash coreutils git openssh-client
  vim-tiny ca-certificates curl less age python3`. Keep it lean — every MB is first-load download.
- `docker export` the container → extract + `mkfs.ext2 -b 4096 -d <rootfs> debian.ext2 <size>`,
  **under `fakeroot`** so files are baked `root:root`. Output is **one `.ext2` file** — there is
  **no chunk/index step** (CheerpX's `HttpBytesDevice` streams blocks via HTTP range from the
  single file; `CloudDevice` was removed).
- Seed `/etc/resolv.conf` (`100.100.100.100` + public fallback) **post-export** in the script —
  Docker masks `/etc/resolv.conf` on export, so a Dockerfile `COPY` would emit a 0-byte file.
- Built sizes: full `debian.ext2` 359 MB, `debian-lite.ext2` 304 MB (both fsck-clean).

**Goal: keep the base image ≤ ~200–400 MB compressed-on-the-wire.** "No installs" is true, but
*first boot is a real download* (red-team §R9).

---

## 4. Boot orchestration — `src/main.js`

```js
async function main() {
  ensureCrossOriginIsolated();          // hard-fail with a clear message if not
  const term = initTerminal(document.getElementById("screen"));
  const storage = await initStorage();  // §5
  const cx = await initVM(storage, term); // §4.2
  wireTerminalToVM(cx, term);           // §6
  setupConnectButton(cx);               // §7 (network is lazy / on-demand)
  await startShell(cx, term);           // launch /bin/bash
}
```

### 4.1 `ensureCrossOriginIsolated()`
```js
function ensureCrossOriginIsolated() {
  if (!self.crossOriginIsolated || typeof SharedArrayBuffer === "undefined")
    throw new BootError("Not cross-origin isolated — check COOP/COEP / coi.js");
}
```

### 4.2 `initVM(storage, term)` — `src/vm.js`
```js
import * as CheerpX from "/vendor/cx.esm.js";

async function initVM(storage, term) {
  // ✅ VERIFIED 2026-06: CloudDevice was removed. A remote ext2 is loaded by
  // HttpBytesDevice (single file, HTTP range requests), then made writable with an
  // OverlayDevice over the IDBDevice. Self-host the .ext2 same-origin (COEP/R-F1).
  const rootfs  = await CheerpX.HttpBytesDevice.create("/disk/debian.ext2"); // read-only base
  const overlay = await CheerpX.OverlayDevice.create(rootfs, storage.idb); // §5
  const cx = await CheerpX.Linux.create({
    mounts: [
      { type: "ext2", path: "/",    dev: overlay },
      { type: "dir",  path: "/dev", dev: await CheerpX.DataDevice.create() },
      // /proc, /sys handled internally by CheerpX
    ],
    networkInterface: buildNetworkInterface(term),  // §6 — created now, auth deferred
  });
  return cx;
}
```
- `networkInterface` is constructed up front (CheerpX wants it at create time) but the **login is
  not triggered** until the user clicks Connect — `loginUrlCb` only fires when the stack actually
  needs to come up. (⚠VERIFY whether CheerpX brings the interface up eagerly; if so, gate by only
  calling `login()`-equivalent on demand, or recreate the Linux instance — see §6.3.)

### 4.3 `startShell(cx, term)`
```js
async function startShell(cx, term) {
  await cx.run("/bin/bash", ["--login"], {
    env: ["HOME=/root", "TERM=xterm-256color", "USER=root", "PATH=/usr/bin:/bin:/usr/sbin:/sbin"],
    cwd: "/root", uid: 0, gid: 0,
  });
}
```

---

## 5. Persistence — `src/storage.js`

```js
async function initStorage() {
  await requestPersistence();                       // avoid eviction of your "disk"
  const idb = await CheerpX.IDBDevice.create("webtui-overlay"); // block-level writable cache+store
  return { idb };
}

async function requestPersistence() {
  if (navigator.storage?.persist) {
    const granted = await navigator.storage.persist();
    const { quota, usage } = await navigator.storage.estimate();
    return { granted, quota, usage };               // surface in status bar
  }
}
```
- Overlay semantics: read base block → if dirty in IDB, return IDB copy; all writes go to IDB.
  Installed packages, edited files, shell history persist across reloads, private to the origin.
- **`/root/.ssh` lives here. By default it is plaintext at rest in IndexedDB.** That is the #1
  red-team finding (§R1). Mitigation = §8 encrypted vault, not the raw overlay.
- `clearDisk()` admin command: `indexedDB.deleteDatabase(...)` for a factory reset.

---

## 6. Networking + auth — `src/net.js`

### 6.1 `buildNetworkInterface(term)`
```js
function buildNetworkInterface(term) {
  return {
    // controlUrl omitted → default Tailscale control plane.
    // For Headscale self-host: controlUrl: "https://headscale.example.ts.net"
    loginUrlCb: (url) => openAuthPopup(url),         // §6.2 — interactive OAuth/SSO
    stateUpdateCb: (state) => onTailscaleState(state, term), // "NeedsLogin"→"Running"
    netmapUpdateCb: (map) => onNetmap(map),          // device list → exit-node picker
    // authKey: <never hardcoded>  — only set if user pastes one at runtime
  };
}
```

### 6.2 `openAuthPopup(url)`
```js
function openAuthPopup(url) {
  // window.open keeps it client-side; user completes Tailscale SSO and approves the node.
  const w = window.open(url, "ts-auth", "width=520,height=680");
  if (!w) showInlineAuthLink(url);     // popup blocked → render a click-through link
}
```
- Node is registered **ephemeral** (auto-removed when the tab closes/idles) so you don't pile up
  dead "browser" devices. Re-auth on reload is expected.

### 6.3 `connectNetwork(cx)` (called by the Connect button)
```js
async function connectNetwork(cx) {
  setStatus("connecting");
  // CheerpX brings the interface up; loginUrlCb fires if not already authed.
  // If CheerpX has no explicit "up" call, the first outbound packet triggers it;
  // we warm it by resolving DNS or pinging the control plane. ⚠VERIFY API.
}
```

### 6.4 `onNetmap(map)` → exit-node selection
```js
function onNetmap(map) {
  const exitNodes = map.peers.filter(p => p.exitNodeOption); // ⚠VERIFY field name
  ui.populateExitNodePicker(exitNodes);
}
async function selectExitNode(node) {
  // Route ALL of the VM's egress through this peer.
  // ⚠VERIFY: WebVM sets this via a netmap/prefs call or an `exitNode` option.
  await net.setExitNode(node.id);
  setStatus("routing via " + node.name);
}
```
- Until an exit node is selected, the VM can reach tailnet peers but **not** the public internet.
  Persist the chosen exit node ID in `localStorage` and auto-select on reconnect.

### 6.5 DNS
- MagicDNS resolver lives at `100.100.100.100`; ensure guest `/etc/resolv.conf` points there.
  Fallback to a public resolver reached *through the exit node* if MagicDNS is off. (⚠VERIFY
  whether CheerpX's lwIP intercepts DNS or passes it through.)

---

## 7. Terminal + UI glue

### 7.1 `initTerminal(el)` / `wireTerminalToVM(cx, term)` — `src/terminal.js`
```js
function initTerminal(el) {
  const term = new Terminal({ convertEol: true, fontFamily: "monospace", scrollback: 5000 });
  term.loadAddon(new FitAddon()); term.open(el); fit();
  return term;
}
function wireTerminalToVM(cx, term) {
  cx.setCustomConsole(                 // ⚠VERIFY exact CheerpX console hook name
    (bytes) => term.write(bytes),      // VM stdout/stderr → xterm
    term.cols, term.rows);
  term.onData((data) => cx.sendData(data));  // keystrokes → VM stdin
  term.onResize(({cols, rows}) => cx.setConsoleSize?.(cols, rows));
}
```
- Kitty protocol: out of scope for v1 (xterm.js doesn't speak it). xterm-256color + standard
  escapes cover vim/htop/most TUIs. Revisit later.

### 7.2 `src/ui.js`
- `setupConnectButton(cx)` → calls `connectNetwork`.
- Status bar: cross-origin-isolation state, storage quota/usage, Tailscale state, exit node,
  DERP region/latency.
- Exit-node picker (from `onNetmap`).
- "Factory reset" (clear IDB), "Lock vault" (drop key from memory).

---

## 8. Secret handling — encrypted at rest, ephemeral by preference (the R1 fix)

`ssh-keygen` → GitHub is the point, so secret handling is load-bearing. The naive design leaves
`~/.ssh/id_ed25519` plaintext in the IndexedDB overlay, where device theft, an IDB dump, a
malicious host operator, or any page-level code compromise reads it — over the very tailnet you
just joined.

### 8.0 Threat model — three distinct exposures, three distinct defenses
A single trick does **not** cover all three. Be honest about which defense covers which:

| Exposure | Example | Defense that actually helps |
|---|---|---|
| **At rest** | stolen laptop, IDB dump, malicious static-host operator, browser-profile sync | **Encrypt at rest** (this section) |
| **In use** | XSS / malicious dependency / extension reading guest memory *while unlocked* | **Minimize & pin page code** (§11) + **lock-on-idle** + **short-lived creds** |
| **In transit** | passphrase keylogged as you type it | **Short-lived creds** + clean profile — see ⚠ below |

> ⚠ **Crucial, non-obvious truth:** *every* keystroke into the terminal — including any passphrase
> you type at a guest prompt — passes through `xterm.js`'s `onData` handler, which is **page-level
> JS**. So guest-side vs host-side entry does **not** change whether compromised page code can
> keylog the passphrase. Encryption defeats *at-rest* theft completely; it cannot, by itself,
> defeat a compromised page during an active session. That residual is why §8.4 (short-lived
> credentials) and §11 (lock down what code runs) matter as much as the crypto.

### 8.1 Design A (recommended): guest-side encrypted `~/.ssh` on a RAM-only mount
Keep only ciphertext on the persisted disk; decrypt to memory; re-encrypt on lock.

- **At rest:** `~/.ssh.age` — an `age`-encrypted archive (passphrase recipient) on the IDB
  overlay. `age` is pre-installed in the disk image (§3).
- **Unlock:** decrypt into a **non-persistent RAM mount** at `/run/keys` (a `tmpfs`, or a
  CheerpX in-memory `DataDevice` mount — ⚠VERIFY tmpfs support; if absent, mount a dedicated
  in-memory device that is *never* backed by the IDB overlay). Load into `ssh-agent` with a
  TTL: `ssh-add -t 1800`.
- **Lock (idle/blur/explicit):** `ssh-add -D`, re-`age`-encrypt if changed, `rm -rf /run/keys/*`.
  Plaintext never touches the persisted overlay.
- Helper scripts shipped in the image: `vault-unlock`, `vault-lock`, `vault-init`.

### 8.2 Design B: host-side WebCrypto vault — `src/vault.js`
For secrets the *page* manages (e.g. a GitHub fine-grained PAT, an optional Tailscale auth key),
or if you prefer JS to own SSH keys and inject them into `ssh-agent` at unlock.

```js
// KDF: Argon2id (argon2-browser wasm) preferred; PBKDF2-SHA256 600k is the WebCrypto fallback.
async function deriveKey(passphrase, salt, params) {
  const argon = await argon2.hash({ pass: passphrase, salt,
    type: argon2.ArgonType.Argon2id, time: params.t, mem: params.m, parallelism: params.p,
    hashLen: 32 });
  // Import as a NON-EXTRACTABLE AES-GCM key so JS can never export the raw bytes.
  return crypto.subtle.importKey("raw", argon.hash, "AES-GCM", /*extractable*/ false,
    ["encrypt", "decrypt"]);
}

async function vaultInit(passphrase) {                 // first run
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const params = { t: 3, m: 64 * 1024, p: 1, v: 1 };   // tune; record them
  const key = await deriveKey(passphrase, salt, params);
  await vaultPut("__verifier__", utf8("ok"), key, {salt, params}); // detect wrong passphrase later
  return key;
}

async function vaultUnlock(passphrase) {               // throws on wrong passphrase
  const { salt, params } = await idbGetMeta();
  const key = await deriveKey(passphrase, salt, params);
  if (utf8d(await vaultGet("__verifier__", key)) !== "ok") throw new BadPassphrase();
  return key;                                          // module-scoped; never persisted
}

async function vaultPut(name, plaintext, key, meta) {  // AES-GCM, fresh IV, authenticated AAD
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = utf8(`${name}|v1`);                      // binds name+version → blocks record-swap
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, plaintext);
  await idbPut("vault", name, { iv, ct, aad: "v1", ...(meta && { meta }) });
}

async function vaultGet(name, key) {
  const rec = await idbGet("vault", name);
  const aad = utf8(`${name}|v1`);
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: rec.iv, additionalData: aad }, key, rec.ct)); // throws on tamper
}

function vaultLock() { _key = null; /* CryptoKey is non-extractable & GC-eligible; see R-C5 */ }
```

### 8.3 Hard rules (enforced in code review)
- **Never** write a decrypted private key / token to the IDB overlay or `localStorage`.
- Derived key is a **non-extractable** `CryptoKey`; raw key bytes never live in a JS variable.
- **Fresh 12-byte random IV per encryption**; never reuse key+IV (R-C4).
- **Authenticate KDF params and record name** (AAD) so a tampered IDB can't downgrade or swap
  records (R-C3).
- **Lock on idle, blur, and explicit command**; clear `ssh-agent`; wipe `/run/keys`.
- Vault is **origin-scoped** (IndexedDB isolation) — a phishing clone on another origin cannot
  read it (R-C8).

### 8.4 Strongly preferred: short-lived credentials over long-lived keys
The best mitigation for the *in-use* residual is a secret that's nearly worthless if stolen:
- **GitHub fine-grained PAT**, scoped to specific repos + `contents:write`, **short expiry**
  (1–7 days), pasted per session, kept only in `ssh-agent`/env, never persisted. Use via the
  GitHub API path (§9).
- **SSH certificates** (short-TTL) if you run a tiny CA — compromised cert expires in minutes.
- Per-use confirmation on the agent: `ssh-add -c`.

### 8.5 Why hardware-backed SSH (`ed25519-sk`) does *not* work here
FIDO2/`-sk` keys would make the private key unexfiltratable, but they need the SSH client to
reach a USB/HID authenticator via `libsk`. **The in-browser VM has no USB/HID access**, and
WebAuthn is a page-JS API not exposed to the guest. So hardware-backed *SSH* is off the table
inside the sandbox; rely on §8.1 + §8.4 instead. (You *can* still protect the GitHub *account*
itself with a passkey — that's account login, not the SSH key.)

### 8.6 Backup = ciphertext is portable
Because the vault/`~/.ssh.age` is encrypted, you can safely export it (download blob) and
re-import on another device — turning the "browser eviction wipes my disk" risk (R11) into a
deliberate, safe backup.

---

## 9. GitHub workflow (works on first try, document both paths)

- **SSH (`git@github.com:…`)**: works through the tunnel once an exit node is selected and the
  pubkey is added to GitHub. `ssh-keygen -t ed25519` → copy `~/.ssh/id_ed25519.pub` → paste into
  GitHub. This is the "real terminal" path.
- **HTTPS API path (no tunnel needed):** GitHub REST/GraphQL send `Access-Control-Allow-Origin:*`,
  so read/commit/PR can be done even before/without networking the VM. `git push` over *HTTPS*
  still needs a CORS proxy (a server) — **prefer SSH-over-tailnet to stay serverless.**

---

## 10. Tailscale-side configuration (one-time, your admin console)

- **OAuth client** with `auth_keys` scope + tag `tag:browser-vm` (for any non-interactive
  variant). For interactive use, `loginUrlCb` SSO needs nothing pre-provisioned.
- **ACLs** scoping `tag:browser-vm` to *only* {your exit node egress, GitHub, specific peers}
  — not the whole tailnet. Critical blast-radius control (§R3).
- **Ephemeral + pre-authorized** node policy so browser nodes self-clean.
- Exit node: already running `--advertise-exit-node` ✅.

---

## 11. CSP / supply chain hardening

- Strict **CSP**: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'
  https://*.tailscale.com wss://*.tailscale.com https://login.tailscale.com;` — pin exactly the
  DERP/control origins; forbid everything else so a compromised dependency can't beacon out
  (note: it could still tunnel via the VM stack — §R2).
- **SRI** hashes on every vendored script; **pin CheerpX version** and self-host the wasm.
- Subresource pinning of `tsconnect.wasm`.

---

## 12. Build & deploy
- `vite build` → static `dist/`.
- Deploy to Cloudflare Pages (set `_headers`). Custom domain w/ HTTPS.
- Smoke test matrix: Chrome/Edge/Firefox desktop; Safari (expect pain, §R10); verify
  `crossOriginIsolated === true` in console on prod.

---

## 13. Fully-open-source fallback (v86) — scope note
If CheerpX's proprietary engine is unacceptable: use **v86** (MIT) + boot a small Alpine kernel.
You then must build, in-browser: an **ethernet (L2) ↔ IP (L3) shim** (ARP, DHCP-less static
config) feeding **lwIP**, then into `tsconnect`. v86's `net_device.relay_url` normally points at
a *server* relay (`websockproxy`/wisp) — replacing that with the Tailscale WASM path is the bulk
of the work and is unproven. Slower userland, no `apt`-on-Debian ergonomics. Only do this if the
open-source constraint outranks effort and UX.

---

## 14. Platform support & memory budget

**Key fact: host CPU architecture is irrelevant.** The engine JIT-compiles the x86 guest →
WebAssembly, and WASM runs on any CPU. So x86 Debian binaries run identically on x86, Apple
Silicon (M1/M2/M3), and ARM Chromebooks/tablets — no ARM port needed. (CheerpX's "ARM support
planned" note is about running ARM *guests*, not about the host; ignore it for this project.)

**The real limiter is the browser's per-tab WASM memory ceiling, not device RAM.** A device can
have 8 GB and still cap a single tab's WASM heap. The split that matters:

**Firefox is a first-class, primary target.** Firefox (desktop, v79+) supports SharedArrayBuffer
under COOP/COEP, WASM, and IndexedDB — everything the engine needs. CheerpX lists Firefox 79+ as
supported and v86 runs on Firefox too. So **develop and test on Firefox first**, not just Chrome.
(⚠VERIFY once on current Firefox: CheerpX engine boots + tsconnect WASM runs; both are expected
to, but Firefox is the canary because its WASM/SAB quirks differ from V8.)

| Target | Browser reality | Verdict |
|---|---|---|
| **Firefox desktop** (primary) | FF 79+ has SAB+COOP/COEP, WASM, IDB; ARM & x86 builds | ✅ First-class — **primary dev/test target** |
| **Chromebook** (primary) | Runs **desktop Chrome** (Chrome OS) → desktop WASM limits (up to ~4 GB heap), full COOP/COEP, real keyboard. Firefox on Chrome OS via Linux container also fine | ✅ First-class, treat as desktop |
| **M1/M2 Mac** | Desktop Firefox / Chrome / Safari 15.2+, fast WASM on ARM | ✅ First-class |
| **Galaxy Tab S8+** (primary) | **Firefox for Android** or Chrome (64-bit on flagship) — 8 GB RAM helps, but Android browsers can cap per-tab WASM growth below device RAM; SAB needs COOP/COEP (Chrome 88+/recent FF Android) | 🟢 Expected to work with a slim image; **test the heap cap + FF-Android SAB** (§14.1) |
| Budget Android tablet | Mobile browser, tight WASM cap (~300 MB historically) | 🟡 Best-effort |
| iPad / iOS | All browsers = WebKit; Safari 15.2+ has SAB but OOMs ~256 MB and after reloads | 🟡 Experimental, don't promise |

Bottom line for your devices: **Firefox desktop + Chromebook = desktop-class, no caveats.
Galaxy Tab S8+ has the RAM and the features; verify the per-tab WASM heap cap and Firefox-Android
SAB, both handled by a slim image + tuned `maxMemory`.** Don't over-invest in iOS.

> **Firefox-specific watch-items** (tracked in Round 4 red team): (a) Firefox enforces COEP on
> *every* subresource — any cross-origin asset without CORP is blocked, so **self-host everything**
> (already the plan). (b) Firefox `WebAssembly.Memory` growth/limits differ from V8 — the §14.2
> probe handles this. (c) Service workers + COOP/COEP interact differently in FF — prefer a
> header-capable host over the `coi-serviceworker` shim. (d) Firefox storage eviction (Total
> Cookie Protection / ETP) can be more aggressive — `navigator.storage.persist()` is mandatory.

### 14.1 `detectPlatformBudget()` — feature-detect + size the VM
```js
async function detectPlatformBudget() {
  ensureCrossOriginIsolated();                 // already required (§4.1)
  const deviceMem = navigator.deviceMemory || 4; // GB hint (Chrome/Android)
  const isMobileUA = /Android|iPhone|iPad/.test(navigator.userAgent);
  // Probe the actual ceiling rather than trust UA: try to grow a WebAssembly.Memory.
  const cap = probeWasmMemoryCeiling();        // §14.2 → bytes we can actually reserve
  return {
    maxMemoryMB: Math.min(cap, isMobileUA ? 1024 : 3072), // headroom under the cap
    lowMem: cap < 768 * 1024 * 1024,
  };
}
```

### 14.2 `probeWasmMemoryCeiling()` — measure, don't assume
```js
function probeWasmMemoryCeiling() {
  // Binary-search how many 64KiB pages WebAssembly.Memory({shared:true}) will grant.
  let lo = 16, hi = 65536 /*4GB*/, ok = 16;     // pages
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try { new WebAssembly.Memory({ initial: mid, maximum: mid, shared: true }); ok = mid; lo = mid + 1; }
    catch { hi = mid - 1; }
  }
  return ok * 65536;                            // bytes
}
```

### 14.3 Apply the budget at boot
- Pass `maxMemoryMB` into the engine config (⚠VERIFY CheerpX option name; v86 uses `memory_size`).
- If `lowMem`, **boot a trimmed image** (a second, smaller `disk/` target — busybox-class base,
  no desktop, minimal packages) and warn the user.
- Show the detected budget + storage quota in the status bar so failures are legible, not silent.
- On `RangeError: out of memory`, catch and surface a clear "this device's browser capped memory —
  try the lite image / a Chromebook" message instead of a blank crash.

### 14.4 Touch / no-physical-keyboard handling
- Chromebook & Tab S8+ both support external/attached keyboards → primary path is fine.
- For on-screen-keyboard sessions, add an xterm soft-key bar (Esc, Tab, Ctrl, Alt, arrows, `|`,
  `~`, `/`) — terminals are unusable on a bare touch keyboard without it.

---
---

# RED TEAM

Severity: 🔴 critical · 🟠 high · 🟡 medium · 🔵 low/operational. Each: attack → impact →
mitigation.

## Security

**R1 🔴→🟢 RESOLVED at rest (see §8). Residual moved to Round 2 (R-C1).**
Original: default overlay stored `~/.ssh/id_ed25519` unencrypted; any XSS, malicious dependency,
malicious operator, or stolen device read it.
Fix: §8 — encrypt at rest (`age` archive on RAM-mount unlock, or Argon2id+AES-GCM non-extractable
vault); never persist plaintext; lock on idle; prefer **short-lived GitHub creds** (§8.4).
**Remaining** risk is *in-use* (key in guest memory while unlocked) — that is not an at-rest
problem and is tracked as **R-C1** in the Round 2 red team below.

**R2 🔴 The page is a node on your tailnet → XSS/supply-chain = lateral movement into your
private network.** This is the deepest risk and it's structural.
Attack: a single compromised dependency (xterm addon, the CheerpX CDN wasm, the SW shim, any
transitive lib) running in a cross-origin-isolated, Tailscale-connected tab can open connections
*through the tunnel* to any peer your ACLs allow — bypassing CSP `connect-src` because traffic
goes via the VM/lwIP stack, not `fetch`. Your "real network" reachability is exactly the
attacker's reachability.
Mitigation: (a) **tight ACLs** — `tag:browser-vm` may reach only the exit node + explicitly
whitelisted peers, never the full tainet (§10/§R3). (b) **Self-host every asset**, pin versions,
SRI, minimal dependency tree, audit them. (c) Ephemeral nodes so access dies with the tab. (d)
Treat this tab as *untrusted* by your tailnet by default; it's a foothold if subverted.

**R3 🟠 Over-broad tailnet access (no/loose ACLs).**
Attack: default tailnet ACL is "allow all"; the browser node can reach every device you own.
Impact: amplifies R1/R2 dramatically.
Mitigation: explicit deny-by-default ACL for `tag:browser-vm`; test with `tailscale ping`/ACL
tester before trusting.

**R4 🟠 Auth-key leakage (if you use the non-interactive path).**
Attack: an `authKey` baked into static JS is world-readable; a key pasted into a phishing clone
of your site is captured.
Mitigation: **default to interactive `loginUrlCb` SSO** (no stored secret). If you must use auth
keys: ephemeral + tagged + short expiry + pre-authorized, minted per-session from the OAuth
client, never committed. Pin/bookmark the real origin to resist clones.

**R5 🟠 Malicious or compromised site operator / CDN.**
Attack: if you don't self-host, whoever serves `cx.esm.js`/`cxcore.wasm` (Leaning Tech CDN) or
the app can ship code that runs inside your isolated, tailnet-connected tab (see R2). Cross-origin
isolation does *not* protect you from first-party/served code.
Mitigation: **self-host pinned, SRI-checked** engine + assets from your own origin; review
diffs on version bumps; never load the app from an origin you don't control.

**R6 🟡 DERP/control-plane trust & MITM.**
Attack: traffic relays through Tailscale-operated DERP and is brokered by Tailscale's control
plane (key distribution). You trust Tailscale Inc. WireGuard E2E protects payloads, but metadata
(who/when) is visible to relays; a malicious control plane could in theory inject a node.
Mitigation: accept the trust model, or **self-host Headscale + your own DERP** (`controlUrl`).
Monitor tailnet device list for unexpected nodes; use tailnet lock if available.

**R7 🟡 Exit node sees plaintext egress.**
Attack: the exit node terminates the tunnel; it sees all non-TLS traffic in clear (e.g. `apt`
over plain HTTP) and can MITM/log.
Impact: it's *your* exit node, so low — but apt-over-http integrity matters.
Mitigation: prefer HTTPS apt mirrors; rely on apt's GPG signature verification regardless; keep
the exit node patched (it's now an internet-facing forwarder).

**R8 🟡 Popup/redirect phishing on the auth step.**
Attack: user is trained to "click Connect → log into Tailscale in a popup"; a lookalike captures
SSO.
Mitigation: render the destination origin in the connect UI; users complete SSO on Tailscale's
real domain; rely on the IdP's own anti-phishing (passkeys/WebAuthn on the Tailscale account).

## Reliability / correctness

**R9 🟠 "No installs" ≠ "no download." First boot pulls a big disk image.**
Reality: 200–400 MB+ of rootfs (lazy, but apt/python/etc. force more block fetches). On a slow
or metered fresh-machine connection this is a poor "instant" experience; blocks also stream
*through DERP*? No — disk blocks come from your **static host over HTTPS** (fast), only VM
*egress* uses DERP. Still, first paint to usable shell can be tens of seconds.
Mitigation: aggressively slim the base image; lazy-load; cache via SW; show progress; warm-cache
messaging. Set honest expectations ("first launch downloads ~Xmb, then it's cached").

**R10 🟠 Safari / iOS.** SharedArrayBuffer cross-origin isolation, WASM size, and storage limits
are flakier on Safari; iOS aggressively evicts IndexedDB and caps memory. May simply not run.
Mitigation: feature-detect and show a "use Chrome/Edge/Firefox desktop" fallback; don't promise
mobile in v1.

**R11 🟠 Storage eviction = you lose your disk AND your keys.**
Attack/accident: browser evicts IndexedDB under pressure (esp. without `persist()` grant, esp.
Safari). Installed packages, history, and (if not externally backed) SSH keys vanish.
Mitigation: `navigator.storage.persist()`; warn if not granted; **don't treat the browser as the
only copy of keys** — keys added to GitHub can be rotated; offer export/backup of the vault.

**R12 🟡 `coi-serviceworker` fragility (GH Pages path).**
Attack/accident: SW shim causes a reload loop, breaks under strict CSP, or fails on first load;
SW itself is extra attack surface (R2/R5).
Mitigation: prefer a host with real header support (Cloudflare Pages) and drop the SW entirely.

**R13 🟡 DERP-relayed throughput/latency.** Browser can't NAT-hole-punch to direct WireGuard, so
all traffic is **relayed** → higher latency, lower throughput than native Tailscale. Big
`apt`/`git clone` may be slow; interactive SSH feels laggy on far DERP regions.
Mitigation: pick a near DERP region; set expectations; consider a same-region exit node.

**R14 🟡 WASM memory ceiling.** 32-bit WASM heap caps (~2–4 GB); heavy builds (compiling, big
toolchains) can OOM the tab.
Mitigation: document limits; lean toolchains; rely on the exit node only for network, not compute.

**R15 🔵 DNS/MTU edge cases.** MagicDNS interception in lwIP, MTU mismatches over DERP causing
fragmentation/black-holing on some sites.
Mitigation: clamp MSS; verify `/etc/resolv.conf`; test against IPv6-only and large-MTU hosts.

**R16 🔵 Ephemeral re-auth friction.** Every reload = new SSO + re-select exit node; mid-work
tab reloads lose unsaved in-memory state (vault relocks).
Mitigation: persist exit-node choice; quick re-unlock; auto-reconnect on `stateUpdateCb`.

## Legal / operational

**R17 🟡 Exit node is legally responsible for egress.** All VM internet traffic exits from your
node's IP — abuse, ToS issues, and liability attach to you.
Mitigation: it's single-user/yours, so acceptable; keep it patched; don't expose the app
multi-tenant without rethinking this.

**R18 🔵 Tailscale ToS / node-count.** Ephemeral browser nodes count toward limits; automated
key minting must respect ToS.
Mitigation: ephemeral cleanup; reasonable usage.

## Top-3 must-fix before trusting this with your GitHub key
1. **R1** encrypted key vault / guest-side encryption — never plaintext keys in IDB.
2. **R2 + R3** lock ACLs so the tab-as-node can reach *only* the exit node + whitelisted peers.
3. **R5** self-host pinned + SRI-checked engine and assets; minimal, audited dependency tree.

If those three are in place, the residual risk is mostly the structural one (R2: a
tailnet-connected browser tab is a network foothold if any code in it is subverted) — tolerable
for a personal, single-user tool you host yourself, and the reason ephemeral nodes + tight ACLs
matter so much.

---
---

# RED TEAM — ROUND 2: attacking the encryption / secret design (§8)

Round 1 said "encrypt the keys." Round 2 attacks *that fix*. The headline: **encryption fully
solves theft at rest; it cannot solve a compromised page during an unlocked session, and the
passphrase itself flows through page code.** Everything below follows from those two facts.

**R-C1 🟠 In-use key exposure (the real residual of R1).**
Attack: while the vault is unlocked, the decrypted key lives in guest memory, which is a
`SharedArrayBuffer` in the JS heap. Page-level code (XSS, a subverted dependency, a malicious
extension) can read it for the duration of the unlock.
Mitigation: short unlock TTL (`ssh-add -t`), **lock on idle/blur**, minimal+pinned deps (§11),
and above all **short-lived credentials (§8.4)** so what's stolen expires fast. Irreducible
without removing trust in page code — so reduce that trust, don't pretend it's zero.

**R-C2 🟠 Passphrase keylogging through `xterm.onData`.**
Attack: *every* keystroke into the terminal passes through page JS before reaching the VM.
Guest-side entry does **not** hide the passphrase from a compromised page.
Mitigation: prefer secrets that are useless once expired (short-lived PAT/SSH-cert); do
account-level GitHub login (passkey) **outside** the VM; clean browser profile, no untrusted
extensions. Accept that passphrase secrecy depends on page-code integrity.

**R-C3 🟡 KDF-param downgrade / record-swap tampering.**
Attack: an attacker with IDB write access rewrites stored Argon2 params to weak values, or swaps
ciphertext records, to enable cheap offline cracking or confuse the app.
Mitigation: bind name+version as **AES-GCM AAD** (done in §8.2); store KDF params inside an
authenticated blob; enforce a **minimum-params floor** and reject downgrades.

**R-C4 🟡 AES-GCM nonce reuse / RNG failure.**
Attack: a repeated (key, 96-bit IV) pair under AES-GCM is catastrophic (forgery); a broken RNG
makes it likely.
Mitigation: fresh `crypto.getRandomValues` IV per write, low message volume per key, key
rotation; consider **XChaCha20-Poly1305 (libsodium-wasm)** with a 192-bit nonce for nonce-misuse
headroom.

**R-C5 🟡 You cannot reliably zero secrets in JS/WASM.**
Attack: passphrase strings are immutable, GC is non-deterministic, SAB pages persist, and the OS
may swap heap to disk. "Wipe on lock" is best-effort, not a guarantee.
Mitigation: minimize plaintext lifetime; non-extractable `CryptoKey` (raw bytes never in a JS
var); rely on **host full-disk encryption** for the swap-to-disk angle; short-lived creds again.

**R-C6 🟡 Argon2 vs the mobile memory cap (downgrade trap).**
Attack: a strong Argon2id (e.g. 64 MB) competes with the VM heap on a memory-capped tablet → OOM,
tempting you to weaken params *on exactly the devices most likely to be lost/stolen*.
Mitigation: tune params per platform but enforce a **security floor**; do first-time key
generation on a desktop/Chromebook with headroom; document it.

**R-C7 🟡 Offline brute-force via the verifier.**
Attack: anyone with the ciphertext + `__verifier__` can brute-force the passphrase offline,
forever.
Mitigation: strong Argon2id cost + long passphrase raise the bill; short-lived creds cap the
payoff. Inherent to passphrase encryption — don't oversell it.

**R-C8 🔵 Phishing clone captures a freshly typed passphrase.**
Note: IndexedDB is origin-isolated, so a clone on another origin **cannot read your real vault** —
but it can capture a passphrase you type into it (useless without your ciphertext, unless they
also phished a backup).
Mitigation: bookmark the exact origin; HSTS; short-lived creds.

**R-C9 🟡 Encrypted-backup blob is offline-crackable forever.**
Attack: you export the ciphertext vault to cloud storage; an attacker who grabs it brute-forces at
leisure.
Mitigation: treat the backup as sensitive; strong passphrase; consider a separate, stronger
backup passphrase.

**R-C10 🟡 ssh-agent hijack by in-VM malware.**
Attack: anything you `apt install` runs as a normal guest process and can use the **unlocked
ssh-agent socket** (`$SSH_AUTH_SOCK`) without the passphrase — classic agent hijack.
Mitigation: `ssh-add -c` (confirm each use) + `-t` TTL; install only trusted packages; this is
identical to the risk on any real Linux box, so treat the VM with the same hygiene.

---
---

# RED TEAM — ROUND 3: systemic / trust / availability

Round 3 zooms out from secrets to the whole trust chain. The uncomfortable finding: **the engine
and the build pipeline are more privileged than any key, and SRI pins *which bytes* you load, not
*whether those bytes are trustworthy*.**

**R-S1 🔴 The virtualization engine is the ultimate trusted component.**
Attack: CheerpX is proprietary and unauditable; a backdoored engine version sees *everything* —
keystrokes, guest memory, decrypted keys, all network. Self-hosting pins the bytes you fetched but
doesn't make them trustworthy.
Mitigation: pin the version, review behavior/diffs on every bump, and consciously accept trust in
Leaning Tech — **or** choose **v86 (open, auditable)** if you need high assurance more than
Debian ergonomics. This is arguably the true #1 risk above even R1.

**R-S2 🟠 Build/CI supply chain.**
Attack: a malicious npm dep, compromised Vite plugin, or hijacked CI injects code into the `dist/`
you deploy — the trusted root of the whole app.
Mitigation: lockfile + `npm ci`, minimal audited deps, generate SRI at build, deploy from a clean
runner, ideally reproducible builds; review the dependency tree like it's production crypto (it is).

**R-S3 🟠 Origin / DNS / TLS takeover.**
Attack: whoever controls the domain, DNS, or cert serves a malicious app to a tab that then holds
your tailnet access and (on unlock) your keys.
Mitigation: reputable host, registrar lock, **DNSSEC + CAA**, **HSTS preload**, monitor
Certificate Transparency, bookmark the exact origin.

**R-S4 🟡 Tailscale / DERP availability + trust.**
Attack: control-plane outage blocks new logins; DERP outage kills networking; relays see traffic
metadata; control plane is the key-distribution root.
Mitigation: accept the SaaS trust, or run **Headscale + your own DERP** for sovereignty (which
makes *you* the single point of failure). Watch the tailnet device list for surprises; use tailnet
lock if available.

**R-S5 🟡 Exit node = choke point, logger, and new attack surface.**
Attack: it sees all VM egress (plaintext for non-TLS), is an internet-facing forwarder, and is a
SPOF.
Mitigation: dedicate and firewall it, patch it, force HTTPS in the guest, don't run other
sensitive services on it.

**R-S6 🟡 The rest of the rootfs overlay is unauthenticated.**
Attack: §8 encrypts `~/.ssh`, but the *rest* of the IDB overlay is plaintext and unauthenticated.
A local-device attacker can trojan a guest binary or edit `.bashrc`/`.profile`; it runs at next
boot — possibly while your agent is unlocked.
Mitigation: consider encrypting/authenticating the **whole** overlay (not just keys); rely on host
full-disk encryption; treat physical/local-account compromise as game-over.

**R-S7 🟡 Cross-origin isolation vs the auth popup.**
Risk: `COOP: same-origin` (required for `crossOriginIsolated`) severs the opener↔popup
relationship, which would break any flow that depends on `postMessage` back from the Tailscale
popup.
Mitigation: the tsconnect flow signals completion via **control-plane state
(`stateUpdateCb`/netmap)**, not popup `postMessage`, so it's fine — but ⚠VERIFY no part of the
flow relies on popup messaging; keep a redirect-based fallback.

**R-S8 🟡 Durability is best-effort.**
Attack/accident: IDB eviction, quota exhaustion, or a browser-update bug wipes the disk + vault.
Mitigation: `navigator.storage.persist()`, encrypted backups (§8.6), and remember GitHub keys are
re-addable — don't make the browser the only copy of anything irreplaceable.

**R-S9 🟡 Cache poisoning via a sloppy service worker.**
Attack: a SW (e.g. the COI shim) with bad cache versioning serves a stale or attacker-influenced
app indefinitely.
Mitigation: prefer a **header-capable host (no SW)**; if a SW is unavoidable, strict versioned
caches + SRI on the engine so poisoned bytes fail to load.

---
---

# RED TEAM — ROUND 4: Firefox + abuse + accessibility

Round 4 targets the explicit requirements: **must run in Firefox**, and must be usable for a
**dyslexic** primary user.

**R-F1 🟠 Firefox enforces COEP on every subresource.**
Attack: any cross-origin asset lacking CORP is silently blocked → engine/disk/wasm fail to load,
often with a confusing error. Firefox is stricter here than older Chrome.
Mitigation: **self-host everything** (already the plan), set `Cross-Origin-Resource-Policy` on
same-origin assets, and make Firefox the **first** browser in the boot smoke test.

**R-F2 🟡 Firefox WASM/SAB memory semantics differ from V8.**
Attack: different growth limits and OOM behavior, especially Firefox-on-Android, can crash a boot
that worked in Chrome.
Mitigation: the §14.2 runtime probe (don't trust UA); test FF desktop **and** FF Android
explicitly.

**R-F3 🟡 Firefox private browsing + aggressive eviction.**
Attack: IndexedDB is **disabled/ephemeral in Firefox private windows**, and ETP/Total Cookie
Protection can evict storage → no disk, no vault, silent data loss.
Mitigation: detect private mode and warn ("won't persist — use a normal window"); require
`persist()`; surface quota in the status bar.

**R-F4 🟡 COI service-worker shim is less reliable on Firefox.**
Mitigation: use a header-capable host (Cloudflare/Netlify) and drop the SW; if you must shim,
test the reload loop specifically in Firefox.

**R-F5 🔵 Argon2/WebCrypto perf differs on Firefox.**
Mitigation: benchmark KDF params on Firefox so unlock isn't painfully slow or insecure.

**R-A1 🟠 Abuse if this ever goes multi-tenant/public.**
Attack: open egress via your exit node, resource abuse, untrusted nodes on your tailnet, liability.
Mitigation: keep it **single-user**; auth-gate any hosting; the whole threat model assumes
personal use — revisit everything before sharing.

**R-A2 🟡 Malicious guest packages.** (See R-C10.) Anything you install runs with your tailnet +
unlocked agent. Mitigation: least privilege, agent confirm, careful installs, ephemeral nodes.

**R-A3 🟠 Clickjacking / UI-redress on the Connect/Unlock controls.**
Attack: the app embedded in a hostile iframe tricks you into clicking Connect/Unlock.
Mitigation: CSP `frame-ancestors 'none'` + `X-Frame-Options: DENY` (COOP also isolates the
context).

**R-A4 🔵 Tab discard / bfcache mid-operation.**
Attack: browser discards the tab under memory pressure → vault relocks and network drops mid
`git push`, leaving partial state.
Mitigation: handle `visibilitychange`/`pagehide`, warn before risky ops, keep operations
idempotent/resumable.

**R-A5 🟠 Accessibility is a requirement, not a nicety (dyslexia).**
The product is a wall of dense text; that's a real usability risk for the primary user.
Mitigation (build into v1): selectable **legible/OpenDyslexic-style font**, adjustable font size
and line-height, high-contrast theme, generous spacing, and **don't encode meaning only in tiny
status glyphs** — pair every icon with a word. Keyboard-driven flows with clear labels over
cramped abbreviations.

---
---

# RED TEAM — SYNTHESIS: the kill chain & revised priorities

**Single most important reframe:** the secrets are *not* the top of the trust stack. In order of
privilege, an attacker who controls any of these owns everything below it:

1. **The engine** (CheerpX) — R-S1
2. **The build/deploy pipeline + origin/DNS/TLS** — R-S2, R-S3
3. **Page code** (deps, extensions, SW) — R2, R-C1, R-C2, R-S9
4. **The tailnet reachability** of the tab — R2, R3
5. **The at-rest secrets** — R1 (now fixed, §8)

Encryption (§8) hardens level 5. **Levels 1–4 are higher-value and must be defended with equal
seriousness**, or the encryption is moot.

**Revised must-fix priority (supersedes Round 1's top-3):**
1. **R-S1 / R-S2 / R-S3** — trust the engine deliberately (pin+review, or go v86); lock the build
   pipeline; protect origin/DNS/TLS. *This is the real root of trust.*
2. **R2 + R3** — tight Tailscale ACLs + ephemeral nodes so a subverted tab is a contained foothold.
3. **§8 + R-C1/R-C2** — encrypt at rest **and** adopt **short-lived GitHub credentials** so the
   in-use residual and passphrase-keylogging risks have small blast radius and short lifetime.
4. **R-F1 / R-F3** — Firefox-first: self-host all assets, handle private-mode/eviction, require
   `persist()`.
5. **R-A5** — ship dyslexia-friendly accessibility in v1, not later.

**Residual you are choosing to accept** (and it's reasonable for a personal, self-hosted,
single-user tool): a browser tab that is both connected to your tailnet and, while unlocked, in
possession of usable credentials is a network foothold if the engine, the pipeline, or page code
is ever subverted. The design shrinks this with ephemerality, tight ACLs, short-lived creds, and
a minimal/pinned/self-hosted code surface — but it does not eliminate it. Use a clean browser
profile, no untrusted extensions, and short-lived credentials, and the real-world risk is small.
