# TEST PLAN

How we prove each phase works and stays safe. **Firefox is the primary target — run every gate in
Firefox first**, then the rest of the matrix. Each test has a **Pass** condition.

Legend: ✅ must pass to ship · 🔁 regression (run every release) · 🔬 manual/security.

---

## 1. Platform matrix (run the smoke suite on each)

| # | Platform / browser | Priority | Notes |
|---|---|---|---|
| P1 | **Firefox desktop** (Linux/Win/Mac) | ✅ primary | first to run, every gate |
| P2 | **Chromebook** (desktop Chrome on Chrome OS) | ✅ primary | treat as desktop |
| P3 | Chrome/Edge desktop | ✅ | |
| P4 | **Firefox for Android** (Galaxy Tab S8+) | ✅ primary mobile | check SAB + heap cap |
| P5 | Chrome for Android (Tab S8+) | 🔁 | |
| P6 | M1/M2 Mac (Firefox + Safari 15.2+) | 🔁 | |
| P7 | iPad / iOS Safari | 🔬 best-effort | expect OOM; don't block release |

---

## 2. Smoke suite (the core "does it work" run)

- **S1 ✅ Cross-origin isolation:** console shows `crossOriginIsolated === true`.
  *Pass:* true on P1–P6.
- **S2 ✅ Boot:** page → `bash` prompt within target time.
  *Pass:* prompt appears; `uname -a`, `ls /`, `cat /etc/os-release` work.
- **S3 ✅ Memory probe:** `probeWasmMemoryCeiling()` returns a sane value; correct image (full vs
  lite) is chosen.
  *Pass:* no OOM on boot; status bar shows the budget.
- **S4 ✅ Terminal I/O:** type, run `vim`, `top`/`htop`, arrow keys, Ctrl-C, resize window.
  *Pass:* TUI renders and responds in xterm.
- **S5 ✅ Run a real TUI:** launch your `media_tui.py` (Textual).
  *Pass:* it renders and edits a file.

---

## 3. Persistence tests

- **PR1 ✅ Survives reload:** create `~/work/hello.txt` → reload → file present.
- **PR2 ✅ Package persists:** `apt install` a small pkg (after Phase 5) → reload → still installed.
- **PR3 ✅ persist() granted:** `navigator.storage.persist()` true, or a clear warning shows.
- **PR4 ✅ Firefox private window (R-F3):** IDB does **not** persist; app **warns** the user.
  *Pass:* warning shown, no silent data loss.
- **PR5 🔁 Factory reset:** `clearDisk()` wipes overlay; next boot is clean.

---

## 4. Networking + Tailscale tests

- **N1 ✅ Auth flow:** Connect → SSO popup (or inline link if blocked) → state `Running`.
- **N2 ✅ Ephemeral node:** node appears in tailnet on connect, **auto-removes** after tab close/idle.
- **N3 ✅ Exit-node egress:** select exit node → `curl https://ifconfig.me` returns the **exit
  node's** IP (not the local network's).
- **N4 ✅ DNS:** `getent hosts github.com` / `curl https://github.com` resolves via MagicDNS.
- **N5 🔬 ACL containment (R3):** from the VM, try to reach a tailnet peer **not** whitelisted.
  *Pass:* connection **fails** (deny-by-default works).
- **N6 🔁 Reconnect:** reload → re-auth → previously chosen exit node auto-selected.
- **N7 🔁 Throughput sanity:** `git clone` a small repo over the tunnel completes (note latency).

---

## 5. Crypto / secret tests (the R1 fix + Round 2)

- **C1 ✅ No plaintext at rest:** create SSH key via `vault-init` → `vault-lock` → dump IDB
  (`indexedDB` inspector). *Pass:* **only ciphertext**; no private key bytes anywhere in IDB or
  `localStorage`.
- **C2 ✅ RAM-only unlock:** while unlocked, confirm decrypted key is under `/run/keys` (RAM mount),
  **not** on the persisted overlay. *Pass:* after `vault-lock`, `/run/keys` is empty and nothing
  new persisted.
- **C3 ✅ Wrong passphrase rejected:** `vault-unlock` with bad passphrase fails cleanly (verifier).
- **C4 ✅ Auto-lock:** idle/blur → vault locks, `ssh-add -l` shows no keys.
- **C5 🔬 Tamper resistance (R-C3):** flip a byte in a vault record → decrypt **throws** (AES-GCM
  AAD/auth tag). *Pass:* no silent corruption, no downgrade accepted.
- **C6 🔬 IV uniqueness (R-C4):** inspect N encryptions → all IVs distinct.
- **C7 ✅ End-to-end GitHub:** unlock → `git push` over SSH to a test repo succeeds → lock.
- **C8 🔬 Agent hygiene (R-C10):** confirm `ssh-add -t` TTL expiry and `-c` confirm prompt fire.
- **C9 ✅ Short-lived cred path (R-C2):** a fine-grained PAT with near expiry stops working after
  expiry. *Pass:* expired cred is rejected (blast radius is time-bounded).
- **C10 🔁 Backup round-trip (§8.6):** export encrypted vault → import on a second profile →
  unlock works with the same passphrase.

---

## 6. Security / red-team verification (manual)

- **SEC1 🔬 R-S1 engine pin:** the engine loads from **self-hosted, SRI-pinned** files; a
  modified byte → load **fails** (SRI works).
- **SEC2 🔬 R-S2 build integrity:** `npm ci` from lockfile reproduces `dist/`; dependency list is
  minimal and reviewed.
- **SEC3 🔬 R-S3/R-S9 headers:** response includes COOP/COEP/CORP, CSP, HSTS, `X-Frame-Options:
  DENY`; no service worker (or a strictly versioned one).
- **SEC4 🔬 R-A3 clickjacking:** embedding the app in an `<iframe>` is blocked
  (`frame-ancestors 'none'`).
- **SEC5 🔬 CSP beacon block:** an attempted `fetch` to a non-allowlisted origin is blocked by CSP.
  *(Note: tunneled traffic via the VM stack is **not** covered by CSP — documented residual R2.)*
- **SEC6 🔬 R2 foothold review:** confirm ACLs make a subverted tab reach only exit node + GitHub.

---

## 7. Firefox-specific gates (R-F*)

- **FF1 ✅ COEP subresource (R-F1):** every asset loads under `require-corp`; intentionally add a
  cross-origin asset without CORP → it is **blocked** (confirms strictness is handled by
  self-hosting).
- **FF2 ✅ Memory semantics (R-F2):** boot succeeds on Firefox desktop **and** Firefox Android;
  probe picks correct image.
- **FF3 ✅ Private mode (R-F3):** covered by PR4.
- **FF4 🔁 KDF perf (R-F5):** Argon2 unlock time on Firefox is acceptable (< ~1.5 s desktop) and
  meets the security floor.

---

## 8. Accessibility gates (R-A5 — required for the primary user)

- **A1 ✅ Legible font:** OpenDyslexic-style font option applies to the terminal and UI.
- **A2 ✅ Sizing:** font size + line-height adjustable; persists across reloads.
- **A3 ✅ Contrast:** high-contrast theme available and readable.
- **A4 ✅ Labels not glyphs:** every status icon has an adjacent text label.
- **A5 🔁 Keyboard flows:** Connect / Unlock / Lock / Reset reachable and clearly labeled.

---

## 9. Resilience / failure-mode tests

- **R1 🔁 OOM handling:** force low-mem (lite image path) → clear message, no blank crash.
- **R2 🔁 Exit node down:** stop the exit node → VM internet fails with a legible status, tailnet
  peers still reachable.
- **R3 🔁 Tab discard mid-op (R-A4):** background the tab during a long op → on return, state is
  legible (warned), no silent corruption.
- **R4 🔁 Eviction:** simulate storage eviction → app detects missing disk, offers restore from
  backup.

---

## 10. Release gate
Ship only when: **all ✅ pass on P1 (Firefox desktop) and P2 (Chromebook)**, the **🔬 security
checks** pass, **P4 (Firefox/Chrome on Tab S8+)** passes the smoke suite with the chosen image,
and the **accessibility gates** pass. iPad (P7) is best-effort and does not block release.
