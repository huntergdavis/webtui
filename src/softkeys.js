// src/softkeys.js — on-screen modifier/navigation keys for touch sessions (PLAN §14.4).
//
// Physical keyboards have Esc/Tab/Ctrl/arrows; phone/tablet soft keyboards usually don't.
// This bar injects those sequences. Esc/Tab/arrows/pipe emit directly; Ctrl and Alt are
// STICKY one-shot modifiers that transform the next real keystroke (via the terminal's
// setNextKeyTransform hook). Auto-shown on coarse-pointer devices; toggleable otherwise.

const SEQ = {
  Esc: "\x1b",
  Tab: "\t",
  "|": "|",
  "↑": "\x1b[A",
  "↓": "\x1b[B",
  "←": "\x1b[D",
  "→": "\x1b[C",
  "^C": "\x03", // SIGINT — common enough to warrant a dedicated key
};

/** Map a printable char to its Ctrl-<char> control byte (Ctrl-A=0x01 … Ctrl-_=0x1f). */
function toCtrl(ch) {
  if (!ch) return ch;
  const up = ch.toUpperCase();
  const c = up.charCodeAt(0);
  if (c >= 63 && c <= 95) return String.fromCharCode(c & 0x1f); // ?@A-Z[\]^_
  if (ch >= "a" && ch <= "z") return String.fromCharCode(ch.charCodeAt(0) - 96);
  return ch;
}
/** Prefix a key with ESC for Alt/Meta semantics. */
function toAlt(ch) {
  return "\x1b" + ch;
}

/**
 * Build + wire the soft-key bar.
 * @param {{type:(s:string)=>void, setNextKeyTransform:(fn:Function)=>void}} io
 */
export function wireSoftKeys(io) {
  const bar = document.getElementById("softkeys");
  if (!bar) return;

  // Show by default on touch / coarse-pointer devices; otherwise it stays available via
  // the toggle but hidden to keep the desktop chrome minimal.
  const coarse = window.matchMedia?.("(pointer: coarse)")?.matches;
  if (coarse) bar.removeAttribute("hidden");

  let stickyCtrl = false;
  let stickyAlt = false;

  const mkBtn = (label, onClick, kind) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "softkey" + (kind ? " softkey-" + kind : "");
    b.textContent = label;
    b.addEventListener("click", () => {
      onClick();
      // Keep focus in the terminal so the next physical/soft key goes to the guest.
      document.getElementById("screen")?.querySelector(".xterm-helper-textarea")?.focus();
    });
    bar.appendChild(b);
    return b;
  };

  const armNext = () => {
    if (!stickyCtrl && !stickyAlt) return;
    io.setNextKeyTransform((data) => {
      let out = data;
      if (stickyCtrl) out = toCtrl(out);
      if (stickyAlt) out = toAlt(out);
      stickyCtrl = stickyAlt = false;
      refreshMods();
      return out;
    });
  };

  let ctrlBtn, altBtn;
  const refreshMods = () => {
    ctrlBtn?.classList.toggle("armed", stickyCtrl);
    altBtn?.classList.toggle("armed", stickyAlt);
  };

  ctrlBtn = mkBtn("Ctrl", () => {
    stickyCtrl = !stickyCtrl;
    refreshMods();
    armNext();
  }, "mod");
  altBtn = mkBtn("Alt", () => {
    stickyAlt = !stickyAlt;
    refreshMods();
    armNext();
  }, "mod");

  for (const [label, seq] of Object.entries(SEQ)) {
    mkBtn(label, () => io.type(seq));
  }
}
