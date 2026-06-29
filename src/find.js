// src/find.js — in-terminal search bar backed by @xterm/addon-search (Ctrl+Shift+F).

/**
 * Wire the find bar to the search addon. Returns { toggle } so the terminal key handler
 * can open it on Ctrl+Shift+F.
 * @param {import("@xterm/addon-search").SearchAddon} search
 * @param {import("@xterm/xterm").Terminal} term
 */
export function wireFind(search, term) {
  const bar = document.getElementById("findbar");
  const input = document.getElementById("find-input");
  if (!bar || !input) return { toggle: () => {} };

  const opts = { decorations: undefined };
  const next = () => { if (input.value) search.findNext(input.value, opts); };
  const prev = () => { if (input.value) search.findPrevious(input.value, opts); };

  const open = () => {
    bar.removeAttribute("hidden");
    input.focus();
    input.select();
  };
  const close = () => {
    bar.setAttribute("hidden", "");
    try { search.clearDecorations?.(); } catch { /* older addon */ }
    term.focus();
  };
  const toggle = () => (bar.hasAttribute("hidden") ? open() : close());

  document.getElementById("find-next")?.addEventListener("click", next);
  document.getElementById("find-prev")?.addEventListener("click", prev);
  document.getElementById("find-close")?.addEventListener("click", close);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? prev() : next(); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });

  return { toggle };
}
