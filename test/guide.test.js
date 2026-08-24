/* CONFORMANCE — MiniMax's own examples must pass this app's checks.
 *
 * The five texts below are the canonical rewriter outputs from the prompt guides
 * that ship inside the model repo (MiniMaxAI/MiniMax-H3, docs/…_base_en.md and
 * …_ref_en.md). They are what the encoder was trained on. If a lint in this app
 * fires on one of them, the lint is wrong — not the guide — and it is steering
 * creators away from the format that works.
 *
 * This test has already deleted two invented rules: a 120-word minimum that
 * every one of the four base cases failed, and a "without" negation warning
 * that fired on the reference guide's own sentence for stopping the model
 * inventing a speaker.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { lintWording, dialogueSentence } from "../web/js/prompt.js";
import { blankProject } from "../web/js/state.js";

/* ── The guide's canonical descriptions ─────────────────────── */

const CASES = {
  "base §5 Case 1 (T2VA)": {
    mode: "t2v",
    text: "[Shot 1] Live-action, cinematic, a medium-wide shot frames a baker opening the shutters of a small street bakery before sunrise. The camera pushes in with small amplitude at slow speed as the middle-aged baker with a calm, slightly raspy voice (S1) places a fresh loaf on the wooden counter and says: <d>[English] First batch of the morning.</d> [Shot 2] At 00:05.000, the camera cuts to a close-up of steam rising from the sliced bread while the baker's final words carry over from the previous shot.",
  },
  "base §5 Case 2 (I2VA)": {
    mode: "i2v",
    text: "[Shot 1] Live-action, cinematic, the young woman shown in <Picture 1> remains beside the rain-covered train window, preserving her appearance, clothing, seat position, and the carriage layout. The camera trucks right with small amplitude at slow speed as she lifts her gaze from the folded letter toward the passing city lights. Her reflection moves across the glass while the quiet, breathy young woman (S1) says: <d>[English] I get off at the next station.</d> She folds the letter along its existing crease.",
  },
  "base §5 Case 3 (FL2VA)": {
    mode: "t2v",
    text: "[Shot 1] Live-action, cinematic, a rain-soaked cyclist begins in the position and framing established by Picture 1, holding a closed black umbrella beside a silver bicycle. The camera pulls out with small amplitude at slow speed as she releases the bicycle handle, raises the umbrella above her shoulder, and presses the runner upward until the canopy opens. Water rolls from the expanding fabric while she steps beneath it, rotates the handle into the final angle, and settles into the pose, spacing, and composition established by Picture 2 at the end of the shot.",
  },
  "base §5 Case 4 (L2VA)": {
    mode: "t2v",
    text: "[Shot 1] Live-action, cinematic, a close shot begins with an intact drinking glass near the edge of a dark wooden table, while the same hand and sleeve visible in <Picture 1> approach from the right. The camera pushes in with small amplitude at slow speed as the fingertips strike the rim. The glass tips, falls, and hits the floor with a sharp impact; cracks spread through it as fragments slide outward. Toward the end, the moving pieces lose momentum and settle into the exact broken arrangement, hand position, camera angle, lighting, and final composition established by <Picture 1>.",
  },
  "ref §7 complete example (Ref2VA)": {
    mode: "r2v",
    text: "The target video uses a realistic multi-camera sitcom style with warm indoor lighting.\n[Shot 1] A medium shot establishes <Subject 1>, the coffee shop with its exposed brick wall, orange tufted sofa, patterned pillows, neon sign, and wooden coffee table. <Subject 3> (S1), the young woman with long blonde hair and a light-pink button-down shirt with rolled-up sleeves, sits on the sofa holding a chocolate-chip cookie. From the left, <Subject 4>, the young man with short wavy brown hair and a dark-grey hoodie with drawstrings, enters holding the leash of <Subject 2>, the thick-furred white Samoyed with pointed ears, a dark nose, and a curved tail. The dog lunges toward the cookie and pulls the leash taut. <Subject 3> (S1) jerks her hand back and, using the clear youthful voice timbre referenced from <Audio 1>, exclaims with light annoyance, <d>[English] Hey! Watch your dog!</d> She closes her lips and guards the cookie while <Subject 4> pulls the dog back.\n[Shot 2] At 00:03.000, the shot cuts to a close-up of <Subject 4> (S2), the young man in the dark-grey hoodie from Shot 1, sitting beside <Subject 3> on the sofa and holding <Subject 2> securely in his arms. <Subject 4> (S2) says in a casual young male voice with a playful tone and an easy conversational pace, <d>[English] He just likes cookies more than me.</d> He closes his mouth into an apologetic smile and strokes the dog's thick white fur.\n[Shot 3] At 00:05.000, the shot cuts to a close-up of <Subject 3> (S1), the blonde woman in the light-pink shirt from Shot 1. Her annoyance softens as she looks toward the Samoyed. <Subject 3> (S1) replies in the same clear youthful voice referenced from <Audio 1> with an amused cadence, <d>[English] Well, he has good taste at least.</d> She smiles and raises the cookie in a small toast-like gesture. A classic canned audience laugh begins immediately after the line and continues through the final frame.",
  },
};

for (const [label, c] of Object.entries(CASES)) {
  test(`the checker is silent on ${label}`, () => {
    const project = { ...blankProject(), mode: c.mode };
    const warnings = lintWording(c.text, project);
    assert.deepEqual(warnings, [],
      `This app warns about MiniMax's own canonical output:\n  ${warnings.join("\n  ")}`);
  });
}

/* ── The two forms the guide states verbatim ────────────────── */

test("voiceover carries the exact phrase the guide mandates", () => {
  // §4.4: "For voiceover, use the exact phrase `says in an off-screen
  // voiceover`. Immediately after every voiceover <d> block, state that the
  // corresponding on-screen character's lips remain closed"
  const line = { speaker: "S1", language: "English", text: "I still remember that road.", voiceover: true };
  const out = dialogueSentence(line);
  assert.match(out, /says in an off-screen voiceover/,
    "the phrase is exact in the guide, not a paraphrase");
  assert.match(out, /<\/d>[^<]*lips remain completely closed/,
    "the lips clause must follow the </d> immediately, with nothing between");
});

test("a spoken line puts only the language tag and the words inside <d>", () => {
  // §4.4: "Place the speaker's identifying phrase, ID, action, and delivery
  // outside <d>. Inside <d>, include only the language tag and the actual
  // user-provided spoken content."
  const out = dialogueSentence({ speaker: "S1", language: "English", text: "I get off at the next station." });
  const inside = /<d>(.*?)<\/d>/.exec(out)?.[1];
  assert.equal(inside, "[English] I get off at the next station.");
  assert.doesNotMatch(out, /<d>[^<]*\(S\d/, "the speaker id belongs outside the tag");
});

test("the words are never rewritten on their way into <d>", () => {
  // §4.4: "Preserve every original word and punctuation mark verbatim; do not
  // translate or rewrite them."
  for (const text of ["Wait for us!", "You said you'd call.", "¿Dónde está?", "no puedo"]) {
    const out = dialogueSentence({ speaker: "S2", language: "Spanish", text });
    assert.ok(out.includes(`] ${text}</d>`), `"${text}" came back changed: ${out}`);
  }
});


/* ── The checks the guide's rules imply ─────────────────────── */

import { validate } from "../web/js/prompt.js";
import { newShot, newBeat, newDialogue } from "../web/js/state.js";

const withShot = (fields = {}, extra = {}) => {
  const p = { ...blankProject(), ...extra };
  const s = newShot(0);
  Object.assign(s, { subject: "a barista", beats: [newBeat("pours slowly")] }, fields);
  p.shots = [s];
  p.sound = { ...p.sound, soundscape: "Cups settle on the drainer." };
  return p;
};
const msgs = (p) => validate(p).checks.map(c => c.msg).join(" | ");

test("an unclosed <d> is an error, not a shrug", () => {
  const p = withShot({}, { prompt: { manual: true, description: "[Shot 1] She says <d>[English] hello. Then she leaves.", alignKeyframe: true } });
  assert.match(msgs(p), /unclosed dialogue span|tags against/);
});

test("a language H3 does not speak is flagged", () => {
  const p = withShot({ dialogue: [{ ...newDialogue("S1"), language: "Welsh", text: "Bore da." }] });
  assert.match(msgs(p), /not one of H3's/);
});

test("a cut verb outside the approved five is flagged", () => {
  const p = withShot();
  const s2 = newShot(2.5);
  Object.assign(s2, { subject: "her hands", beats: [newBeat("twist the portafilter")], cutVerb: "we smash cut to" });
  p.shots.push(s2);
  assert.match(msgs(p), /not one of the five approved cut verbs/);
});

test("a mood word in the score is flagged; instrumentation is not", () => {
  // §4.7: "do not use abstract mood words or explain the emotional function of
  // the score."
  const moody = withShot();
  moody.sound = { ...moody.sound, music: "A haunting, melancholy piano." };
  assert.match(msgs(moody), /mood word/);

  const fine = withShot();
  fine.sound = { ...fine.sound, music: "Sparse piano notes at a slow tempo, joined by sustained low strings that gradually increase in volume before fading out." };
  assert.doesNotMatch(msgs(fine), /mood word|explains what the score is FOR/);
});

test("explaining what the score is for is flagged", () => {
  const p = withShot();
  p.sound = { ...p.sound, music: "Low strings that underscore her isolation." };
  assert.match(msgs(p), /explains what the score is FOR/);
});

test("a retention marker from the wrong vocabulary is an error", () => {
  const p = withShot();
  p.mode = "r2v";
  p.refs = { images: [{ id: "a", name: "a.png", label: "a", kind: "image", retention: "fully_copy" }], videos: [], audios: [] };
  p.shots[0].subject = "a woman — <Subject 1>";
  assert.match(msgs(p), /not one of the visual retention values/);
});

test("the I2VA instruction cannot be quietly switched off", () => {
  // §2.1: "I2VA always uses: …"
  const p = withShot();
  p.mode = "i2v";
  p.frames = { first: { id: "f", name: "f.png", label: "f", kind: "image" } };
  p.prompt = { ...p.prompt, alignKeyframe: false };
  assert.match(msgs(p), /keyframe-alignment line is off/);
});
