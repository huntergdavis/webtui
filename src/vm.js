// src/vm.js — CheerpX VM setup (PLAN §4.2).
//
// VERIFIED 2026-06 against current CheerpX (1.2.8): a self-hosted ext2 over HTTP is loaded
// with HttpBytesDevice (single file, range requests; the static host MUST send a
// Last-Modified or ETag validator or HttpBytesDevice refuses to initialise), made writable
// with OverlayDevice over the IDB overlay, then mounted ext2 at / with a devs /dev.
// (CloudDevice still exists but is for wss:// disks; HttpBytesDevice is the HTTP path.)

import { loadCheerpX } from "./cheerpx.js";

/** Disk image URLs (served from public/disk/, range-enabled). */
export const DISK_URLS = {
  full: "/disk/debian.ext2",
  lite: "/disk/debian-lite.ext2",
};

/**
 * Build the VM. `storage.idb` is the IndexedDB overlay from initStorage().
 * @param {{idb:any}} storage
 * @param {{image?: "full"|"lite"}} [opts]
 */
export async function initVM(storage, opts = {}) {
  const CheerpX = await loadCheerpX();
  const diskUrl = DISK_URLS[opts.image === "lite" ? "lite" : "full"];

  const block = await CheerpX.HttpBytesDevice.create(diskUrl);
  const overlay = await CheerpX.OverlayDevice.create(block, storage.idb);

  const cx = await CheerpX.Linux.create({
    mounts: [
      { type: "ext2", path: "/", dev: overlay },
      { type: "devs", path: "/dev" },
      // /proc and /sys are provided internally by CheerpX.
    ],
    // networkInterface / TailscaleNetwork is added in Phase 5 (deferred until Connect).
  });
  return cx;
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
