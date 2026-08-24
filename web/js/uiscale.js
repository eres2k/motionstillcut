/* HOW BIG THE INTERFACE IS.
 *
 * This app is drawn at 11px because it is copying a colourist's tool made for a
 * 27" monitor. On a phone that is a squint, and the browser's own pinch-zoom
 * answers it badly for a layout that is a full-height grid: you end up panning
 * a scaled page with half the chrome off screen.
 *
 * So the app scales itself, and the scale is a per-machine setting like the
 * panel sizes — it describes the screen you are looking at, not the clip you
 * are making.
 *
 * `zoom` is deliberate. `transform: scale()` would scale the pixels and leave
 * the layout thinking it was the old size, so a scaled app would overflow or
 * leave a gap; `zoom` scales the layout itself, and the app's height and width
 * are divided back out in CSS so it still fills the viewport exactly.
 */

const KEY = "mscut.ui.scale";

/* Named rather than free — three sizes someone can actually choose between,
 * and a phone-sized default that is not a squint. */
export const SCALES = [
  ["0.85", "Compact", "More on screen, smaller text"],
  ["1", "Default", "The size this was drawn at"],
  ["1.25", "Large", "Bigger controls and text"],
  ["1.5", "Largest", "For a phone, or across a room"],
];

const clamp = (n) => Math.min(2, Math.max(0.7, Number(n) || 1));

export function uiScale() {
  try {
    const v = localStorage.getItem(KEY);
    if (v) return clamp(v);
  } catch { /* private mode */ }
  /* No choice made yet. A coarse pointer on a narrow screen is a phone, and
   * 11px controls on a phone are the problem this exists to solve — so the
   * default is a size, not a shrug. */
  try {
    if (window.matchMedia("(pointer: coarse)").matches && window.innerWidth <= 820) return 1.25;
  } catch { /* jsdom, old browsers */ }
  return 1;
}

export function setUiScale(v) {
  const n = clamp(v);
  try { localStorage.setItem(KEY, String(n)); } catch { /* private mode */ }
  applyUiScale();
  return n;
}

export function applyUiScale() {
  document.documentElement.style.setProperty("--ui", String(uiScale()));
}

/** Step through the named sizes — for a keyboard shortcut or the palette. */
export function stepUiScale(dir) {
  const now = uiScale();
  const values = SCALES.map(s => Number(s[0]));
  // Nearest named size, then move from there, so a hand-set value still steps.
  let i = values.reduce((best, v, j) => (Math.abs(v - now) < Math.abs(values[best] - now) ? j : best), 0);
  i = Math.min(values.length - 1, Math.max(0, i + dir));
  return setUiScale(values[i]);
}
