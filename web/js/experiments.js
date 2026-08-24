/* MOTIONSTILL CUT — experiments.
 *
 * The only reliable way to learn what a video model responds to is to change
 * ONE thing and hold everything else still. Doing that by hand means editing a
 * field, rendering, writing the settings down, editing it back, and trusting
 * yourself to have kept the seed — which is why nobody does it, and why prompt
 * folklore is mostly wrong.
 *
 * A sweep does it properly: one variable, N values, the same seed, everything
 * else untouched, each result recorded under one experiment id so the library
 * can show them together. What comes out is not a clip, it is an answer.
 */

import { getProject, update, orderedShots, selectedShot, RESOLUTIONS, DURATION_FRAMES, overLength, activeEngine } from "./state.js";
import {
  CAMERA_TYPES, AMPLITUDES, SPEEDS, SHOT_TYPES, VIEWPOINTS, LENSES,
  CAMERA_HEIGHTS, DEPTH_CUES, GRADES, LOOKS, variantsFor,
} from "./vocab.js";
import { rememberedVariant } from "./renderprefs.js";
import { renderNow } from "./render.js";
import { uid } from "./util.js";

const shotOf = (draft, shotId) => draft.shots.find(s => s.id === shotId) || draft.shots[0];

/* Each variable knows how to read itself, how to write itself, and what its
 * values are. Adding one is three lines, which is the point: the thing you
 * want to sweep next week is not on this list yet. */
export const SWEEP_VARIABLES = [
  {
    id: "camera.type", label: "Camera motion", scope: "shot",
    values: () => CAMERA_TYPES.map(c => [c[0], c[1]]),
    defaults: ["static", "push in", "arc left", "tracking"],
    get: (p, id) => shotOf(p, id)?.camera?.type,
    set: (draft, v, id) => { const s = shotOf(draft, id); s.camera = { ...s.camera, type: v, custom: "" }; },
  },
  {
    id: "camera.amplitude", label: "Amplitude", scope: "shot",
    values: () => AMPLITUDES, defaults: ["small", "medium", "large"],
    get: (p, id) => shotOf(p, id)?.camera?.amplitude,
    set: (draft, v, id) => { const s = shotOf(draft, id); s.camera = { ...s.camera, amplitude: v }; },
  },
  {
    id: "camera.speed", label: "Speed", scope: "shot",
    values: () => SPEEDS, defaults: ["slow", "normal", "fast"],
    get: (p, id) => shotOf(p, id)?.camera?.speed,
    set: (draft, v, id) => { const s = shotOf(draft, id); s.camera = { ...s.camera, speed: v }; },
  },
  {
    id: "camera.lens", label: "Lens", scope: "shot",
    values: () => LENSES, defaults: ["", "35mm", "85mm", "telephoto 135mm"],
    get: (p, id) => shotOf(p, id)?.camera?.lens,
    set: (draft, v, id) => { const s = shotOf(draft, id); s.camera = { ...s.camera, lens: v }; },
  },
  {
    id: "camera.height", label: "Camera height", scope: "shot",
    values: () => CAMERA_HEIGHTS, defaults: ["", "eye level", "ground level", "overhead"],
    get: (p, id) => shotOf(p, id)?.camera?.height,
    set: (draft, v, id) => { const s = shotOf(draft, id); s.camera = { ...s.camera, height: v }; },
  },
  {
    id: "camera.depth", label: "Depth / focus", scope: "shot",
    values: () => DEPTH_CUES, defaults: DEPTH_CUES.slice(0, 3).map(d => d[0]),
    get: (p, id) => shotOf(p, id)?.camera?.depth,
    set: (draft, v, id) => { const s = shotOf(draft, id); s.camera = { ...s.camera, depth: v }; },
  },
  {
    id: "shotType", label: "Shot type", scope: "shot",
    values: () => SHOT_TYPES, defaults: ["wide", "medium", "close-up"],
    get: (p, id) => shotOf(p, id)?.shotType,
    set: (draft, v, id) => { shotOf(draft, id).shotType = v; },
  },
  {
    id: "viewpoint", label: "Viewpoint", scope: "shot",
    values: () => VIEWPOINTS, defaults: ["front-facing", "side", "low-angle"],
    get: (p, id) => shotOf(p, id)?.viewpoint,
    set: (draft, v, id) => { shotOf(draft, id).viewpoint = v; },
  },
  {
    /* How hard an LTX timeline pin holds. The one guide parameter upstream
     * exposes, and the honest answer to "what strength should a pin be" is a
     * sweep — 1.0 nails the frame, lower lets the model drift toward it. */
    id: "keyframeStrength", label: "Pin strength (LTX keyframe)", scope: "shot", engines: ["ltx25"],
    values: () => [["0.25", "0.25"], ["0.5", "0.5"], ["0.75", "0.75"], ["1", "1.0"]],
    defaults: ["0.5", "0.75", "1"],
    get: (p, id) => String(shotOf(p, id)?.keyframeStrength ?? 1),
    set: (draft, v, id) => { const s = shotOf(draft, id); s.keyframeStrength = Number(v) || 1; },
  },
  {
    id: "style.look", label: "Overall style", scope: "clip",
    values: () => LOOKS.map(l => [l, l]), defaults: LOOKS.slice(0, 3),
    get: (p) => p.style.look,
    set: (draft, v) => { draft.style.look = v; },
  },
  {
    id: "style.grade", label: "Grade", scope: "clip",
    values: () => GRADES, defaults: GRADES.slice(0, 4).map(g => g[0]),
    get: (p) => p.style.grade,
    set: (draft, v) => { draft.style.grade = v; },
  },
  {
    /* THE engine experiment: the same compiled prompt, the same seed, H3 and
     * LTX-2.5 side by side in the library. This sweep is most of the reason
     * the second engine exists — folklore about which model "listens better"
     * is exactly the kind of claim a pinned-seed pair answers. */
    id: "render.engine", label: "Engine (same prompt, H3 vs LTX-2.5)", scope: "clip", modes: ["t2v", "i2v"],
    values: () => [["minimax", "MiniMax H3"], ["ltx25", "LTX-2.5 (experimental)"]],
    defaults: ["minimax", "ltx25"],
    get: (p) => (p.render.engine === "ltx25" ? "ltx25" : "minimax"),
    set: (draft, v) => {
      draft.render.engine = v;
      // The families share no build names — reach for the one last chosen
      // for the target engine so the sweep compares each at its usual build.
      draft.render.variant = rememberedVariant(draft.mode, v === "ltx25" ? "ltx_two" : "turbo", v);
    },
  },
  {
    id: "render.variant", label: "Build", scope: "clip",
    values: (p) => variantsFor(p.mode, activeEngine(p)).map(v => [v.key, v.label]),
    defaults: null,   // every build this mode has
    get: (p) => p.render.variant,
    set: (draft, v) => { draft.render.variant = v; },
  },
  {
    id: "render.resolution", label: "Canvas", scope: "clip",
    values: () => RESOLUTIONS.map(r => [r[0], r[1]]), defaults: ["832x480", "1344x768"],
    get: (p) => p.render.resolution,
    set: (draft, v) => { draft.render.resolution = v; },
  },
  {
    id: "render.duration", label: "Length", scope: "clip",
    values: () => Object.keys(DURATION_FRAMES).map(d => [d, `${d}s${overLength(d) ? " ⚠ repeats" : ""}`]), defaults: ["5", "10"],
    get: (p) => String(p.render.duration),
    set: (draft, v) => { draft.render.duration = Number(v); },
  },
  {
    id: "render.refImageSize", label: "Reference size (Ref2V)", scope: "clip", modes: ["r2v"],
    values: () => [["match", "match"], ["max", "max"]], defaults: ["match", "max"],
    get: (p) => p.render.refImageSize,
    set: (draft, v) => { draft.render.refImageSize = v; },
  },
  {
    id: "render.precision", label: "Precision", scope: "clip", engines: ["minimax"],
    values: () => [["int8", "INT8"], ["nvfp4", "NVFP4"]], defaults: ["int8", "nvfp4"],
    get: (p) => p.render.precision,
    set: (draft, v) => { draft.render.precision = v; },
  },
  {
    id: "seed", label: "Seed (the same prompt, different draws)", scope: "clip",
    values: () => [], defaults: null, freeform: true,
    get: (p) => p.render.seed,
    set: (draft, v) => { draft.render.seed = Number(v); },
  },
];

export const variableById = (id) => SWEEP_VARIABLES.find(v => v.id === id) || null;

export function variablesFor(project) {
  return SWEEP_VARIABLES.filter(v => (!v.modes || v.modes.includes(project.mode))
    && (!v.engines || v.engines.includes(activeEngine(project))));
}

/** The values a variable offers, with a sensible pre-selection. */
export function valuesFor(variable, project) {
  if (variable.freeform) {
    // A seed sweep is four draws from wherever the project currently sits.
    const base = project.render.seed >= 0 ? project.render.seed : Math.floor(Math.random() * 0xffffffff);
    return { all: [], selected: [base, base + 1, base + 2, base + 3].map(String) };
  }
  const all = variable.values(project);
  const defaults = variable.defaults || all.map(v => (Array.isArray(v) ? v[0] : v));
  return { all, selected: defaults.map(String) };
}

export const labelOf = (variable, value, project) => {
  if (variable.freeform) return `seed ${value}`;
  const pair = variable.values(project).find(v => String(Array.isArray(v) ? v[0] : v) === String(value));
  const label = Array.isArray(pair) ? pair[1] : pair;
  return String(label || value || "— none —");
};

/**
 * Run the sweep. Everything except the variable is held still — including the
 * seed, which is pinned for the duration and restored afterwards, because a
 * sweep whose seed moves is not an experiment, it is a mood board.
 *
 * @returns {{experimentId: string, results: object[]}}
 */
export async function runSweep({ variableId, values, shotId = null, onStep = () => {}, onEach = () => {} }) {
  const variable = variableById(variableId);
  if (!variable) throw new Error(`no such variable: ${variableId}`);
  if (!values?.length) throw new Error("pick at least one value");

  const project = getProject();
  const experimentId = `x-${uid()}`;
  const targetShot = shotId || (variable.scope === "shot" ? (selectedShot(project)?.id || orderedShots(project)[0]?.id) : null);

  const before = variable.get(project, targetShot);
  const seedBefore = project.render.seed;
  // A moving seed would hide the effect being measured behind sampling noise.
  const pinnedSeed = seedBefore >= 0 ? seedBefore : Math.floor(Math.random() * 0xffffffffff);
  if (!variable.freeform) update((draft) => { draft.render.seed = pinnedSeed; }, "render");

  const results = [];
  try {
    for (const [i, value] of values.entries()) {
      update((draft) => variable.set(draft, value, targetShot), "shots");
      const label = `${variable.label}: ${labelOf(variable, value, project)}`;
      onStep(`${i + 1}/${values.length} — ${label}`);
      const job = await renderNow({
        onStep: (m) => onStep(`${i + 1}/${values.length} — ${label} · ${m}`),
        experimentId,
        variantLabel: labelOf(variable, value, project),
      });
      results.push({ value, job });
      onEach(value, job, i);
    }
  } finally {
    // Put the project back exactly as it was: a sweep is a question, not an
    // edit, and answering it should not quietly change the timeline.
    update((draft) => {
      variable.set(draft, before, targetShot);
      draft.render.seed = seedBefore;
    }, "shots");
  }
  return { experimentId, results, variable, values };
}

/** A one-line estimate so nobody starts a nine-render sweep by accident. */
export function sweepCost(values, estimateSeconds) {
  const n = values?.length || 0;
  return { runs: n, seconds: n * estimateSeconds };
}
