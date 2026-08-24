/* MOTIONSTILL CUT — the command palette (⌘K / Ctrl+K).
 *
 * Everything the chrome can do, reachable by typing. An NLE has hundreds of
 * commands behind menus; this app has a few dozen and no menu bar, so the
 * palette is the menu. Actions are registered by the modules that own them,
 * which keeps main.js from becoming a switchboard. */

import { h, $, clear } from "./util.js";

const actions = [];
let box = null, input = null, listEl = null, index = 0, filtered = [];

/**
 * @param {object} a
 * @param {string} a.id      stable id
 * @param {string} a.label   what it does, imperative
 * @param {string} [a.group] section heading
 * @param {string} [a.hint]  shortcut or explanation, right-aligned
 * @param {string[]} [a.keywords] extra search terms
 * @param {() => any} a.run
 * @param {() => boolean} [a.when] hide the action when this returns false
 */
export function registerCommand(a) {
  const existing = actions.findIndex(x => x.id === a.id);
  if (existing >= 0) actions[existing] = a; else actions.push(a);
}

export const registerCommands = (list) => list.forEach(registerCommand);

/* A forgiving subsequence match — "dlj" finds "Download the workflow JSON". */
function score(query, text) {
  const q = query.toLowerCase(), t = text.toLowerCase();
  if (!q) return 1;
  if (t.includes(q)) return 100 - t.indexOf(q);
  let qi = 0, hits = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) { qi++; hits++; }
  }
  return qi === q.length ? hits : 0;
}

function build() {
  if (box) return box;
  input = h("input", {
    type: "text", placeholder: "Type a command…  (⌘K)", spellcheck: "false",
    role: "combobox", "aria-expanded": "true", "aria-controls": "palette-list",
    "aria-autocomplete": "list", "aria-label": "Command palette",
    style: { height: "32px", fontSize: "13px", background: "#141414", border: "0", borderBottom: "1px solid var(--line)", borderRadius: "0" },
    oninput: () => { index = 0; paint(); },
  });
  listEl = h("div", {
    id: "palette-list", class: "pal-list", role: "listbox", "aria-label": "Commands",
    style: { maxHeight: "52vh", overflowY: "auto" },
  });
  box = h("div", {
    class: "pal-box", role: "dialog", "aria-modal": "true", "aria-label": "Command palette",
    style: {
      position: "fixed", top: "16vh", left: "50%", transform: "translateX(-50%)",
      width: "min(620px, 92vw)", zIndex: "120", display: "none",
      background: "var(--bg-panel)", border: "1px solid #000", borderRadius: "3px",
      boxShadow: "0 24px 70px rgba(0,0,0,.75)", overflow: "hidden",
    },
  }, input, listEl);
  document.body.appendChild(box);

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); index = Math.min(index + 1, filtered.length - 1); paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); index = Math.max(index - 1, 0); paint(); }
    else if (e.key === "Enter") { e.preventDefault(); runIndex(index); }
    else if (e.key === "Escape") { e.preventDefault(); closePalette(); }
  });
  document.addEventListener("mousedown", (e) => {
    if (box.style.display === "block" && !box.contains(e.target)) closePalette();
  });
  return box;
}

function runIndex(i) {
  const a = filtered[i];
  if (!a) return;
  closePalette();
  try { a.run(); } catch (err) { console.error("[palette]", err); }
}

function paint() {
  const q = input.value.trim();
  filtered = actions
    .filter(a => !a.when || a.when())
    .map(a => ({ a, s: Math.max(score(q, a.label), score(q, (a.keywords || []).join(" ")) * 0.8, score(q, a.group || "") * 0.5) }))
    .filter(x => x.s > 0)
    .sort((x, y) => y.s - x.s)
    .slice(0, 40)
    .map(x => x.a);
  index = Math.min(index, Math.max(0, filtered.length - 1));

  clear(listEl);
  let group = null;
  filtered.forEach((a, i) => {
    if (a.group && a.group !== group) {
      group = a.group;
      listEl.appendChild(h("div", {
        class: "pal-group", role: "presentation",
        style: {
          padding: "6px 11px 3px", fontSize: "var(--fs-sm)", letterSpacing: ".1em",
          textTransform: "uppercase", color: "var(--fg-faint)",
        },
      }, group));
    }
    listEl.appendChild(h("div", {
      class: "pal-item", role: "option", id: `palette-opt-${i}`,
      "aria-selected": i === index ? "true" : "false",
      dataset: { cmd: a.id },
      style: {
        display: "flex", alignItems: "center", gap: "10px", padding: "6px 11px", cursor: "pointer",
        background: i === index ? "var(--accent-dim)" : "transparent",
        color: i === index ? "#fff" : "var(--fg)",
      },
      onmouseenter: () => { index = i; paint(); },
      onclick: () => runIndex(i),
    },
      h("span", { style: { flex: "1", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, a.label),
      a.hint ? h("span.mono", { style: { fontSize: "var(--fs-sm)", opacity: ".65" } }, a.hint) : null,
    ));
  });
  if (!filtered.length) listEl.appendChild(h("div", { class: "pal-empty", style: { padding: "14px", color: "var(--fg-faint)" } }, "Nothing matches."));
  input?.setAttribute("aria-activedescendant", filtered.length ? `palette-opt-${index}` : "");
}

export function openPalette(prefill = "") {
  build();
  box.style.display = "block";
  input.value = prefill;
  index = 0;
  paint();
  input.focus();
  input.select();
}

export function closePalette() {
  if (box) box.style.display = "none";
}

export function togglePalette() {
  build();
  if (box.style.display === "block") closePalette(); else openPalette();
}

export const isPaletteOpen = () => !!box && box.style.display === "block";
