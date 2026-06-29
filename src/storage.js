// src/storage.js — the writable IndexedDB overlay that backs the VM disk (PLAN §5).
//
// The IDBDevice is the block-level writable layer that OverlayDevice stacks over the
// read-only ext2 base, so installed packages / edited files / shell history survive a
// reload, private to the origin. Phase 4 adds: a persistence request (so the browser
// doesn't silently evict the "disk" under storage pressure), quota/usage reporting for
// the status bar, and a factory reset.
//
// SECURITY: by default everything here is plaintext at rest in IndexedDB — including
// /root/.ssh. That is the #1 red-team finding (§R1); the mitigation is the encrypted
// vault in Phase 6, not this raw overlay.

import { loadCheerpX } from "./cheerpx.js";

export const OVERLAY_DB = "webtui-overlay";

/**
 * Ask the browser to make our origin's storage persistent (exempt from eviction under
 * storage pressure), and report the current quota/usage. Best-effort: a denial (e.g. a
 * private window, or a UA that gates it on engagement) is not fatal — the overlay still
 * works, it just isn't protected from eviction.
 * @returns {Promise<{supported:boolean, persisted:boolean, quota:number, usage:number}>}
 */
export async function requestPersistence() {
  const out = { supported: false, persisted: false, quota: 0, usage: 0 };
  if (!navigator.storage) return out;
  out.supported = true;
  try {
    // persisted() reports an already-granted grant; persist() requests one. Some UAs
    // grant silently, others prompt or auto-decide — either way we just read the result.
    if (navigator.storage.persisted) {
      out.persisted = await navigator.storage.persisted();
    }
    if (!out.persisted && navigator.storage.persist) {
      out.persisted = await navigator.storage.persist();
    }
    if (navigator.storage.estimate) {
      const { quota, usage } = await navigator.storage.estimate();
      out.quota = quota || 0;
      out.usage = usage || 0;
    }
  } catch (err) {
    console.warn("[webtui] persistence request failed:", err);
  }
  return out;
}

/** Re-read quota/usage without re-requesting the grant (cheap; for status refreshes). */
export async function storageEstimate() {
  if (!navigator.storage?.estimate) return { quota: 0, usage: 0 };
  try {
    const { quota, usage } = await navigator.storage.estimate();
    return { quota: quota || 0, usage: usage || 0 };
  } catch {
    return { quota: 0, usage: 0 };
  }
}

/**
 * Create the block-level writable overlay store. Requests persistence first so the
 * backing IndexedDB isn't a candidate for eviction.
 * @returns {Promise<{idb:any, persistence:{supported:boolean,persisted:boolean,quota:number,usage:number}}>}
 */
export async function initStorage() {
  const persistence = await requestPersistence();
  const CheerpX = await loadCheerpX();
  const idb = await CheerpX.IDBDevice.create(OVERLAY_DB);
  return { idb, persistence };
}

/**
 * Factory reset: delete the overlay IndexedDB database, discarding every write made to
 * the disk (installed packages, files, history, keys). The base ext2 image is untouched,
 * so the next boot starts from a pristine disk. (PLAN §5, `clearDisk()`.)
 *
 * The DB can't be deleted while CheerpX holds it open, so `deleteDatabase` fires a
 * `blocked` event rather than completing. The only reliable way to release those handles
 * is to tear down the page, so callers should reload immediately after this resolves;
 * we resolve on success OR on blocked (treating blocked as "will complete once the tab
 * goes away on reload").
 * @returns {Promise<{deleted:boolean, blocked:boolean}>}
 */
export function clearDisk() {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.deleteDatabase(OVERLAY_DB);
    } catch (err) {
      reject(err);
      return;
    }
    req.onsuccess = () => resolve({ deleted: true, blocked: false });
    req.onerror = () => reject(req.error || new Error("deleteDatabase failed"));
    // Open connections (the running VM) hold the DB; the delete will finish once the tab
    // reloads and those connections close. Report it so the caller can reload now.
    req.onblocked = () => resolve({ deleted: false, blocked: true });
  });
}
