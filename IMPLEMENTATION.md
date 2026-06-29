# IMPLEMENTATION — step by step

Build order for the client-side-only browser Linux terminal (see `PLAN.md` for design,
`research.md` for the why). **Firefox is the primary dev/test browser.** Each phase has a clear
**Done when** so you always know if it worked.

> Conventions: 🧩 = code, 🧪 = test gate, ⚠ = verify against current CheerpX docs.

---

## Phase 0 — Decisions locked (no work, just the ground rules)
- Engine: **WebVM / CheerpX** (fastest to usable Debian). v86 only if you later need a fully
  auditable engine.
- Host: **header-capable static host** (Cloudflare Pages or Netlify) so you can set COOP/COEP and
  **avoid the service-worker shim**. (GitHub Pages only as a last resort + `coi-serviceworker`.)
- Networking: Tailscale `tsconnect` WASM + your existing exit node.
- Secrets: encrypt at rest (§8) + short-lived GitHub credentials.

**Done when:** you've created the GitHub repo and the static-host project (empty is fine).

---

## Phase 1 — Repo skeleton + cross-origin isolation (do this first; it gates everything)

1. Init the repo and toolchain:
   - `npm init`, add **Vite**, `xterm`, `xterm-addon-fit`.
   - Create the layout from `PLAN.md §2`.
2. 🧩 `index.html` — a `<div id="screen">`, a status bar, a Connect button, an Unlock button.
3. 🧩 `_headers` (Cloudflare/Netlify):
   ```
   /*
     Cross-Origin-Opener-Policy: same-origin
     Cross-Origin-Embedder-Policy: require-corp
     Cross-Origin-Resource-Policy: same-origin
     X-Frame-Options: DENY
     Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://*.tailscale.com wss://*.tailscale.com https://login.tailscale.com; frame-ancestors 'none'
   ```
4. 🧩 `ensureCrossOriginIsolated()` (PLAN §4.1) — hard-fail with a readable message.

🧪 **Done when:** deployed page logs `crossOriginIsolated === true` **in Firefox** (and Chrome).
If false, fix headers before doing anything else.

---

## Phase 2 — Disk image build pipeline (offline, one-time per image)

1. 🧩 `Dockerfile` — minimal Debian + `bash coreutils git openssh-client ca-certificates curl
   less vim age python3` + your tools (e.g. textual for `media_tui`). Keep it lean.
2. 🧩 `scripts/build-disk.sh` (PLAN §3): `build_rootfs` → `export_to_ext2` → `chunk_and_index`.
   - ⚠ Confirm the exact block format CheerpX `CloudDevice` expects for the current version.
3. Pre-seed `/etc/resolv.conf` (MagicDNS `100.100.100.100` + public fallback).
4. Build a **second, trimmed image** (busybox-class) for low-memory devices (PLAN §14.3).

🧪 **Done when:** `debian.ext2` exists, is chunked, and is < ~400 MB on the wire; lite image exists.

---

## Phase 3 — Boot the VM (no network yet)

1. 🧩 `terminal.js`: `initTerminal(el)`, `wireTerminalToVM(cx, term)` (PLAN §7.1).
   - ⚠ Confirm the CheerpX console hook (`setCustomConsole`/equivalent) name.
2. 🧩 `vm.js`: `initVM(storage, term)` — `CloudDevice` → `OverlayDevice` → `CheerpX.Linux.create`
   (PLAN §4.2). Self-host `cx.esm.js` + wasm in `vendor/`, pin the version, add **SRI**.
3. 🧩 `main.js`: `main()` orchestrator (PLAN §4) → `startShell()` runs `/bin/bash --login`.
4. 🧩 `detectPlatformBudget()` + `probeWasmMemoryCeiling()` (PLAN §14.1–14.3); pick image +
   `maxMemoryMB`.

🧪 **Done when:** in Firefox you get a `bash` prompt, can run `ls`, `uname -a`, edit a file.
No network needed yet.

---

## Phase 4 — Persistence

1. 🧩 `storage.js`: `initStorage()`, `requestPersistence()` (PLAN §5).
2. 🧩 `clearDisk()` admin action + a "Factory reset" button.
3. Show quota/usage + persist-granted state in the status bar.

🧪 **Done when:** create a file → reload tab → file still there. `persist()` returns granted (or a
clear warning shows if not). Verify in Firefox **and** a Firefox private window (expect: warns,
does not persist).

---

## Phase 5 — Tailscale networking + auth

1. 🧩 `net.js`: `buildNetworkInterface(term)` with `loginUrlCb / stateUpdateCb / netmapUpdateCb`
   (PLAN §6.1). No hardcoded `authKey`.
2. 🧩 `openAuthPopup(url)` + inline-link fallback (PLAN §6.2). Node = **ephemeral**.
3. 🧩 `connectNetwork(cx)` (Connect button) + `onNetmap` exit-node picker + `selectExitNode`
   (PLAN §6.3–6.4). Persist exit-node choice in `localStorage`.
4. Tailscale admin (one-time): tag `tag:browser-vm`, **deny-by-default ACL** scoped to exit node
   + GitHub only, ephemeral+pre-authorized policy (PLAN §10).

🧪 **Done when:** click Connect → Tailscale SSO → state reaches `Running` → select exit node →
inside the VM `curl https://ifconfig.me` returns the **exit node's** IP. Verify the ACL blocks a
non-whitelisted tailnet peer (`tailscale ping` / curl should fail).

---

## Phase 6 — Encrypted secrets (the R1 fix) + GitHub

1. 🧩 Disk image: ship `vault-init`, `vault-unlock`, `vault-lock` scripts (PLAN §8.1):
   - `vault-init`: `ssh-keygen -t ed25519`, then `age -p -o ~/.ssh.age` the `~/.ssh` archive.
   - `vault-unlock`: decrypt to **RAM mount** `/run/keys`, `ssh-add -t 1800 -c`.
   - `vault-lock`: `ssh-add -D`, re-encrypt if changed, `rm -rf /run/keys/*`.
   - ⚠ Confirm a non-persistent (tmpfs / in-memory DataDevice) mount for `/run/keys`.
2. 🧩 (Optional) `vault.js` host-side vault (PLAN §8.2) for a GitHub **fine-grained PAT** (short
   expiry), Argon2id + non-extractable AES-GCM, AAD-bound records.
3. 🧩 "Lock vault" button → `vault-lock` + clear any host-side key (`vaultLock()`).
4. Auto-lock on idle/blur (`visibilitychange`).
5. GitHub flow (PLAN §9): `ssh-keygen` (in `vault-init`) → add pubkey to GitHub → `git push` over
   SSH through the tunnel. Document the PAT/API path as the no-tunnel alternative.

🧪 **Done when:** create key in vault → lock → inspect IDB: **only ciphertext**, no plaintext key.
Unlock → `git clone`/`push` to a test GitHub repo over SSH succeeds. Idle → vault auto-locks.

---

## Phase 7 — UX, accessibility, hardening

1. 🧩 `ui.js`: status bar (isolation, quota, Tailscale state, exit node, DERP latency), exit-node
   picker, Connect/Unlock/Lock/Reset buttons.
2. 🧩 **Accessibility (R-A5):** font picker incl. an OpenDyslexic-style legible font, adjustable
   size + line-height, high-contrast theme, **labels next to every status icon** (no glyph-only
   meaning).
3. 🧩 Soft-key bar (Esc/Tab/Ctrl/Alt/arrows/pipe) for touch sessions (PLAN §14.4).
4. 🧩 Error surfaces: OOM → "browser capped memory, try lite image / Chromebook"; private-window →
   "won't persist"; popup blocked → inline link.
5. Hardening: SRI on all vendored scripts + the engine wasm; `npm ci` + lockfile; minimal deps;
   build from a clean runner (PLAN §11, R-S2).

🧪 **Done when:** full run-through on Firefox desktop passes the TEST_PLAN smoke + security gates,
and the font/contrast options visibly work.

---

## Phase 8 — Deploy
1. `vite build` → `dist/`.
2. Deploy to Cloudflare Pages; confirm `_headers` applied (check response headers in DevTools).
3. Custom domain + HTTPS + HSTS; enable DNSSEC/CAA on the domain (R-S3).
4. Run the TEST_PLAN platform matrix.

🧪 **Done when:** production URL boots in Firefox on a **fresh machine**, you auth Tailscale,
unlock the vault, and `git push` works — with no local installs.

---

## Build dependency checklist (keep it tiny — it's your trusted surface)
- Runtime: `xterm`, `xterm-addon-fit`, CheerpX (self-hosted), `tsconnect.wasm`, `argon2-browser`
  (only if host-side vault), optional `libsodium-wrappers`.
- Every one: pinned version + SRI + a reason to exist. Audit before adding. (R-S2)
