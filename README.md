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
npm ci        # install pinned deps (lockfile committed)
npm run dev    # Vite dev server with COOP/COEP -> crossOriginIsolated === true
npm run build  # -> dist/ (Cloudflare Pages / Netlify ready, _headers included)
```

## Status
Phase 1 (skeleton + cross-origin isolation) and Phase 2 (disk image pipeline) done.
See [IMPLEMENTATION.md](IMPLEMENTATION.md) for the build order.

## Key constraints
- Client-side only · runs in **Firefox** (primary) and Chrome/Chromebook · works on M1 and ARM ·
  encrypted secrets at rest · single-user / personal use.
