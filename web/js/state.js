/* MOTIONSTILL CUT — the project model.
 *
 * One plain object holds the whole timeline. Everything the editor shows is a
 * projection of it, everything the editor does is a mutation of it, and both
 * deliverables — the ComfyUI graph and the compiled prompt — are pure
 * functions of it. That is what makes "download the JSON" and "send it to
 * ComfyUI" the same button with two endings.
 */

import { uid, debounce } from "./util.js";
import { applyRenderPrefs, rememberRender, rememberedVariant } from "./renderprefs.js";
// vocab.js imports nothing, so this is a leaf dependency and not a cycle.
import { SPEAKERS, REF_TASK_TYPES, FRAMINGS } from "./vocab.js";

const STORE_KEY = "mscut.project.v1";
export const PROJECT_VERSION = 1;

/* T2V and I2V share a node on purpose, and it is not a copy-paste slip:
 * MiniMaxH3ImageToVideo takes `first_frame` as an OPTIONAL input, and text to
 * video is that node with the input left unconnected. There is no separate
 * text-only node in ComfyUI's MiniMax H3 support. They do differ in one thing
 * this table doesn't carry — I2V also emits the keyframe-alignment line — and
 * that lives in the prompt compiler where it belongs.
 *
 * Ref2V is genuinely different: a different node AND a different checkpoint
 * (ref2va, not fl2va). The two are never mixed, including their Turbo LoRAs. */
export const MODES = {
  t2v: { key: "t2v", label: "Text to Video",      short: "T2V",   node: "MiniMaxH3ImageToVideo",     dit: "fl2va" },
  i2v: { key: "i2v", label: "Image to Video",     short: "I2V",   node: "MiniMaxH3ImageToVideo",     dit: "fl2va" },
  r2v: { key: "r2v", label: "Reference to Video", short: "Ref2V", node: "MiniMaxH3ReferenceToVideo", dit: "ref2va" },
};

/* MiniMax H3 at 24 fps. The frame counts are the model's, not ours: the joint
 * video/audio latent only lands on lengths where n % 17 == 5 — the VAE's own
 * clip_length is 17 (vae/config.json in MiniMaxAI/MiniMax-H3) — and anything
 * else is silently rounded inside the node.
 *
 * DO NOT "correct" these to duration × 24. Every entry is on the grid —
 * 124, 243, 362, 481, 600 and 736 are all ≡ 5 (mod 17) — which is why they are
 * not multiples of 24 and why the steps are not even. The last one is the
 * conspicuous one: 30 s would be 720 frames, 720 is off the grid, and the row
 * rounds UP to 736 (30.7 s) rather than down to 719, matching the table the
 * main Motionstill app has been rendering with. Changing it changes what a
 * "30 s" clip is. */
export const DURATION_FRAMES = { 5: 124, 10: 243, 15: 362, 20: 481, 25: 600, 30: 736 };

/* What H3 can actually GENERATE, which is a different question from what the
 * latent grid can hold — and the one that matters, because the node accepts a
 * longer length without complaining and the model fills the extra seconds by
 * repeating itself.
 *
 * MiniMax's model card is unambiguous: "durations of up to 15 seconds", and a
 * specification table whose first row reads
 *
 *     | Output duration | 4–15 seconds |
 *     | Output frame rate | 24 FPS |
 *
 * (huggingface.co/MiniMaxAI/MiniMax-H3, System Overview). More shots do not
 * buy more seconds: the shot list is prompt syntax, the 15 s is the model.
 * The last three rows above are past it and stay selectable — the main app
 * renders with that table, and a length you can pick and be warned about is
 * better than one that silently disappears from a saved project — but nothing
 * in this app may present them as equivalent choices. */
export const H3_DURATION = { min: 4, max: 15 };

/* ── The second engine (experimental) ─────────────────────────
 * LTX-2.5 as an alternative renderer for T2V and I2V, fed the same timeline compiled
 * prompt. That is the whole experiment: H3's grammar is a structure the cut
 * timeline already compiles, and LTX-2.5 reads long structured prose well —
 * but it was not trained on the [Shot N] dialect, so the markers ride along
 * as prose and multi-shot control is exactly what the experiment measures.
 * Ref2V stays MiniMax-only: LTX has no reference pipeline, so activeEngine()
 * answers "minimax" there whatever the field says.
 *
 * The engines disagree about time. H3's joint latent lands on n % 17 == 5;
 * LTX's video VAE has temporal stride 8, so its clips land on 8k + 1 frames
 * (the same grid the main Motionstill app renders LTX on). 481 frames — the
 * 20 s row — happens to sit on both grids, which is a coincidence, not a
 * design. And LTX-2.5 genuinely generates up to 30 s, so the H3 repeat
 * warning would be wrong there: overLength() checks the engine's own ceiling.
 */
export const ENGINES = {
  minimax: { key: "minimax", label: "MiniMax H3", short: "H3" },
  ltx25:   { key: "ltx25",   label: "LTX-2.5",    short: "LTX", experimental: true },
};
export const LTX_DURATION_FRAMES = { 5: 121, 10: 241, 15: 361, 20: 481, 25: 601, 30: 721 };
export const LTX25_DURATION = { min: 3, max: 30 };

/** The engine a render of this project would actually use. */
export const activeEngine = (p = project) =>
  (p?.render?.engine === "ltx25" && p?.mode !== "r2v") ? "ltx25" : "minimax";

/** duration (s) → frames, on whichever grid the active engine samples on. */
export const durationFrames = (p = project) =>
  activeEngine(p) === "ltx25" ? LTX_DURATION_FRAMES : DURATION_FRAMES;

/* LTXVAddGuide samples time on the video VAE's temporal stride of 8, so a
 * pin placed at an arbitrary cut time lands on the nearest multiple of 8
 * frames — a 1/3 s grid at 24 fps. The node quantises silently (a single
 * image lands on latent ceil(idx / 8)); done invisibly it reads as drift,
 * so the same rounding is shown on the pin row and used by the graph. */
export const LTX_GUIDE_STRIDE = 8;
export function ltxGuideIdx(seconds, p = project) {
  const fps = p?.render?.fps || 24;
  const last = frameCount(p) - 1;
  const idx = Math.round((Number(seconds) || 0) * fps / LTX_GUIDE_STRIDE) * LTX_GUIDE_STRIDE;
  return Math.max(0, Math.min(last, idx));
}
/** Where a pin at `seconds` actually lands, in seconds, on the guide grid. */
export const ltxGuideTime = (seconds, p = project) => ltxGuideIdx(seconds, p) / (p?.render?.fps || 24);

/** Switch the render engine. One place, because it is not one field:
 *  the build families share no names ("turbo" is not an LTX build), so the
 *  variant follows the engine to whichever build was last used there. */
export function setEngine(engine) {
  const v = engine === "ltx25" ? "ltx25" : "minimax";
  update((proj) => {
    proj.render.engine = v;
    proj.render.variant = rememberedVariant(proj.mode, v === "ltx25" ? "ltx_two" : "turbo", v);
  }, "render");
}

export const overLength = (seconds, p = project) => {
  const max = activeEngine(p) === "ltx25" ? LTX25_DURATION.max : H3_DURATION.max;
  return Number(seconds || 0) > max;
};

/* THE FILM — what to do when the thing you are making is longer than the
 * thing the model makes. Not a longer render: several renders, planned as one
 * piece and joined afterwards (see film.js). The ceiling here is a policy, not
 * a limit of anything — two minutes is eight to twenty-four renders, which is
 * already a long time to leave a machine unattended. */
export const FILM_LIMITS = { min: 20, max: 120, maxClips: 12 };

/** How long the timeline actually runs.
 *
 *  A shot's length is never stored — it is the gap to the next cut, and the
 *  last shot's is the gap to the end. Which means every check that measures a
 *  shot has to know where "the end" is, and in a film that is NOT
 *  render.duration: that field holds the length of one clip, and the film is
 *  the sum of several. Asking here rather than reading render.duration is what
 *  keeps a film's later shots from reading as cutting past a clip they were
 *  never in. */
export const filmSpan = (p = project) =>
  (p?.film?.enabled ? (Number(p.film.seconds) || FILM_LIMITS.min) : (Number(p?.render?.duration) || 5));

/* Ref2VA's input budget, from the same table: "Images: ≤ 9 · Videos: ≤ 3 ·
 * Audio: ≤ 3 · Mixed inputs: Maximum number of files across all input types
 * is 12." The per-kind caps do not add up to the total — 9 + 3 + 3 is 15 — so
 * checking them one at a time passes a set of references the model refuses. */
export const REF_LIMITS = { images: 9, videos: 3, audios: 3, total: 12 };

export const RESOLUTIONS = [
  ["1344x768", "768p · 16:9 — 1344×768", "The official H3 canvas and what the 4-step Turbo build was distilled on"],
  ["768x1344", "768p · 9:16 — 768×1344", "Portrait at the 768p tier"],
  ["960x960",  "768p · 1:1 — 960×960",   "Square at roughly the 768p pixel budget"],
  ["832x480",  "480p · 16:9 — 832×480",  "Fast tier; the 8-step Turbo build was distilled around 544p"],
  ["480x832",  "480p · 9:16 — 480×832",  "Portrait, fast tier"],
  ["640x640",  "480p · 1:1 — 640×640",   "Square, fast tier"],
];

/** A camera as something outside the app wrote it — a model's JSON, a saved
 *  file — with the fields it cannot mean removed. `framing` is WHERE the
 *  subject sits (a third, low in frame); a model asked for a shot's framing
 *  hands back its SIZE, and "wide" in this slot compiled to "The frame is
 *  composed with the subject framed in the wide" on a close-up. A size in
 *  the framing slot is dropped, never rewritten: shotType already says it. */
export function cleanCamera(raw = {}) {
  const cam = { ...newShot(0).camera, ...(raw || {}) };
  const ok = cam.framing === "custom" || FRAMINGS.some(([id]) => id === cam.framing);
  if (!ok) { cam.framing = "centered"; cam.fx = 50; cam.fy = 50; }
  return cam;
}

export function newShot(at = 0) {
  return {
    id: uid(),
    at,                       // seconds into the clip; shot 1 is always 0
    cutVerb: "the camera cuts to",
    shotType: "medium",
    viewpoint: "front-facing",
    subject: "",
    // Action BEATS, not one action line. H3 renders roughly one beat per
    // 2–3 seconds, and the guide wants them chronological and linked
    // ("…, then …", "…, as …") rather than piled into one sentence. Making
    // them a list is what lets the timeline show them and the checker count
    // them against the shot's length.
    beats: [newBeat("")],
    setting: "",
    lighting: "",
    camera: {
      type: "static", amplitude: "medium", speed: "normal", target: "",
      secondary: "none",     // a second simultaneous move
      lens: "", height: "",  // "" → unstated, and the prompt says nothing
      framing: "centered",   // a preset, or "custom" with fx/fy below
      // Where the subject sits in the frame, 0–100 across and down. Written by
      // dragging the framing box in previz; the presets above set them too, so
      // there is only ever one source of truth.
      fx: 50, fy: 50,
      depth: "",             // depth of field / rack focus / dolly zoom
      custom: "",            // free text that replaces the generated sentence
    },
    details: "",
    /* Timeline pinning (LTX-2.5 engine only). An image conditioned into the
     * clip at this shot's cut time via LTXVAddGuide — it pins what the frame
     * looks like when this shot lands, at an adjustable strength. H3 has no
     * per-frame guide input (its one image input is the I2V first frame), so
     * the MiniMax graph ignores both fields and the checker says so. A media
     * item like frames.first: { id, name, dataUrl?, comfyName }. */
    keyframe: null,
    keyframeStrength: 1,
    /* What is different about the subject NOW, as against how the subject was
     * described at the top of the clip. H3 has no memory across a cut and the
     * compiler repeats the subject line at every one, so a jacket taken off in
     * shot 2 is put back on by shot 3's own description unless something says
     * otherwise. This is that something. */
    continuity: "",
    sfx: "",
    dialogue: [],
  };
}

/**
 * Wipe a shot's WRITING while keeping it the same shot.
 *
 * The difference matters. A shot has two kinds of field on it: what this clip
 * is about (subject, beats, setting, light, extra detail, sound effects, who
 * speaks) and how it is shot (cut time, shot type, viewpoint, camera). The
 * first kind belongs to an idea and must not outlive it; the second is craft
 * and survives a rewrite happily.
 *
 * Nothing used to do this, and the result reached users: reading fresh
 * material into an open project rewrote the subject and the setting and left
 * everything else, so a new scene arrived carrying the last one's extra
 * detail — a Spartan warrior standing in a Soviet warehouse, in a shot list
 * that had never heard of Sparta. Every writer in the app merges with `||`,
 * which is right when re-steering one idea and wrong when replacing it, so
 * the clearing has to happen once, deliberately, at the point where the idea
 * changes.
 */
export function clearShotWriting(shot) {
  shot.subject = "";
  shot.beats = [newBeat("")];
  shot.setting = "";
  shot.lighting = "";
  shot.details = "";
  shot.sfx = "";
  shot.dialogue = [];
  shot.continuity = "";
  if (shot.camera) { shot.camera.custom = ""; shot.camera.target = ""; shot.camera.byHand = false; }
  return shot;
}

/** One action beat. `link` is the word that joins it to the beat before it —
 *  "then" for a sequence, "as"/"while" for something concurrent. */
export function newBeat(text = "", link = "then") {
  return { id: uid(), text, link };
}

/** The beats of a shot as plain text, for anything that wants one string. */
export const shotActionText = (shot) =>
  (shot?.beats || []).map(b => (b.text || "").trim()).filter(Boolean).join("; ");

/**
 * One spoken line.
 *
 * `identity` and `delivery` are what H3 builds a voice out of. The guide asks
 * for the speaker's identifying phrase and delivery OUTSIDE the <d> tag —
 * "character type, age, gender, whether the person is on-screen, pitch,
 * timbre, speaking rate, or accent" — and until these fields existed the
 * compiler could only emit a bare "(S1) says,", which tells the model nothing
 * about who is talking or how.
 *
 * `delivery` is the verb and its manner ("says", "shouts", "says quietly"),
 * and it is what goes between the id and the tag.
 */
export function newDialogue(speaker = "S1") {
  /* `continues` marks a line the cut lands in the middle of, and `cutoff` a
   * line the end of the video truncates. Both have their own tag in H3's
   * grammar — <scenetrans> and <cutoff> — and neither could be expressed at
   * all before, because a line belongs to exactly one shot. */
  return {
    id: uid(), speaker, identity: "", delivery: "", language: "English",
    text: "", voiceover: false, continues: false, cutoff: false, note: "",
  };
}

/** Every spoken line in the clip, in playback order. A speaker id belongs to
 *  the CLIP, not to a shot: (S1) in shot 1 and (S1) in shot 4 are one person
 *  and H3 keeps the voice between them. */
export function orderedDialogue(p = project) {
  return orderedShots(p).flatMap(s => (s.dialogue || []).map(line => ({ shot: s, line })));
}

/** The voice a new line most likely belongs to: whoever spoke last. A second
 *  line is usually the same conversation continuing. */
export function lastSpeaker(p = project) {
  const spoken = orderedDialogue(p).filter(({ line }) => (line.text || "").trim());
  return spoken.length ? spoken[spoken.length - 1].line.speaker : "S1";
}

/** The first id nobody is using. Null once they are all taken — the app's
 *  limit, not the model's; the guide describes an open series. */
export function nextUnusedSpeaker(p = project) {
  const taken = new Set(orderedDialogue(p).map(({ line }) => line.speaker));
  return SPEAKERS.find(id => !taken.has(id)) || null;
}

export function blankProject() {
  /* The numbers below are the FALLBACK, not the default. Whatever render
   * settings were chosen last are laid over them before this returns, because
   * a resolution, a length and a checkpoint variant describe the machine you
   * are working on — not the clip you are making. */
  const fresh = {
    version: PROJECT_VERSION,
    name: "Untitled Timeline",
    mode: "t2v",
    style: {
      look: "live-action cinematic",
      grade: "",
      // The one line that opens [Shot 1]; MiniMax's guide asks for the overall
      // style and the initial composition right at the top.
      extra: "",
    },
    render: {
      resolution: "832x480",
      duration: 5,
      fps: 24,
      // Which model renders the timeline. "minimax" is the app's native
      // engine; "ltx25" is the experimental second one — same timeline, its own dialect;
      // prompt, a different DiT behind it. Ignored in r2v (see activeEngine).
      engine: "minimax",      // minimax | ltx25 (experimental)
      variant: "turbo",       // full | turbo | turbo4 (fl2va) · full | ref4 (ref2va) · ltx_two | ltx_single (ltx25)
      seed: -1,
      precision: "int8",      // int8 | nvfp4 (MiniMax DiT only — LTX-2.5 has one loadable build)
      // Tiled decode is the one accelerator here, because VAEDecodeTiled is a
      // stock node. Sol-Attn, chunked feed-forward and the free-memory nodes
      // all live in custom packs, and this project stays on stock ComfyUI.
      tiledDecode: false,
      refImageSize: "match",
      // Post-render upscale — after the decode, before the mux. The clip is
      // generated at the canvas size and delivered larger.
      upscale: { engine: "off", target: "1080p" },
      // A mark on every delivered frame: off | signature | client. The name
      // itself is a browser setting (Deliver ▸ Output), not part of the project.
      watermark: "off",   // engine: off | seedvr2 | flashvsr | ltx25 | esrgan · target: 720p | 1080p | 1440p | 2160p
      outputPrefix: "",
    },
    shots: [newShot(0)],
    sound: {
      soundscape: "",
      music: "",
      musicOff: false,        // true → non_diegetic_music: N/A
      silent: false,          // true → overall_soundscape: N/A
    },
    frames: { first: null },  // i2v — { id, name, dataUrl, comfyName, caption }
    refs: { images: [], videos: [], audios: [] },   // r2v
    ref2v: {
      taskType: "subject reference",
      subjectDefs: "",
      summary: "",
      useFullIR: true,        // emit subject_definitions / summary / retention_analysis
    },
    prompt: {
      manual: false,          // true → the compiled fields are edited by hand
      description: "",        // manual override of integrated_multimodal_description
      lastEnhancedAt: 0,
      alignKeyframe: true,    // emit the I2V keyframe-alignment first line
    },
    /* Several clips, cut together — off until someone asks for it. While it
     * is on, render.duration stops being the length of the piece (the planner
     * sets a length per clip) and `seconds` below is what the timeline runs
     * for. See film.js. */
    film: {
      enabled: false,
      seconds: 60,          // how long the whole thing is meant to be
      continuity: true,     // hand each clip the last frame of the one before
      audio: "keep",        // keep | mute — H3 writes audio per clip, and it does not match across a join
      /* LTX-2.5 only: every hard cut becomes its own clip, rendered on its
       * own and joined afterwards — a real cut instead of one the model is
       * asked to perform inside a clip. Rows marked "no cut" stay inside
       * their clip. Ignored on MiniMax. */
      splitAtCuts: false,
    },
    jobs: [],                 // render history: { id, promptId, at, mode, status, outputs, prompt }
    selectedShot: null,

    /* The front of house. A creator arrives with material and an idea, not with
     * a shot list — this is what they actually touched, kept separately from
     * the shot list it produces so that re-steering never loses their words. */
    creative: {
      shotCount: 0,           // 0 = auto (Pace and written cuts decide); 1–6 = exactly that many
      preset: "",             // a scene preset key (presets.js) — its guidance rides on every LLM call while set
      stage: "material",      // material → steer → takes
      material: { text: "" },
      proposal: null,         // what the model read out of the material
      answers: {},            // subject / setting / beats / speech / model questions
      dials: { distance: 50, energy: 30, pace: 40, light: 45, sound: 55, faithfulness: 80 },
      pool: { beats: [] },    // beats the pace dial expands and contracts against
      soundEdited: false,     // once they write their own sound, the dial stops overwriting it
      takes: [],              // the current pair of renders
    },
  };
  applyRenderPrefs(fresh.render, fresh.mode);
  return fresh;
}

let project = blankProject();
const listeners = new Set();

/* ── Undo / redo ──────────────────────────────────────────
 * Snapshots, not commands: the project is small enough (a few KB of text and
 * metadata — media lives in IndexedDB) that a deep copy per edit is cheaper
 * than maintaining inverse operations, and it can never drift out of sync
 * with the real state. Rapid typing coalesces into one entry so ⌘Z doesn't
 * walk back character by character. */
const HISTORY_LIMIT = 60;
const COALESCE_MS = 700;
let undoStack = [];
let redoStack = [];
let lastSnapshotAt = 0;
let lastReason = "";

const snapshot = () => JSON.parse(JSON.stringify({ ...project, jobs: [] }));

function pushHistory(reason) {
  const now = Date.now();
  const coalesce = reason === "text" && lastReason === "text" && now - lastSnapshotAt < COALESCE_MS;
  if (coalesce) return;
  undoStack.push(snapshot());
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
  lastSnapshotAt = now;
  lastReason = reason;
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

export function undo() {
  if (!undoStack.length) return false;
  redoStack.push(snapshot());
  const prev = undoStack.pop();
  project = { ...prev, jobs: project.jobs };
  lastReason = "";
  persist();
  emit("undo");
  return true;
}

export function redo() {
  if (!redoStack.length) return false;
  undoStack.push(snapshot());
  const next = redoStack.pop();
  project = { ...next, jobs: project.jobs };
  lastReason = "";
  persist();
  emit("redo");
  return true;
}

export function getProject() { return project; }

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function emit(reason) {
  for (const fn of listeners) {
    try { fn(project, reason); } catch (err) { console.error("[state] listener failed", err); }
  }
}

const persist = debounce(() => {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...project, jobs: project.jobs.slice(0, 25) }));
    document.getElementById("save-state") && (document.getElementById("save-state").textContent = "saved");
  } catch (err) {
    console.warn("[state] could not persist:", err.message);
  }
}, 500);

const NO_HISTORY = new Set(["select", "jobs", "undo", "redo"]);

/** Mutate the project. `fn` gets a live draft; return value is ignored. */
export function update(fn, reason = "") {
  if (!NO_HISTORY.has(reason)) pushHistory(reason);
  fn(project);
  // Whatever was just chosen becomes the default for the next project. This
  // sits here rather than in the Deliver page because the canvas, the palette
  // and the director all change these too.
  if (reason === "render") rememberRender(project.render, project.mode);
  const badge = document.getElementById("save-state");
  if (badge) badge.textContent = "saving…";
  persist();
  emit(reason);
}

/* Told when the open project is swapped for a different one.
 *
 * There was no such signal, and the consequence was the whole second half of
 * "a fresh project has the last one's things in it". These are plain ES
 * modules and half of them keep per-project state in a module-level `let` —
 * the idea box on the Cut page, the director's conversation and its
 * pre-ticked plan, the last finished render, the last sweep, the Create
 * page's pair of takes. Replacing the project object left every one of them
 * standing, and the app's only hygiene gesture (`drawn = false`) merely
 * re-runs a page's render(), which draws the same stale variables again.
 *
 * A module that keeps anything belonging to ONE project registers here. */
const swapWatchers = new Set();
export function onProjectSwap(fn) { swapWatchers.add(fn); return () => swapWatchers.delete(fn); }

export function replaceProject(next, reason = "load") {
  project = migrate(next);
  undoStack = []; redoStack = [];
  persist();
  for (const fn of swapWatchers) { try { fn(project); } catch (e) { console.error("[state] a project-swap reset threw:", e); } }
  emit(reason);
}

/** Duplicate a shot half a second after the original — ⌘D in every NLE. */
export function duplicateShot(id) {
  const src = (project.shots || []).find(s => s.id === id);
  if (!src) return null;
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = uid();
  copy.beats = (copy.beats || []).map(b => ({ ...b, id: uid() }));
  copy.dialogue = (copy.dialogue || []).map(d => ({ ...d, id: uid() }));
  copy.at = Math.min(project.render.duration - 0.5, (src.at || 0) + 1);
  update((p) => { p.shots.push(copy); p.selectedShot = copy.id; }, "shots");
  return copy;
}

function migrate(p) {
  const base = blankProject();
  const merged = { ...base, ...p };
  // Sub-objects get merged rather than replaced, so a project saved by an
  // older build doesn't come back missing half its controls.
  for (const key of ["style", "render", "sound", "refs", "ref2v", "prompt", "frames", "creative", "film"]) {
    merged[key] = { ...base[key], ...(p?.[key] || {}) };
  }
  /* Projects saved before full-reference mode used <Subject N> cite their
   * images as <Picture N>. The tag is positional either way, so the rewrite is
   * exact — and leaving them would silently break every citation the moment
   * referenceInventory started answering <Subject 1>. */
  if (merged.mode === "r2v") {
    /* The task-type prefix was an invented vocabulary; anything saved under the
     * old names is dropped so the app derives a real one from what is attached.
     * Keeping it would put a phrase the rewriter never emitted at the exact
     * position the encoder looks for a task type. */
    if (merged.ref2v?.taskType && !REF_TASK_TYPES.some(([v]) => v === merged.ref2v.taskType)) {
      merged.ref2v.taskType = "";
    }
    const toSubject = (t) => String(t || "").replace(/<Picture (\d+)>/g, "<Subject $1>");
    for (const shot of merged.shots || []) {
      for (const f of CITING_FIELDS) if (shot[f]) shot[f] = toSubject(shot[f]);
      for (const b of shot.beats || []) if (b?.text) b.text = toSubject(b.text);
      for (const d of shot.dialogue || []) if (d?.identity) d.identity = toSubject(d.identity);
    }
    // subject_definitions is where <Picture N> legitimately still appears —
    // it is the line that binds the subject to its source image — so it is
    // deliberately not rewritten.
    if (merged.ref2v?.summary) merged.ref2v.summary = toSubject(merged.ref2v.summary);
  }
  merged.creative.dials = { ...base.creative.dials, ...(p?.creative?.dials || {}) };
  merged.creative.pool = { ...base.creative.pool, ...(p?.creative?.pool || {}) };
  merged.creative.material = { ...base.creative.material, ...(p?.creative?.material || {}) };
  merged.shots = Array.isArray(p?.shots) && p.shots.length
    ? p.shots.map((s) => {
        const shot = { ...newShot(s.at || 0), ...s, camera: cleanCamera(s.camera), dialogue: s.dialogue || [] };
        /* An undirected "roll" is not in H3's vocabulary and camPhrase falls
         * back to "The camera remains static" for an id it does not know — so
         * leaving this unmigrated would silently turn a saved roll into a
         * locked-off shot. */
        if (shot.camera.type === "roll") shot.camera.type = "roll clockwise";
        if (shot.camera.secondary === "roll") shot.camera.secondary = "roll clockwise";
        // Projects saved before beats existed carry a single `action` string.
        if (!Array.isArray(shot.beats) || !shot.beats.length) {
          shot.beats = [newBeat(typeof s.action === "string" ? s.action : "")];
        }
        shot.beats = shot.beats.map(b => ({ ...newBeat(), ...b }));
        delete shot.action;
        return shot;
      })
    : base.shots;
  merged.jobs = Array.isArray(p?.jobs) ? p.jobs : [];
  return merged;
}

export function loadProject() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) project = migrate(JSON.parse(raw));
  } catch (err) {
    console.warn("[state] stored project unreadable, starting fresh:", err.message);
  }
  return project;
}

/* ── Derived helpers every page needs ─────────────────────── */

export const modeInfo = () => MODES[project.mode] || MODES.t2v;

export function dimensions(p = project) {
  const [w, h] = String(p.render.resolution || "832x480").split("x").map(Number);
  return { width: w || 832, height: h || 480 };
}

export function frameCount(p = project) {
  const table = durationFrames(p);
  return table[p.render.duration] || table[5];
}

/** Shots sorted by cut time, with the first pinned to 0 — the order the
 *  prompt has to be written in, and the order the timeline draws. */
export function orderedShots(p = project) {
  const shots = [...(p.shots || [])].sort((a, b) => (a.at || 0) - (b.at || 0));
  if (shots[0]) shots[0] = { ...shots[0], at: 0 };
  return shots;
}

/* ── Removing a reference ─────────────────────────────────────
 * Tags are POSITIONAL — <Picture 2> means "the second image in the pool" —
 * so deleting one silently re-points every later citation at a different
 * picture. A shot that said <Picture 3> now names what used to be <Picture 4>,
 * and the render comes back with the wrong face in it and no error anywhere.
 *
 * So removal is not a delete: it is a delete plus a remap. The tags are
 * resolved BEFORE anything is mutated (the old code resolved them after, and
 * therefore always found nothing and stripped nothing), the removed reference's
 * own tags come out of the text, and every survivor's citations are rewritten
 * to the number it now holds.
 */

/** Every field of a shot the compiled description draws prose from. */
const CITING_FIELDS = ["subject", "setting", "details", "sfx", "lighting"];

/** id → the tags that reference answers to (a video owns two). */
function tagsById(p) {
  const map = new Map();
  for (const e of referenceInventory(p)) {
    if (!e.ref?.id) continue;
    if (!map.has(e.ref.id)) map.set(e.ref.id, []);
    map.get(e.ref.id).push(e.tag);
  }
  return map;
}

/** Rewrite every citation in a project, in one pass so renames cannot collide. */
function rewriteCitations(p, { drop = [], rename = [] }) {
  if (!drop.length && !rename.length) return;
  // Two phases via sentinels: renaming <Picture 3> → <Picture 2> while a
  // <Picture 2> still exists would otherwise merge two references into one.
  const apply = (text) => {
    let out = String(text || "");
    for (const tag of drop) {
      out = out.split(tag).join("")
        .replace(/\s+(with|and)\s*$/i, "")
        .replace(/\s+(with|and)\s+(?=(with|and)\b)/gi, " ");
    }
    rename.forEach(([from], i) => { out = out.split(from).join(`\u0000${i}\u0000`); });
    rename.forEach(([, to], i) => { out = out.split(`\u0000${i}\u0000`).join(to); });
    return out.replace(/\s{2,}/g, " ").replace(/\s+([,.;])/g, "$1").trim();
  };

  for (const shot of p.shots || []) {
    for (const f of CITING_FIELDS) if (shot[f]) shot[f] = apply(shot[f]);
    for (const b of shot.beats || []) b.text = apply(b.text);
  }
  if (p.ref2v) {
    if (p.ref2v.subjectDefs) p.ref2v.subjectDefs = apply(p.ref2v.subjectDefs);
    if (p.ref2v.summary) p.ref2v.summary = apply(p.ref2v.summary);
  }
  if (p.prompt?.manual && p.prompt.description) p.prompt.description = apply(p.prompt.description);
}

/**
 * Take a reference out of the pool and keep every remaining citation pointing
 * at the picture it always meant.
 *
 * @returns {{ dropped: string[], renamed: Array<[string,string]> }}
 */
export function removeReference(p, id) {
  const before = tagsById(p);
  const wasFirstFrame = p.frames?.first?.id === id;
  const dropped = wasFirstFrame && !before.has(id) ? ["<Picture 1>"] : (before.get(id) || []);

  if (wasFirstFrame) p.frames.first = null;
  for (const bin of ["images", "videos", "audios"]) {
    p.refs[bin] = (p.refs[bin] || []).filter(m => m.id !== id);
  }

  const after = tagsById(p);
  const renamed = [];
  for (const [refId, oldTags] of before) {
    if (refId === id) continue;
    const newTags = after.get(refId) || [];
    oldTags.forEach((from, i) => {
      const to = newTags[i];
      if (to && to !== from) renamed.push([from, to]);
    });
  }
  rewriteCitations(p, { drop: dropped, rename: renamed });
  return { dropped, renamed };
}

/* ── The mode is not a choice ─────────────────────────────────
 * T2V, I2V and Ref2V are not three things you pick between — they are the
 * names of three situations. Nothing attached is text to video. One picture is
 * image to video, and that picture IS the first frame. Anything more is
 * reference to video. Asking someone to also declare which of those they are
 * in is asking them to restate what they just did, and lets the two disagree:
 * a project could sit in I2V with six references attached, emitting a graph
 * that ignored five of them.
 *
 * So the mode is derived, and the media is moved into the slot the derived
 * mode reads from — the first frame and refs.images[0] are the same picture
 * under two names, so <Picture 1> survives the move either way.
 */
export function inferMode(p) {
  const images = (p.frames?.first ? 1 : 0) + (p.refs?.images || []).length;
  const others = (p.refs?.videos || []).length + (p.refs?.audios || []).length;
  if (!images && !others) return "t2v";
  if (images === 1 && !others) return "i2v";
  return "r2v";
}

/**
 * Put the media where the derived mode expects to find it, and set the mode.
 * Returns true when anything actually changed.
 */
export function normaliseMedia(p) {
  const next = inferMode(p);
  // Images in tag order: the first frame is always <Picture 1>.
  const images = [...(p.frames?.first ? [p.frames.first] : []), ...(p.refs?.images || [])];
  const changed = p.mode !== next
    || (next === "i2v" && (!p.frames?.first || (p.refs?.images || []).length))
    || (next !== "i2v" && !!p.frames?.first);

  if (p.mode !== next) {
    /* The two modes load different checkpoints, and their variant lists share
     * no names — "turbo" means nothing to ref2va, and neither means anything
     * to the LTX-2.5 builds. Left alone, the picker would silently fall back
     * to the first entry and the Turbo you chose would be gone. Reach for the
     * one you last chose for THIS family instead. The family is decided by
     * what will actually render: in r2v the LTX engine is inert (activeEngine
     * answers minimax), so the ref2va list is the right one even while the
     * engine field still says ltx25. */
    p.render = p.render || {};
    const eng = next === "r2v" ? "minimax" : (p.render.engine === "ltx25" ? "ltx25" : "minimax");
    p.render.variant = rememberedVariant(next,
      next === "r2v" ? "ref_full" : eng === "ltx25" ? "ltx_two" : "turbo", eng);
  }
  /* The label an image answers to depends on the mode — <Subject N> where it
   * is content to reproduce, <Picture N> where it is an actual frame — so a
   * mode change has to carry the citations with it, or every one of them stops
   * resolving. This is the same job normaliseMedia already does for the media
   * itself: keep the tags meaning what they meant. */
  if (p.mode !== next) {
    const swap = next === "r2v"
      ? (t) => String(t || "").replace(/<Picture (\d+)>/g, "<Subject $1>")
      : (t) => String(t || "").replace(/<Subject (\d+)>/g, "<Picture $1>");
    for (const shot of p.shots || []) {
      for (const f of CITING_FIELDS) if (shot[f]) shot[f] = swap(shot[f]);
      for (const b of shot.beats || []) if (b?.text) b.text = swap(b.text);
      for (const d of shot.dialogue || []) if (d?.identity) d.identity = swap(d.identity);
    }
    if (p.ref2v?.summary) p.ref2v.summary = swap(p.ref2v.summary);
  }
  p.mode = next;
  p.refs = p.refs || { images: [], videos: [], audios: [] };
  if (next === "i2v") {
    p.frames.first = images[0] || null;
    p.refs.images = [];
  } else {
    p.frames.first = null;
    p.refs.images = images;
  }
  return changed;
}

export function selectedShot(p = project) {
  const shots = p.shots || [];
  return shots.find(s => s.id === p.selectedShot) || shots[0] || null;
}

export function selectShot(id) {
  update(p => { p.selectedShot = id; }, "select");
}

/** Every reference tag that exists, in the exact order MiniMax's node emits
 *  them: images first, then each video (its own soundtrack claims an <Audio>
 *  slot immediately before the <Video> tag), then standalone audio. A tag with
 *  no media behind it is silently ignored by the model, so this inventory is
 *  what the prompt is allowed to cite — nothing more. */
export function referenceInventory(p = project) {
  const tags = [];
  /* An image in full-reference mode is a SUBJECT, not a picture.
   *
   * The reference guide gives the two labels different jobs. <Picture N> is
   * "a reference image used as a concrete target frame or shot-planning
   * anchor"; <Subject N> is "visible content abstracted from reference assets
   * that can be reused or modified in the target video" — people, animals,
   * objects, scenes, clothing, props, styles. And §2.2 is explicit about which
   * to use: "If an image is used only to define a character, scene, costume,
   * or style, do not create a standalone picture entry. Instead, cite the
   * image source inside the corresponding <Subject N> definition."
   *
   * Attaching a photo of someone and asking for a video of them is the second
   * of those, every time. This app called all of them <Picture N>, which is
   * the label for the case it almost never is — and the complete example in
   * the guide contains no <Picture N> in its description at all.
   *
   * `source` is the asset by upload position, which is what subject_definitions
   * cites to bind the two: "<Subject 1> is the woman in <Picture 1>".
   *
   * Outside r2v an image IS a frame anchor — i2v's first frame is literally
   * the video's first frame — so there it stays <Picture 1>, correctly. */
  const asSubject = p.mode === "r2v";
  (p.refs.images || []).forEach((r, i) => tags.push({
    kind: "picture",
    tag: asSubject ? `<Subject ${i + 1}>` : `<Picture ${i + 1}>`,
    source: `<Picture ${i + 1}>`,
    index: i,
    ref: r,
  }));
  let audioNo = 1;
  (p.refs.videos || []).forEach((v, i) => {
    if (v.useAudio) tags.push({ kind: "audio", tag: `<Audio ${audioNo++}>`, index: i, ref: v, fromVideo: true });
    tags.push({ kind: "video", tag: `<Video ${i + 1}>`, index: i, ref: v });
  });
  (p.refs.audios || []).forEach((a, i) => tags.push({ kind: "audio", tag: `<Audio ${audioNo++}>`, index: i, ref: a }));
  return tags;
}

/** Has anything been written yet? A brand-new timeline has one empty shot, and
 *  reporting that as an error the moment the app opens is noise: nothing is
 *  wrong, nothing has happened. The checks use this to say "empty" instead. */
export function isPristine(p = project) {
  const shots = p.shots || [];
  const written = shots.some(s => (s.subject || "").trim() || shotActionText(s)
    || (s.setting || "").trim() || (s.details || "").trim()
    || (s.dialogue || []).some(d => (d.text || "").trim()));
  const media = !!p.frames?.first || (p.refs?.images || []).length
    || (p.refs?.videos || []).length || (p.refs?.audios || []).length;
  const sound = (p.sound?.soundscape || "").trim() || (p.sound?.music || "").trim();
  const manual = (p.prompt?.manual && (p.prompt.description || "").trim());
  /* A render setting that is already wrong is not an untouched timeline.
   *
   * validate() short-circuits on a pristine project — reporting "nothing
   * written yet" is the right answer to an empty one, and reporting errors
   * before anybody has typed anything trains people to ignore the counter.
   * But a project sitting at 30 s is not empty in the way that reasoning
   * assumes: it carries a setting that WILL produce a repeating render, and
   * hiding it until the first word is typed means the error appears attached
   * to that word instead of to the length. */
  return !written && !media && !sound && !manual && !overLength(p.render?.duration);
}

/**
 * Forget where this project's media was uploaded.
 *
 * `comfyName` is a cache of "these bytes are already sitting in ComfyUI/input
 * under this name", and uploadPending skips any item that has one — which
 * also skips the only check that the bytes still exist. That cache is true
 * for exactly one ComfyUI on one machine, and it travels through every
 * transport that leaves it: an exported .mscut.json opened somewhere else, a
 * duplicated project, a project snapshot restored out of the library. Each of
 * those arrives claiming files are uploaded that may never have been, and the
 * render is fed whatever happens to be sitting under that name.
 *
 * Cheap to be wrong about in the safe direction: clearing it costs one
 * re-upload, keeping it costs a render of the wrong picture.
 */
export function forgetUploads(p) {
  const each = (m) => { if (m) m.comfyName = ""; };
  each(p?.frames?.first);
  for (const kind of ["images", "videos", "audios"]) (p?.refs?.[kind] || []).forEach(each);
  for (const shot of p?.shots || []) each(shot?.keyframe);
  return p;
}

/** The shots that pin a keyframe, in cut order — the LTX guide chain reads
 *  this, and so do the checks that warn when the pins cannot apply. */
export function shotKeyframes(p = project) {
  return orderedShots(p).filter(s => s?.keyframe);
}

export function exportProject() {
  const { jobs, ...rest } = project;
  return JSON.stringify({ ...rest, exportedAt: new Date().toISOString() }, null, 2);
}

/** The references a shot cites, in inventory order: every picture, clip or
 *  sound whose tag appears in the fields the compiled description draws from,
 *  beats included. One predicate for "which pictures is this shot of", so the
 *  Cut page's thumbnails and the storyboard agree with the prompt. */
export function shotCitations(p, shot) {
  if (!shot) return [];
  const hay = [shot.subject, shotActionText(shot), shot.setting, shot.details, shot.lighting, shot.sfx,
    ...(shot.beats || []).map(b => b?.text)].filter(Boolean).join(" ");
  if (!hay.includes("<")) return [];
  return referenceInventory(p).filter(e => hay.includes(e.tag));
}
