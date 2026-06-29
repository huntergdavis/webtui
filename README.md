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

## Status
Design + research complete. Implementation not yet started.

## Key constraints
- Client-side only · runs in **Firefox** (primary) and Chrome/Chromebook · works on M1 and ARM ·
  encrypted secrets at rest · single-user / personal use.
