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

**Phase 8 (deploy) caveat:** Cloudflare Pages caps assets at **25 MiB/file**, so the
~300–360 MB disk images **cannot** be served from Pages. Host the `.ext2` on object
storage (e.g. **Cloudflare R2**) with HTTP range + `Last-Modified`/`ETag`, and — because
the page is COEP `require-corp` — send `Cross-Origin-Resource-Policy: cross-origin` (or
CORS with `Access-Control-Expose-Headers: Content-Range, Last-Modified, ETag`). If the
disk lives on a different origin than the app, add that origin to CSP `connect-src`.
Same-origin (one host serving both app + disk with range) avoids all of this.

## Key constraints
- Client-side only · runs in **Firefox** (primary) and Chrome/Chromebook · works on M1 and ARM ·
  encrypted secrets at rest · single-user / personal use.
