/* MOTIONSTILL CUT — the director.
 *
 * Everything else the LLM does in this app hands back a string that someone
 * then pastes into a field: rewrite this description, write me a soundscape,
 * caption this picture. That is an autocomplete, not a collaborator, and it
 * leaves the model unable to do most of what the app is for — it cannot add a
 * shot, move a cut, change the pace, mark a reference as fully preserved, or
 * notice that the clip is two seconds too short for the beats you wrote.
 *
 * So the model does not return prose here. It returns ACTIONS against the
 * project, from a fixed vocabulary this file defines, and the app:
 *
 *   1. validates every action against that vocabulary and the real project —
 *      an action naming shot 7 of a 3-shot clip is dropped, not applied;
 *   2. renders each one as a sentence in the creator's language, so the plan
 *      is reviewed BEFORE it lands rather than discovered afterwards;
 *   3. applies only what is accepted, through the ordinary update() path, so
 *      undo works exactly as it does for a human edit.
 *
 * The model never touches state directly and never sees a field it may not
 * write. The vocabulary IS the permission boundary — anything not listed
 * below cannot be expressed, so a confused or hostile answer can at worst
 * propose a bad edit that you can see and decline.
 */

import {
  getProject, update, orderedShots, newShot, newBeat, newDialogue,
  referenceInventory, shotActionText, DURATION_FRAMES, RESOLUTIONS, H3_DURATION,
} from "./state.js";
import { compilePrompt, validate } from "./prompt.js";
import { applySteering, DIALS } from "./steer.js";
import {
  CAMERA_TYPES, SHOT_TYPES, VIEWPOINTS, AMPLITUDES, SPEEDS, LENSES,
  CAMERA_HEIGHTS, FRAMINGS, GRADES, LIGHTING, LANGUAGES, SPEAKERS,
  VISUAL_RETENTION, AUDIO_RETENTION,
} from "./vocab.js";
import { api } from "./api.js";
import { projectImages } from "./llm.js";
import { library, summarise } from "./library.js";
import { clamp } from "./util.js";
import { presetGuidance } from "./presets.js";

const ids = (list) => list.map(x => (Array.isArray(x) ? x[0] : x));
const oneOf = (list) => (v) => ids(list).includes(String(v)) ? String(v) : null;
const text = (max = 400) => (v) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};
const num = (lo, hi) => (v) => (Number.isFinite(Number(v)) ? clamp(Number(v), lo, hi) : null);
const bool = (v) => (typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : null);

/** Arguments that identify a target rather than change it. */
const ADDRESSING = new Set(["shot", "tag"]);

/** Resolve a shot index the model gave us, 1-based, against the real project. */
function shotAt(p, index) {
  const shots = orderedShots(p);
  const i = Math.round(Number(index));
  if (!Number.isFinite(i) || i < 1 || i > shots.length) return null;
  return shots[i - 1];
}

/* ── The vocabulary ───────────────────────────────────────────
 * Each action says what it may carry, how to describe itself in one sentence,
 * and how to apply itself to a draft. Nothing else is reachable.
 */
export const ACTIONS = {
  "shot.add": {
    label: "Add a shot",
    args: {
      at: num(0, 30), subject: text(240), setting: text(240), details: text(400), continuity: text(200),
      shotType: oneOf(SHOT_TYPES), viewpoint: oneOf(VIEWPOINTS), lighting: oneOf(LIGHTING),
      beats: (v) => (Array.isArray(v) ? v.map(b => String(typeof b === "string" ? b : b?.text || "").trim()).filter(Boolean).slice(0, 8) : null),
      camera: (v) => (v && typeof v === "object" ? v : null),
    },
    describe: (a) => `Add a ${a.shotType || "medium"} shot at ${(a.at ?? 0).toFixed?.(1) ?? a.at}s — ${a.subject || "(no subject yet)"}`,
    apply: (p, a) => {
      const shot = newShot(clamp(Number(a.at ?? 0), 0, (p.render.duration || 5) - 0.5));
      Object.assign(shot, {
        subject: a.subject || "", setting: a.setting || "", details: a.details || "",
        continuity: a.continuity || "",
        shotType: a.shotType || shot.shotType, viewpoint: a.viewpoint || shot.viewpoint,
        lighting: a.lighting || "",
      });
      if (a.beats?.length) shot.beats = a.beats.map((t, i) => newBeat(t, i === 0 ? "" : "then"));
      if (a.camera) shot.camera = { ...shot.camera, ...cleanCamera(a.camera) };
      p.shots.push(shot);
      p.shots.sort((s1, s2) => (s1.at || 0) - (s2.at || 0));
      if (p.shots[0]) p.shots[0].at = 0;
    },
  },

  "shot.update": {
    label: "Change a shot",
    args: {
      shot: num(1, 12), at: num(0, 30), subject: text(240), setting: text(240), details: text(400), continuity: text(200),
      shotType: oneOf(SHOT_TYPES), viewpoint: oneOf(VIEWPOINTS), lighting: oneOf(LIGHTING),
      // Sound the characters can hear, tied to this shot. §4.7 sends diegetic
      // audio to the description rather than either sound field, and this is
      // the field that lands there — it compiled all along and nothing could
      // write it.
      sfx: text(240),
    },
    describe: (a, p) => {
      const s = shotAt(p, a.shot);
      const changes = ["subject", "setting", "details", "shotType", "viewpoint", "lighting", "sfx", "at"]
        .filter(k => a[k] != null)
        .map(k => `${k} → ${k === "at" ? `${a[k]}s` : `"${String(a[k]).slice(0, 60)}"`}`);
      return `Shot ${a.shot}${s ? "" : " (missing)"}: ${changes.join(", ") || "no change"}`;
    },
    apply: (p, a) => {
      const s = shotAt(p, a.shot);
      if (!s) return;
      const live = p.shots.find(x => x.id === s.id);
      for (const k of ["subject", "setting", "details", "shotType", "viewpoint", "lighting"]) {
        if (a[k] != null) live[k] = a[k];
      }
      if (a.at != null && orderedShots(p)[0]?.id !== live.id) {
        live.at = clamp(a.at, 0.5, (p.render.duration || 5) - 0.5);
      }
    },
  },

  "shot.remove": {
    label: "Remove a shot",
    args: { shot: num(1, 12) },
    describe: (a, p) => `Remove shot ${a.shot}${shotAt(p, a.shot) ? ` — "${(shotAt(p, a.shot).subject || shotActionText(shotAt(p, a.shot)) || "").slice(0, 50)}"` : " (missing)"}`,
    apply: (p, a) => {
      const s = shotAt(p, a.shot);
      if (!s || p.shots.length < 2) return;
      p.shots = p.shots.filter(x => x.id !== s.id);
      if (p.shots[0]) p.shots[0].at = 0;
    },
  },

  "beats.set": {
    label: "Rewrite a shot's action",
    args: {
      shot: num(1, 12),
      beats: (v) => (Array.isArray(v) ? v.map(b => String(typeof b === "string" ? b : b?.text || "").trim()).filter(Boolean).slice(0, 8) : null),
    },
    describe: (a) => `Shot ${a.shot} action: ${(a.beats || []).map(b => `"${b}"`).join(", then ") || "(empty)"}`,
    apply: (p, a) => {
      const s = shotAt(p, a.shot);
      if (!s || !a.beats?.length) return;
      const live = p.shots.find(x => x.id === s.id);
      live.beats = a.beats.map((t, i) => newBeat(t, i === 0 ? "" : "then"));
    },
  },

  "camera.set": {
    label: "Move the camera",
    args: {
      shot: num(1, 12), type: oneOf(CAMERA_TYPES), amplitude: oneOf(AMPLITUDES),
      speed: oneOf(SPEEDS), target: text(120), lens: oneOf(LENSES),
      height: oneOf(CAMERA_HEIGHTS), framing: oneOf(FRAMINGS),
    },
    describe: (a) => `Shot ${a.shot} camera: ${[a.type, a.amplitude && `${a.amplitude} amplitude`, a.speed && `${a.speed} speed`, a.lens, a.framing].filter(Boolean).join(", ")}`,
    apply: (p, a) => {
      const s = shotAt(p, a.shot);
      if (!s) return;
      const live = p.shots.find(x => x.id === s.id);
      live.camera = { ...live.camera, ...cleanCamera(a), custom: "" };
    },
  },

  "dialogue.set": {
    label: "Write dialogue",
    /* `identity` and `delivery` are what the model needs to give a line a
     * voice. Without them the compiler can only write a bare "(S1) says," —
     * and the guide asks for "the speaker's identifying phrase, ID, action,
     * and delivery outside <d>". The permission boundary was the reason the
     * app could not produce a conformant line even when the writer wanted to. */
    args: {
      shot: num(1, 12), speaker: oneOf(SPEAKERS.map(s => [s])), language: oneOf(LANGUAGES),
      words: text(300), voiceover: bool, identity: text(160), delivery: text(60),
      continuesAcrossCut: bool, cutOffByEnd: bool,
    },
    describe: (a) => `Shot ${a.shot}: ${a.identity ? `${a.identity} ` : ""}(${a.speaker || "S1"}) ${a.voiceover ? "says in voiceover" : (a.delivery || "says")} “${a.words || ""}”`,
    apply: (p, a) => {
      const s = shotAt(p, a.shot);
      if (!s || !a.words) return;
      const live = p.shots.find(x => x.id === s.id);
      const line = newDialogue(a.speaker || "S1");
      line.language = a.language || "English";
      line.text = a.words;
      line.voiceover = !!a.voiceover;
      line.identity = (a.identity || "").trim();
      line.delivery = (a.delivery || "").trim();
      line.continues = !!a.continuesAcrossCut;
      line.cutoff = !!a.cutOffByEnd;
      live.dialogue = [...(live.dialogue || []), line];
    },
  },

  "sound.set": {
    label: "Write the sound",
    args: { soundscape: text(700), music: text(500), silent: bool, musicOff: bool },
    describe: (a) => {
      const bits = [];
      if (a.silent) bits.push("deliberate silence");
      else if (a.soundscape) bits.push(`ambience: "${a.soundscape.slice(0, 70)}…"`);
      if (a.musicOff) bits.push("no score");
      else if (a.music) bits.push(`music: "${a.music.slice(0, 60)}…"`);
      return `Sound — ${bits.join("; ") || "no change"}`;
    },
    apply: (p, a) => {
      if (a.silent != null) p.sound.silent = a.silent;
      if (a.musicOff != null) p.sound.musicOff = a.musicOff;
      if (a.soundscape) { p.sound.soundscape = a.soundscape; p.sound.silent = false; }
      if (a.music) { p.sound.music = a.music; p.sound.musicOff = false; }
      p.creative = p.creative || {};
      p.creative.soundEdited = true;
    },
  },

  "dials.set": {
    label: "Re-steer",
    args: Object.fromEntries(DIALS.map(d => [d.id, num(0, 100)])),
    describe: (a) => `Steering: ${DIALS.filter(d => a[d.id] != null).map(d => `${d.label} ${a[d.id]}`).join(", ") || "no change"}`,
    apply: (p, a) => {
      p.creative = p.creative || {};
      p.creative.dials = { ...p.creative.dials, ...Object.fromEntries(DIALS.filter(d => a[d.id] != null).map(d => [d.id, a[d.id]])) };
      applySteering(p);
    },
  },

  "style.set": {
    label: "Set the look",
    args: { look: text(120), grade: oneOf(GRADES), extra: text(300) },
    describe: (a) => `Look: ${[a.look, a.grade, a.extra].filter(Boolean).join(", ")}`,
    apply: (p, a) => {
      for (const k of ["look", "grade", "extra"]) if (a[k] != null) p.style[k] = a[k];
    },
  },

  "duration.set": {
    label: "Change the clip length",
    /* Capped at H3's ceiling. The director is the one actor here that reaches
     * for a longer clip on its own — asked for more story it will happily
     * propose 30 s — and the model cannot render it, so the tool refuses the
     * value rather than the user discovering it in the output. */
    args: {
      seconds: (v) => {
        const n = Number(v);
        if (!Object.keys(DURATION_FRAMES).map(Number).includes(n)) return null;
        return n > H3_DURATION.max ? null : n;
      },
    },
    describe: (a) => `Clip length → ${a.seconds}s (${DURATION_FRAMES[a.seconds]} frames)`,
    apply: (p, a) => { p.render.duration = a.seconds; },
  },

  "resolution.set": {
    label: "Change the resolution",
    args: { resolution: (v) => (RESOLUTIONS.some(r => (Array.isArray(r) ? r[0] : r.id ?? r.value) === String(v)) ? String(v) : null) },
    describe: (a) => `Resolution → ${a.resolution}`,
    apply: (p, a) => { p.render.resolution = a.resolution; },
  },

  "reference.retention": {
    label: "Set how closely a reference is kept",
    args: {
      tag: text(40),
      visual: oneOf(VISUAL_RETENTION), audio: oneOf(AUDIO_RETENTION),
      caption: text(300),
    },
    describe: (a) => `${a.tag}: keep ${a.visual || a.audio || "as is"}${a.caption ? ` — "${a.caption.slice(0, 50)}…"` : ""}`,
    apply: (p, a) => {
      const entry = referenceInventory(p).find(e => e.tag === a.tag);
      if (!entry?.ref) return;
      const bins = [p.frames.first, ...(p.refs.images || []), ...(p.refs.videos || []), ...(p.refs.audios || [])];
      const live = bins.find(m => m && m.id === entry.ref.id);
      if (!live) return;
      /* The two vocabularies are not interchangeable — ref §4.1 and §4.2 are
       * different closed lists — and this used to write whichever one arrived
       * into the visual field, so an audio marker could land on a picture and
       * silently become a value H3 has never seen there. A reference video
       * carries both: its frames take a visual marker, its soundtrack an audio
       * one, in its own field. */
      if (entry.kind === "audio" && entry.fromVideo) {
        if (a.audio) live.audioRetention = a.audio;
      } else if (entry.kind === "audio") {
        if (a.audio) live.retention = a.audio;
      } else if (a.visual) {
        live.retention = a.visual;
      }
      if (a.caption) live.caption = a.caption;
    },
  },

  "mode.set": {
    label: "Change the generation mode",
    args: { mode: oneOf([["t2v"], ["i2v"], ["r2v"]]) },
    describe: (a) => `Generation mode → ${a.mode.toUpperCase()}`,
    apply: (p, a) => { p.mode = a.mode; },
  },

  "prompt.override": {
    label: "Replace the description by hand",
    args: { description: text(4000) },
    describe: () => "Replace the compiled description with a hand-written one",
    apply: (p, a) => { p.prompt.manual = true; p.prompt.description = a.description; },
  },
};

/** Camera args, filtered to the fields a camera actually has. */
function cleanCamera(raw) {
  const spec = ACTIONS["camera.set"].args;
  const out = {};
  for (const k of ["type", "amplitude", "speed", "target", "lens", "height", "framing"]) {
    if (raw[k] == null) continue;
    const v = spec[k](raw[k]);
    if (v != null) out[k] = v;
  }
  return out;
}

/* ── Validation ───────────────────────────────────────────────
 * An action survives only if its name is in the vocabulary AND at least one of
 * its arguments validated. Everything else is reported, not silently dropped:
 * a plan that half-landed with no explanation is worse than one that says
 * which parts it could not use.
 */
export function validateActions(raw, project = getProject()) {
  const kept = [], rejected = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const name = String(item?.action || item?.type || "").trim();
    const spec = ACTIONS[name];
    if (!spec) { rejected.push({ name: name || "(unnamed)", why: "not something this app can do" }); continue; }
    const args = {};
    let payload = false, badArgs = 0;
    for (const [key, check] of Object.entries(spec.args)) {
      if (item[key] === undefined) continue;
      const value = check(item[key]);
      if (value == null) {
        badArgs++;
        rejected.push({ name, why: `${key}: "${String(item[key]).slice(0, 40)}" is not a value it accepts` });
        continue;
      }
      args[key] = value;
      // `shot` and `tag` say WHICH thing to change, not what to change about
      // it. An action left holding only those after validation is a no-op
      // dressed as an edit — "Shot 1 camera:" with nothing after the colon —
      // so it is rejected rather than offered.
      if (!ADDRESSING.has(key)) payload = true;
    }
    if (!payload) {
      // Only say so when nothing above already explained why: an action
      // rejected for a bad value should not also be reported as empty.
      if (!badArgs) rejected.push({ name, why: "no usable arguments" });
      continue;
    }
    // An action naming a shot that does not exist cannot be applied.
    if (args.shot != null && !shotAt(project, args.shot)) {
      rejected.push({ name, why: `there is no shot ${args.shot}` });
      continue;
    }
    kept.push({ name, args, why: String(item.why || item.reason || "").slice(0, 300), spec });
  }
  return { actions: kept, rejected };
}

/** One sentence per action, in the creator's language, for the review list. */
export const describeAction = (a, project = getProject()) => {
  try { return a.spec.describe(a.args, project); }
  catch { return a.spec.label; }
};

/**
 * Apply a plan. Every action lands in ONE update() so undo takes back the whole
 * plan, which is how a person thinks about it — `also` exists so a caller with
 * its own bookkeeping (the canvas re-deriving the generation mode from the
 * wiring) can ride along inside that same step instead of adding a second one
 * that swallows the first ⌘Z.
 */
export function applyActions(actions, reason = "director", also = null) {
  if (!actions?.length) return 0;
  update((draft) => {
    for (const a of actions) {
      try { a.spec.apply(draft, a.args); }
      catch { /* one bad action must not abandon the rest of the plan */ }
    }
    try { also?.(draft); } catch { /* bookkeeping must not fail the plan */ }
  }, reason);
  return actions.length;
}

/* ── What the model is told ───────────────────────────────────
 * The vocabulary, generated from the same objects that validate it, so the
 * prompt can never drift from what the app will accept.
 */
function vocabularySpec() {
  const shape = (spec) => Object.keys(spec.args).join(", ");
  return Object.entries(ACTIONS)
    .map(([name, spec]) => `  {"action":"${name}", ${shape(spec).split(", ").map(k => `"${k}":…`).join(", ")}}  — ${spec.label}`)
    .join("\n");
}

const VALUES = () => [
  `shotType: ${ids(SHOT_TYPES).join(" | ")}`,
  `viewpoint: ${ids(VIEWPOINTS).join(" | ")}`,
  `camera.type: ${ids(CAMERA_TYPES).join(" | ")}`,
  `amplitude: ${ids(AMPLITUDES).join(" | ")}   speed: ${ids(SPEEDS).join(" | ")}`,
  `framing: ${ids(FRAMINGS).join(" | ")}`,
  `lighting: ${ids(LIGHTING).join(" | ")}`,
  `grade: ${ids(GRADES).join(" | ")}`,
  `visual retention: ${ids(VISUAL_RETENTION).join(" | ")}   audio retention: ${ids(AUDIO_RETENTION).join(" | ")}`,
  `duration seconds: ${Object.keys(DURATION_FRAMES).map(Number).filter(d => d <= H3_DURATION.max).join(" | ")} (H3 generates ${H3_DURATION.min}-${H3_DURATION.max}s; longer clips repeat themselves and cuts do not extend that)`,
  `dials (0–100): ${DIALS.map(d => `${d.id} (${d.low} → ${d.high})`).join(", ")}`,
].join("\n");

/* ── The state the model reasons over ─────────────────────────
 * Not a summary someone wrote by hand: the real shot list with indices that
 * match the ones its actions must use, the compiled prompt it is judged on,
 * the checker's complaints, and what past renders of this kind were worth.
 */
export function projectState(p = getProject()) {
  const shots = orderedShots(p);
  const inv = referenceInventory(p);
  const report = validate(p);
  const lines = [
    `Mode: ${p.mode.toUpperCase()}. Clip: ${p.render.duration}s @ ${p.render.fps}fps, ${p.render.resolution}.`,
    `Look: ${p.style?.look || "—"}${p.style?.grade ? `, ${p.style.grade}` : ""}.`,
    "",
    "SHOTS (the numbers here are the ones your actions must use):",
    ...shots.map((s, i) => {
      const end = i + 1 < shots.length ? shots[i + 1].at : p.render.duration;
      const cam = s.camera?.type === "static" ? "static" : [s.camera?.type, s.camera?.amplitude, s.camera?.speed].filter(Boolean).join("/");
      return `  ${i + 1}. ${s.at.toFixed(1)}–${end.toFixed(1)}s · ${s.shotType}, ${s.viewpoint} · camera ${cam}`
        + `\n     subject: ${s.subject || "—"}`
        + `\n     action:  ${shotActionText(s) || "—"}`
        + (s.setting ? `\n     setting: ${s.setting}` : "")
        + (s.lighting ? `\n     light:   ${s.lighting}` : "")
        + ((s.dialogue || []).length ? `\n     speech:  ${s.dialogue.map(d => `(${d.speaker}) "${d.text}"`).join(" ")}` : "");
    }),
    "",
    `SOUND: ${p.sound.silent ? "deliberate silence" : p.sound.soundscape || "— (not written; the model will invent it)"}`,
    `MUSIC: ${p.sound.musicOff ? "none" : p.sound.music || "— (not written; the model will invent it)"}`,
  ];
  if (inv.length) {
    lines.push("", "REFERENCES (cite exactly these tags, no others):",
      ...inv.map(e => `  ${e.tag} — ${e.ref?.label || e.ref?.name || e.kind}${e.ref?.retention ? ` · kept ${e.ref.retention}` : ""}${e.ref?.caption ? ` · "${e.ref.caption}"` : ""}`));
  }
  if (p.creative?.dials) {
    lines.push("", `STEERING: ${DIALS.map(d => `${d.id} ${p.creative.dials[d.id] ?? "—"}`).join(", ")}`);
    if (presetGuidance(p)) lines.push("", presetGuidance(p).toUpperCase());
  }
  if (report.errors || report.warnings) {
    lines.push("", "THE CHECKER SAYS:",
      ...(report.items || []).filter(i => i.level !== "ok").slice(0, 12).map(i => `  [${i.level}] ${i.text}`));
  }
  return lines.join("\n");
}

/** What past renders taught, so advice is grounded in this creator's results
 *  rather than in generic prompt lore. */
async function lessons(p) {
  try {
    const all = await library.list();
    const judged = (all || []).filter(e => e.verdict?.rating).slice(0, 40);
    if (!judged.length) return "";
    const good = judged.filter(e => e.verdict.rating >= 4).slice(0, 4);
    const bad = judged.filter(e => e.verdict.rating <= 2).slice(0, 4);
    const line = (e) => `  ${e.verdict.rating}/5 ${summarise(e)}${e.verdict.tags?.length ? ` [${e.verdict.tags.join(", ")}]` : ""}${e.verdict.note ? ` — "${String(e.verdict.note).slice(0, 100)}"` : ""}`;
    return [
      "",
      "WHAT THIS CREATOR'S PAST RENDERS SHOW (their own ratings — weigh these over general advice):",
      ...(good.length ? ["  worked:", ...good.map(line)] : []),
      ...(bad.length ? ["  did not work:", ...bad.map(line)] : []),
    ].join("\n");
  } catch { return ""; }
}

const SYSTEM = `You are the director inside MOTIONSTILL CUT, a prompt-engineering tool for MiniMax H3
(Hailuo 3.0) — an omni-modal video model with native audio, text-encoded by Qwen3-VL 32B.

You do not write prompts for the creator to paste. You OPERATE THE APP: you answer in plain
words AND return a list of actions the app applies to the project.

THE ONLY ACTIONS THAT EXIST:
{{VOCAB}}

VALUES THESE FIELDS ACCEPT (anything else is rejected):
{{VALUES}}

HOW MINIMAX H3 ACTUALLY BEHAVES — this is what your actions are for:
- Prose, never tag soup. The encoder is an LLM. "masterpiece, 8k, best quality" is placebo.
- Concrete beats abstract. "shifts her weight to her left foot" survives; "moves gracefully" does not.
- No negations describing the FRAME. Naming what should be absent summons it. (A clause that
  stops the model adding something — "without becoming a separate speaker source" — is fine;
  MiniMax's own guide uses one.)
- Camera motion is ALWAYS stated — type + amplitude + speed — or explicitly static. Unstated
  motion means the model invents motion.
- H3 renders roughly ONE BEAT PER 2–3 SECONDS. More beats than that in a shot and the late ones
  blur together. If the creator wants more, lengthen the clip (duration.set) — never delete a
  beat they wrote.
- A cut must introduce new information. If only the distance changes, prefer camera motion.
- Restrained wording: "red dress", not "vibrant red dress". Intensifiers destabilise output.
- Emotions only as observable detail ("his eyebrows angle downward"), never inferred states.
- Describe people specifically, but never infer ethnicity, nationality or religion.
- Action beats are bare lowercase clauses starting with a verb — "looks up at the soldier", not
  "She looks up at the soldier." The app writes ", then " in front of each one after the first.
- overall_soundscape NAMES SOUNDS — footsteps, fabric, rain, impacts, breathing. A category
  ("the physical sounds of what is happening") is not an answer. It must not repeat dialogue or
  music, and "N/A" means the whole clip is silent, which is a choice you must be told to make.
- non_diegetic_music is instrumentation, tempo, rhythm and dynamics. No mood words ("epic",
  "haunting"), and never say what the score is FOR. Music the characters can hear is diegetic and
  belongs in the description instead.
- Dialogue needs the exact words: mentioning speech without them makes the model invent it. The
  first time a speaker talks, set "identity" — who they are and how they sound, "a young woman
  with a quiet, breathy voice" — or H3 picks a voice for you. "delivery" is the verb and its
  manner ("says", "shouts", "says quietly").
- Speaker ids are assigned in the order people actually speak, and (S1) is the same person in
  every shot they appear in.

THE PROMPT FORMAT YOUR TEXT LANDS IN — matters most for prompt.override, which is sent to the
model unmodified:
- [Shot 1] with no timestamp, then "[Shot 2] At 00:03.500, the camera cuts to …". A single-shot
  clip still opens with [Shot 1]. Cut times strictly increase and stay inside the clip.
- Dialogue is <d>[Language] exact words</d>, with the speaker, delivery and identity OUTSIDE the
  tag and the line's own punctuation INSIDE it.
- References are <Picture N>/<Video N>/<Audio N>, exactly as the state below lists them. A tag
  with no file behind it is silently ignored by the model.
- On-screen text goes in double quotes, verbatim, never translated.

HOW TO ANSWER:
- Return JSON only: {"reply":"…","actions":[…],"asks":["…"]}
- "reply" is 1–3 sentences to a person, in plain language. Say what you changed and WHY it will
  change the render. Never mention JSON, actions, fields or this format.
- Every action carries "why": one short clause, shown next to it in the review list.
- Change only what the request needs. A creator who asked about the sound does not want their
  shot list rewritten. An empty actions list is a perfectly good answer to a question.
- Prefer the smallest action that does the job: camera.set over shot.update, dials.set over
  rewriting six shots by hand.
- If something genuinely blocks you, put it in "asks" as a direct question. Do not guess at
  the creator's intent and act on the guess.
- Use the shot numbers exactly as given in the state below.`;

/**
 * Ask the director for a plan. Vision-capable calls carry the project's images
 * so advice about a reference is based on the picture, not on a caption
 * nobody wrote.
 */
export async function direct(request, { project = getProject(), useVision = true, images = null } = {}) {
  const p = project;
  const pics = images || (useVision ? await projectImages(p, { max: 6 }).catch(() => []) : []);
  const compiled = compilePrompt(p);

  const system = SYSTEM
    .replace("{{VOCAB}}", vocabularySpec())
    .replace("{{VALUES}}", VALUES());

  const prompt = [
    "THE PROJECT RIGHT NOW",
    projectState(p),
    await lessons(p),
    "",
    "THE PROMPT THIS CURRENTLY COMPILES TO (what the model will actually read):",
    String(compiled.text || "").slice(0, 3000),
    pics.length ? `\nThe ${pics.length} image${pics.length === 1 ? "" : "s"} attached to this message are the references, in tag order.` : "",
    "",
    "WHAT THE CREATOR ASKS:",
    request,
  ].filter(Boolean).join("\n");

  const r = await api.chat({
    json: true, expect: ["reply", "actions", "asks"], system, prompt, temperature: 0.4, maxTokens: 2600,
    images: pics.map(x => x.dataUrl || x),
    mode: "director",
  });
  const data = r.json;
  if (!data) {
    // The server works out WHY and what to change; repeating "try a larger
    // model" at someone whose model was simply told to think was wrong most of
    // the time, and gave them nothing to act on.
    const why = r.jsonFailure;
    const err = new Error(why ? `${why.title}. ${why.detail}` : "The model did not answer with JSON.");
    err.raw = r.text;
    err.jsonCause = why?.cause || "not-json";
    err.fix = why?.fix || "model";
    throw err;
  }
  const { actions, rejected } = validateActions(data.actions, p);
  return {
    reply: String(data.reply || "").trim(),
    asks: (Array.isArray(data.asks) ? data.asks : []).map(a => String(a).trim()).filter(Boolean).slice(0, 4),
    actions, rejected,
    model: r.model, ms: r.ms, sawImages: pics.length,
  };
}

/* ── The standing jobs ────────────────────────────────────────
 * The same machinery, pointed at the questions a creator would otherwise have
 * to know to ask. These are what make the model part of the workflow rather
 * than a box you type into.
 */

/** Before a render: what is actually wrong with this prompt, as fixes. */
export const critique = (project) => direct(
  `Review this prompt as the person who will have to explain the render to me. Find what will
   actually go wrong — invented motion, beats too dense for the length, an unstated camera, a
   reference nothing cites, sound that repeats the dialogue, wording that destabilises H3 — and
   return actions that fix each one. If it is genuinely ready, say so and return no actions.`,
  { project });

/** After a render the creator disliked: the next thing to try. */
export const nextTake = (project, verdict) => direct(
  `I just rendered this and it did not work${verdict?.note ? `: "${verdict.note}"` : ""}${verdict?.tags?.length ? ` (${verdict.tags.join(", ")})` : ""}.
   Diagnose it against how H3 behaves and change the ONE thing most likely to be the cause.
   Say what you changed and what I should look for in the next render.`,
  { project });

/** From material to a first draft, in one move. */
export const fromMaterial = (project, material) => direct(
  `Here is my rough idea: "${material}"
   Build me a first version — shots, action, camera, light and sound — that suits the clip length
   and the references I have attached. Look at the pictures before you decide what is in frame.`,
  { project });
