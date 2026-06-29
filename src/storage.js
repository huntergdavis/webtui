// src/storage.js — the writable IndexedDB overlay that backs the VM disk (PLAN §5).
//
// Phase 3 provides the minimum the boot needs: an IDBDevice that OverlayDevice layers over
// the read-only ext2 base, so installed packages / edited files / shell history survive a
// reload, private to the origin. Phase 4 adds navigator.storage.persist(), quota reporting,
// and clearDisk()/factory-reset on top of this.

import { loadCheerpX } from "./cheerpx.js";

export const OVERLAY_DB = "webtui-overlay";

/** Create the block-level writable overlay store. */
export async function initStorage() {
  const CheerpX = await loadCheerpX();
  const idb = await CheerpX.IDBDevice.create(OVERLAY_DB);
  return { idb };
}
