/* MOTIONSTILL CUT — steering.
 *
 * The premise of the whole app, restated: a creator arrives with a rough idea
 * and some material. They do not think in "shot type: medium close-up" or
 * "amplitude: small at slow speed". They think *closer*, *calmer*, *let it
 * breathe*, *keep her face exactly*.
 *
 * So the interface is six dials in the creator's language, and this file is the
 * translation layer that turns them into MiniMax H3's grammar — deterministic,
 * no model involved. The division of labour that makes the app work:
 *
 *   the creator steers FORM     (these dials)
 *   the LLM writes CONTENT      (what is in frame, what happens)
 *   the compiler enforces GRAMMAR (prompt.js, unchanged)
 *
 * Because the dials write ordinary project state, everything downstream — the
 * compiler, the checks, the previz, the ComfyUI graph — keeps working exactly
 * as it did.
 */

import { newShot, newBeat, orderedShots, DURATION_FRAMES, H3_DURATION } from "./state.js";
import { GRADES } from "./vocab.js";
import { clamp } from "./util.js";
import { cutInBeat, readFraming } from "./shotlist.js";

/* The colourist's shelf, by its short name — a readout has room for "Low key"
 * and not for the sentence the model reads. */
const GRADE_LABEL = Object.fromEntries(GRADES.map(([value, label]) => [value, label]));

/** The six things a creator actually feels about a shot. */
/* Three of these describe ONE shot and three describe the clip. Distance,
 * energy and light are properties of a frame, so they can differ shot to shot;
 * pace decides how many shots there ARE and how the beats divide among them,
 * sound is one continuous track H3 generates for the whole clip, and
 * faithfulness is a retention marker per reference, not per shot. Saying which
 * is which is the honest way to offer per-shot steering — the alternative is a
 * dial that silently does nothing when you scope it. */
export const DIALS = [
  {
    id: "distance", label: "Distance", low: "far off", high: "right up close",
    hint: "How much of the world is in frame — and therefore how much the model has to invent.",
    icon: "⤡", perShot: true,
  },
  {
    id: "energy", label: "Energy", low: "perfectly still", high: "restless",
    hint: "What the camera is doing. Still is a real choice: H3 invents motion when you don't state it.",
    icon: "≋", perShot: true,
  },
  {
    id: "pace", label: "Pace", low: "one long breath", high: "quick",
    hint: "How much happens per second. H3 renders about one beat per 2–3 seconds — past that, beats drop.",
    icon: "⏱",
  },
  {
    id: "light", label: "Light", low: "soft and flat", high: "hard and contrasty",
    hint: "One axis: how hard the light is and how much of the frame it leaves black. "
      + "Five stops, each one a named source and the grade that goes with it — a named light is "
      + "worth more to the model than any adjective. Previz draws it, so you can see where it lands.",
    icon: "☀", perShot: true,
  },
  {
    id: "sound", label: "Sound", low: "silence", high: "full mix",
    hint: "H3 generates its own audio. Silence is a choice you have to make out loud.",
    icon: "♪",
  },
  {
    id: "faithfulness", label: "Faithfulness", low: "loose inspiration", high: "keep it exactly",
    hint: "How closely the render must match the pictures you gave it.",
    icon: "⧉", needsRefs: true,
  },
  {
    id: "detail", label: "Detail", low: "spare", high: "exhaustive",
    hint: "How much each shot says: a phrase per thing, or clothing, materials, background and what the hands are doing. "
      + "It steers the writer (Read my material, Polish, Enhance), not the render — the model reads what is written and invents the rest, "
      + "so spare hands it more to invent.",
    icon: "✎",
  },
];

export const DEFAULT_DIALS = { distance: 50, energy: 30, pace: 40, light: 45, sound: 55, faithfulness: 80, detail: 50 };

/* ── Detail: how much each shot says ─────────────────────────
 * The dial does not touch the render graph and it does not rewrite text on
 * its own — a dial may propose, not bin work. It sets the target the LLM
 * writes to, and the explain line says the target in words per shot so the
 * word counter has something to be measured against. */
export const DETAIL_BANDS = [
  { max: 20, name: "spare", wordsPerShot: 25,
    rules: "SPARE. The subject in one short phrase (no more than eight words). One short clause per beat. The setting as a single phrase. "
      + "Lighting as one named source. No details field. Nothing about texture, background or clothing unless it is the point of the shot." },
  { max: 45, name: "measured", wordsPerShot: 45,
    rules: "MEASURED. The subject with two or three identifiers (one of them clothing or a key object). Beats as short clauses. "
      + "The setting in one sentence with one concrete anchor. Lighting as a named source. A details field only when something in frame would otherwise be invented." },
  { max: 70, name: "rich", wordsPerShot: 70,
    rules: "RICH. The subject with clothing, colour and one key object. Beats as clauses that say what the hands and the eyes do. "
      + "The setting with two or three concrete anchors (a named surface, a light, an object). Lighting as source plus how it falls. One details sentence about the frame's edges or background." },
  { max: 100, name: "exhaustive", wordsPerShot: 100,
    rules: "EXHAUSTIVE. Everything RICH asks for, plus materials and textures, what is in the background and how far away it is, weather or air (dust, steam, rain), "
      + "and one thing per shot that only a person who was there would notice. Still concrete — no adjectives of quality, no mood words." },
];
export const detailBand = (v) => DETAIL_BANDS.find(b => clamp(Number(v) || 0, 0, 100) <= b.max) || DETAIL_BANDS[DETAIL_BANDS.length - 1];
/** The writing rule the LLM is handed, and the word target per shot. */
export function detailToWriting(v) {
  const b = detailBand(v);
  return { name: b.name, wordsPerShot: b.wordsPerShot, rules: b.rules };
}
export const detailSays = (v, shots = 1) => {
  const w = detailToWriting(v);
  return `${w.name} · about ${w.wordsPerShot} words a shot${shots > 1 ? `, ~${w.wordsPerShot * shots} in all` : ""}`;
};

/** The dials that describe one shot rather than the whole clip. */
export const PER_SHOT_DIALS = DIALS.filter(d => d.perShot).map(d => d.id);

/**
 * The dials in force for one shot: the clip's, with that shot's overrides on
 * top. A shot with no overrides follows the clip, which is what "steer the
 * whole thing" has to keep meaning.
 */
export function dialsFor(project, shot) {
  const base = { ...DEFAULT_DIALS, ...(project.creative?.dials || {}) };
  if (!shot?.dials) return base;
  for (const id of PER_SHOT_DIALS) {
    if (Number.isFinite(shot.dials[id])) base[id] = shot.dials[id];
  }
  return base;
}

/** Does this shot steer itself? */
export const hasOwnDials = (shot) =>
  !!shot?.dials && PER_SHOT_DIALS.some(id => Number.isFinite(shot.dials[id]));

const band = (v, bands) => bands.find(b => v <= b[0])?.[1] ?? bands[bands.length - 1][1];

/* ── Distance → shot size ─────────────────────────────────── */
export const distanceToShot = (v) => band(v, [
  [12, "extreme wide"], [26, "wide"], [42, "medium wide"], [58, "medium"],
  [72, "medium close-up"], [88, "close-up"], [100, "extreme close-up"],
]);

/* ── Energy → what the camera does ────────────────────────── */
export function energyToCamera(v, { subjectMoves = false } = {}) {
  if (v <= 10) return { type: "static", amplitude: "medium", speed: "normal", secondary: "none" };
  if (v <= 28) return { type: "push in", amplitude: "small", speed: "slow", secondary: "none" };
  if (v <= 45) return { type: subjectMoves ? "tracking" : "push in", amplitude: "small", speed: "normal", secondary: "none" };
  if (v <= 62) return { type: subjectMoves ? "tracking" : "arc left", amplitude: "medium", speed: "normal", secondary: "none" };
  if (v <= 78) return { type: "arc left", amplitude: "medium", speed: "fast", secondary: "tilt up" };
  if (v <= 90) return { type: "handheld", amplitude: "medium", speed: "fast", secondary: "pan right" };
  return { type: "strong shake", amplitude: "large", speed: "fast", secondary: "pan right" };
}

/* ── Pace → how much happens, and how often it cuts ───────── */
export function paceToStructure(v, durationSeconds, beatCount = 0) {
  // One beat per 2–3 s is the model's real throughput; the top of the dial
  // pushes to the edge of it rather than past it, because past it beats are
  // silently dropped and the clip looks *emptier*, not busier.
  const secondsPerBeat = 6 - (v / 100) * 3.8;              // 6.0s → 2.2s
  // How many beats this duration has *room* for at this pace.
  const room = clamp(Math.round(durationSeconds / secondsPerBeat), 1, 12);
  // Cuts start appearing in the top half and never go under 3 s apart.
  const shots = v < 45 ? 1 : clamp(Math.floor(durationSeconds / (9 - (v / 100) * 5)), 1, 6);
  // What the creator wrote always wins over what the dial would have picked:
  // a dial may warn that a clip is crowded, it may never quietly bin a beat.
  const needsSeconds = beatCount ? Math.ceil(beatCount * secondsPerBeat) : 0;
  const crowded = beatCount > room;
  const fits = crowded ? nearestDuration(needsSeconds, durationSeconds) : null;
  return {
    room, shots, secondsPerBeat,
    beats: Math.max(room, beatCount),
    crowded,
    needsSeconds,
    suggestDuration: fits,
    /* These beats need more seconds than H3 can render at all. Worth saying
     * out loud, because the honest remedies are a faster pace or a second
     * clip — and the answer the app used to give was "make it 20 s", which
     * renders 20 seconds the last five of which repeat. */
    overRuns: crowded && needsSeconds > H3_DURATION.max,
  };
}

/**
 * The next length H3 actually offers that fits `seconds` — never past the
 * ceiling, and never a length you already have.
 *
 * This used to fall back to the LAST row in the table when nothing fit, which
 * is 30 s, so beats crowded at a slow pace were answered with "Make it 30s"
 * and the render came back repeating itself for the last half. Nothing above
 * 15 s is a real answer.
 *
 * When even 15 s cannot hold them, 15 s is still offered if it is longer than
 * what is set — going 5 s → 15 s is a genuine improvement even when it is not
 * a complete one — and `overRuns` tells the caller to say what is still true.
 */
function nearestDuration(seconds, current = 0) {
  const options = Object.keys(DURATION_FRAMES).map(Number)
    .filter((d) => d <= H3_DURATION.max)
    .sort((a, b) => a - b);
  const fit = options.find((d) => d >= seconds) || options[options.length - 1];
  return fit > current ? fit : null;
}

/* ── Light → one axis, walked in step ──────────────────────
 *
 * This dial was two dials wearing one coat. It picked a named source off one
 * ladder and a grade off another; the ladders had different band edges
 * (15/32/50/68/85 against 20/40/60/80) so a one-point drag could move either,
 * both or neither at nine places you could not see; and neither ladder was
 * ordered by the thing the slider says it controls. Dragging left to right you
 * got: soft key from the LEFT, a practical lamp, a backlight, hard key from the
 * RIGHT — the key crossing the face because you asked for more contrast — and
 * at the top "harsh midday sun" handed to the model together with "most of the
 * frame in shadow", which are two different frames in the same breath.
 *
 * It is one axis now, the one the ends have always claimed: how hard the light
 * is, and how much of the frame it leaves black. Five bands, twenty apart. The
 * source and the grade step together at every one of them, so the dial has five
 * stops you can find rather than nine you cannot. Contrast only goes up.
 *
 * The key stays on the left the whole way. Where the light comes FROM is a
 * separate decision from how hard it is, and it belongs to the shot's own
 * Lighting field — the previz draws whichever side that field names.
 */
export const LIGHT_BANDS = [
  {
    upTo: 20,
    lighting: "overcast diffused daylight",
    grade: "high-key grade, bright and low-contrast with lifted blacks",
    say: "nothing in the frame casts a shadow",
  },
  {
    upTo: 40,
    lighting: "soft key light from the left",
    grade: "neutral Rec.709 grade with true blacks",
    say: "one soft source, shadows still readable",
  },
  {
    upTo: 60,
    lighting: "single practical lamp in frame",
    grade: "Kodak 2383 print emulation, dense blacks and creamy highlight rolloff",
    say: "a lamp in shot, the shadow side falling away",
  },
  {
    upTo: 80,
    lighting: "harsh midday sun",
    grade: "bleach-bypass look, desaturated with crushed blacks and hard contrast",
    say: "hard-edged shadows, blacks crushed",
  },
  {
    upTo: 100,
    lighting: "hard key light from the left",
    grade: "low-key grade, most of the frame in shadow with a single bright source",
    say: "one hard source, the rest of the frame black",
  },
];

const lightBand = (v) => LIGHT_BANDS.find(b => v <= b.upTo) || LIGHT_BANDS[LIGHT_BANDS.length - 1];

export const lightToLighting = (v) => lightBand(v).lighting;
export const lightToGrade = (v) => lightBand(v).grade;

/** What the dial just did, both halves of it. The grade used to change in
 *  silence — the readout named the source and said nothing about the colour
 *  treatment it had also rewritten. */
export const lightSays = (v) => {
  const b = lightBand(v);
  return `${b.lighting} · ${GRADE_LABEL[b.grade] || "graded"} — ${b.say}`;
};

/* ── Sound → the two audio fields ─────────────────────────── */
export function soundToAudio(v, { setting = "" } = {}) {
  /* The place, spliced mid-sentence, so it must not arrive capitalised or with
   * a full stop on the end — that is how the app produced "The ambience of A
   * dilapidated outdoor area … in the background. carries under the action". */
  const place = (setting || "the room")
    .replace(/^(in|on|at|inside|outside)\s+/i, "")
    .replace(/\.\s*$/, "")
    .trim()
    .replace(/^(The|A|An)\b/, (m) => m.toLowerCase()) || "the room";

  /* Every noun below is from §4.6's own list — "wind, rain, traffic,
   * footsteps, fabric movement, impacts, breathing, laughter, or panting" —
   * minus the ones that assume a place the dial cannot know about. What is
   * gone is the meta-description these used to carry: "the small sounds of the
   * space, and the physical sounds of what is happening, in the order they
   * happen" names no audible event at all, and it is what the model was being
   * handed as its entire audio track. §4.6 asks for a SUMMARY OF SOUNDS.
   *
   * Speech is gone too, and deliberately: "Dialogue, singing, and diegetic
   * music already belong in the multimodal description and should not be
   * repeated here." */
  if (v <= 8) return { silent: true, soundscape: "", musicOff: true, music: "" };
  if (v <= 30) {
    return {
      silent: false, musicOff: true, music: "",
      soundscape: `Low room tone from ${place}, with footsteps and the movement of clothing the only other sounds.`,
    };
  }
  if (v <= 60) {
    return {
      silent: false, musicOff: true, music: "",
      soundscape: `Room tone from ${place} continues underneath, with footsteps, the movement of clothing and the handling of objects audible over it.`,
    };
  }
  if (v <= 85) {
    return {
      silent: false, musicOff: false,
      soundscape: `The ambience of ${place} is present throughout, with footsteps, impacts, the handling of objects and audible breathing clear over it.`,
      // §4.7 asks for instrumentation, speed, rhythm and dynamics. "A single
      // sustained instrument" named none of them.
      music: "Sustained low strings at a slow tempo, entering late and holding at a low volume without a swell.",
    };
  }
  return {
    silent: false, musicOff: false,
    soundscape: `A dense ambience from ${place}: room tone and air movement layered underneath, with footsteps, impacts, fabric and breathing all distinct.`,
    music: "Low strings and a slow percussive pulse at a moderate tempo, rising in volume through the clip and thinning at the end.",
  };
}

/* ── Faithfulness → what the references are for ───────────── */
export function faithToReferences(v) {
  if (v >= 80) return { visual: "fully_preserved", audio: "fully_copy", refImageSize: "max", note: "keep the subject exactly as shown" };
  if (v >= 55) return { visual: "partially_preserved", audio: "partially_copy", refImageSize: "match", note: "keep who it is; let the pose and framing move" };
  if (v >= 30) return { visual: "attribute_transfer", audio: "reference", refImageSize: "match", note: "take the look, not the subject" };
  return { visual: "weak_reference", audio: "weak_reference", refImageSize: "match", note: "loose inspiration only" };
}

/* ── The whole translation, applied to a project draft ────── */

/**
 * Write the dials into project state. Content — who is in frame and what they
 * do — is never touched: that belongs to the creator and the LLM. This only
 * writes form.
 *
 * `pool` holds beats the LLM proposed; the pace dial expands and contracts
 * against it, so moving a dial never needs a model call.
 */
/** Every beat the creator has actually written — the pool if we're re-steering
 * from one, otherwise what is already on the timeline. Pace may never delete
 * these; it may only ask for more room. */
/* Does the subject move in these words? Decides tracking vs a still camera.
 * Per shot, not per clip: "she stands and turns" in shot 3 is no reason to
 * track a woman resting her hands on a desk in shot 1 — a moving camera on
 * a still subject is exactly what reads as jitter in a 5 s shot. */
export const MOVES_RE = /\b(walk|run|turn|reach|lift|pour|step|move|ride|drive|dance|climb|swing|stand|cross|enter|leave|rise|spin)\w*\b/i;
export const shotMoves = (shot) => MOVES_RE.test((shot?.beats || []).map(b => b.text || "").join(" "));

/* Speech has a speed. ~2.5 words a second is conversational; a line that
 * needs more seconds than its shot has is rushed or cut off, and on a talking
 * head the rush is visible as jerk. */
export const WORDS_PER_SECOND = 2.5;
export const speechWords = (text) => String(text || "").trim().split(/\s+/).filter(Boolean).length;
export const speechSeconds = (text) => speechWords(text) / WORDS_PER_SECOND;

/**
 * One line, spoken across the shots. Create writes the whole speech into
 * shot 1; on a four-shot clip that is twenty seconds of words in a five-
 * second shot. When exactly one shot carries speech and the speech overflows
 * it, the line is cut at sentence ends and dealt across the shots by how
 * long each one is. Speech the creator placed by hand — more than one shot
 * with lines — is never touched.
 */
export function spreadDialogue(draft) {
  const shots = orderedShots(draft);
  if (shots.length < 2) return false;
  const withLines = shots.filter(s => (s.dialogue || []).some(l => (l.text || "").trim()));
  if (withLines.length !== 1) return false;
  const src = withLines[0];
  const line = src.dialogue.find(l => (l.text || "").trim());
  if (line.voiceover || line.continues) return false;
  const duration = draft.render?.duration || 5;
  const secondsOf = (i) => Math.max(0, ((i + 1 < shots.length ? shots[i + 1].at : duration) - (shots[i].at || 0)));
  const srcIndex = shots.indexOf(src);
  if (speechSeconds(line.text) <= secondsOf(srcIndex) + 0.5) return false;

  const sentences = String(line.text).trim().match(/[^.!?…]+[.!?…]+["'”’]?|[^.!?…]+$/g)?.map(t => t.trim()).filter(Boolean) || [];
  if (sentences.length < 2) return false;
  // Deal sentences to shots from the source shot onward, by each shot's
  // capacity, but never leaving a later shot with nothing while sentences
  // remain — a talking head that falls silent for a shot reads as a glitch.
  const targets = shots.slice(srcIndex);
  const groups = targets.map(() => []);
  let gi = 0;
  for (let si = 0; si < sentences.length; si++) {
    const left = sentences.length - si;
    const shotsLeft = targets.length - gi;
    const cap = secondsOf(srcIndex + gi) * WORDS_PER_SECOND;
    const used = speechWords(groups[gi].join(" "));
    const next = speechWords(sentences[si]);
    const mustMoveOn = groups[gi].length && (used + next > cap * 1.15) && gi < targets.length - 1;
    const mustLeaveSome = left <= shotsLeft - 1 && groups[gi].length && gi < targets.length - 1;
    if (mustMoveOn || mustLeaveSome) gi++;
    groups[gi].push(sentences[si]);
  }
  const base = { speaker: line.speaker || "S1", language: line.language || "English", voiceover: false, note: "", identity: line.identity || "", voice: line.voice || "", delivery: line.delivery || "" };
  targets.forEach((shot, i) => {
    const text = groups[i].join(" ");
    // By id into the real array: orderedShots hands back shot 1 as a copy.
    const real = (draft.shots || []).find(x => x.id === shot.id) || shot;
    real.dialogue = text ? [{ ...base, id: i === 0 ? line.id : `${line.id}-${i + 1}`, text }] : [];
  });
  return true;
}

/** The beat pool cut at every beat that is really a cut. Each segment:
 *  { beats, cut (verb or null), shotType (named after the cut or null),
 *  subjectOf }. A pool with no cut-beats is one segment. */
export function cutSegments(beatPool) {
  const segments = [];
  let seg = { beats: [], cut: null, shotType: null, subjectOf: "" };
  for (const b of beatPool) {
    const c = cutInBeat(b);
    if (!c) { seg.beats.push(b); continue; }
    const f = readFraming(c.remainder);
    if (seg.beats.length || segments.length) segments.push(seg);
    seg = { beats: f.rest ? [f.rest] : [], cut: segments.length ? c.verb : null, shotType: f.shotType, subjectOf: f.framingOf };
  }
  segments.push(seg);
  return segments;
}

function writtenBeats(draft, pool) {
  const fromPool = (pool || draft.creative?.pool?.beats || []).filter(Boolean);
  if (fromPool.length) return fromPool;
  return orderedShots(draft)
    .flatMap((s) => (s.beats || []).map((b) => (b.text || "").trim()))
    .filter(Boolean);
}

export function applySteering(draft, { pool = null } = {}) {
  const dials = { ...DEFAULT_DIALS, ...(draft.creative?.dials || {}) };
  const duration = draft.render?.duration || 5;
  const beatPool = writtenBeats(draft, pool);
  /* Cuts the writer wrote. A beat that opens "cut to close-up, …" is not
   * an action, it is where a new shot starts — and Pace, which only counts
   * beats, would otherwise pack it into whatever number of shots the dial
   * happens to want (one, below 45). So the pool is cut into segments at
   * those beats first; when there are any, the segments ARE the shots, and
   * Pace keeps its say over camera, timing and everything else. */
  const segments = cutSegments(beatPool);
  const authoredCuts = segments.length > 1;
  const structure = paceToStructure(dials.pace, duration, beatPool.length);
  void distanceToShot(dials.distance);   // the clip-wide reading; each shot resolves its own below
  const subjectMoves = MOVES_RE.test(beatPool.join(" ") || orderedShots(draft).map(s => (s.beats || []).map(b => b.text).join(" ")).join(" "));

  /* Shots: keep what exists where possible, so a re-steer does not throw away
   * a subject the creator typed. */
  const existing = orderedShots(draft);
  /* NEVER fewer shots than already exist.
   *
   * structure.shots is what the pace dial would pick for an empty clip, and
   * using it directly meant that touching ANY dial rebuilt the shot list at
   * that count — so a four-shot clip written by Create collapsed to one the
   * moment you nudged Distance. A dial may propose; it may not quietly bin
   * work the creator or the interview already did. Cutting a shot is what the
   * shot's own ✕ is for, and the explain line offers it when the pace really
   * does want fewer. */
  /* An exact count from the first screen outranks Pace's guess; cuts the
   * writer actually wrote outrank both, since they say where the shots are.
   * Never fewer than exist — a shot is removed with its own ✕, not by a
   * number changing elsewhere. */
  const fixed = clamp(Number(draft.creative?.shotCount) || 0, 0, 8);
  const wanted = authoredCuts
    ? Math.max(existing.length, segments.length)
    : Math.max(existing.length, fixed || structure.shots);
  const bySegment = authoredCuts && segments.length === wanted;
  const shots = [];
  for (let i = 0; i < wanted; i++) {
    const base = existing[i] ? { ...existing[i] } : { ...newShot(0), subject: existing[0]?.subject || "" };
    base.at = i === 0 ? 0 : Math.round((duration / wanted) * i * 100) / 100;
    // A shot that steers itself uses its own distance, energy and light; the
    // rest of the clip still follows the clip-wide dials.
    const own = dialsFor(draft, base);
    const ownShotType = distanceToShot(own.distance);
    base.shotType = i === 0 || own.distance !== dials.distance ? ownShotType : nudgeShot(ownShotType, i);
    base.lighting = lightToLighting(own.light);
    /* A camera the creator set by hand is theirs. The Energy dial describes
     * what the camera should do when nobody has said; once somebody has, the
     * dial has no business overwriting it — the same rule the pace dial
     * follows about beats. It is released explicitly, never silently. */
    if (!base.camera?.byHand) {
      base.camera = {
        ...base.camera,
        ...energyToCamera(own.energy, { subjectMoves }),
        // Alternate the horizontal moves so a multi-shot clip doesn't arc the
        // same way three times. A shot steering itself is left pointing where
        // its own dial put it.
        ...(i % 2 === 1 && own.energy === dials.energy ? mirrorMove(energyToCamera(own.energy, { subjectMoves })) : {}),
        custom: "",
      };
    }
    shots.push(base);
  }

  /* Beats: every beat the creator wrote gets a home. Pace decides how they are
   * grouped across shots, never whether they survive — the last shot absorbs
   * the remainder rather than the remainder being dropped. */
  if (bySegment) {
    // One shot per authored cut: the beats after the cut, the framing it
    // named, the verb it used. The cut phrase itself is not a beat.
    segments.forEach((seg, i) => {
      const shot = shots[i];
      shot.beats = seg.beats.length ? seg.beats.map((text, j) => newBeat(text, j === 0 ? "" : "then")) : [newBeat("")];
      if (seg.shotType) shot.shotType = seg.shotType;
      if (seg.cut) shot.cutVerb = seg.cut;
      if (seg.subjectOf && !(shot.subject || "").trim()) shot.subject = seg.subjectOf;
    });
  } else {
    const perShot = Math.max(1, Math.ceil(beatPool.length / wanted));
    let cursor = 0;
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const last = i === shots.length - 1;
      const take = last ? beatPool.slice(cursor) : beatPool.slice(cursor, cursor + perShot);
      cursor += take.length;
      if (take.length) {
        shot.beats = take.map((text, j) => newBeat(text, j === 0 ? "" : "then"));
      } else if (!shot.beats?.length) {
        shot.beats = [newBeat("")];
      }
    }
  }

  /* Now that every shot has its beats, the camera can be decided by what
   * happens in THAT shot rather than anywhere in the clip. */
  shots.forEach((shot, i) => {
    if (shot.camera?.byHand) return;
    const own = dialsFor(draft, shot);
    const moves = shotMoves(shot);
    shot.camera = {
      ...shot.camera,
      ...energyToCamera(own.energy, { subjectMoves: moves }),
      ...(i % 2 === 1 && own.energy === dials.energy ? mirrorMove(energyToCamera(own.energy, { subjectMoves: moves })) : {}),
      custom: "",
    };
  });
  spreadDialogue({ ...draft, shots });

  draft.shots = shots;
  draft.selectedShot = shots[0]?.id || null;
  draft.style = { ...draft.style, grade: lightToGrade(dials.light) };

  const audio = soundToAudio(dials.sound, {
    setting: shots[0]?.setting || draft.creative?.answers?.setting || "",
  });
  // A soundscape the creator wrote themselves outranks the dial.
  if (!draft.creative?.soundEdited) {
    draft.sound = { ...draft.sound, ...audio };
  }

  if (draft.mode === "r2v" || draft.frames?.first) {
    const faith = faithToReferences(dials.faithfulness);
    draft.render.refImageSize = faith.refImageSize;
    for (const bin of ["images", "videos"]) {
      (draft.refs?.[bin] || []).forEach(m => { m.retention = faith.visual; });
    }
    (draft.refs?.audios || []).forEach(m => { m.retention = faith.audio; });
  }
  return draft;
}

/* Later shots step one size closer or wider, so a cut carries new information
 * rather than repeating the same frame. */
const SIZES = ["extreme wide", "wide", "medium wide", "medium", "medium close-up", "close-up", "extreme close-up"];
function nudgeShot(base, i) {
  const at = SIZES.indexOf(base);
  const shift = i % 3 === 1 ? 2 : i % 3 === 2 ? -1 : 1;
  return SIZES[clamp(at + shift, 0, SIZES.length - 1)];
}

const MIRROR = {
  "arc left": "arc right", "arc right": "arc left",
  "pan left": "pan right", "pan right": "pan left",
  "truck left": "truck right", "truck right": "truck left",
};
const mirrorMove = (cam) => (MIRROR[cam.type] ? { type: MIRROR[cam.type] } : {});

/** One line per dial saying what it just did, in the model's own words. This is
 *  the honesty the dials owe: a slider that hides its effect is a toy. */
/**
 * @param {object} project
 * @param {string|null} scopeShotId  when set, explain the dials as they apply
 *   to that ONE shot rather than to the clip.
 */
export function explainDials(project, scopeShotId = null) {
  const scoped = scopeShotId ? orderedShots(project).find(sh => sh.id === scopeShotId) : null;
  const dials = dialsFor(project, scoped);
  const duration = project.render?.duration || 5;
  const written = writtenBeats(project, null).length;
  const structure = paceToStructure(dials.pace, duration, written);
  const cam = energyToCamera(dials.energy);
  const faith = faithToReferences(dials.faithfulness);
  const hasRefs = project.mode === "r2v" || !!project.frames?.first;
  return [
    { id: "distance", text: `${distanceToShot(dials.distance)} shot` },
    {
      id: "energy",
      text: (() => {
        const said = cam.type === "static"
          ? "the camera remains static"
          : `${cam.type}, ${cam.amplitude} amplitude, ${cam.speed} speed`;
        const held = orderedShots(project).filter(s => s.camera?.byHand).length;
        if (!held) return said;
        const all = held === orderedShots(project).length;
        return all
          ? `every shot's camera is set by hand — this dial is not touching them`
          : `${said} · ${held} shot${held === 1 ? "" : "s"} set by hand, left alone`;
      })(),
    },
    (() => {
      const have = orderedShots(project).length;
      const per = `about one every ${structure.secondsPerBeat.toFixed(1)}s`;
      if (structure.crowded) {
        return {
          id: "pace",
          text: `${structure.beats} beats in ${duration}s is tight — H3 renders ${per}, so the later ones may blur together`
            /* When the beats need more than H3 renders at all, say what the
             * real options are. A longer clip is not one of them past 15 s:
             * the model repeats itself and the beats are no less crowded. */
            + (structure.overRuns
                ? `. At this pace they want about ${structure.needsSeconds}s, past the ${H3_DURATION.max}s H3 renders — quicken the pace, or make this two clips`
                : ""),
          warn: true,
          suggestDuration: structure.suggestDuration,
        };
      }
      // The pace wants a shorter shot list than exists. Say so; do not act.
      if (have > structure.shots) {
        return {
          id: "pace",
          text: `${structure.beats} beat${structure.beats === 1 ? "" : "s"} across the ${have} shots you have · ${per}`
            + ` — this pace suits ${structure.shots} shot${structure.shots === 1 ? "" : "s"}, but nothing is removed for you`,
        };
      }
      return {
        id: "pace",
        text: `${structure.beats} beat${structure.beats === 1 ? "" : "s"} across ${Math.max(have, structure.shots)} shot${Math.max(have, structure.shots) === 1 ? "" : "s"} · ${per}`,
        suggestDuration: structure.suggestDuration,
      };
    })(),
    { id: "light", text: lightSays(dials.light) },
    { id: "sound", text: dials.sound <= 8 ? "deliberate silence" : dials.sound <= 60 ? "ambience only, no score" : "ambience and a score" },
    ...(hasRefs ? [{ id: "faithfulness", text: `${faith.note} (${faith.visual})` }] : []),
    { id: "detail", text: detailSays(dials.detail, Math.max(1, orderedShots(project).length)) },
  ];
}
