/* RESIZABLE SECTIONS.
 *
 * Every main layout in this app is one CSS grid of panels — three columns on
 * the Cut page, three on Media, two on Setup, and on a phone the same grids
 * stacked into rows. The proportions were the author's guess. This puts them
 * back in the creator's hands: drag the seam between any two sections.
 *
 * How it works, and why:
 *
 *   The seam is a real grid track, not an overlay. An absolutely-positioned
 *   handle would sit on top of a panel's scrollbar and eat the scroll; a track
 *   of its own cannot.
 *
 *   The pages do not have to know. A MutationObserver re-hydrates whatever the
 *   active page just drew, so a page's own redraw — which rebuilds its DOM
 *   from scratch — gets its seams back on the next frame, and no page needs a
 *   line of resize code in it.
 *
 *   Fixed tracks stay fixed and flexible ones stay flexible. A sidebar that
 *   was 230px stays 230px when you widen the window, exactly as it did before
 *   this existed — dragging changes the number, not the kind. Which tracks are
 *   flexible is read off the layout the stylesheet actually produced.
 *
 *   Sizes are remembered per breakpoint. The stylesheet lays these pages out
 *   differently at 1420, 1180 and 880 pixels — sometimes with a different
 *   number of sections — so one stored set of widths would be wrong in three
 *   of the four. Each width belongs to the shape it was dragged in.
 *
 *   It works with a finger. Pointer events throughout, a fatter grab strip on
 *   a touch screen, and `touch-action: none` so a drag is a drag and not a
 *   page scroll.
 *
 * Double-click a seam to give the section back to the stylesheet.
 */

const KEY = "mscut.sizes";
let lastBucket;
const MIN_COL = 96;     // a panel narrower than this is a sliver, not a panel
const MIN_ROW = 64;

const coarse = () => {
  try { return window.matchMedia("(pointer: coarse)").matches; } catch { return false; }
};
/* The grab strip. Wider on a touch screen, because a fingertip is about 9mm
 * and a mouse pointer is one pixel. */
const gutSize = () => (coarse() ? 13 : 6);

/* The stylesheet's own breakpoints. A width dragged at 1500px says nothing
 * about the two-column layout the same page takes at 1000px. */
function bucket() {
  const w = window.innerWidth;
  if (w <= 880) return "s";
  if (w <= 1180) return "m";
  if (w <= 1420) return "l";
  return "xl";
}

function readAll() {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; }
}
function writeAll(all) {
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* private mode */ }
}
const slot = (key, axis, n) => `${key}|${bucket()}|${axis}|${n}`;

function readSizes(key, axis, n) {
  const v = readAll()[slot(key, axis, n)];
  return Array.isArray(v) && v.length === n ? v : null;
}
function writeSizes(key, axis, tracks) {
  const all = readAll();
  all[slot(key, axis, tracks.length)] = tracks;
  writeAll(all);
}
function clearSizes(key, axis, n) {
  const all = readAll();
  delete all[slot(key, axis, n)];
  writeAll(all);
}

/* ── Tracks ───────────────────────────────────────────────────
 * A track is either {px} — a sidebar, which keeps its size when the window
 * changes — or {fr} — the part that absorbs the change. We cannot ask the
 * browser which is which (computed style resolves everything to pixels), so we
 * read it off the result: the widest tracks, and anything close to them, are
 * the ones the stylesheet let grow. That is true of every layout here, and the
 * classification is stored the moment a seam is dragged, so the guess is only
 * ever made once per layout. */
function classify(px) {
  const max = Math.max(...px);
  return px.map(v => (v >= max * 0.92 ? { fr: v } : { px: v }));
}

function template(tracks, axis, gut) {
  const min = axis === "col" ? MIN_COL : MIN_ROW;
  return tracks
    .map(t => (t.fr !== undefined ? `minmax(${Math.min(min, Math.round(t.fr))}px, ${t.fr.toFixed(3)}fr)` : `${Math.round(t.px)}px`))
    .flatMap((s, i) => (i ? [`${gut}px`, s] : [s]))
    .join(" ");
}

const propOf = (axis) => (axis === "col" ? "gridTemplateColumns" : "gridTemplateRows");
const sizeOf = (el, axis) => (axis === "col" ? el.getBoundingClientRect().width : el.getBoundingClientRect().height);

/** Move `delta` pixels across the seam between tracks i and i+1, honouring what
 *  each track is and refusing to squash either below the minimum. */
function nudge(tracks, i, delta, axis) {
  const min = axis === "col" ? MIN_COL : MIN_ROW;
  const a = tracks[i], b = tracks[i + 1];
  const av = a.fr !== undefined ? a.fr : a.px;
  const bv = b.fr !== undefined ? b.fr : b.px;
  // Both sides are measured in pixels at the moment of the grab, so a fr
  // weight and a pixel width move by the same arithmetic — and because the
  // pair's total never changes, the rest of the grid does not move.
  const d = Math.max(min - av, Math.min(bv - min, delta));
  const set = (t, v) => (t.fr !== undefined ? { fr: v } : { px: v });
  const out = tracks.slice();
  out[i] = set(a, av + d);
  out[i + 1] = set(b, bv - d);
  return out;
}

/* ── One grid ─────────────────────────────────────────────── */
function sections(grid) {
  return [...grid.children].filter(el =>
    !el.classList.contains("sz-gut") && getComputedStyle(el).display !== "none");
}

function hydrate(grid, key) {
  // A grid that scrolls its own children is a list, not a layout — the Setup
  // page becomes one on a phone, and rows you can drag inside a scrolling
  // column are nothing but a trap.
  const cs = getComputedStyle(grid);
  if (cs.overflowY === "auto" || cs.overflowY === "scroll") return;

  const panes = sections(grid);
  if (panes.length < 2) {
    grid.querySelectorAll(":scope > .sz-gut").forEach(g => g.remove());
    grid.classList.remove("sz-grid");
    grid.style.gap = "";
    return;
  }
  // Already seamed by a previous pass, and still the right shape.
  const existing = grid.querySelectorAll(":scope > .sz-gut");
  if (existing.length === panes.length - 1 && grid.dataset.szKey === key) return;
  existing.forEach(g => g.remove());

  /* Which way does this grid run? One resolved column with several children
   * means the stylesheet has stacked it — which is what every one of these
   * layouts does on a phone — so the seams run the other way. */
  const cols = cs.gridTemplateColumns.split(" ").filter(Boolean).length;
  const axis = cols > 1 ? "col" : "row";
  const gut = gutSize();

  // Measure BEFORE inserting anything: this is the layout the stylesheet
  // (and the page's own inline style) asked for.
  const measured = panes.map(el => sizeOf(el, axis));
  let tracks = readSizes(key, axis, panes.length) || classify(measured);
  // Stored widths were recorded at some other window size. Pixel tracks are
  // meant to survive that; flexible weights are relative anyway.
  tracks = tracks.map(t => (t.fr !== undefined ? { fr: t.fr } : { px: t.px }));

  for (let i = 0; i < panes.length - 1; i++) {
    grid.insertBefore(gutter(grid, key, axis, i, gut), panes[i + 1]);
  }
  grid.dataset.szKey = key;
  grid.dataset.szAxis = axis;
  grid.style[propOf(axis)] = template(tracks, axis, gut);
  /* The seam IS the hairline now, so the grid's own 1px gap would only make it
   * thicker. Set inline rather than in the stylesheet: the page layouts are
   * written with an id selector and would otherwise win on specificity, order
   * be damned. */
  grid.style.gap = "0px";
  grid.classList.add("sz-grid");
}

function gutter(grid, key, axis, i, gut) {
  const el = document.createElement("div");
  el.className = `sz-gut sz-${axis}`;
  el.style[axis === "col" ? "width" : "height"] = `${gut}px`;
  el.setAttribute("role", "separator");
  el.setAttribute("aria-orientation", axis === "col" ? "vertical" : "horizontal");
  el.tabIndex = 0;
  el.title = "Drag to resize — double-click to put it back";
  el.appendChild(document.createElement("i"));   // the grip

  const start = (e) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    const panes = sections(grid);
    const from = axis === "col" ? e.clientX : e.clientY;
    // Freeze the pixel truth at the moment of the grab. Everything after is
    // arithmetic on this, so nothing drifts mid-drag.
    const base = classifyFrom(readSizes(key, axis, panes.length), panes.map(el2 => sizeOf(el2, axis)));
    el.setPointerCapture?.(e.pointerId);
    grid.classList.add("sz-dragging");
    document.body.classList.add("sz-busy");

    let live = base;
    const move = (ev) => {
      const now = axis === "col" ? ev.clientX : ev.clientY;
      live = nudge(base, i, now - from, axis);
      grid.style[propOf(axis)] = template(live, axis, gut);
    };
    const end = () => {
      el.releasePointerCapture?.(e.pointerId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      grid.classList.remove("sz-dragging");
      document.body.classList.remove("sz-busy");
      writeSizes(key, axis, live);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  el.addEventListener("pointerdown", start);
  el.addEventListener("dblclick", () => {
    clearSizes(key, axis, sections(grid).length);
    delete grid.dataset.szKey;
    grid.style[propOf(axis)] = "";
    grid.querySelectorAll(":scope > .sz-gut").forEach(g => g.remove());
    hydrate(grid, key);
  });
  /* A seam is a control, so it answers the arrow keys — and that is also the
   * only way to move one without a pointing device. */
  el.addEventListener("keydown", (ev) => {
    const fwd = axis === "col" ? "ArrowRight" : "ArrowDown";
    const back = axis === "col" ? "ArrowLeft" : "ArrowUp";
    if (ev.key !== fwd && ev.key !== back) return;
    ev.preventDefault();
    const panes = sections(grid);
    const base = classifyFrom(readSizes(key, axis, panes.length), panes.map(el2 => sizeOf(el2, axis)));
    const next = nudge(base, i, (ev.key === fwd ? 1 : -1) * (ev.shiftKey ? 32 : 8), axis);
    grid.style[propOf(axis)] = template(next, axis, gut);
    writeSizes(key, axis, next);
  });
  return el;
}

/** Stored tracks tell us which are flexible; the live measurement tells us how
 *  big each one is right now. A drag needs both. */
function classifyFrom(stored, measured) {
  if (!stored || stored.length !== measured.length) return classify(measured);
  return stored.map((t, i) => (t.fr !== undefined ? { fr: measured[i] } : { px: measured[i] }));
}

/* ── Hydration ────────────────────────────────────────────── */
const GRIDS = ".cols, .rows, .cut-center";

function hydrateAll() {
  const page = document.querySelector(".page.active");
  if (!page) return;
  const id = page.id.replace(/^page-/, "");
  page.querySelectorAll(GRIDS).forEach((grid, i) => {
    // The key names the layout, not the element: a page redraws into brand new
    // nodes and the seams have to land in the same places.
    hydrate(grid, `${id}.${grid.classList[0]}.${i}`);
  });
}

let queued = false;
function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; hydrateAll(); });
}

let started = false;
export function startResizers() {
  if (started) return;
  started = true;
  lastBucket = bucket();
  hydrateAll();
  // Pages redraw themselves without telling anyone; watching the stage is how
  // the seams come back without every page having to remember to ask.
  new MutationObserver(schedule).observe(document.querySelector(".stage") || document.body,
    { childList: true, subtree: true });
  /* Crossing a breakpoint is the only thing that invalidates a layout: the
   * stylesheet may show a different number of sections, run them the other
   * way, or size them differently, and the widths you dragged belong to the
   * shape you dragged them in. Ordinary resizing inside a breakpoint is left
   * alone — that is what the fixed/flexible split is for. */
  window.addEventListener("resize", () => {
    if (bucket() === lastBucket) return;
    lastBucket = bucket();
    forget();
    schedule();
  });
}

/** Drop the seams and the inline templates, keeping what is stored. */
function forget() {
  document.querySelectorAll(`.page ${GRIDS}`).forEach(g => {
    delete g.dataset.szKey;
    g.classList.remove("sz-grid");
    g.style.gridTemplateColumns = "";
    g.style.gridTemplateRows = "";
    g.style.gap = "";
    g.querySelectorAll(":scope > .sz-gut").forEach(x => x.remove());
  });
}

/** Give every section on every page back to the stylesheet. */
export function resetAllSizes() {
  writeAll({});
  forget();
  hydrateAll();
}
