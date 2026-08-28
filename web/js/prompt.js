/* MOTIONSTILL CUT — the prompt compiler.
 *
 * Turns the timeline into the exact text MiniMax H3's rewriter emits, because
 * that shape is what Qwen3-VL 32B was trained to read:
 *
 *   [optional keyframe-alignment line]
 *
 *   integrated_multimodal_description: [Shot 1] … [Shot 2] At 00:03.500, …
 *   overall_soundscape: …
 *   non_diegetic_music: …
 *
 * Ref2VA swaps in the reference format — subject_definitions, summary,
 * retention_analysis, detailed_description — and keeps the last two fields.
 *
 * Everything is a pure function of the project, so the compiled prompt, the
 * validation report and the ComfyUI graph can never drift apart.
 */

import { shotTime, words } from "./util.js";
import { CAMERA_TYPES, CAMERA_GERUNDS, LANGUAGES, VISUAL_RETENTION, AUDIO_RETENTION, NO_CUT, cutVerbFor } from "./vocab.js";
import { orderedShots, referenceInventory, MODES, shotActionText, isPristine, H3_DURATION, LTX25_DURATION, activeEngine, shotKeyframes, REF_LIMITS, filmSpan, FILM_LIMITS, ltxGuideTime } from "./state.js";
import { speechWords, WORDS_PER_SECOND } from "./steer.js";
import { stripCutPrefix, cutInBeat } from "./shotlist.js";

/* "Wide low-angle shot of…", "Close-up shot on…", "An extreme wide shot…" —
 * a size word, up to two qualifiers, then "shot". "Long shadows fall" is not
 * one, so the word "shot" is required. */
const SHOT_HEADING_RE = /^(?:an?\s+)?(?:extreme\s+|medium\s+|big\s+)?(?:close[- ]?up|wide|long|establishing|medium)(?:\s+[\w-]+){0,2}\s+shot\b/i;
/* film.js imports state.js and nothing else, so reaching for the planner here
 * is a leaf dependency rather than a cycle. The checker needs it because a
 * film's real error is never "this clip is too long" — it is where the clips
 * fall. */
import { planFilm, describePlan, CLIP_MAX } from "./film.js";
import { mentionedKnown } from "./knowncast.js";

/* "toward subject" is not English, and it is what the compiler emitted when a
 * writer filled `target` with a bare noun. Every other camera field in this
 * file already tests for a leading determiner before splicing — `depth` does it
 * five lines down — and `target` was the one that skipped the convention. */
const determined = (t) =>
  (!t || /^(the|a|an|his|her|its|their|my|your|our|some|each|every|this|that|these|those|\d)\b/i.test(t) || /^[<(A-Z]/.test(t)
    ? t
    : `the ${t}`);

const camPhrase = (type) => CAMERA_TYPES.find(c => c[0] === type)?.[2] || "The camera remains static";

/** Where the subject sits in the rectangle, in words, from coordinates. The
 *  framing box in previz writes fx/fy directly, so an arbitrary position has to
 *  come back out as language the encoder reads — thirds and halves, which is
 *  how composition is described anyway. Returns "" for a centred frame,
 *  because "framed in the centre" is a sentence that buys nothing. */
const tidyPreset = (f) => f.replace(/\bin frame\b/, "in the frame");

export function framingPhrase(camera = {}) {
  if (camera.framing && camera.framing !== "custom") {
    if (camera.framing === "centered") return "";
    if (camera.framing === "over-shoulder foreground") return "with a shoulder in the near foreground";
    const f = camera.framing;
    return `with the subject framed ${f.startsWith("low") || f.startsWith("high") ? phrase(tidyPreset(f)) : `in the ${phrase(f)}`}`;
  }
  const x = Number.isFinite(camera.fx) ? camera.fx : 50;
  const y = Number.isFinite(camera.fy) ? camera.fy : 50;
  const across = x < 25 ? "hard to the left of frame"
    : x < 42 ? "in the left third"
    : x > 75 ? "hard to the right of frame"
    : x > 58 ? "in the right third"
    : "";
  const down = y < 28 ? "high in the frame"
    : y < 42 ? "slightly high in the frame"
    : y > 72 ? "low in the frame"
    : y > 58 ? "slightly low in the frame"
    : "";
  if (!across && !down) return "";
  return `with the subject framed ${[across, down].filter(Boolean).join(" and ")}`;
}

/** The framing sentence: lens, height, where the subject sits, and what the
 *  lens is doing about depth. Separate from the move, because it is true for
 *  the whole shot while the move is what changes during it. Anything left
 *  unstated is left out — an unstated lens is better than a wrong one. */
export function framingSentence(camera = {}, shotType = "") {
  const bits = [];
  if (camera.lens) bits.push(`Shot on a ${camera.lens} lens`);
  if (camera.height) bits.push(bits.length ? `at ${phrase(camera.height)}` : `The camera sits at ${phrase(camera.height)}`);
  const where = framingPhrase(camera);
  if (where) bits.push(bits.length ? where : `The frame is composed ${where}`);
  const first = bits.length ? `${bits.join(", ")}.` : "";
  // Depth is its own sentence: a rack focus or a dolly zoom is an event, not an
  // attribute, and burying it in a clause is how it gets dropped.
  const depth = (camera.depth || "").trim();
  if (!depth) return first;
  const depthSentence = /^(the|a) /i.test(depth)
    ? `${depth.charAt(0).toUpperCase()}${depth.slice(1)}.`
    : `The shot is held in ${phrase(depth)}.`;
  return first ? `${first} ${depthSentence}` : depthSentence;
}

/** "The camera pushes in with small amplitude at slow speed toward the door,
 *  while tilting up."
 *  Amplitude "medium" and speed "normal" are the unmarked cases and are left
 *  out — that is how the guide's own examples read. A custom line replaces the
 *  generated one outright: sometimes a move has a name the vocabulary doesn't
 *  carry, and inventing one in the wrong grammar is worse than writing it. */
export function cameraSentence(camera = {}) {
  if ((camera.custom || "").trim()) return sentence(camera.custom.trim());
  const type = camera.type || "static";
  const secondary = camera.secondary && camera.secondary !== "none" ? camera.secondary : "";
  if (type === "static" && !secondary) return "The camera remains static.";

  const bits = type === "static"
    ? [camPhrase(secondary)]
    : [camPhrase(type)];
  if (camera.amplitude && camera.amplitude !== "medium") bits.push(`with ${camera.amplitude} amplitude`);
  if (camera.speed && camera.speed !== "normal") bits.push(`at ${camera.speed} speed`);
  if (camera.target) bits.push(`toward ${determined(phrase(camera.target))}`);
  if (type !== "static" && secondary) {
    // The second move rides along: named, but without repeating amplitude and
    // speed, which belong to the shot's dominant motion.
    bits.push(`while ${CAMERA_GERUNDS[secondary] || camPhrase(secondary).replace(/^The camera /, "")}`);
  }
  return `${bits.join(" ")}.`;
}

/**
 * Dialogue in the model's own syntax.
 *
 * The guide is specific about what goes where (§4.4):
 *
 *   "When a speaker first appears, provide enough information from the visual
 *    and audio context to establish a stable identity, such as character type,
 *    age, gender, whether the person is on-screen, pitch, timbre, speaking
 *    rate, or accent. Place the speaker's identifying phrase, ID, action, and
 *    delivery outside <d>. Inside <d>, include only the language tag and the
 *    actual user-provided spoken content."
 *
 * So the shape is `<identity> (S1) <delivery>, <d>[Language] words</d>` —
 * "The young woman with a quiet, breathy voice (S1) says: …". This used to emit
 * a bare `(S1) says,` with no identity at all, which gives H3 nothing to build
 * a voice from and, in a two-person frame, nothing to tell it whose mouth to
 * move.
 *
 * The identity is stated at a speaker's FIRST appearance only — that is what
 * the guide scopes it to, and repeating it every shot spends the description's
 * length on bookkeeping.
 *
 * Nothing is added inside <d> and nothing is added after it. The guide:
 * "Preserve every original word and punctuation mark verbatim; do not translate
 * or rewrite them." Every worked example carries the sentence's terminal mark
 * INSIDE the tag, because that is the author's own punctuation; a `.` bolted on
 * after `</d>` appears in no example in either guide. If the author left the
 * line unpunctuated, that is what the checker is for — it is not this
 * function's business to put words in their mouth.
 */
/** The identifying phrase a speaker was introduced with, wherever it was. */
export function identityOf(project, speaker) {
  for (const sh of orderedShots(project)) {
    for (const l of sh.dialogue || []) {
      if ((l.speaker || "S1") === speaker && (l.identity || "").trim()) return shortIdentity(l.identity);
    }
  }
  /* No identifying phrase written: the subject is who is on screen, and
   * "the woman with short grey hair" is a person where "the speaker" is a
   * voice from nowhere. */
  const subject = expandTokens((orderedShots(project)[0]?.subject || "").trim());
  if (subject) return definite(shortIdentity(subject));
  return "the speaker";
}
/** "a woman in her forties" → "the woman in her forties". */
export const definite = (phrase) => String(phrase || "").replace(/^(a|an)\s+/i, "the ");
/** The identifier reused after a first appearance: the phrase up to its
 *  first comma, "and" or "in" clause — "the woman with short grey hair", not
 *  the whole introduction again. */
export function shortIdentity(identity) {
  const full = String(identity || "").trim().replace(/[.,;:]\s*$/, "");
  const cut = full.split(/,| and | in (?:her|his|their) | wearing | seated | standing /i)[0].trim();
  return cut || full;
}

export function dialogueSentence(line, opts = {}) {
  const text = (line.text || "").trim();
  if (!text) return "";
  const speaker = line.speaker || "S1";
  const lang = line.language || "English";
  // `first` defaults to true so every caller that does not track appearances
  // (the readthrough, the Sound page's preview) still shows the full form.
  const first = opts.first !== false;
  const identity = first ? (line.identity || "").trim().replace(/[.,;:]\s*$/, "") : "";
  const lead = identity ? `${identity} (${speaker})` : `(${speaker})`;

  /* LTX-2.5 (docs.ltx.io): exact words in quotes, the speaker and the voice
   * named in prose — "The man says in an excited voice: 'You won't believe
   * what I just saw!'" — no tags, no speaker ids. Mentioning speech without
   * the words makes the model invent lines, so the words are always there. */
  if (opts.ltx) {
    const who = identity || (opts.identityFallback || "the speaker");
    const voice = (line.voice || "").trim();
    const deliveryWord = (line.delivery || "").trim() || "says";
    const how = line.voiceover ? "in an off-screen voiceover" : voice ? `in ${/^(a|an|the)\b/i.test(voice) ? voice : `a ${voice}`}` : "";
    const clean = text.replace(/^["'“”]+|["'“”]+$/g, "");
    /* The period sits outside the quote so the sentence ends in one — the
     * joiner adds a stop to anything that does not, and a stop after a
     * closing quote is what produced ." ." */
    const quoted = `"${clean.replace(/[.]+$/, "")}"`;
    return `${who.charAt(0).toUpperCase()}${who.slice(1)} ${deliveryWord}${how ? ` ${how}` : ""}: ${quoted}.${line.voiceover ? " Their lips stay closed." : ""}`;
  }

  if (line.voiceover) {
    // §4.4: "For voiceover, use the exact phrase `says in an off-screen
    // voiceover`. Immediately after every voiceover <d> block, state that the
    // corresponding on-screen character's lips remain closed" — the guide's own
    // example joins the two with "while", not a semicolon.
    const whose = identity ? `${identity.replace(/^(the|a|an)\s+/i, "the ")}'s` : "their";
    return `${lead} says in an off-screen voiceover, <d>[${lang}] ${text}</d> while ${whose} lips remain completely closed.`;
  }
  const delivery = (line.delivery || "").trim() || "says";
  /* §4.4: "When the same line of dialogue or lyrics crosses a cut, use
   * <scenetrans> at the connecting points in both parts … Use <cutoff> when
   * speech is truncated by the end of the video." */
  const tail = line.continues ? " <scenetrans>" : line.cutoff ? " <cutoff>" : "";
  return `${lead} ${delivery}, <d>[${lang}] ${text}</d>${tail}`;
}

/* The other half of a line that crosses a cut: the tag again at the top of the
 * next shot, and a statement that the audio carries. The four phrasings are the
 * guide's own — "Continuity may be expressed with …" — and are cycled so a clip
 * with several carries does not repeat one sentence. */
const CONTINUITY = [
  "carries over from the previous shot",
  "continues seamlessly across the cut",
  "continues uninterrupted into the next shot",
  "remains audible across the transition",
];

/**
 * The counterpart `sentence()` never had.
 *
 * `sentence()` up-cases a fragment that is about to become a sentence. But
 * half this file does the opposite: it splices a field into the MIDDLE of a
 * sentence, behind a carrier phrase — "The setting is ", " of ", ", then ",
 * "toward ", "The ambience of ". A field written as a standalone sentence then
 * lands mid-clause with its capital and its full stop intact, and the model
 * reads exactly what a user pasted back to us:
 *
 *   "…with her hands clasped tightly at her chest, then She looks up…"
 *   "The setting is A dilapidated outdoor area…"
 *
 * Nothing in either guide contains a clause-opening capital mid-sentence.
 *
 * The de-capitalisation is deliberately narrow: only a closed-class opener,
 * never a proper noun. `expandTokens` substitutes cast entries straight into
 * these fields, so a blanket lower-case would turn "Anna looks up" into "anna
 * looks up" and "Paris at dusk" into "paris at dusk". A string that starts
 * with a tag or a speaker id is never touched at all.
 */
const CLOSED_OPENER = /^(the|a|an|his|her|its|their|there|this|that|these|those|she|he|they|it|both|one|two|someone|somebody)\b/;

function phrase(text) {
  let t = String(text || "").trim();
  if (!t) return "";
  if (/^[<(]/.test(t)) return t;              // <Picture 1>, (S1) — leave alone
  t = t.replace(/\.\s*$/, "");                 // a terminal stop, mid-sentence, is a break
  if (/^[A-Z]/.test(t) && CLOSED_OPENER.test(t.toLowerCase())) t = t[0].toLowerCase() + t.slice(1);
  return t;
}

function sentence(text) {
  let t = String(text || "").trim();
  if (!t) return "";
  // Fields are typed as fragments ("pours the water in a slow spiral") and read
  // back as sentences, so the first letter is fixed here rather than asking
  // every field to be capitalised by hand. Tags like <Picture 1> and speaker
  // ids like (S1) start with punctuation and are left exactly as written.
  if (/^[a-z]/.test(t)) t = t.charAt(0).toUpperCase() + t.slice(1);
  // A clause that ends in a dialogue span is already finished: its terminal
  // mark belongs inside the tag, where the author put it, and `</d>.` appears
  // nowhere in either guide. The same goes for the two continuity markers,
  // which are tags rather than words.
  if (/<\/d>$|<scenetrans>$|<cutoff>$/.test(t)) return t;
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

function joinSentences(parts) {
  return parts.map(sentence).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

const article = (word) => (/^[aeiou]/i.test(word || "") ? "an" : "a");

/** Action beats, joined the way the guide joins them: chronological, linked
 *  with "then" / "as" / "while" rather than piled into one sentence. The first
 *  beat carries the main action — the guide is explicit that the opening
 *  sentence is what the model anchors on. */
/* A leading connective in the beat's own text, which the join is about to add
 * again. Models write beats as "then turns toward the window" however firmly
 * they are asked for a bare clause, and the result was "…, then then turns
 * toward the window" in the description the render model reads. */
const LEADING_LINK = /^(and\s+then|and|then|next|after\s+that|as|while|before|after|so)\s+/i;

/* The connective the creator wrote is the connective they meant: "as the rain
 * thickens" is concurrent and "then she turns" is sequential, and throwing the
 * word away to avoid the stutter would quietly change what the shot says. So
 * the word is MOVED into the link rather than deleted — the join then uses it
 * once instead of adding a second one in front of it. */
const adoptLink = (b) => {
  const text = (b.text || "").trim();
  const m = LEADING_LINK.exec(text);
  if (!m) return { ...b, text };
  const word = m[1].toLowerCase().replace(/\s+/g, " ");
  return { ...b, text: text.slice(m[0].length).trim(), link: word === "and" ? "then" : word };
};

export function beatsProse(shot) {
  // A beat that opens with a cut phrase is compiled without it: a cut is a
  // shot, and a "Cut to" inside a beat is a second cut the model performs.
  const beats = (shot?.beats || []).map(adoptLink).map(b => ({ ...b, text: stripCutPrefix(b.text || "") })).filter(b => b.text);
  if (!beats.length) return "";
  let out = beats[0].text;
  for (const beat of beats.slice(1)) {
    const link = beat.link === "" ? "." : beat.link || "then";
    const body = beat.text.replace(/^[.,;]\s*/, "");
    out = link === "."
      // A full stop between beats starts a new sentence, so the next one is
      // capitalised — the mirror of the bug below, and just as wrong.
      ? `${sentence(out)} ${sentence(body)}`
      : `${out.replace(/[.]\s*$/, "")}, ${link} ${phrase(body)}`;
  }
  return out;
}

/**
 * One shot, as the model wants to read it.
 *
 * Shot 1 carries the overall style and the initial composition (the guide is
 * explicit about that), every later shot opens with its cut time and an
 * approved cut verb. Shot type and viewpoint are woven into the prose rather
 * than tagged on, because tags are exactly what an LLM encoder dilutes.
 */
/** LTX re-establishes the subject at every cut, but "a woman in her forties"
 *  again is a second woman to it. The same subject as shot 1 comes back as
 *  "the same woman in her forties…" — an identifier reused, as the guide asks. */
function ltxSubjectRef(subject, project) {
  const first = expandTokens((orderedShots(project)[0]?.subject || "").trim());
  const same = first && first.replace(/[.,;]\s*$/, "").toLowerCase() === subject.replace(/[.,;]\s*$/, "").toLowerCase();
  if (!same || !/^(a|an)\s+/i.test(subject)) return phrase(subject);
  /* The identifier, not the whole description. Shot 1 said the coat, the
   * boots and the hair; "the same lighthouse keeper" is the guide's reused
   * identifier, and repeating the full sentence at every cut was a third of
   * a four-shot prompt spent re-reading shot 1. */
  const tag = subject.replace(/[.,;]\s*$/, "").split(/,| wearing | holding | carrying | with (?:a|an|her|his|their|short|long)\b/i)[0].trim() || subject;
  return `the same ${phrase(tag).replace(/^(a|an)\s+/i, "")}`;
}

/** How many plain hard cuts precede shot `index` — dissolves, fades and
 *  same-take rows do not count, they are not hard cuts. */
function hardCutsBefore(project, index) {
  const shots = orderedShots(project);
  let n = 0;
  for (let i = 1; i < index && i < shots.length; i++) {
    const v = shots[i].cutVerb || "the camera cuts to";
    if (v === NO_CUT || /dissolve|fade|transitions/i.test(v)) continue;
    n++;
  }
  return n;
}

export function shotProse(shot, index, project, opts = {}) {
  const first = index === 0;
  /* Which speakers have already been introduced. A caller with no shot list —
   * the node view's per-shot preview — passes nothing and every line reads as
   * a first appearance, which is what you want when looking at one shot. */
  const seen = opts.seen || new Set();
  const look = (project.style?.look || "live-action cinematic").trim();
  const shotType = shot.shotType || "medium";
  /* LTX reads the guide's prose — "a medium close-up of her face", "a
   * low-angle shot of a man's boots" — where only an angle worth naming is
   * named. The default angle stamped on every shot gave it "a medium shot,
   * front-facing of the white foam of the ocean waves". */
  const isLtx = activeEngine(project) === "ltx25";
  const viewpoint = (shot.viewpoint || "front-facing") === "front-facing" && isLtx ? "" : (shot.viewpoint || "front-facing");
  const subject = expandTokens((shot.subject || "").trim());
  const action = expandTokens(beatsProse(shot));
  const setting = expandTokens((shot.setting || "").trim());

  /* Where the style goes differs by mode, and the guide is explicit about it.
   * Base §4.1: "At the beginning of [Shot 1], state the overall style and
   * initial composition." Ref §5.2's table: full-reference mode establishes the
   * style "in one or two English sentences before [Shot 1]" instead — and its
   * complete example opens exactly that way. */
  const styleInHead = first && opts.styleAhead !== true;
  const opening = first
    ? (styleInHead
        ? `${article(look)} ${look} ${shotType} shot${viewpoint ? `, ${viewpoint}` : ""}`
        : `${article(shotType)} ${shotType} shot${viewpoint ? `, ${viewpoint}` : ""}`)
    : continuesTake(shot, index)
      ? `without a cut, the camera reframes to ${article(shotType)} ${shotType} shot${viewpoint ? `, ${viewpoint}` : ""}`
      : `${cutVerbFor(shot.cutVerb, activeEngine(project), hardCutsBefore(project, index))} ${article(shotType)} ${shotType} shot${viewpoint ? `, ${viewpoint}` : ""}`;

  /* I2V opens FROM the picture. §3.1: "The description should first establish
   * the style, subjects, composition, and scene anchors in the image, then
   * describe the next action. Character identity, clothing, colors, key objects
   * and spatial relationships should remain consistent." Case 2 does it in one
   * clause: "the young woman shown in <Picture 1> remains beside the
   * rain-covered train window, preserving her appearance, clothing, seat
   * position, and the carriage layout."
   *
   * The app emitted the mandated alignment line and then never mentioned the
   * picture again, so the only thing tying the render to the image was one line
   * of bookkeeping. Skipped when the creator has already cited the tag
   * themselves — two mentions of <Picture 1> is worse than one. */
  const anchors = first && project.mode === "i2v" && project.frames?.first
    && !`${subject} ${action} ${setting}`.includes("<Picture 1>");
  const ltx = activeEngine(project) === "ltx25";
  // LTX has no <Picture N> label; the guide simply wants the opening image
  // matched exactly, so the anchor names it in plain words.
  const anchored = anchors && subject ? `${phrase(subject)}, shown in ${ltx ? "the opening image" : "<Picture 1>"}` : phrase(subject);

  /* What is different about the subject now.
   *
   * The head repeats the subject line at every cut, because that is what the
   * guide asks for — a cut "should introduce new information about the
   * subject, space, state, viewpoint, or time", and the model has no memory
   * across one. But repeating it VERBATIM re-asserts the opening state, and
   * the model believes the most recent description: a coat taken off in shot 2
   * is back on in shot 3, because shot 3's own head still says the subject is
   * wearing it. §3.1 names exactly these fields as the ones that have to stay
   * straight — "character identity, clothing, colors, key objects, and spatial
   * relationships".
   *
   * So the amendment goes immediately after the stale clause it corrects,
   * which is the only position where it reliably wins. Shot 1 has nothing to
   * differ from and never gets one. */
  const changed = first ? "" : expandTokens((shot.continuity || "").trim());
  const head = first
    ? `${opening.charAt(0).toUpperCase()}${opening.slice(1)}${subject ? `: ${anchored}` : ""}`
    : ltx
      /* Lightricks: no timestamps, no shot numbers — the cut is named in
       * prose and the new shot re-established (scale, angle, subject). */
      ? `${opening.charAt(0).toUpperCase()}${opening.slice(1)}${subject ? ` of ${ltxSubjectRef(subject, project)}` : ""}${changed ? `, now ${phrase(changed)}` : ""}`
      : `At ${shotTime(shot.at || 0)}, ${opening}${subject ? ` of ${phrase(subject)}` : ""}${changed ? `, now ${phrase(changed)}` : ""}`;
  /* "State audio continuity explicitly" at every cut — the guide's own
   * example: "the piano score continues across the cut". */
  const audioAcross = ltx && !first && !continuesTake(shot, index) && !project.sound?.silent
    ? (project.sound?.musicOff || !(project.sound?.music || "").trim()
        ? "The ambient sound continues across the cut."
        : "The ambient sound and the score continue across the cut.")
    : "";

  /* Order matters, because this IS the timeline the model reads.
   *
   * §3.1: "The description should first establish the style, subjects,
   * composition, and scene anchors in the image, then describe the next
   * action." §4.3: camera motion is "a natural English action within the shot,
   * rather than stacked as separate labels at the end of a sentence", and all
   * four worked cases put the camera sentence second, never after the beats.
   *
   * This used to run the action third — so the model was told the woman sobbed
   * before it was told where she was standing, and the camera move was
   * described after the action it was carrying. Scene, light and camera are
   * conditions the shot opens in; the beats are what happens next. */
  const body = [
    head,
    audioAcross,
    // What the first frame fixes, said once, where the model reads it.
    anchors ? `The opening preserves the appearance, clothing and spatial arrangement established in ${ltx ? "the opening image" : "<Picture 1>"}.` : "",
    framingSentence(shot.camera, shotType),
    setting ? (/^(in|on|at|inside|outside|under|behind|beside)\b/i.test(setting) ? sentence(setting) : `The setting is ${phrase(setting)}.`) : "",
    shot.lighting,
    first && styleInHead ? project.style?.grade : "",
    first && styleInHead ? expandTokens(project.style?.extra) : "",
    cameraSentence(shot.camera),
    action,
    expandTokens(shot.details),
    ...(shot.dialogue || []).map((line) => {
      const spk = line.speaker || "S1";
      const firstTime = !seen.has(spk);
      if ((line.text || "").trim()) seen.add(spk);
      /* LTX reuses the speaker's identifier at every line — the guide asks
       * for recurring elements to keep their visual identifiers across cuts,
       * and a bare "the speaker" would be a new person to it. */
      return dialogueSentence(line, { first: firstTime, ltx, identityFallback: ltx ? identityOf(project, spk) : null });
    }),
    shot.sfx,
  ];

  /* A row that continues the take has no marker: it is the rest of the
   * previous block, and compileDescription joins it on. */
  if (continuesTake(shot, index) || ltx) return joinSentences(body).trim();
  return `[Shot ${opts.marker || index + 1}] ${joinSentences(body)}`.trim();
}

/**
 * The whole video, as one field.
 *
 * Every shot keeps its [Shot N] marker, including a clip that has only one.
 * This used to strip it, on the theory that the marker was multi-shot syntax —
 * it is not. Ref §5.1: "[Shot 1] marks the opening shot and has no timestamp."
 * Base §2.2 gives the field template as `integrated_multimodal_description:
 * [Shot 1] ...`, §4.1 says "At the beginning of [Shot 1], state the overall
 * style and initial composition", and Cases 2, 3 and 4 are all single shots
 * that keep it — Case 3's own preamble reads "The following example is an
 * eight-second single shot."
 *
 * The strip also made the app contradict itself out loud: I2VA's mandated
 * first line is "… <Picture 1> (from [Shot 1]) is fully referenced." pointing
 * at a label the next line had just deleted.
 */
export function compileDescription(project) {
  if (project.prompt?.manual && project.prompt.description?.trim()) return expandTokens(project.prompt.description.trim());
  const shots = orderedShots(project);
  /* A speaker is introduced once. §4.4 scopes the identifying phrase to "when
   * a speaker first appears", and the only place that can be known is here,
   * where the whole shot list is in hand — shotProse sees one shot at a time. */
  const seen = new Set();
  const styleAhead = project.mode === "r2v";
  const markers = shotMarkers(shots);
  const parts = shots.map((s, i) => shotProse(s, i, project, { seen, styleAhead, marker: markers[i] }));
  /* A line flagged as crossing the cut needs its second half at the head of the
   * following shot. Only compileDescription can do that — shotProse sees one
   * shot at a time, which is why this was unrepresentable. */
  let carried = 0;
  shots.forEach((s, i) => {
    if (i + 1 >= parts.length) return;
    for (const line of s.dialogue || []) {
      if (!line.continues || !(line.text || "").trim()) continue;
      /* Appended, not prepended: the next shot opens "[Shot 2] At 00:05.000,
       * the camera cuts to …" and that opening is a fixed format. Case 1 hangs
       * the continuity on the end of the shot's clause for the same reason. */
      const how = CONTINUITY[carried++ % CONTINUITY.length];
      /* After the shot's opening clause, which is where Case 1 puts it — not at
       * the end, where it would read as happening after everything else in the
       * shot including any line the clip cuts off. */
      const carry = activeEngine(project) === "ltx25"
        ? `The line ${how}.`
        : `<scenetrans> The line from (${line.speaker || "S1"}) ${how}.`;
      parts[i + 1] = /\.\s/.test(parts[i + 1])
        ? parts[i + 1].replace(/\.\s/, `. ${carry} `)
        : `${parts[i + 1]} ${carry}`;
    }
  });
  const body = parts.join(" ");
  if (!styleAhead) return body;
  /* Ref §5.2: the style is established before [Shot 1] in full-reference mode.
   * Its own example: "The target video uses a realistic multi-camera sitcom
   * style with warm indoor lighting." */
  const look = (project.style?.look || "live-action cinematic").trim();
  const grade = (project.style?.grade || "").trim();
  const extra = expandTokens((project.style?.extra || "").trim());
  const lead = sentence([`The target video is in ${article(look)} ${look} style`, phrase(grade)].filter(Boolean).join(", "));
  return [lead, extra ? sentence(extra) : "", body].filter(Boolean).join(" ");
}

/** I2V's keyframe-alignment instruction — the first line, then a blank one.
 *  Verbatim from the guide: the anchor is stated in seconds with two decimals
 *  and names the shot the picture belongs to. */
export function alignmentLine(project) {
  if (project.mode !== "i2v" || !project.prompt?.alignKeyframe) return "";
  if (!project.frames?.first) return "";
  return "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.";
}

export function compileSoundscape(project) {
  if (project.sound?.silent) return "N/A";
  return expandTokens((project.sound?.soundscape || "").trim()) || "N/A";
}

export function compileMusic(project) {
  if (project.sound?.musicOff) return "N/A";
  return expandTokens((project.sound?.music || "").trim()) || "N/A";
}

/** Which shots actually name a tag. retention_analysis wants it — the guide's
 *  entry shape is "<Subject 1> (appears in [Shot 1], [Shot 3]): fully_preserved
 *  - …" — and it is also the only honest answer to "where is this used". */
/** Which [Shot N] marker each timeline row falls under. A row that continues
 *  the previous take (cutVerb "none") has no marker of its own — it is part
 *  of the block before it — so markers count cuts, not rows. */
export function shotMarkers(shots) {
  let n = 0;
  return shots.map((s, i) => (i === 0 || s.cutVerb !== NO_CUT) ? ++n : n);
}
export const continuesTake = (shot, index) => index > 0 && shot?.cutVerb === NO_CUT;

function shotsCiting(project, tag) {
  if (!tag) return [];
  const shots = orderedShots(project);
  const markers = shotMarkers(shots);
  return [...new Set(shots
    .map((shot, i) => {
      const hay = [shot.subject, shot.setting, shot.details, shot.sfx, shot.lighting,
        ...(shot.beats || []).map(b => b.text)].join(" ");
      return hay.includes(tag) ? markers[i] : 0;
    })
    .filter(Boolean))];
}

/**
 * retention_analysis — how each reference is preserved, transferred or reused.
 *
 * ONE LINE PER LABEL, which is what the guide shows and what this used to
 * flatten into a single semicolon-joined string. That mattered for more than
 * neatness: a semicolon inside somebody's note was indistinguishable from an
 * entry boundary.
 *
 * The markers are a closed vocabulary — "fixed English values in the output
 * format" — and the visual set and the audio set are different lists.
 */
export function compileRetention(project) {
  const inv = referenceInventory(project);
  if (!inv.length) return "";
  return inv.map(entry => {
    // A reference video contributes two tags — its frames and its soundtrack —
    // and they take markers from different vocabularies. The clip's own audio
    // defaults to "reference" (match its character) rather than the lip-sync
    // "fully_copy" that a standalone upload usually wants.
    const isVideoAudio = entry.kind === "audio" && entry.fromVideo;
    const fallback = entry.kind !== "audio" ? "fully_preserved" : isVideoAudio ? "reference" : "fully_copy";
    const marker = (isVideoAudio ? entry.ref?.audioRetention : entry.ref?.retention) || fallback;
    const note = (entry.ref?.note || "").trim();
    // Where it appears. Audio has no on-screen appearance to report, and the
    // guide's audio entries carry none.
    const where = entry.kind === "audio" ? "" : (() => {
      const shots = shotsCiting(project, entry.tag);
      return shots.length ? ` (appears in ${shots.map(n => `[Shot ${n}]`).join(", ")})` : "";
    })();
    return `${entry.tag}${where}: ${marker}${note ? ` - ${note.replace(/\s*[;\n]+\s*/g, ", ")}` : ""}`;
  }).join("\n");
}

/**
 * The task-type prefix on `summary`, derived from what is actually attached.
 *
 * Ref §3 gives six values and combines them with " + ". Deriving beats asking:
 * "the mere presence of video or audio does not automatically create a
 * corresponding task type", and the distinctions turn on how each asset is
 * being used — which the app already knows from the retention markers.
 */
export function taskTypeFor(project) {
  const override = (project.ref2v?.taskType || "").trim();
  if (override) return override;
  const inv = referenceInventory(project);
  const types = [];
  // An image that anchors a concrete frame completes a keyframe; an image that
  // defines a person or a place guides generation.
  if (inv.some(e => e.kind === "picture")) types.push("reference generation");
  if (project.frames?.first) types.push("keyframe completion");
  if (inv.some(e => e.kind === "video")) {
    // §3: a reference video that only supplies motion, cuts or rhythm is
    // reference generation, not editing. The app never edits a source video.
    if (!types.includes("reference generation")) types.push("reference generation");
  }
  const audio = inv.filter(e => e.kind === "audio");
  if (audio.length) {
    const copied = audio.some(e => {
      const m = (e.fromVideo ? e.ref?.audioRetention : e.ref?.retention) || (e.fromVideo ? "reference" : "fully_copy");
      return m === "fully_copy" || m === "partially_copy";
    });
    types.push(copied ? "audio reuse" : "audio reference");
  }
  return types.length ? [...new Set(types)].join(" + ") : "reference generation";
}

/**
 * subject_definitions — what each label denotes, one per line.
 *
 * This is the line that binds a subject to the file behind it: "<Subject 1> is
 * the young woman in <Picture 1>, with long dark hair, a blue cardigan…". The
 * app can only supply the binding and whatever the creator named the file; the
 * features are theirs to write, which is what the Cast sheet is for and what
 * the placeholder there now shows.
 */
export function compileSubjectDefs(project) {
  const written = (project.ref2v?.subjectDefs || "").trim();
  if (written) return written;
  const inv = referenceInventory(project);
  if (!inv.length) return "";
  return inv.map(e => {
    const name = (e.ref?.label || e.ref?.name || "").replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim();
    if (e.kind === "picture") {
      // §2.1's shape: the subject, then the asset it comes from.
      return `${e.tag} is the subject shown in ${e.source}${name ? `, ${name}` : ""}.`;
    }
    if (e.kind === "video") return `${e.tag} is a reference clip${name ? ` of ${name}` : ""}, used for its motion and structure.`;
    return `${e.tag} is ${e.fromVideo ? `the synchronized audio track of <Video ${e.index + 1}>` : `a reference audio clip${name ? ` of ${name}` : ""}`}.`;
  }).join("\n");
}

/**
 * summary — one short paragraph naming the subjects and the shot flow.
 *
 * It used to be the first 220 characters of the description, which cut off
 * mid-word and, on a clip with speech, could truncate inside a <d> tag and
 * leave an unclosed one in the prompt. The guide asks for a summary that "uses
 * the previously defined labels to describe the main subjects, shot flow, and
 * roles of the reference assets" — so that is what is built.
 */
export function compileSummary(project) {
  const written = (project.ref2v?.summary || "").trim();
  const prefix = `[${taskTypeFor(project)}]`;
  if (written) return `${prefix} ${written}`;

  const inv = referenceInventory(project);
  const subjects = inv.filter(e => e.kind === "picture").map(e => e.tag);
  const clips = inv.filter(e => e.kind === "video").map(e => e.tag);
  const audio = inv.filter(e => e.kind === "audio").map(e => e.tag);
  const shots = orderedShots(project);
  const list = (a) => (a.length > 1 ? `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}` : a[0] || "");

  const bits = [];
  if (subjects.length) bits.push(`The target video features ${list(subjects)}`);
  else bits.push("The target video is generated from the references below");
  bits[0] += shots.length > 1 ? ` across ${shots.length} shots.` : " in a single shot.";
  if (clips.length) bits.push(`${list(clips)} supplies the motion and structure it follows.`);
  if (audio.length) bits.push(`${list(audio)} is used for its audio.`);
  return `${prefix} ${bits.join(" ")}`;
}

/**
 * The finished prompt, plus every field on its own so the UI can show, count
 * and colour them separately.
 */
export function compilePrompt(project) {
  const description = compileDescription(project);
  const soundscape = compileSoundscape(project);
  const music = compileMusic(project);
  const fields = [];

  if (project.mode === "r2v" && project.ref2v?.useFullIR) {
    const defs = compileSubjectDefs(project);
    const retention = compileRetention(project);
    if (defs) fields.push(["subject_definitions", defs]);
    fields.push(["summary", compileSummary(project)]);
    if (retention) fields.push(["retention_analysis", retention]);
    fields.push(["detailed_description", description]);
  } else if (project.mode === "r2v") {
    fields.push(["detailed_description", description]);
  } else {
    fields.push(["integrated_multimodal_description", description]);
  }
  fields.push(["overall_soundscape", soundscape]);
  fields.push(["non_diegetic_music", music]);

  /* LTX-2.5 reads one chronological paragraph (docs.ltx.io, "Multi-shot
   * prompts"): no field labels, no alignment line, the sound described in
   * prose at the end. The fields are still returned for the library. */
  if (activeEngine(project) === "ltx25") {
    const sound = soundscape !== "N/A" ? sentence(`Ambient sound throughout: ${soundscape}`) : (project.sound?.silent ? "There is no ambient sound." : "");
    const score = music !== "N/A" ? sentence(`A non-diegetic score: ${music}`) : "";
    const text = [description, sound, score].filter(Boolean).join(" ");
    return { text, fields: Object.fromEntries(fields), align: "", description, soundscape, music, dialect: "ltx25" };
  }

  const align = alignmentLine(project);
  /* A blank line between the fields. §2.2's template has them, all four cases
   * have them, and the reference guide's complete example has them — a field
   * whose value is several lines long (subject_definitions, retention_analysis)
   * runs into the next field's name without one. */
  const text = [align, align ? "" : null, fields.map(([k, v]) => `${k}: ${v}`).join("\n\n")]
    .filter(v => v !== null)
    .join("\n")
    .replace(/^\n+/, "");

  return { text, fields: Object.fromEntries(fields), align, description, soundscape, music };
}

/* ── Word budgets ─────────────────────────────────────────────
 * There is NO minimum in the base guide. The number that used to be here —
 * "150–220, the rewriter's own target" — existed nowhere but this app quoting
 * itself, and all four of MiniMax's canonical examples are shorter than it:
 * Case 1 is 85 words, Case 2 is 81, Case 3 is 93, Case 4 is 98. The checker was
 * warning about the format it is supposed to be enforcing.
 *
 * The reference guide DOES state a range — "normally 350-500 English words"
 * (§5.2) — and it comes with its own carve-out: "Dialogue-dense content
 * prioritizes fitting the complete spoken timeline rather than mechanically
 * reaching a word count." So the floor is dropped once a clip has speech. */
export function wordBudget(project) {
  return project?.mode === "r2v" ? { min: 350, max: 500 } : { min: 0, max: 500 };
}

/* ── Validation ───────────────────────────────────────────── */

const BANNED_OPENERS = [/^the scene opens/i, /^we see\b/i, /^the video (shows|opens|begins)/i, /^the camera shows/i, /^this (video|shot|clip)/i];
const BOORU = /\b(masterpiece|best quality|8k|4k uhd|highly detailed|ultra[- ]?detailed|award[- ]winning)\b/i;
const INTENSIFIERS = /\b(very|extremely|incredibly|vibrant|stunning|breathtaking|gorgeous|amazing|perfect|beautifully)\b/i;
/* "without" is deliberately NOT here. The reference guide's own worked example
 * reads "performs the corresponding hand gesture without becoming a separate
 * speaker source" — the clause whose entire job is to stop the model inventing
 * a speaker. Linting it was this app inventing a rule and then enforcing it
 * against the guide it claims to follow. */
const NEGATIONS = /\b(no |not |never |avoid |don't |doesn't |isn't )/i;
/* §4.7 bans two things in non_diegetic_music specifically, and neither is
 * covered by the general intensifier lint: an abstract mood, and an explanation
 * of what the score is for. Both read as good prose and neither tells the model
 * a single thing to play. */
const MOOD_WORDS = /\b(epic|emotional|melancholy|melancholic|haunting|uplifting|tense|dramatic|somber|sombre|moody|ethereal|triumphant|ominous|whimsical|nostalgic)\b/i;
/* Transitive only. "A sparse underscore" is the name of a piece of music and is
 * fine; "strings that underscore her isolation" is an explanation of what the
 * music is for, which is the thing §4.7 rules out. */
const SCORE_FUNCTION = new RegExp(
  "\\b(?:"
  + "(?:conveys|convey|captures|capture|evokes|evoke|heightens|heighten|mirrors|mirror|reflects|reflect|reinforces|reinforce|underscores|underscoring|underscore|emphasises|emphasizes)"
  + "\\s+(?:her|his|their|its|the|a|an)\\b"
  + "|to\\s+(?:build|create|convey|heighten)\\s+(?:a\\s+)?(?:sense|feeling|mood|tension)"
  + "|(?:sense|feeling)\\s+of\\s+(?:dread|unease|loss|longing|hope|wonder)"
  + ")", "i");

/**
 * Everything the editor can check before a single GPU second is spent.
 * Errors block nothing — the render button still works — but Deliver shows the
 * count, because most bad clips are bad prompts and this is where that is
 * cheapest to notice.
 */
/* ── The cast ──────────────────────────────────────────────
 * A recurring subject written once and referred to as @anna everywhere. The
 * point is not typing speed: it is that the SAME words describe her in every
 * shot and every project, which is most of what identity consistency is on a
 * model with no character memory.
 *
 * Injected like the house rules, so the compiler stays a pure function. */
let castList = [];
export function setCast(list) { castList = Array.isArray(list) ? list : []; }
export const getCast = () => castList;

export const castSlug = (name) => String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Replace @slug with what it stands for. Unknown tokens are left alone —
 *  an email address in a prompt should survive, and a typo should be visible
 *  rather than silently deleted. */
export function expandTokens(text) {
  if (!text || !castList.length) return text || "";
  return String(text).replace(/@([a-z0-9][a-z0-9-]{1,40})/gi, (whole, slug) => {
    const entry = castList.find(c => castSlug(c.name) === slug.toLowerCase());
    return entry?.text ? entry.text.trim() : whole;
  });
}

/* House rules, injected by the app once the rulebook has loaded. The checker
 * stays a pure function of (project, rules) — the fetching happens elsewhere. */
let houseRules = [];
export function setHouseRules(rules) { houseRules = Array.isArray(rules) ? rules : []; }
export const getHouseRules = () => houseRules;

/**
 * The wording lints, as their own exported function.
 *
 * Pulled out of validate() so a test can run them over MiniMax's OWN canonical
 * examples — the four cases in the base guide and the complete example in the
 * reference guide. Any lint that fires on those is not a rule the model has;
 * it is a rule this app invented, and it is steering creators away from the
 * format the encoder was trained on. That test has already deleted two.
 */
export function lintWording(description, project) {
  const out = [];
  const desc = String(description || "");
  // The shot marker is part of the format, not part of the prose. Every banned
  // opener is ^-anchored, so leaving the marker on silently disables all of
  // them the moment single-shot projects keep theirs.
  /* What these lints are ABOUT is the prompt's prose. Two spans in it are not
   * prose and must be exempt:
   *
   *   <d>…</d> is somebody's dialogue, preserved "verbatim; do not translate or
   *   rewrite them" — people say "I didn't" and "no", and warning an author
   *   about a negation inside a line of speech is telling them to rewrite the
   *   one thing the guide says never to rewrite.
   *
   *   "…" is on-screen text (§4.5), preserved for the same reason.
   *
   * They are blanked rather than deleted so nothing either side of them runs
   * together into a word that was never written. */
  const prose = desc
    .replace(/^\[Shot \d+\]\s*/, "")
    .replace(/<d>[\s\S]*?<\/d>/g, " ")
    .replace(/"[^"\n]{0,200}"/g, " ")
    .trim();
  const budget = wordBudget(project);
  const count = words(desc);

  /* The floor is dropped for anything with speech in it, which is the guide's
   * own carve-out: "Dialogue-dense content prioritizes fitting the complete
   * spoken timeline rather than mechanically reaching a word count." Tested on
   * the reference guide's complete example, which is 326 words against a
   * stated range of 350-500 — the guide does not meet its own floor when there
   * is dialogue, and says so. */
  const speaks = /<d>/.test(desc);
  if (budget.min && !speaks && count < budget.min) {
    out.push(`Description is ${count} words; this mode reads best at ${budget.min}–${budget.max}.`);
  } else if (count > budget.max * 1.15) {
    out.push(`Description is ${count} words, well past the ${budget.max}-word target — later detail tends to get dropped.`);
  }
  for (const re of BANNED_OPENERS) {
    if (re.test(prose)) { out.push("The description opens with a narration phrase (\"we see…\", \"the scene opens…\"). Open on the action itself."); break; }
  }
  if (BOORU.test(prose)) out.push("Quality tags (\"masterpiece\", \"8k\", \"highly detailed\") are placebo on an LLM text encoder and push toward a digital-art look.");
  if (INTENSIFIERS.test(prose)) out.push("Intensifiers destabilise this encoder — \"red dress\", not \"vibrant red dress\".");
  // Negations are linted outside full-reference mode only. The reference
  // guide's own example sentence — "performs the corresponding hand gesture
  // WITHOUT becoming a separate speaker source" — is the sentence that stops
  // the model inventing an extra speaker, and warning about it is backwards.
  if (project?.mode !== "r2v" && NEGATIONS.test(prose)) {
    out.push("Negations tend to summon the thing they name. State what SHOULD be in frame.");
  }
  if (/\b(talks|talking|speaks|speaking|chats|converses)\b/i.test(desc) && !/<d>/.test(desc)) {
    out.push("Speech is mentioned without quoted words — the model will invent dialogue. Add a line on the Sound page, or drop the mention.");
  }
  return out;
}

export function validate(project) {
  const out = [];
  const add = (level, msg, extra = {}) => out.push({ level, msg, ...extra });

  // An untouched timeline is not a broken one. Reporting "1 error" before the
  // user has typed anything trains people to ignore the counter, which is the
  // one thing it must not do.
  if (isPristine(project)) {
    return {
      checks: [{ level: "ok", msg: "Nothing written yet. Start with an idea and Auto-shots, a template, or just type into the inspector." }],
      errors: 0, warnings: 0, pristine: true,
      wordCount: 0, budget: wordBudget(project),
    };
  }

  const compiled = compilePrompt(project);
  const shots = orderedShots(project);
  const duration = project.render?.duration || 5;
  /* In a film the timeline runs for film.seconds and render.duration is only
   * the length of ONE clip — so every measurement below that asks "where does
   * this end" has to ask filmSpan, or the second half of a film reads as
   * cutting past a clip it was never part of. */
  const isFilm = !!project.film?.enabled;
  const span = filmSpan(project);
  const budget = wordBudget(project);
  const count = words(compiled.description);
  const mode = MODES[project.mode];

  /* — Structure — */
  if (!shots.length) add("err", "The timeline has no shots.");
  const withText = shots.filter(s => shotActionText(s) || (s.subject || "").trim());
  if (!withText.length) add("err", "No shot describes anything yet — a subject and one action beat are the minimum.");

  let prev = -1;
  shots.forEach((s, i) => {
    const at = s.at || 0;
    if (i === 0 && at !== 0) add("warn", "Shot 1 must start at 0.000 — it is pinned there on export.");
    if (i > 0) {
      if (at <= prev) add("err", `Shot ${i + 1} cuts at ${shotTime(at)}, which is not after Shot ${i}. Cut times must strictly increase.`);
      if (at >= span) add("err", `Shot ${i + 1} cuts at ${shotTime(at)}, past the ${span}s ${isFilm ? "film" : "clip"}. It will never be reached.`);
      const gap = at - prev;
      if (gap > 0 && gap < 2) add("warn", `Shot ${i} only lasts ${gap.toFixed(1)}s. H3 renders roughly one action beat per 2–3s — shorter shots tend to blur together.`);
    }
    prev = at;
  });
  // One action beat per 2–3 seconds is the model's actual throughput; more
  // than that and beats silently drop out of the render.
  shots.forEach((s, i) => {
    const end = i + 1 < shots.length ? shots[i + 1].at : span;
    const len = end - (s.at || 0);
    const n = (s.beats || []).filter(b => (b.text || "").trim()).length;
    if (n > Math.max(1, Math.ceil(len / 2))) {
      add("warn", `Shot ${i + 1} packs ${n} beats into ${len.toFixed(1)}s. H3 renders about one beat per 2–3s — the later ones tend to be dropped.`);
    }
  });

  /* A cut inside a beat. "Cut to medium shot, the camera glides…" as a beat
   * is a second cut the model performs inside the shot — a four-shot
   * timeline rendered seven. The phrase is dropped from the prompt; the
   * timeline is where a cut belongs. */
  shots.forEach((s, i) => {
    const n = (s.beats || []).filter(b => cutInBeat(b.text || "")).length;
    if (n) add("warn", `Shot ${i + 1} has ${n} beat${n === 1 ? "" : "s"} that begin${n === 1 ? "s" : ""} with a cut ("Cut to …"). A cut is a shot, not an action: the phrase is left out of the prompt and the beat reads as what follows it. To cut there, add a shot with ✂ instead.`);
  });

  /* A shot heading inside a beat. "Wide low-angle shot of the tower as rain
   * hammers down" as a beat of a medium shot is a second shot described
   * inside the first — the model cannot cut to it (no cut is named) and
   * cannot hold the medium either, so it blends the two. The size and angle
   * belong to the shot's own fields; the beat is what happens in it. */
  shots.forEach((s, i) => {
    const heads = (s.beats || []).filter(b => !cutInBeat(b.text || "") && SHOT_HEADING_RE.test((b.text || "").trim()));
    if (heads.length) add("warn", `Shot ${i + 1} has a beat that reads as a shot heading ("${heads[0].text.trim().slice(0, 40)}…"). A shot's size and angle live in its own Shot and Angle fields; a heading inside a beat is a second shot the model blends into this one. Make it a shot with ✂, or cut the heading and keep the action.`);
  });

  /* Speech has a speed. A shot holding more words than its seconds carry is
   * rushed on screen — the mouth and the body hurry to fit it — or cut off. */
  {
    const total = shots.reduce((n, s) => n + (s.dialogue || []).reduce((m, l) => m + speechWords(l.text), 0), 0);
    const need = total / WORDS_PER_SECOND;
    if (total && need > span + 3) {
      add("warn", `${total} words of speech need about ${Math.ceil(need)}s at a spoken pace; the ${isFilm ? "film" : "clip"} is ${span}s. Trim the lines${activeEngine(project) === "ltx25" && !isFilm && span < LTX25_DURATION.max ? `, or make it ${Math.min(LTX25_DURATION.max, Math.ceil(need / 5) * 5)}s` : ""}.`);
    }
  }
  shots.forEach((s, i) => {
    const words = (s.dialogue || []).reduce((n, l) => n + speechWords(l.text), 0);
    if (!words) return;
    const secs = Math.max(0, ((i + 1 < shots.length ? shots[i + 1].at : span) - (s.at || 0)));
    const fit = Math.floor(secs * WORDS_PER_SECOND);
    if (words > fit + 3) add("warn", `Shot ${i + 1} carries ${words} words of speech in ${secs.toFixed(1)}s — about ${fit} fit at a spoken pace (≈${WORDS_PER_SECOND} words a second). The rest is rushed, and a rushed talking head jerks. Spread the line over more shots, or give this one more seconds.`);
  });

  const last = shots.length ? span - (shots[shots.length - 1].at || 0) : span;
  if (shots.length > 1 && last < 2) add("warn", `The last shot only gets ${last.toFixed(1)}s.`);

  /* — Length —
   * The one the user hits hardest, because the failure looks like a bug in the
   * prompt rather than a limit of the model: past H3's ceiling the clip does
   * not stop, it repeats.
   *
   * MiniMax's model card gives the output duration as 4–15 seconds. The node
   * accepts a longer latent without erroring, so nothing upstream says no —
   * the model simply has nothing trained past that point and fills the rest by
   * looping what it already made.
   *
   * This used to fire only on a SINGLE-shot project at 20 s or more, and told
   * the author that "a shot list holds together noticeably better at this
   * length" — which sent exactly the wrong person away happy. Cuts are prompt
   * syntax. They do not extend the generation window, so a six-shot 30 s clip
   * repeats just as a one-shot 30 s clip does, and it is the multi-shot case
   * that had no warning at all. */
  if (isFilm) {
    /* A film is allowed to be longer than H3 can render — that is what it is
     * for. What it is not allowed to be is longer than the plan can carry, and
     * what the author actually needs to see is where the joins land. */
    if (span > FILM_LIMITS.max) {
      add("err", `A ${span}s film is past this app's ${FILM_LIMITS.max}s ceiling. That is a policy, not the model's — but ${Math.ceil(span / CLIP_MAX)} `
        + `renders is already a long unattended run. Shorten it, or make the rest a second film.`);
    } else if (span < FILM_LIMITS.min && !(project.film?.splitAtCuts && activeEngine(project) === "ltx25")) {
      add("warn", `A ${span}s film is short enough to be one or two clips. Below ${FILM_LIMITS.min}s, plain single-clip renders are less work.`);
    }
    const plan = planFilm(project, { span });
    for (const note of plan.notes) if (note.level !== "info") add(note.level, note.msg);
    if (plan.clips.length) {
      add("ok", `This cuts into ${describePlan(plan)}. Each clip renders on its own and they are joined afterwards on the Deliver page.`);
    }
    if (project.mode === "r2v" && plan.clips.length > 1) {
      add("warn", "Ref2V films cannot be chained by a keyframe — the ref2va checkpoint has no first-frame input. Identity across the clips comes from the "
        + "reference images alone, so attach the ones that have to stay the same in every clip.");
    }
  } else if (activeEngine(project) === "ltx25") {
    /* The experimental engine has its own window — a real 30 s — so the H3
     * ceiling must not fire here: an error about a repeat that will not
     * happen teaches people to ignore the counter. The dropdown cannot
     * exceed 30 s, but a hand-edited or imported project can. */
    const cuts = shotMarkers(shots)[shots.length - 1] || 1;
    if (cuts > 4) add("warn", `${cuts} shots in one LTX-2.5 generation. Lightricks' guide prefers 2–4 — more cuts need clearer, shorter beats per shot, or render every cut as its own clip (Deliver ▸ Film ▸ Cuts).`);
    /* — Cuts that look like one take —
     * LTX reads a cut out of the prose only when the next shot is visibly a
     * different shot. Six shots that are all front-facing with the same pan
     * stamped into each one is, to the model, a single take with a camera
     * that keeps panning; it renders no cut, or a blend. The guide asks that
     * every cut re-establish scale AND angle, and that a continuous move
     * not run through the cut. */
    if (cuts >= 3) {
      const cutRows = shots.filter((s, i) => i > 0 && s.cutVerb !== NO_CUT);
      const camKey = (s) => cameraSentence(s.camera || {});
      const moving = cutRows.filter(s => camKey(s) !== "The camera remains static.");
      const sameCam = moving.length === cutRows.length && new Set(cutRows.map(camKey)).size === 1;
      const sameAngle = new Set(shots.map(s => s.viewpoint || "front-facing")).size === 1;
      if (sameCam && sameAngle) {
        add("warn", `Every shot is ${shots[0].viewpoint || "front-facing"} with the same camera move ("${camKey(cutRows[0]).replace(/\.$/, "")}"). LTX-2.5 reads that as one continuous take and drops the cuts — change the angle at every cut, keep the move to one shot, or render every cut as its own clip (Deliver ▸ Film ▸ Cuts).`);
      } else if (sameCam) {
        add("warn", `The same camera move runs through every cut ("${camKey(cutRows[0]).replace(/\.$/, "")}"). A move that continues across a cut tells LTX-2.5 it is one take — make the other shots static, or give each its own move.`);
      } else if (sameAngle) {
        add("warn", `All ${shots.length} shots are ${shots[0].viewpoint || "front-facing"}. A cut LTX-2.5 honours changes the angle as well as the scale — vary the viewpoint (low-angle, over-the-shoulder, side) at each cut.`);
      }
    }
    /* — Cuts with nothing to hold them —
     * Measured on this app's own renders: four shots of physical action
     * (climb, throw a lever, look out) with speech only in shot 1 came back
     * as one continuous take five times out of five, at 10 s and 20 s, on
     * both samplers; the same shots with a sentence in each cut cleanly at
     * every one, as did a talking head with a line per shot. The model
     * cuts where the sound changes; where it does not, it travels. */
    if (cuts >= 3 && !project.sound?.silent) {
      const cutRows = shots.filter((s, i) => i > 0 && s.cutVerb !== NO_CUT);
      const silent = cutRows.filter(s => !(s.dialogue || []).some(l => (l.text || "").trim()));
      if (silent.length === cutRows.length) {
        add("warn", `No shot after the first has a spoken line. In this app's own LTX-2.5 tests, ${shots.length} shots of action with no speech after shot 1 rendered as a single unbroken take; the same shots with a line in each cut at every one. Give each shot something said, or render every cut as its own clip (Deliver ▸ Film ▸ Cuts).`);
      }
    }
    if (duration > LTX25_DURATION.max) {
      add("err", `A ${duration}s clip is past LTX-2.5's ${LTX25_DURATION.max}s window.`);
    } else if (duration < LTX25_DURATION.min) {
      add("warn", `A ${duration}s clip is under the ${LTX25_DURATION.min}s floor LTX-2.5 generates.`);
    }
  } else if (duration > H3_DURATION.max) {
    add("err", `A ${duration}s clip is past H3's ${H3_DURATION.max}s ceiling — MiniMax specifies 4–15 seconds of output. The node will render ${duration}s without complaining and the model repeats itself to fill the extra ${(duration - H3_DURATION.max).toFixed(0)}s. Adding shots does not help: a cut is prompt syntax, not a longer window. Render at ${H3_DURATION.max}s or less${shots.length > 1 ? ", and make the rest a second clip" : ""}.`,
      /* The other engine genuinely renders it. Offer the switch here, where
       * the problem is read, instead of sending people to Deliver. */
      project.mode !== "r2v" && duration <= LTX25_DURATION.max
        ? { action: { kind: "engine", engine: "ltx25", label: `Switch to LTX-2.5 (renders up to ${LTX25_DURATION.max} s)` } }
        : {});
  } else if (duration < H3_DURATION.min) {
    add("warn", `A ${duration}s clip is under the ${H3_DURATION.min}s floor MiniMax specifies for H3.`);
  }

  /* — Timeline pins that cannot apply —
   * A pinned keyframe is an LTX guide. The MiniMax graph has no node to hang
   * it on, so pins on the H3 engine (or in Ref2V, where the engine field is
   * inert) ride along silently — and an attachment that silently does
   * nothing is exactly the kind of thing someone re-renders four times
   * before questioning. */
  {
    const pinned = shotKeyframes(project);
    const pins = pinned.length;
    if (pins && activeEngine(project) !== "ltx25") {
      add("warn", `${pins} shot${pins === 1 ? " has" : "s have"} a pinned keyframe, and pins only apply on the LTX-2.5 engine — the ${project.mode === "r2v" ? "Ref2V graph (always MiniMax)" : "MiniMax graph"} ignores them. ${project.mode === "r2v" ? "Ref2V is MiniMax-only: remove the pins, or leave Ref2V." : "Switch the engine, or remove the pins."}`,
        project.mode !== "r2v" ? { action: { kind: "engine", engine: "ltx25", label: "Switch to LTX-2.5" } } : {});
    } else if (pins) {
      /* — The same picture pinned more than once —
       * A guide says "the frame looks like THIS at this time". Pin one
       * picture at several times and the guides agree with each other:
       * the model is told the pose does not change, and the character
       * holds still between them. It is the intuitive thing to do with a
       * cast sheet — the same @anna at every cut — and it is exactly what
       * produces a frozen clip. (Reported by testers of multi-point
       * guidance on LTX-2.5; ComfyUI cannot see it, this app can.) */
      const shots = orderedShots(project);
      const byImage = new Map();
      const first = project.mode === "i2v" ? project.frames?.first : null;
      const keyOf = (m) => m?.id || m?.comfyName || m?.name || "";
      if (first) byImage.set(keyOf(first), ["the first frame"]);
      for (const s of pinned) {
        const k = keyOf(s.keyframe);
        if (!k) continue;
        const strong = (Number(s.keyframeStrength) || 1) >= 0.7;
        if (!strong) continue;
        const list = byImage.get(k) || [];
        list.push(`shot ${shots.indexOf(s) + 1}`);
        byImage.set(k, list);
      }
      for (const [, where] of byImage) {
        if (where.length < 2) continue;
        add("warn", `The same picture is pinned at ${where.join(", ")}. Identical guides at several times tell the model the pose does not change, and the character freezes between them. Pin a different frame at each cut, or lower the strength below 0.7 on all but one.`);
      }
      /* — Where the pins actually land —
       * The guide sits on the video VAE's 8-frame stride (a third of a
       * second at 24 fps). ComfyUI rounds to it without saying so, and a
       * pin that lands 0.15 s off its cut looks like drift, not rounding. */
      const moved = pinned
        .map(s => ({ i: shots.indexOf(s) + 1, at: Number(s.at) || 0, to: ltxGuideTime(s.at, project) }))
        .filter(x => Math.abs(x.to - x.at) > 0.02);
      if (moved.length) {
        add("ok", `Pins land on LTX's 8-frame grid (every ⅓ s): ${moved.map(x => `shot ${x.i} ${x.at.toFixed(2)}s → ${x.to.toFixed(2)}s`).join(", ")}. Set the cut on the grid if the exact frame matters.`);
      }
    }
  }

  /* — A hand-written description — */
  if (project.prompt?.manual && (project.prompt.description || "").trim()) {
    /* This is the one setting that makes every other edit look broken. With an
     * override in force the prompt is NOT built from the shots, so changing a
     * subject, a beat, the camera or a dial changes the project and changes
     * nothing the model reads — and the only symptom is "my edits do not
     * apply". Say it before anything else in the report. */
    add("warn", "The description is hand-written, so your shots, camera and dials are NOT being compiled — this text is sent instead. Turn it off to go back to the prompt built from your shots.");
  }

  /* — Wording — */
  for (const w of lintWording(compiled.description, project)) add("warn", w);

  /* — Sound —
   * §4.6 is unusually strict about N/A: "Use N/A only when the user explicitly
   * requests complete silence throughout the video." An empty field is not a
   * request for silence, it is an unfinished prompt — and the app used to send
   * it as a positive instruction to render a silent clip. That is an error. */
  if (compiled.soundscape === "N/A" && !project.sound?.silent) {
    add("err", "overall_soundscape is empty, so it exports as N/A — which tells the model to render the clip SILENT. Describe what can be heard, or tick deliberate silence if that is what you want.");
  }
  if (compiled.music === "N/A" && !project.sound?.musicOff) {
    add("warn", "non_diegetic_music is empty, so it exports as N/A — no score.");
  }
  if (project.sound?.silent && compiled.music !== "N/A") {
    add("warn", "The clip is marked completely silent but a score is written. N/A in overall_soundscape means silence throughout — the two cannot both be true.");
  }
  if (/\bmusic\b/i.test(compiled.soundscape)) {
    add("warn", "Music is named in overall_soundscape. Score belongs in non_diegetic_music, and music the characters can hear belongs in the description — the guide asks for it in exactly one place.");
  }
  /* §4.6 / ref §6: "Write complete dialogue and lyrics only inside <d> in
   * detailed_description; do not repeat them in these two sections." */
  for (const [field, label] of [[compiled.soundscape, "overall_soundscape"], [compiled.music, "non_diegetic_music"]]) {
    if (/<d>/.test(field)) add("warn", `A <d> dialogue tag is inside ${label}. Spoken words belong only in the description.`);
  }
  {
    const spoken = shots.flatMap(sh => (sh.dialogue || []).map(d => (d.text || "").trim())).filter(t => words(t) >= 5);
    for (const line of spoken) {
      if (compiled.soundscape.includes(line) || compiled.music.includes(line)) {
        add("warn", `The line "${line.slice(0, 40)}…" is repeated in the sound fields. Dialogue belongs only in the description.`);
      }
    }
  }

  /* — Speech —
   * §4.4 wants the author's punctuation preserved verbatim inside <d>, so the
   * compiler will not add a terminal mark for them. Which means saying so. */
  {
    const lines = shots.flatMap((sh, i) => (sh.dialogue || []).map(d => ({ d, shot: i + 1 })));
    for (const { d, shot } of lines) {
      const t = (d.text || "").trim();
      // A line the clip cuts off is SUPPOSED to stop mid-sentence — that is
      // what <cutoff> says — so an em dash or a missing stop is correct there.
      if (t && !d.cutoff && !/[.!?…"'\u201d\u2019\u2014-]$/.test(t)) {
        add("warn", `Shot ${shot}: (${d.speaker}) "${t.slice(0, 32)}" has no full stop. The words go into the prompt exactly as typed, so the sentence ends without one.`);
      }
    }
    /* §4.4: "When a speaker first appears, provide enough information … to
     * establish a stable identity". A bare (S1) gives H3 nothing to build a
     * voice out of, and in a two-person frame nothing to tell it who is
     * talking. */
    const introduced = new Set();
    for (const { d, shot } of lines) {
      if (!(d.text || "").trim() || introduced.has(d.speaker)) continue;
      introduced.add(d.speaker);
      if (!(d.identity || "").trim()) {
        add("warn", `(${d.speaker}) speaks in shot ${shot} with no description. Say who they are and how they sound — "a young woman with a quiet, breathy voice" — or the model picks a voice for you.`);
      }
    }
    /* Ref §5.4: "Assign (Sx) once according to the order of actual vocal
     * events in the target video." Ids that appear out of order, or skip one,
     * read to the model as speakers it was never introduced to. */
    const order = [];
    for (const { d } of lines) {
      if (!(d.text || "").trim()) continue;
      for (const id of String(d.speaker || "S1").split(",")) if (!order.includes(id)) order.push(id);
    }
    order.forEach((id, i) => {
      if (id !== `S${i + 1}`) add("warn", `(${id}) is the ${i === 0 ? "first" : `${i + 1}th`} voice to speak but is not (S${i + 1}). Speaker ids are assigned in the order people actually speak.`);
    });
  }

  /* — The prompt's own syntax —
   * These read the COMPILED text rather than the project, because that is what
   * the encoder gets, and because a hand-written override reaches it without
   * passing through any of the model's own constraints. */
  {
    const t = compiled.text;
    const opens = (t.match(/<d>/g) || []).length;
    const closes = (t.match(/<\/d>/g) || []).length;
    if (opens !== closes) add("err", `${opens} <d> tags against ${closes} closing ones — an unclosed dialogue span swallows the rest of the prompt.`);
    for (const m of t.matchAll(/<d>([^<]{0,24})/g)) {
      if (!/^\[[A-Za-z ]+\] /.test(m[1])) {
        add("err", "A <d> block does not open with a language tag. The form is <d>[English] the words</d>.");
        break;
      }
    }
    for (const m of t.matchAll(/<d>\[([A-Za-z ]+)\]/g)) {
      if (!LANGUAGES.includes(m[1])) add("warn", `"${m[1]}" is not one of H3's ${LANGUAGES.length} dialogue languages — the words may come back in another one.`);
    }
    // §4.2's approved cut verbs. Dissolves and fades are allowed only on
    // request, which the vocabulary already labels.
    const APPROVED = /^(the camera cuts to|the shot (cuts|transitions|changes|switches) to)$/i;
    shots.forEach((sh, i) => {
      if (i === 0 || !sh.cutVerb || sh.cutVerb === NO_CUT) return;
      if (!APPROVED.test(sh.cutVerb) && !/dissolve|fade|wipe/i.test(sh.cutVerb)) {
        add("warn", `Shot ${i + 1} cuts with "${sh.cutVerb}", which is not one of the five approved cut verbs.`);
      }
    });
    // The markers themselves: one per shot, numbered from 1, none on shot 1.
    const markers = (compiled.description.match(/\[Shot (\d+)\]/g) || []);
    if (!project.prompt?.manual) {
      // Rows that continue the take have no marker of their own, so the
      // expected count is the number of cuts, not the number of rows.
      const expected = shotMarkers(shots)[shots.length - 1] || 0;
      if (markers.length !== expected && activeEngine(project) !== "ltx25") {
        add("warn", `${markers.length} [Shot N] marker${markers.length === 1 ? "" : "s"} for ${expected} cut${expected === 1 ? "" : "s"} across ${shots.length} shot${shots.length === 1 ? "" : "s"}.`);
      }
      if (/\[Shot 1\]\s*At \d/.test(compiled.description)) {
        add("err", "Shot 1 carries a cut time. The opening shot has no timestamp — it starts at 0.");
      }
    }
  }

  /* — The sound fields, on their own terms — */
  {
    const count = (t) => (t === "N/A" ? 0 : (String(t).match(/[.!?…]+(\s|$)/g) || []).length || 1);
    const sc = count(compiled.soundscape);
    if (sc > 4) add("warn", `overall_soundscape runs to ${sc} sentences; the guide asks for 1–4.`);
    const mc = count(compiled.music);
    if (mc > 3) add("warn", `non_diegetic_music runs to ${mc} sentences; the guide asks for 1–3.`);
    /* §4.7: "do not use abstract mood words or explain the emotional function
     * of the score." The general intensifier lint does not cover either — these
     * are words that read as perfectly good prose and tell the model nothing
     * about what to play. */
    if (MOOD_WORDS.test(compiled.music)) {
      add("warn", "non_diegetic_music uses a mood word. Say what plays — instrumentation, tempo, rhythm, dynamics — not how it should feel.");
    }
    if (SCORE_FUNCTION.test(compiled.music)) {
      add("warn", "non_diegetic_music explains what the score is FOR. Describe the music itself; the model cannot play a purpose.");
    }
  }

  /* — Mode requirements — */
  if (project.mode === "i2v" && !project.frames?.first) {
    add("err", "I2V needs a first frame. Drop an image on the Media page.");
  }
  /* §2.1: "I2VA always uses: For the target video, at 0.00 seconds into the
   * target video, <Picture 1> (from [Shot 1]) is fully referenced." Always —
   * the app exposes it as a toggle, which is a reasonable escape hatch, but
   * turning it off is a deviation and should say so. */
  if (project.mode === "i2v" && project.frames?.first && !project.prompt?.alignKeyframe) {
    add("err", "The keyframe-alignment line is off. H3 requires it for image-to-video — without it the model is never told the picture is the first frame.");
  }
  if (project.mode === "r2v") {
    const refs = project.refs || {};
    const total = (refs.images?.length || 0) + (refs.videos?.length || 0) + (refs.audios?.length || 0);
    if (!total) add("err", "Ref2V needs at least one reference. Add images, clips or audio on the Media page.");
    if ((refs.images?.length || 0) > REF_LIMITS.images) add("err", `The node takes at most ${REF_LIMITS.images} reference images.`);
    if ((refs.videos?.length || 0) > REF_LIMITS.videos) add("err", `The node takes at most ${REF_LIMITS.videos} reference videos.`);
    if ((refs.audios?.length || 0) > REF_LIMITS.audios) add("err", `The node takes at most ${REF_LIMITS.audios} standalone reference audio clips.`);
    /* The per-kind caps do not add up to the total, and checking them one at a
     * time passes a set the model refuses: 9 + 3 + 3 is 15, and the card caps
     * "the maximum number of files across all input types" at 12. */
    if (total > REF_LIMITS.total) {
      add("err", `${total} references are attached. H3 takes at most ${REF_LIMITS.total} files across all types, whatever the per-type counts allow.`);
    }

  }

  /* — References —
   * Outside r2v as well. A tag with nothing behind it is just as dead in i2v,
   * and a pool of references carried into t2v is worse than dead: the graph
   * never sends them, so the prompt names pictures the model will never see.
   * Keeping this inside the r2v branch meant every one of those was silent. */
  {
    const inv = referenceInventory(project);
    const known = new Set(inv.map(e => e.tag));
    // subject_definitions binds a subject to the asset it came from — "<Subject
    // 1> is the subject shown in <Picture 1>" — so the source label is real
    // even in the mode where the citation label is <Subject N>.
    for (const e of inv) if (e.source) known.add(e.source);
    if (project.mode === "i2v" && project.frames?.first && !(project.refs?.images || []).length) {
      known.add("<Picture 1>");   // the fixed first frame answers to it
    }
    const TAG_RE = /<(?:Subject|Picture|Video|Audio) \d+>/g;
    for (const tag of new Set(compiled.text.match(TAG_RE) || [])) {
      if (!known.has(tag)) add("err", `${tag} is cited but nothing is attached to it — a tag with no media behind it is silently ignored.`);
    }
    if (project.mode === "r2v") {
      /* The retention markers are "fixed English values in the output format",
       * and the visual set and the audio set are different lists. A value from
       * the wrong one is a word the model has never seen in that position. */
      const VIS = new Set(VISUAL_RETENTION.map(v => v[0]));
      const AUD = new Set(AUDIO_RETENTION.map(v => v[0]));
      for (const e of inv) {
        const isVideoAudio = e.kind === "audio" && e.fromVideo;
        const marker = isVideoAudio ? e.ref?.audioRetention : e.ref?.retention;
        if (!marker) continue;
        const legal = e.kind === "audio" ? AUD : VIS;
        if (!legal.has(marker)) {
          add("err", `${e.tag} is marked "${marker}", which is not one of the ${e.kind === "audio" ? "audio" : "visual"} retention values.`);
        }
      }
      // Ref §5.4: "Do not write (Sx) in retention_analysis."
      if (/\(S\d/.test(compiled.fields?.retention_analysis || "")) {
        add("warn", "A speaker id is inside retention_analysis. Speaker ids belong in the description only.");
      }
      // Citation is judged on the description, not on the whole prompt: the
      // bookkeeping sections list every tag by construction, and a reference
      // that only appears there is a reference doing no work.
      const usedInDescription = new Set(compiled.description.match(TAG_RE) || []);
      for (const entry of inv) {
        if (!usedInDescription.has(entry.tag)) {
          add("warn", `${entry.tag} is attached but never mentioned in the description. Say what it is for.`);
        }
      }
    } else if (inv.length) {
      add("warn", `${inv.length} reference${inv.length === 1 ? " is" : "s are"} attached, but ${MODES[project.mode].label} does not send ${inv.length === 1 ? "it" : "them"} to the model. Switch to Reference to Video, or remove ${inv.length === 1 ? "it" : "them"}.`);
    }
  }

  /* — Render settings — */
  const [w, hgt] = String(project.render?.resolution || "832x480").split("x").map(Number);
  if (project.render?.variant === "turbo4" && Math.min(w, hgt) < 700) {
    add("warn", "The 4-step Turbo distill was trained on the 1344×768 canvas; at 480p it softens. The 8-step build is the better fast option here.");
  }
  if (project.render?.variant === "ref4") {
    add("warn", "Ref2V's 4-step distill is v0.1, and 4 steps is the worst case for the thing this mode fails at first — the soundtrack. Check the audio before trusting a batch.");
  }
  if (mode?.key === "r2v" && project.render?.refImageSize === "max") {
    add("warn", "ref_image_size \"max\" holds identity better and costs real time — reference tokens ride through every sampling step, not just the encode.");
  }

  /* — Hand-written camera lines —
   * §4.3: camera motion is "written as a natural English action within the
   * shot, rather than stacked as separate labels at the end of a sentence".
   * The custom field is the one place someone can do the second thing. */
  shots.forEach((sh, i) => {
    const custom = (sh.camera?.custom || "").trim();
    if (!custom) return;
    const commas = (custom.match(/,/g) || []).length;
    if (commas >= 2 && !/\b(camera|shot|lens|frame|pushes|pulls|pans|tilts|trucks|arcs|tracks|holds|rolls|shakes|zooms)\b/i.test(custom)) {
      add("warn", `Shot ${i + 1}'s camera line reads as stacked labels ("${custom.slice(0, 44)}"). Write it as an action: "The camera pushes in with small amplitude at slow speed toward…".`);
    }
  });

  /* — Cast tokens —
   * @anna with nobody called Anna is the same failure as a <Picture 1> with no
   * picture: it reads as a name to the model and means nothing. */
  const raw = [
    ...shots.flatMap(s => [s.subject, shotActionText(s), s.details, s.setting]),
    project.sound?.soundscape, project.sound?.music, project.style?.extra,
    project.prompt?.manual ? project.prompt.description : "",
  ].filter(Boolean).join(" ");
  for (const token of new Set(raw.match(/@[a-z0-9][a-z0-9-]{1,40}/gi) || [])) {
    const slug = token.slice(1).toLowerCase();
    if (!getCast().some(c => castSlug(c.name) === slug)) {
      add("warn", `${token} is not in the cast — it will reach the model as a literal word.`);
    }
  }

  /* — Continuity across a cut —
   *
   * The failure this catches, in the words of the person who hit it: "at 12sec
   * cut she is wearing her blazer again she just removed."
   *
   * The mechanism is not the model being forgetful. It is the prompt: the head
   * of every shot after the first repeats the subject line word for word, so a
   * subject introduced as "in a tactical outfit" is described that way again at
   * 12 s, after the beats have spent eight seconds taking the outfit off. H3
   * believes the most recent description, which is the stale one, and the
   * change is undone at the cut.
   *
   * So: if a shot's beats change the state of the subject, and a later shot
   * repeats the same subject text without saying what is different now, say so.
   * Word-for-word repetition is the signal — two shots that describe the
   * subject differently are already doing the right thing. */
  {
    const CHANGES_STATE = /\b(removes?|removed|takes? off|took off|puts? on|pulls? on|slips? (?:on|off|out of)|strips?|undoes|undid|unbuttons?|unzips?|opens?|closes?|shuts?|drops?|picks? up|sets? down|puts? down|breaks?|tears?|rips?|spills?|lights?|extinguishes?|draws?|holsters?|sheathes?|discards?|throws? (?:away|down)|changes? into|wraps?|unwraps?|dons?|doffs?)\b/i;
    let changedAt = -1;
    let changedBy = "";
    shots.forEach((sh, i) => {
      const subj = (sh.subject || "").trim();
      if (changedAt >= 0 && subj && !((sh.continuity || "").trim())
          && subj === (shots[changedAt].subject || "").trim()) {
        add("warn", `Shot ${i + 1} describes the subject in exactly the same words as shot ${changedAt + 1}, but shot ${changedAt + 1} changed something — "${changedBy.slice(0, 48)}". The model reads the most recent description as the truth, so the change is undone at this cut. Say what is different now in Shot ${i + 1}'s "Changed since" line.`);
        changedAt = -1;   // one warning per change, not one per later shot
      }
      const beats = shotActionText(sh);
      const m = CHANGES_STATE.exec(beats);
      if (m && subj) { changedAt = i; changedBy = beats; }
    });
  }

  /* — Named characters —
   * H3 renders some characters from the name alone and renders a stranger for
   * most. Which is which is not guessable, so it is looked up: 1293 names
   * that were actually tested, in web/assets/known-characters.tsv.
   *
   * Warnings, never errors, and only about the two failing buckets. The index
   * is one person's read of a handful of clips, and a name it calls unusable
   * is a fine thing to write when a reference image is holding the face —
   * which is why the message says so rather than pretending otherwise. The
   * lookup is empty until the index has loaded, and an absent hint is the
   * correct behaviour then. */
  {
    const named = mentionedKnown(compiled.description);
    const pinned = referenceInventory(project).some(e => e.kind === "image")
      || (project.mode === "i2v" && !!project.frames?.first);
    const list = (es) => es.slice(0, 3).map(e => `“${e.name}”`).join(", ")
      + (es.length > 3 ? ` and ${es.length - 3} more` : "");
    const bad = named.filter(e => e.status === "b");
    const fence = named.filter(e => e.status === "f");
    if (bad.length) {
      add("warn", `${list(bad)} ${bad.length === 1 ? "is" : "are"} named, and H3 did not reproduce ${bad.length === 1 ? "that character" : "those characters"} from the name in community testing — expect a stranger. ${pinned ? "The attached reference is doing the work here, so the name is only a label." : "Describe them in concrete detail, or pin the face with a reference image."}`);
    }
    if (fence.length) {
      add("warn", `${list(fence)} came back recognisable only some of the time in community testing.${pinned ? "" : " A reference image is what makes it stick."}`);
    }
  }

  /* — What this machine has learned —
   * A rule with a pattern is checked against the prompt; a rule without one is
   * a reminder shown alongside. Either way it is the user's own finding, so it
   * is reported as their words, not as a lint message. */
  for (const rule of houseRules) {
    if (rule.active === false) continue;
    if (rule.mode && rule.mode !== "all" && rule.mode !== project.mode) continue;
    if (!rule.pattern) continue;
    let re = null;
    try { re = new RegExp(rule.pattern, "i"); } catch { continue; }
    if (re.test(compiled.text)) add("warn", `House rule — ${rule.text}`);
  }

  const errors = out.filter(c => c.level === "err").length;
  const warnings = out.filter(c => c.level === "warn").length;
  if (!out.length) add("ok", "Nothing to flag — the prompt matches the format H3's rewriter emits.");
  return { checks: out, errors, warnings, wordCount: count, budget, pristine: false };
}
