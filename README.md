# webtui

A research + design project for a **client-side-only website that boots a real Linux terminal in
the browser** — no backend — and does real work (`apt`, `ssh-keygen`, `git`) by routing all
networking through a **Tailscale** tailnet and your existing exit node.

> Open the site on any fresh machine → a Debian terminal boots in the tab → authenticate to
> Tailscale → get to work. No installs.

## How it works (short version)
- **Boot Linux in the tab:** WebVM / CheerpX JIT-compiles x86 Debian → WebAssembly. Runs on any
  CPU (x86, M1, ARM Chromebooks/tablets) and in Firefox/Chrome.
- **Persistent disk:** writable overlay in IndexedDB; SSH keys encrypted at rest.
- **Networking (the hard part):** browsers have no raw TCP, so packets tunnel over
  WebSocket/HTTPS via Tailscale DERP relays to **your exit node**, which reaches the internet.
- **No server you operate:** static hosting only; the exit node is the one machine involved.

## Launch a TUI from a link (`?app=`)
Add a small **`webtui.json`** to your repo root, then link to
`https://hunterdavis.com/webtui/?app=OWNER/REPO` — webtui fetches the manifest (over CORS
from `raw.githubusercontent.com`), shows a panel with the **exact commands**, and after you
click **Install & Run** it clones, installs prerequisites, and runs your TUI in the tab. If
the manifest needs network it makes you connect Tailscale first. See
[`examples/webtui.json`](examples/webtui.json).

```jsonc
{
  "name": "My TUI",            // required; shown in the launch panel
  "description": "…",          // optional
  "network": true,             // default true; clone/apt need the tunnel -> connect first
  "apt": ["python3"],          // optional prerequisite apt packages
  "install": ["pip3 install -r requirements.txt"],  // string or array; run after clone
  "run": "python3 -m myapp",   // string or array; the app (only runs if install succeeded)
  "workdir": "myapp"           // optional; defaults to the repo name
}
```

URL params: `?app=owner/repo` (or a full `https://…/webtui.json`), optional `&ref=branch`
and `&manifest=path/to/file.json`. **Security:** a `?app=` link is untrusted — nothing runs
until you click, and every command is shown first (the VM may be on your tailnet, R2).

### Offline mode — no Tailscale (recommended for dependency-free TUIs)
Cloning needs the tunnel, but the **page** can fetch your repo over CORS even when the VM
has no network. Set `"offline": true` and webtui downloads your files (the page lists them
via the GitHub API, skipping images/README/LICENSE), packs them into a tar, writes it into
an in-memory device, and the guest extracts + runs — **with Tailscale offline**:

```json
{ "name": "labrync", "description": "Maze screensaver.", "offline": true,
  "run": "python3 labrync.py -a" }
```

Optional: `"files": ["a.py","pkg/b.py"]` (explicit list, skips the API), `"exclude":
["docs/*"]`, `"env": {"PYTHONPATH": "."}`, `"workdir"`. Limitation: offline can't `apt`/
`pip install`, so it suits **stdlib-only** apps (or repos that vendor their deps into the
fetched files). Apps needing package installs should stay on the network (clone) path.

## Documents
- **[research.md](research.md)** — is this possible, and the alternatives (the "why").
- **[PLAN.md](PLAN.md)** — full design, function-level, plus a multi-round red team.
- **[IMPLEMENTATION.md](IMPLEMENTATION.md)** — step-by-step build order with "done when" gates.
- **[TEST_PLAN.md](TEST_PLAN.md)** — test matrix and pass criteria (Firefox-first).
- **[prompt.md](prompt.md)** — the original research prompt.

## Building the disk image
The Debian rootfs is built locally and is **not** committed (it's large and generated).
Requires Docker, `e2fsprogs` (`mkfs.ext2`), and `fakeroot`:

```sh
scripts/build-disk.sh full   # -> public/disk/debian.ext2       (~359 MB)
scripts/build-disk.sh lite   # -> public/disk/debian-lite.ext2  (~304 MB, busybox-class)
```

It builds an **i386** image (CheerpX runs a 32-bit x86 guest), exports the rootfs, and
`mkfs.ext2`'s a single read-only image under `fakeroot`. CheerpX streams blocks on demand
via `HttpBytesDevice` (HTTP range), so first boot only downloads the blocks it touches.

## Dev
```sh
npm ci                      # install pinned deps (lockfile committed)
scripts/build-disk.sh full  # -> public/disk/debian.ext2 (needs Docker; see above)
scripts/fetch-engine.sh     # self-host pinned CheerpX 1.2.8 -> public/vendor/ (+ SRI manifest)
npm run dev                  # Vite dev server (COOP/COEP) -> boots the VM in the browser
npm run build                # -> dist/ (Cloudflare Pages / Netlify ready, _headers included)
```
`scripts/fetch-engine.sh verify` checks the vendored engine against the committed
`public/vendor/engine.manifest.json` hashes (run on every version bump).

The host serving `debian.ext2` must support **HTTP range** and send **`Last-Modified` or
`ETag`** — `HttpBytesDevice` refuses to start otherwise. Vite dev and Cloudflare Pages both do.

## Status
Phases 1–7 implemented: cross-origin isolation, disk image pipeline, VM boot to a Debian
`bash` prompt, persistence (`persist()` + quota + factory reset), Tailscale networking +
auth (lazy `networkLogin` on Connect), the encrypted vault (age + ssh-agent on a RAM-only
`/run/keys` DataDevice, with Lock/auto-lock), and accessibility/UX (font/size/line-height/
high-contrast settings + a touch soft-key bar). See [IMPLEMENTATION.md](IMPLEMENTATION.md).

Phases 5–6 carry live gates that need your accounts (a tailnet + exit node; GitHub) and an
image rebuild; the code is in place but those end-to-end runs are unverified here.

## Deploy — GitHub Pages only, no server (Phase 8)
The whole thing ships on GitHub with no backend, via `.github/workflows/deploy.yml`:
- **App** → GitHub Pages (project site at `https://<user>.github.io/<repo>/`; Vite `base`
  defaults to `/webtui/`, override with `VITE_BASE=/` for a custom domain / user page).
- **Disk** → built **in CI** and published inside the Pages artifact, **not committed to
  git**. That sidesteps git's 100 MB/file push limit *and* keeps the disk **same-origin**
  with the app, so `HttpBytesDevice`'s ranged reads need no CORS. (GitHub Release assets
  were ruled out: `release-assets.githubusercontent.com` sends no `Access-Control-Allow-
  Origin`, so a cross-origin ranged read is blocked.) Published site stays under the 1 GB
  Pages limit (full 359 MB + lite 304 MB + engine ≈ 670 MB).
- **Cross-origin isolation** → Pages can't set COOP/COEP response headers, so
  `public/coi-serviceworker.js` (pinned, reviewed) injects them client-side; the app shows
  "enabling isolation…" during its one-time registration + reload. CSP is delivered via a
  `<meta>` tag (header-only directives like `frame-ancestors`/`X-Frame-Options` aren't
  available on Pages — a documented, accepted gap for this single-user tool).

**One-time repo setup:** Settings → Pages → Build and deployment → **Source = GitHub
Actions**. Then every push to `main` builds the engine + disk + app and deploys.

> Not yet verified end-to-end on a live Pages deployment (CI disk build + the 1 GB
> artifact + range serving through Pages' CDN). Run the workflow once and confirm the boot
> in Firefox; if a per-file serving limit ever bites, the fallback is to chunk the `.ext2`
> behind a stitching service worker (still same-origin, still GitHub-only).

## Key constraints
- Client-side only · runs in **Firefox** (primary) and Chrome/Chromebook · works on M1 and ARM ·
  encrypted secrets at rest · single-user / personal use.
