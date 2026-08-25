/* MOTIONSTILL CUT — small DOM + formatting helpers.
   No framework: the editor is a few thousand lines of plain modules, which is
   also what the rest of Motionstill is built out of. */

/** Tiny hyperscript. h("div.row", {onclick}, "text", child) */
export function h(spec, props, ...kids) {
  const [tag, ...classes] = String(spec).split(".");
  const node = document.createElement(tag || "div");
  if (classes.length) node.className = classes.join(" ");
  if (props && (typeof props !== "object" || props instanceof Node || Array.isArray(props))) {
    kids.unshift(props); props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class" || k === "className") node.className += (node.className ? " " : "") + v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k === "html") node.innerHTML = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "value") node.value = v;
    else if (k === "checked" || k === "disabled" || k === "selected") node[k] = !!v;
    else node.setAttribute(k, v);
  }
  const add = (kid) => {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) return kid.forEach(add);
    node.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  };
  kids.forEach(add);
  return node;
}

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
/* A rebuild that would put back the same <video> keeps the one that is
 * already there — moved, not recreated — so it neither restarts nor
 * autoplays again. Anything else is replaced as before. */
export function mount(node, ...kids) {
  const playing = new Map();
  node.querySelectorAll("video[src]").forEach(v => playing.set(v.getAttribute("src"), v));
  clear(node);
  kids.flat().forEach(k => k && node.appendChild(k));
  if (playing.size) node.querySelectorAll("video[src]").forEach(v => {
    const prev = playing.get(v.getAttribute("src"));
    if (prev && prev !== v && !prev.ended) v.replaceWith(prev);
  });
  return node;
}

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const uid = () => Math.random().toString(36).slice(2, 10);

export function debounce(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Seconds → HH:MM:SS:FF, the timecode Resolve puts on every ruler. */
export function timecode(seconds, fps = 24) {
  const s = Math.max(0, seconds || 0);
  const f = Math.round((s - Math.floor(s)) * fps);
  const total = Math.floor(s);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}:${pad(Math.min(f, fps - 1))}`;
}

/** Seconds → MM:SS.mmm — the format MiniMax's own multi-shot syntax uses for
 *  cut times ("[Shot 2] At 00:03.500, …"). Three decimals, always. */
export function shotTime(seconds) {
  const s = Math.max(0, seconds || 0);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const rest = (s % 60).toFixed(3).padStart(6, "0");
  return `${mm}:${rest}`;
}

export const words = (text) => String(text || "").trim().split(/\s+/).filter(Boolean).length;

export function download(filename, text, type = "application/json") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = h("textarea", { style: { position: "fixed", opacity: "0" } });
    ta.value = text;
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/* ── Toasts ─────────────────────────────────────────────── */
export function toast(title, message = "", kind = "") {
  const box = $("#toasts");
  if (!box) return;
  const node = h(`div.toast${kind ? "." + kind : ""}`, h("div.t", title), message ? h("div.m", message) : null);
  box.appendChild(node);
  setTimeout(() => {
    node.style.transition = "opacity .25s ease, transform .25s ease";
    node.style.opacity = "0"; node.style.transform = "translateX(14px)";
    setTimeout(() => node.remove(), 260);
  }, kind === "err" ? 7000 : 3600);
  return node;
}

/* ── Modal ──────────────────────────────────────────────────
 * One overlay, so two callers must not paint over each other: a password
 * prompt and a first-run guide arriving in the same tick is the normal case,
 * not an edge case. Later modals queue behind the open one. */
let _modalResolve = null;
let _modalChain = Promise.resolve();

export function modal(opts = {}) {
  const run = () => showModal(opts);
  // Chain onto whatever is already open, and keep the chain alive if a modal
  // rejects so one failure can't wedge every later dialog.
  const next = _modalChain.then(run, run);
  _modalChain = next.catch(() => {});
  return next;
}

function showModal({ title = "", body = null, actions = [], wide = false, full = false } = {}) {
  const overlay = $("#overlay");
  const box = $("#modal");
  $("#modal-title").textContent = title;
  // `full` is for content that needs the room to be understood at all — the
  // readthrough is a timeline, and a timeline in a 620px column is a list.
  box.classList.toggle("modal-full", !!full);
  box.style.width = full ? "min(1500px, 96vw)" : wide ? "min(900px, 94vw)" : "min(620px, 92vw)";
  box.style.height = full ? "min(920px, 92vh)" : "";
  const bd = $("#modal-body");
  mount(bd, body instanceof Node ? body : h("div", { html: body || "" }));
  const ft = $("#modal-foot");
  clear(ft);
  return new Promise((resolve) => {
    _modalResolve = resolve;
    const done = (v) => { closeModal(v); };
    for (const a of actions) {
      ft.appendChild(h(`button.btn${a.kind ? "." + a.kind : ""}`, { onclick: () => (a.onClick ? a.onClick(done) : done(a.value)) }, a.label));
    }
    if (!actions.length) ft.appendChild(h("button.btn", { onclick: () => done(null) }, "Close"));
    overlay.classList.add("open");
    const first = bd.querySelector("input, textarea, button");
    if (first) setTimeout(() => first.focus(), 30);
  });
}

export function closeModal(value = null) {
  $("#overlay")?.classList.remove("open");
  if (_modalResolve) { const r = _modalResolve; _modalResolve = null; r(value); }
}

/* ── Inspector building blocks ───────────────────────────────
 * An inspector earns its keep by being scannable. Three rules, enforced here
 * rather than left to each page: one group open at a time, the advanced
 * controls behind a "more", and the explanations behind a "?" instead of
 * permanently between you and the field you came for. */

const GROUP_STATE_KEY = "mscut.insp.open";

const readOpenGroup = () => {
  try { return localStorage.getItem(GROUP_STATE_KEY) || ""; } catch { return ""; }
};
const writeOpenGroup = (id) => {
  try { localStorage.setItem(GROUP_STATE_KEY, id || ""); } catch { /* private mode */ }
};

/**
 * Collapsible inspector group.
 * @param {string} title
 * @param {object} [opts] { id, icon, help, open, accordion }
 */
export function group(title, opts = {}, ...content) {
  if (typeof opts !== "object" || opts instanceof Node || Array.isArray(opts)) {
    content.unshift(opts);
    opts = {};
  }
  const id = opts.id || title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const accordion = opts.accordion !== false;
  const stored = readOpenGroup();
  const open = opts.open !== undefined ? opts.open : (accordion ? (stored ? stored === id : !!opts.defaultOpen) : true);

  const helpBox = opts.help
    ? h("div.g-help", { style: { display: "none" } }, opts.help)
    : null;

  const g = h(`div.insp-group${open ? "" : ".closed"}`, { dataset: { group: id } },
    h("div.gh",
      {
        onclick: (e) => {
          if (e.target.closest(".g-help-btn")) return;
          const box = e.currentTarget.parentElement;
          const closing = !box.classList.contains("closed");
          if (accordion) {
            box.parentElement.querySelectorAll(".insp-group").forEach(other => other.classList.add("closed"));
          }
          box.classList.toggle("closed", closing);
          if (accordion) writeOpenGroup(closing ? "" : id);
        },
      },
      h("span.caret", "▸"),
      opts.icon ? h("span.g-icon", opts.icon) : null,
      h("span.g-title", title),
      opts.badge ? h("span.g-badge", opts.badge) : null,
      h("span.spacer", { style: { flex: "1" } }),
      opts.help ? h("button.g-help-btn", {
        title: "What this is for",
        onclick: (e) => {
          e.stopPropagation();
          const shown = helpBox.style.display !== "none";
          helpBox.style.display = shown ? "none" : "block";
          e.currentTarget.classList.toggle("on", !shown);
        },
      }, "?") : null,
    ),
    /* The body is wrapped, so the group can be collapsed by animating the
     * wrapper's height to nothing without every control inside having to
     * survive being laid out by a grid. */
    h("div.gb", h("div.gb-in", helpBox, ...content.filter(Boolean))),
  );
  return g;
}

/** The advanced half of a group: hidden until asked for, so the common case is
 *  three controls rather than nine. */
export function more(label, ...content) {
  const body = h("div.more-body", ...content.filter(Boolean));
  const btn = h("button.more-btn", {
    onclick: (e) => {
      const shown = body.classList.toggle("open");
      e.currentTarget.classList.toggle("on", shown);
      e.currentTarget.firstChild.textContent = shown ? "▾ " : "▸ ";
    },
  }, h("span", "▸ "), label || "More");
  return h("div.more", btn, body);
}

/** A compact labelled row. Same shape everywhere, so the eye can skim. */
export function row(label, control, hint) {
  return h("div.i-row",
    h("label.i-label", label),
    h("div.i-ctl", control),
    hint ? h("div.i-hint", hint) : null,
  );
}

/** Labelled control row. */
export function field(label, ...ctl) {
  return h("div.field", h("label", label), h("div.ctl", ...ctl));
}

export function stackField(label, ...ctl) {
  return h("div.field.stack", h("label", label), ...ctl);
}

/** A <select>. An option may be a bare value, [value, label], or
 *  [value, label, title] — the third element becomes the option's tooltip,
 *  the same shape segmented() already took. */
export function select(options, value, onChange, props = {}) {
  const sel = h("select", { ...props, onchange: (e) => onChange(e.target.value) });
  for (const o of options) {
    const [v, label, title] = Array.isArray(o) ? o : [o, o];
    sel.appendChild(h("option", { value: v, title: title || null, selected: String(v) === String(value) }, label));
  }
  return sel;
}

export function checkbox(label, checked, onChange, title = "") {
  const id = "cb-" + uid();
  return h("label.flex", { for: id, title, style: { cursor: "pointer", gap: "6px" } },
    h("input", { type: "checkbox", id, checked, onchange: (e) => onChange(e.target.checked) }),
    h("span", label));
}

export function textarea(value, onInput, props = {}) {
  return h("textarea", { spellcheck: "false", ...props, value: value || "", oninput: (e) => onInput(e.target.value) });
}

export function segmented(options, value, onChange, extraClass = "") {
  const box = h(`div.seg${extraClass ? "." + extraClass : ""}`);
  for (const o of options) {
    const [v, label, title] = Array.isArray(o) ? o : [o, o];
    box.appendChild(h("button", {
      class: String(v) === String(value) ? "on" : "",
      title: title || "",
      onclick: () => onChange(v),
    }, label));
  }
  return box;
}

export function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}

export const bytes = (n) => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`;
