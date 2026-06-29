# Deep Research: A client-side-only, in-browser Linux terminal that can do real work

**Date:** 2026-06-28
**Question:** Can you ship a website with *no server component* that boots a minimal Linux
terminal in the browser, gives you a persistent (ideally encrypted) disk, lets you install
packages and `ssh-keygen` + push to GitHub, and — crucially — does **real networking**, given
that browsers don't expose raw TCP sockets?

---

## TL;DR

- **Booting Linux client-side: solved.** Two mature engines exist. **WebVM (CheerpX)** runs
  *unmodified* x86 Debian/Alpine binaries via an x86→WASM JIT; **v86** emulates a full PC and
  boots real kernels. Both are pure static assets — no server needed to *run* them.
- **Persistent encrypted-ish disk: solved.** Modified disk blocks are stored in the browser's
  **IndexedDB** as a writable overlay on top of a streamed base image. It persists across
  sessions and is private to the browser/origin. (It's at-rest in IndexedDB; "encrypted" needs
  a caveat — see §4.)
- **The crux — networking — is the real constraint, and it cannot be made *purely*
  client-side for arbitrary destinations.** Browsers expose only HTTP(S) and WebSockets, and
  even those are gated by CORS. Raw TCP/UDP to `github.com:22` or `deb.debian.org:80` is
  impossible from page JS. **Every** working solution tunnels packets over WebSocket/HTTPS to
  *some* relay. The only question is *whose* relay and whether *you* have to run it.
- **Best realistic answer for your use case:** ship the VM as static files, and get networking
  via **Tailscale's DERP relays (WebSocket transport) + an exit node**. You don't run a web
  server and you don't run a DERP relay, but the exit node is a machine somewhere (yours, a
  VPS, or any tailnet peer). That's the closest thing to "client-side only" that still lets
  `apt`, `git`, and `ssh` actually reach the internet. This is exactly how the public
  [webvm.io](https://webvm.io) does it.
- **GitHub specifically is the bright spot:** GitHub's REST/GraphQL API sends
  `Access-Control-Allow-Origin: *`, so you can do a surprising amount of GitHub work (read/write
  files, commits, PRs) **with zero proxy and zero VM** straight from page JS. Git's smart-HTTP
  transport does *not* send CORS headers, so `git push` over HTTPS still needs a CORS proxy.

---

## 1. Why the networking problem is fundamental

A web page's JS can only initiate three kinds of outbound connections:

1. `fetch`/`XMLHttpRequest` — HTTP(S) only, and subject to **CORS** (the *target* server must
   opt in with `Access-Control-Allow-*` headers, or the browser blocks the response).
2. `WebSocket` — an HTTP-upgraded, framed, bidirectional stream — but only to servers that
   speak the WebSocket handshake.
3. `WebRTC` (data channels) — peer-to-peer UDP-ish, but needs signaling + STUN/TURN.

There is **no** API for a raw TCP or UDP socket. (The experimental "Direct Sockets API" exists
only for Isolated Web Apps / installed PWAs with special permissions — not general web pages.)
So a Linux VM in the browser cannot just `connect()` to an arbitrary `host:port`. Its emulated
NIC has to hand ethernet/IP frames to JavaScript, and JS has to ferry them somewhere reachable
over WS/HTTPS. That "somewhere" is the unavoidable relay.

This is confirmed straight from the WebVM team: *"the browser does not expose access to
lower-level protocols such as UDP and TCP — you can only do HTTP(S), and even then you are
severely limited by CORS policies."*

---

## 2. The two engines for booting Linux in the browser

### Option A — WebVM / CheerpX (run real binaries, no full kernel emulation)
- **What it is:** [CheerpX](https://cheerpx.io) is an x86→WebAssembly JIT + Linux syscall
  emulation layer. It runs **unmodified** x86 Debian/Alpine ELF binaries (gcc, python, git,
  vim, etc.) directly. [WebVM](https://github.com/leaningtech/webvm) is the Debian-based demo
  distro on top of it; **WebVM 2.0** even ships a full Xorg/desktop.
- **Build your own image:** *Mini.WebVM* lets you define the box with a **Dockerfile** and get
  a browser-virtualized image out — that's your "install all kinds of supporting packages"
  story baked at build time.
- **Pros:** Near-native-ish performance for real toolchains; the most "it just works" Debian
  experience; first-class Tailscale networking already wired in.
- **Cons:** CheerpX is a **proprietary, closed-source** engine (free to use under their terms,
  loaded from their distribution). You're depending on Leaning Tech's runtime.
- **Licensing/repo:** WebVM repo is open (Apache-ish for the distro glue) but pulls the CheerpX
  engine.

### Option B — v86 (full-machine emulation, fully open source)
- **What it is:** [copy/v86](https://github.com/copy/v86) emulates an actual x86 PC (CPU, NIC,
  devices) and JIT-recompiles x86→WASM. Boots real Linux kernels (Buildroot, Alpine, even
  larger distros), ReactOS, FreeBSD, etc.
- **Networking:** configured via `config.net_device` with a **`relay_url`** — i.e. it expects a
  WebSocket relay (`fetch`/`wisp`/`websockproxy`) to carry ethernet frames out.
- **Pros:** MIT-licensed, self-contained, no proprietary dependency, you can host every byte.
- **Cons:** Slower than CheerpX for heavy userland; you assemble more of the stack (image,
  9p/filesystem, relay) yourself.

**Recommendation:** For your stated goal (open a browser on a Windows box, get a usable Debian
terminal with `fresh-editor`, real CLI tools, GitHub access), **WebVM/CheerpX** is the fastest
path to something genuinely usable; **v86** is the choice if "no proprietary engine, I host
everything" is a hard requirement.

---

## 3. Filesystem persistence

Both engines converge on the same browser-native trick:

- A **base disk image** is streamed/downloaded on demand (block-by-block, lazily).
- An **OverlayDevice / IDBDevice** stores every modified block in **IndexedDB**.
- Result: changes (your `ssh` keys, installed packages, edited files) **persist across reloads**
  and are **private to the origin** — never sent anywhere. CheerpX explicitly documents
  `CheerpX.OverlayDevice.create()` for "writable overlay on top of a read-only base, persisted
  in IndexedDB."
- v86 supports state snapshots and 9p filesystem with IndexedDB-backed persistence (via
  `IDBFS`-style `syncfs`).

**Capacity caveat:** IndexedDB is subject to browser storage quotas/eviction. For a "real" box
you'll want to request **persistent storage** (`navigator.storage.persist()`) and possibly the
**Origin Private File System (OPFS)** for larger/faster block storage.

---

## 4. "Encrypted disk" — the honest answer

IndexedDB data is stored on the user's machine, isolated per origin, but it is **not encrypted
at rest by the browser** in a way you control. To get real encryption you'd:

- Wrap the block device in a **client-side crypto layer** (WebCrypto AES-GCM) and store
  ciphertext blocks in IndexedDB/OPFS, deriving the key from a passphrase (PBKDF2/Argon2-WASM).
  This is custom work — neither engine does encrypted-at-rest overlays out of the box today.
- Or run an encrypted container *inside* the guest (e.g. a LUKS/`gocryptfs`/`age`-encrypted
  file on the overlay). Simpler to reason about, since the guest already has the tools, and the
  ciphertext is what lands in IndexedDB.

For `ssh-keygen` → add to GitHub: the keypair lives in the overlay (`~/.ssh`), persists, and
the guest-side encryption option above protects it at rest. Good enough for your scenario.

---

## 5. Networking options, ranked for "client-side only"

Restating the inescapable fact: **something** must relay frames over WS/HTTPS. Options differ
by *who runs that something* and *what it can reach*.

### 5a. Tailscale DERP + exit node  ⭐ (recommended; how webvm.io does it)
- Tailscale's **DERP relays** speak plain **HTTPS/WebSocket**, designed for "heavily
  constrained" clients — a browser qualifies. The official Tailscale Go client compiles to
  WASM; WebVM modified `tsconnect`, added a custom TUN device, and pipes IP packets over a JS
  `MessageChannel` into an **lwIP** TCP/IP stack compiled to WASM.
- To reach a *specific* tailnet machine: nothing else needed.
- To reach the **public internet** (`apt`, `git`, arbitrary hosts): you need an **exit node** —
  any device on your tailnet (a home box, a cheap VPS, a Raspberry Pi) advertising
  `--advertise-exit-node`.
- **"Client-side only" scorecard:** ✅ no web server you host, ✅ no DERP relay you host,
  ⚠️ you do need *one* exit-node machine somewhere for general internet. For "reach my own
  servers / GitHub via my homelab," this is excellent and basically zero-maintenance.

### 5b. WebSocket→TCP proxy (websockify / wstunnel / wisp / Emscripten proxy)
- A small server accepts a WebSocket and bridges to arbitrary TCP. Tools:
  [websockify](https://github.com/novnc/websockify),
  [wstunnel](https://github.com/erebe/wstunnel),
  [websocat](https://github.com/vi/websocat), or Emscripten's POSIX-sockets proxy.
- **Most flexible** (reaches anything) but **you must host and secure the proxy**, and it's
  legally on the hook for traffic it makes on users' behalf. This is the thing your "no server
  component" rule is trying to avoid. Fine for personal/single-user use; problematic as a
  public service.

### 5c. WebRTC to a peer relay
- Use WebRTC data channels to a peer that has real network access. Removes the *HTTP* server
  but still needs **signaling + STUN/TURN** infrastructure and a peer with connectivity. Not
  meaningfully more "serverless" than 5a/5b in practice.

### 5d. App-level HTTPS shims (no VM-level TCP at all)
- Skip emulating TCP; have the *guest* (or page) talk to services that already expose
  **CORS-enabled HTTPS APIs**. You can't `apt` this way, but you can do real work against any
  API that sets `Access-Control-Allow-Origin`. See §6 — this is the genuinely
  zero-infrastructure path for GitHub.

---

## 6. The GitHub / "real work" angle (better than expected)

Your worry — "without GitHub and API access it's pointless" — splits into two cases:

- **GitHub REST/GraphQL API:** sends `Access-Control-Allow-Origin: *`. You can read repos,
  create/update files, make commits, open PRs, manage issues — **directly from browser JS, no
  proxy, no VM, no relay.** A surprising amount of "git workflow" can be done as plain API
  calls. (`isomorphic-git` users commonly do exactly this as a push alternative.)
- **Git smart-HTTP transport** (`git clone/push` over `https://github.com/...git`): the git
  endpoints **do not** send CORS headers, so the browser blocks them. You need a **CORS proxy**
  — e.g. [`@isomorphic-git/cors-proxy`](https://github.com/isomorphic-git/cors-proxy) (the
  hosted `cors.isomorphic-git.org` exists but is rate-limited/for-dev). That's a tiny server,
  reintroducing a server component.
- **`git` over SSH** (`git@github.com:...`): needs TCP:22 → requires the Tailscale exit node or
  a WS→TCP proxy (§5a/5b). Your `ssh-keygen` keys then work normally.

**Practical takeaway:** For pure GitHub workflows, prefer **isomorphic-git + GitHub REST API**
(mostly proxy-free). For "I want a real shell that runs `apt`, `pip`, `cargo`, and `git push`,"
you need the VM **plus** Tailscale-exit-node networking.

---

## 7. Recommended architectures (pick by how strict "no server" is)

**Tier 1 — Purest, narrowest (zero infra you run).**
Static page + `xterm.js` + a JS-side toolset using only CORS-enabled HTTPS APIs
(GitHub API, etc.). No Linux VM. Great for a "GitHub power tool," not a general terminal.

**Tier 2 — Real Linux, networking via your own tailnet (recommended).**
Static-hosted **WebVM/CheerpX** (or self-hosted **v86**) + IndexedDB/OPFS persistent overlay
(+ optional guest-side encryption) + **Tailscale DERP/WASM** for networking + **one exit node**
(home box or $5 VPS) for `apt`/internet. You host *no web server and no relay*; just maintain
one always-on peer. Closest match to your vision that actually does real work.

**Tier 3 — Maximum reach, accepts a proxy.**
Same VM + a self-hosted **wstunnel/websockify** WS→TCP proxy (and/or a git CORS proxy). Reaches
literally anything, at the cost of running (and being responsible for) that proxy. Best for a
single-user personal deployment behind auth.

---

## 8. Hard limits / things that won't change

- **No raw TCP/UDP from a normal web page — period.** (Direct Sockets API is IWA/PWA-only and
  permission-gated; not a general solution.) Plan around relays, don't fight this.
- **A truly serverless *and* full-internet terminal is not achievable** — reaching arbitrary
  `host:port` always needs a relay with real network access. You can minimize/outsource it
  (Tailscale) but not eliminate it.
- **Performance:** CheerpX is good; v86 is heavier. Big `apt install`s are slow (blocks stream
  in, JIT warms up). First boot downloads a sizable base image.
- **Storage eviction:** without `navigator.storage.persist()`, the browser may evict your
  "disk." Request persistence and warn users.
- **CORS is per-target:** you only get proxy-free HTTP to servers that opt in (GitHub does;
  most don't).

---

---

## 9. Deep dive: routing ALL networking through Tailscale (your preferred path)

Since you already have Tailscale, this is the strongest answer — and it genuinely keeps the
*web app* serverless. Here's how it actually works and what you'd build.

### 9.1 The architecture, end to end
The in-browser Linux VM becomes **its own node on your tailnet**. Packet flow:

```
guest app (apt/git/ssh)
  → guest kernel NIC
  → custom TUN device driver        (in the VM engine)
  → lwIP TCP/IP stack (C→WASM)      (turns frames into a usable stack)
  → JS MessageChannel
  → Tailscale client (Go→WASM, "tsconnect")
  → WireGuard-over-DERP (HTTPS/WebSocket)   ← the only transport a browser allows
  → DERP relay (Tailscale-hosted)
  → your exit node                  ← does the real TCP/UDP to the internet
  → github.com / deb.debian.org / anything
```

Every hop except the exit node runs **inside the browser tab**. DERP relays are run by
Tailscale (you don't host them). The exit node is the one machine that touches the real
internet on the VM's behalf.

### 9.2 Auth: how you "log in within the terminal app"
The Tailscale Go client compiles to WASM and exposes a JS API via `newIPN(config)`. The
returned `ipn` object has `run(callbacks)`, **`login()`**, `logout()`, `ssh(...)`. Two ways to
authenticate, both fit your "OAuth within the app" idea:

1. **Interactive login (true OAuth/SSO flow).** Call `ipn.login()` → it surfaces a Tailscale
   login URL; the user completes the normal Tailscale OAuth/SSO in the browser and the node
   joins the tailnet. This is what public webvm.io does ("Log in with your Tailscale
   credentials"). Cleanest UX for *you* as the human at the keyboard — no secrets embedded in
   the page. **This is the recommended flow for a personal tool.**

2. **Auth key (non-interactive).** Pass `config.authKey` to `newIPN`. Good for automation, but
   it's a bearer secret you'd have to get into the page — only acceptable if *you* paste it at
   runtime (never bake it into shipped static assets).

WebVM logs the browser node in as an **ephemeral node** — it auto-removes from your tailnet
after the tab closes / goes idle, so you don't accumulate dead "phantom browser" devices. You
re-auth on reload. That's the right default for a browser node.

### 9.3 Getting an exit node (the one piece of "infra")
To route **all** of the VM's internet traffic through Tailscale you need an exit node — any
device on your tailnet running:
```
tailscale up --advertise-exit-node
# (and enable IP forwarding on that host)
```
Then approve it in the admin console. From the browser VM you select that exit node and 100% of
its egress flows: tab → DERP → exit node → internet. Candidates you likely already have:
your always-on home box, a NAS, a Raspberry Pi, or a $4–5/mo VPS. **You don't run a DERP relay
and you don't run a web/proxy server** — just this one peer, which you may already have.

### 9.4 Tightening it down (recommended hardening)
- **Tagged + scoped auth via an OAuth client.** Create a Tailscale **OAuth client** with the
  `auth_keys` scope and a tag like `tag:browser-vm`. Use it to mint **ephemeral, tagged** auth
  keys programmatically. Then write **ACLs** so `tag:browser-vm` may reach *only* what you want
  (e.g. your exit node + GitHub egress), not your whole tailnet. This contains the blast radius
  if a browser session is ever compromised.
- **Ephemeral + pre-authorized** keys so browser nodes self-clean and don't need manual
  approval each boot.
- Keep the interactive `login()` flow for day-to-day personal use; reserve auth keys for any
  unattended/automated variant.

### 9.5 What this gets you vs. what it can't
- ✅ `apt`/`pip`/`cargo` install over the network, `git push` over **SSH** (your `ssh-keygen`
  keys work), `ssh` to your own tailnet machines, curl/API calls — all real, through one tunnel.
- ✅ Web app stays static/serverless; no proxy you operate; DERP is Tailscale's.
- ✅ Private: traffic is WireGuard-encrypted end to end to the exit node.
- ⚠️ You need that **one exit node** for public-internet egress (not needed if you only ever
  talk to tailnet peers).
- ⚠️ Depends on Tailscale-the-company (control plane + DERP). Self-hostable alternative:
  **Headscale** (open-source control server) + your own DERP — removes the SaaS dependency, adds
  ops work.
- ⚠️ Latency: traffic is relayed via DERP (browser can't do direct WireGuard/UDP hole-punching),
  so expect relay-path latency, not LAN speed.

### 9.6 Concrete build recipe
1. Base VM: **WebVM/CheerpX** (fastest to a usable Debian) — its Tailscale integration is
   already wired; or **v86** with a `relay_url` if you want fully open-source/self-hosted.
2. Persistence: IndexedDB/OPFS overlay + `navigator.storage.persist()`; optional guest-side
   LUKS/`gocryptfs` for encrypted `~/.ssh`.
3. Networking: bundle the `tsconnect` WASM; on terminal start, run `ipn.login()` for the OAuth
   flow; mark the node ephemeral + `tag:browser-vm`.
4. Exit node: advertise one on your tailnet; select it from the VM; lock egress with ACLs.
5. GitHub: SSH (`git@github.com`) now works via the tunnel; or skip the tunnel for read/write
   via the CORS-enabled GitHub REST API + isomorphic-git.

**Bottom line:** Yes — "OAuth into Tailscale from inside the browser terminal, then route all
networking through the tailnet" is a real, proven pattern (it's literally how webvm.io ships),
and since you already run Tailscale, an exit node is the only moving part you need to provide.

---

## Sources

- [WebVM — webvm.io](https://webvm.io/)
- [WebVM repo (Leaning Tech)](https://github.com/leaningtech/webvm)
- [WebVM: server-less x86 VMs in the browser](https://labs.leaningtech.com/blog/webvm-server-less-x86-virtual-machines-in-the-browser)
- [How we added full networking to WebVM via Tailscale](https://labs.leaningtech.com/blog/webvm-virtual-machine-with-networking-via-tailscale)
- [WebVM 2.0: full Linux desktop in the browser](https://labs.leaningtech.com/blog/webvm-20)
- [Mini.WebVM: your Linux box from a Dockerfile](https://labs.leaningtech.com/blog/mini-webvm-your-linux-box-from-dockerfile-via-wasm)
- [CheerpX docs — Networking](https://cheerpx.io/docs/guides/Networking)
- [CheerpX docs — Files and filesystems](https://cheerpx.io/docs/guides/File-System-support)
- [CheerpX docs — OverlayDevice.create](https://cheerpx.io/docs/reference/CheerpX.OverlayDevice/create)
- [v86 (copy/v86)](https://github.com/copy/v86) · [v86 networking docs](https://github.com/copy/v86/blob/master/docs/networking.md)
- [Emscripten networking (WebSocket-emulated sockets)](https://emscripten.org/docs/porting/networking.html)
- [websockify](https://github.com/novnc/websockify) · [wstunnel](https://github.com/erebe/wstunnel) · [websocat](https://github.com/vi/websocat)
- [Tailscale exit nodes](https://tailscale.com/docs/features/exit-nodes) · [DERP servers](https://tailscale.com/kb/1232/derp-servers)
- [isomorphic-git](https://github.com/isomorphic-git/isomorphic-git) · [cors-proxy](https://github.com/isomorphic-git/cors-proxy)
- [GitHub: Using CORS and JSONP for cross-origin requests](https://docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests)
