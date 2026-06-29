// src/vm.js — CheerpX VM setup (PLAN §4.2).
//
// VERIFIED 2026-06 against current CheerpX (1.2.8): a self-hosted ext2 over HTTP is loaded
// with HttpBytesDevice (single file, range requests; the static host MUST send a
// Last-Modified or ETag validator or HttpBytesDevice refuses to initialise), made writable
// with OverlayDevice over the IDB overlay, then mounted ext2 at / with a devs /dev.
// (CloudDevice still exists but is for wss:// disks; HttpBytesDevice is the HTTP path.)

import { loadCheerpX } from "./cheerpx.js";
import { buildNetworkInterface } from "./net.js";

/**
 * Disk image URLs (served same-origin from <base>disk/, range-enabled). Base-aware so they
 * resolve under a GitHub Pages project path. Same-origin is deliberate: it sidesteps CORS
 * entirely (Release assets / third-party hosts don't send Access-Control-Allow-Origin, so a
 * cross-origin ranged read would be blocked). The disk is deployed via the Pages Actions
 * workflow, not committed to git, so the 100 MB git-push limit doesn't apply.
 */
export const DISK_URLS = {
  full: import.meta.env.BASE_URL + "disk/debian.ext2",
  lite: import.meta.env.BASE_URL + "disk/debian-lite.ext2",
};

/**
 * Build the VM. `storage.idb` is the IndexedDB overlay from initStorage().
 *
 * The Tailscale networkInterface is attached here at create() time (the only time
 * CheerpX accepts it), but it stays DORMANT — no packets leave until net.js calls
 * cx.networkLogin() from the Connect button (PLAN §6, VERIFIED 2026-06). Pass
 * `{ net: false }` to boot with no interface at all (offline-only).
 * @param {{idb:any}} storage
 * @param {{image?: "full"|"lite", net?: boolean}} [opts]
 */
export async function initVM(storage, opts = {}) {
  const CheerpX = await loadCheerpX();
  const diskUrl = DISK_URLS[opts.image === "lite" ? "lite" : "full"];

  const block = await CheerpX.HttpBytesDevice.create(diskUrl);
  const overlay = await CheerpX.OverlayDevice.create(block, storage.idb);

  // In-memory device for the secret vault's plaintext keys (PLAN §8.1). DataDevice is
  // session-only RAM, NOT backed by IndexedDB, so decrypted keys mounted at /run/keys
  // never persist to the overlay — the core R1 fix. Mounted as a "dir" device.
  const keysDev = await CheerpX.DataDevice.create();

  // In-memory device for the offline app launcher (?app=). The PAGE fetches a repo's files
  // over CORS and writes them here with appDev.writeFile(); the guest sees them at /opt
  // with no VM network — so dependency-free TUIs run without Tailscale. Returned below.
  const appDev = await CheerpX.DataDevice.create();

  const config = {
    mounts: [
      { type: "ext2", path: "/", dev: overlay },
      { type: "devs", path: "/dev" },
      { type: "dir", path: "/run/keys", dev: keysDev },
      { type: "dir", path: "/opt", dev: appDev },
      // /proc and /sys are provided internally by CheerpX.
    ],
  };
  if (opts.net !== false) {
    // Dormant until cx.networkLogin() (Connect button) — see net.js.
    config.networkInterface = buildNetworkInterface();
  }

  const cx = await CheerpX.Linux.create(config);
  return { cx, appDev };
}

/**
 * Launch the login shell. Resolves when the process exits (PLAN §4.3).
 * The image runs as root (uid 0); HOME=/root.
 */
export async function startShell(cx) {
  return cx.run("/bin/bash", ["--login"], {
    env: [
      "HOME=/root",
      "USER=root",
      "TERM=xterm-256color",
      "SHELL=/bin/bash",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "LANG=C.UTF-8",
    ],
    cwd: "/root",
    uid: 0,
    gid: 0,
  });
}
