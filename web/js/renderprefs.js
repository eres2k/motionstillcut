/* THE RENDER SETTINGS YOU CHOSE LAST.
 *
 * Resolution, length, checkpoint variant, precision, tiled decode — these are
 * properties of a MACHINE, not of a clip. Someone with 12GB and an int8 build
 * picks the same six things on every project, and until now the app made them
 * pick again every time: a new project came back at 832×480 turbo int8, and a
 * project that changed generation mode silently lost its checkpoint variant
 * because "turbo" is not a name the reference checkpoint answers to.
 *
 * So the last choice is remembered here, and it is what a new project starts
 * from. Two details make it behave:
 *
 *   The variant is remembered PER CHECKPOINT FAMILY. fl2va (text and image to
 *   video) offers full/turbo/turbo4; ref2va (reference to video) offers
 *   full/ref4. They are different lists of different files, so one slot could
 *   only ever hold half your answer. Attach a second picture, come back, and
 *   your Turbo is still Turbo.
 *
 *   The seed is not remembered. A seed belongs to a take, not to a setup —
 *   carrying yesterday's pinned seed into a new project would quietly render
 *   the same noise for a completely different clip.
 */

const KEY = "mscut.render.prefs";

/* Everything that describes the MACHINE, and nothing that describes this
 * particular clip.
 *
 * Two entries were on the wrong side of that line and both reached users.
 *
 *   duration is a property of the clip, not the box. Carrying it meant one
 *   click on a length button published that length as the default for every
 *   project afterwards — so somebody who tried 30 s once got 30 s on every
 *   new project from then on, past H3's 15 s ceiling, without ever choosing
 *   it again. That is most of "my videos keep repeating", arriving as a
 *   setting nobody set.
 *
 *   outputPrefix is where deliverables land. Carrying it meant a folder typed
 *   for one job silently collected every later project's renders.
 *
 * The seed was already excluded for the same reason, and this is the same
 * reason. If a length really is a habit rather than a decision, the honest
 * place to say so is the Setup memory panel, not a silent carry. */
const CARRIED = [
  "resolution", "fps", "precision", "tiledDecode", "refImageSize", "steps", "upscale",
  /* The engine is a machine fact too: picking the experimental LTX-2.5 build
   * means its ~40 GB of weights are installed on this box, and that stays
   * true for the next project. In r2v the field is inert (activeEngine in
   * state.js answers minimax there), so carrying it is harmless everywhere. */
  "engine",
];

/* Which family a mode's checkpoint belongs to. Kept as a literal rather than
 * imported from state.js, because state.js is what calls in here. The LTX
 * engine is its own family: its builds ("ltx_two"/"ltx_single") are names no
 * MiniMax checkpoint answers to, and vice versa. */
const familyOf = (mode, engine = "minimax") =>
  engine === "ltx25" && mode !== "r2v" ? "ltx25" : mode === "r2v" ? "ref2va" : "fl2va";

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch { return {}; }
}
function write(v) {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private mode */ }
}

/** The variant last chosen for whichever checkpoint this mode loads. */
export function rememberedVariant(mode, fallback, engine = "minimax") {
  const v = read().variants?.[familyOf(mode, engine)];
  return typeof v === "string" && v ? v : fallback;
}

/** Record a render block as the new default. Called whenever one changes. */
export function rememberRender(render, mode) {
  if (!render) return;
  const prefs = read();
  for (const k of CARRIED) {
    if (render[k] !== undefined) prefs[k] = render[k];
  }
  if (render.variant) {
    prefs.variants = { ...prefs.variants, [familyOf(mode, render.engine)]: render.variant };
  }
  write(prefs);
}

/** Lay the remembered settings over a fresh render block. */
export function applyRenderPrefs(render, mode = "t2v") {
  const prefs = read();
  for (const k of CARRIED) {
    if (prefs[k] !== undefined) render[k] = prefs[k];
  }
  // After the carry, so a remembered LTX engine reaches for the LTX build.
  render.variant = rememberedVariant(mode, render.variant, render.engine);
  return render;
}

/** Forget them — Setup offers this, because a machine can change. */
export function forgetRenderPrefs() { write({}); }

/** What is currently remembered, for Setup to show. */
export function renderPrefs() { return read(); }
