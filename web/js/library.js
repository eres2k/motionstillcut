/* MOTIONSTILL CUT — the library.
 *
 * Everything upstream of a render is authoring. This is the other half: what
 * was made, what it was made from, and what you thought of it. Without it you
 * re-learn the same lesson every session, because the prompt that worked is
 * gone the moment the tab closes.
 */

import { api } from "./api.js";
import { compilePrompt } from "./prompt.js";
import { getProject } from "./state.js";

/* What goes wrong with an H3 clip, as a closed list — because a tag you can
 * count is worth ten notes you cannot. These are the failures the model
 * actually has; "bad" is not one of them. */
/* What can go right and wrong with a take.
 *
 * Each failure carries the house rule it implies, because noticing a problem
 * and preventing it are two different acts and the second one is the point.
 * Tagging a render "camera did its own thing" is an observation; turning that
 * into a rule is what makes the next prompt state the camera. One click
 * between them, or the observation just sits there being counted. */
export const VERDICT_TAGS = [
  { id: "good-take",       label: "a keeper",              good: true },
  { id: "identity-held",   label: "identity held",         good: true },
  { id: "audio-good",      label: "audio landed",          good: true },
  { id: "motion-good",     label: "motion read clearly",   good: true },
  {
    id: "identity-drift", label: "identity drifted",
    rule: "Restate the subject's identifying details — face, hair, wardrobe — in every shot they appear in. H3 does not carry identity across a cut on its own.",
  },
  {
    id: "extra-subject", label: "an extra character appeared",
    rule: "Name exactly who is in frame and no one else. An open cast invites the model to add people.",
  },
  {
    id: "beat-dropped", label: "a beat was dropped",
    rule: "One beat per 2–3 seconds. Lengthen the clip rather than crowding beats into a short one.",
  },
  {
    id: "cut-early", label: "the cut landed wrong",
    rule: "A cut must introduce new information. If only the distance or angle changes, use camera motion instead of a cut.",
  },
  {
    id: "camera-invented", label: "camera did its own thing",
    rule: "State the camera on every shot — motion, amplitude and speed, or \"the camera remains static\". Unstated motion is invented motion.",
  },
  {
    id: "audio-desync", label: "audio out of sync",
    rule: "Keep spoken lines short, and put them in the shot where the speaker's mouth is visible.",
  },
  {
    id: "audio-rough", label: "audio came back rough",
    rule: "Describe the ambience concretely in overall_soundscape — named physical sounds, not a mood.",
  },
  {
    id: "dialogue-wrong", label: "wrong words or language",
    rule: "Quote the exact words inside <d>[Language] … </d> and never paraphrase or translate them.",
  },
  {
    id: "soft", label: "soft or smeared",
    rule: "Keep camera amplitude small at 480p — large moves smear on this canvas.",
  },
  {
    id: "ref-ignored", label: "a reference was ignored",
    rule: "Cite every attached reference tag in the description. A tag the prompt never names is ignored entirely.",
  },
  {
    id: "style-off", label: "style missed",
    rule: "State the look and the grade in shot 1, and do not restate them differently later.",
  },
];

/** The house rule a failure implies, when it implies one. */
export const tagRule = (id) => VERDICT_TAGS.find(t => t.id === id)?.rule || "";

export const tagLabel = (id) => VERDICT_TAGS.find(t => t.id === id)?.label || id;
export const tagIsGood = (id) => !!VERDICT_TAGS.find(t => t.id === id)?.good;

/* ── The API ───────────────────────────────────────────────── */
export const library = {
  list:   (params = {}) => api.storeList("library", params),
  save:   (entry) => api.storeSave("library", entry),
  patch:  (id, changes) => api.storePatch("library", id, changes),
  remove: (id) => api.storeDelete("library", id),
};

export const rulebook = {
  list:   () => api.storeList("rulebook", { limit: 500 }),
  save:   (rule) => api.storeSave("rulebook", rule),
  patch:  (id, changes) => api.storePatch("rulebook", id, changes),
  remove: (id) => api.storeDelete("rulebook", id),
};

export const cast = {
  list:   () => api.storeList("cast", { limit: 500 }),
  save:   (entry) => api.storeSave("cast", entry),
  patch:  (id, changes) => api.storePatch("cast", id, changes),
  remove: (id) => api.storeDelete("cast", id),
};

/**
 * A finished job, as a library record. The project snapshot is what makes
 * "open this again" possible six weeks later — media bytes stay out of it (they
 * live in the pool and in ComfyUI), but every word and every setting is here.
 */
export function recordFor(job, project = getProject()) {
  const compiled = compilePrompt(project);
  const { jobs, simple, ...snapshot } = project;
  return {
    at: job.at || Date.now(),
    name: project.name || "Untitled",
    mode: job.mode || project.mode,
    status: job.status,
    tookMs: job.tookMs || null,
    promptText: job.promptText || compiled.text,
    description: compiled.description,
    soundscape: compiled.soundscape,
    music: compiled.music,
    settings: job.settingsSnapshot || {
      mode: project.mode,
      engine: job.meta?.engine || "minimax",
      resolution: project.render.resolution,
      duration: project.render.duration,
      variant: project.render.variant,
      seed: job.meta?.seed,
      precision: project.render.precision,
      refImageSize: project.render.refImageSize,
      tiledDecode: project.render.tiledDecode,
    },
    meta: job.meta || null,
    outputs: job.outputs || [],
    error: job.error || null,
    experimentId: job.experimentId || null,
    variantLabel: job.variantLabel || null,
    project: snapshot,
    verdict: { rating: null, tags: [], note: "" },
  };
}

/* ── Word diff ─────────────────────────────────────────────
 * The whole reason to keep two prompts side by side is to see the one word
 * that changed. A classic LCS diff over words, which is small, exact, and
 * needs no dependency. */
export function wordDiff(a = "", b = "") {
  const split = (t) => String(t || "").split(/(\s+)/).filter(s => s !== "");
  const A = split(a), B = split(b);
  const n = A.length, m = B.length;

  // Guard: the table is n×m, and a pair of very long prompts would be a big
  // allocation for a diff nobody can read anyway.
  if (n * m > 4_000_000) {
    return [{ type: a === b ? "same" : "changed", a, b }];
  }

  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  const push = (type, text) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { push("same", A[i]); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { push("del", A[i]); i++; }
    else { push("add", B[j]); j++; }
  }
  while (i < n) { push("del", A[i]); i++; }
  while (j < m) { push("add", B[j]); j++; }
  return out;
}

/** What differs between two records' settings, as rows the UI can print. */
export function settingsDiff(a = {}, b = {}) {
  const keys = [...new Set([...Object.keys(a.settings || {}), ...Object.keys(b.settings || {})])];
  return keys
    .map(k => ({ key: k, a: a.settings?.[k], b: b.settings?.[k] }))
    .filter(r => String(r.a ?? "") !== String(r.b ?? ""));
}

/** One line summarising a record, for a card. */
export function summarise(entry) {
  const s = entry.settings || {};
  return [
    (entry.mode || "").toUpperCase(),
    s.resolution,
    s.duration ? `${s.duration}s` : null,
    entry.meta?.variantLabel || s.variant,
    s.seed != null ? `seed ${s.seed}` : null,
  ].filter(Boolean).join(" · ");
}
