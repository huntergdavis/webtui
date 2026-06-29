// src/settings.js — accessibility + display settings (PLAN §7.2, R-A5).
//
// First-class, not polish: font family (incl. a dyslexia-friendly legible option),
// adjustable size + line-height, and a high-contrast theme. Everything persists to
// localStorage and applies to BOTH the page chrome (CSS custom properties) and the
// xterm canvas (which can't read CSS vars, so we set term.options directly).

const KEY = "webtui.settings";

const FONTS = {
  mono: {
    label: "Monospace (default)",
    stack: 'ui-monospace, "Cascadia Code", "Fira Code", Menlo, Consolas, "DejaVu Sans Mono", monospace',
  },
  legible: {
    // High-legibility option. Uses OpenDyslexic if self-hosted (scripts/fetch-fonts.sh
    // -> /vendor/fonts, declared via @font-face in style.css); falls back to a widely
    // available legible mono stack if the font file is absent, so it never breaks.
    label: "OpenDyslexic / legible",
    stack: '"OpenDyslexic Mono", "OpenDyslexic", "Atkinson Hyperlegible", "DejaVu Sans Mono", ui-monospace, monospace',
  },
};

const DEFAULTS = { font: "mono", size: 14, lineHeight: 1.0, contrast: "normal" };

function load() {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) || "{}")) };
  } catch {
    return { ...DEFAULTS };
  }
}
function save(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private window — settings just won't persist */
  }
}

const TERM_THEME = {
  normal: { background: "#000000", foreground: "#d6deeb", cursor: "#d6deeb" },
  high: { background: "#000000", foreground: "#ffffff", cursor: "#ffff00" },
};

/**
 * Apply settings to the live terminal + page. Refits so the guest gets correct cols/rows
 * after any size/font change.
 * @param {{term:any, fit:any}} io
 * @param {object} s
 */
function apply(io, s) {
  const fam = (FONTS[s.font] || FONTS.mono).stack;
  // Page chrome via CSS vars.
  document.documentElement.style.setProperty("--term-font", fam);
  document.body.classList.toggle("hc", s.contrast === "high");
  // Terminal canvas (direct options; xterm can't see CSS vars).
  if (io.term) {
    io.term.options.fontFamily = fam;
    io.term.options.fontSize = s.size;
    io.term.options.lineHeight = s.lineHeight;
    io.term.options.theme = TERM_THEME[s.contrast === "high" ? "high" : "normal"];
  }
  try {
    io.fit?.fit();
  } catch {
    /* transient 0-size during layout — ignore */
  }
}

/**
 * Wire the settings panel (toggle button + controls) and apply persisted settings.
 * @param {{term:any, fit:any}} io
 */
export function wireSettings(io) {
  const state = load();
  apply(io, state);

  const panel = document.getElementById("settings-panel");
  const toggle = document.getElementById("btn-settings");
  if (toggle && panel) {
    toggle.addEventListener("click", () => {
      const open = panel.hasAttribute("hidden");
      if (open) panel.removeAttribute("hidden");
      else panel.setAttribute("hidden", "");
      toggle.setAttribute("aria-expanded", String(open));
    });
  }

  // Populate the font <select>.
  const fontSel = document.getElementById("set-font");
  if (fontSel) {
    fontSel.innerHTML = "";
    for (const [k, v] of Object.entries(FONTS)) {
      const opt = document.createElement("option");
      opt.value = k;
      opt.textContent = v.label;
      if (k === state.font) opt.selected = true;
      fontSel.appendChild(opt);
    }
    fontSel.addEventListener("change", () => {
      state.font = fontSel.value;
      save(state);
      apply(io, state);
    });
  }

  bindRange("set-size", state, "size", io, (v) => parseInt(v, 10), "px");
  bindRange("set-lh", state, "lineHeight", io, (v) => parseFloat(v), "×");

  const hc = document.getElementById("set-contrast");
  if (hc) {
    hc.checked = state.contrast === "high";
    hc.addEventListener("change", () => {
      state.contrast = hc.checked ? "high" : "normal";
      save(state);
      apply(io, state);
    });
  }
}

function bindRange(id, state, prop, io, parse, suffix) {
  const el = document.getElementById(id);
  const out = document.getElementById(id + "-val");
  if (!el) return;
  el.value = String(state[prop]);
  if (out) out.textContent = state[prop] + (suffix || "");
  el.addEventListener("input", () => {
    state[prop] = parse(el.value);
    if (out) out.textContent = state[prop] + (suffix || "");
    save(state);
    apply(io, state);
  });
}
