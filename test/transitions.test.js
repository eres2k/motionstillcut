/* WHAT HAPPENS BETWEEN TWO SHOTS — a cut verb from the guide, or no cut at
 * all. "No cut" is the one the guide has no word for because it is not a
 * cut: the row continues the same take and compiles into the previous
 * [Shot N] block, so markers count cuts, not rows. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { blankProject, newShot, newBeat } from "../web/js/state.js";
import { compilePrompt, validate, shotMarkers } from "../web/js/prompt.js";
import { NO_CUT, TRANSITIONS, transitionLabel, cutVerbFor } from "../web/js/vocab.js";

function three() {
  const p = blankProject();
  p.render.duration = 10;
  p.shots[0].subject = "a baker in a flour-dusted apron";
  p.shots[0].beats = [newBeat("lifts the shutter", "")];
  p.shots[0].setting = "a street bakery before sunrise";
  p.sound.soundscape = "a shutter rattling up"; p.sound.musicOff = true;
  const s2 = newShot(); s2.at = 3; s2.subject = "the baker"; s2.shotType = "close-up"; s2.beats = [newBeat("wipes flour from the counter", "")];
  const s3 = newShot(); s3.at = 6; s3.subject = "the baker"; s3.beats = [newBeat("turns to the oven", "")];
  p.shots.push(s2, s3);
  return p;
}
const markers = (text) => [...text.matchAll(/\[Shot (\d+)\]/g)].map(m => Number(m[1]));

test("every transition value is a cut verb the compiler writes, or no cut", () => {
  for (const [v] of TRANSITIONS) assert.ok(v === NO_CUT || /^the (camera|shot) \w+ to$/.test(v), v);
  assert.equal(transitionLabel(undefined), "Cut");
  assert.equal(transitionLabel(NO_CUT), "No cut — same take");
});

test("a hard cut keeps one marker per row", () => {
  const { text } = compilePrompt(three());
  assert.deepEqual(markers(text), [1, 2, 3]);
  assert.match(text, /\[Shot 2\] At 00:03\.000, the camera cuts to a close-up shot/);
});

test("no cut folds the row into the previous block and renumbers what follows", () => {
  const p = three();
  p.shots[1].cutVerb = NO_CUT;
  const { text } = compilePrompt(p);
  assert.deepEqual(markers(text), [1, 2], "two markers for three rows");
  assert.match(text, /\[Shot 1\][^[]*At 00:03\.000, without a cut, the camera reframes to a close-up shot[^[]*wipes flour/i);
  assert.match(text, /\[Shot 2\] At 00:06\.000, the camera cuts to/);
  assert.deepEqual(shotMarkers(p.shots), [1, 1, 2]);
});

test("on LTX-2.5 the prompt is Lightricks' dialect: one paragraph, cuts in prose, no markers or timestamps", () => {
  const p = three();
  p.render.engine = "ltx25";
  p.shots[1].cutVerb = "the shot switches to";
  const { text } = compilePrompt(p);
  assert.ok(!/\[Shot \d\]/.test(text), "no shot numbers");
  assert.ok(!/At \d\d:\d\d/.test(text), "no timestamps");
  assert.ok(!/integrated_multimodal_description|overall_soundscape|non_diegetic_music/.test(text), "no field labels");
  assert.match(text, /A hard cut transitions to a close-up shot of the baker\. The ambient sound continues across the cut\./);
  assert.match(text, /Ambient sound throughout: a shutter rattling up\./);
  p.shots[2].cutVerb = "the shot dissolves to";
  assert.match(compilePrompt(p).text, /The image dissolves into a medium shot/);
  p.shots[2].cutVerb = "the shot transitions to";
  assert.match(compilePrompt(p).text, /The view cuts to a medium shot/);
  assert.equal(cutVerbFor("the camera cuts to", "minimax"), "the camera cuts to", "MiniMax keeps the guide's verb");
  assert.equal(cutVerbFor(NO_CUT, "ltx25"), NO_CUT);
});

test("on LTX-2.5 more than five shots is a warning: the seams land, the shots stop reading", () => {
  const p = three();
  p.render.engine = "ltx25";
  for (const at of [7, 8, 9]) { const s = newShot(); s.at = at; s.subject = "the baker"; s.beats = [newBeat("x", "")]; p.shots.push(s); }
  assert.ok(validate(p).checks.some(c => /prefers 2–4/.test(c.msg)));
  p.shots[5].cutVerb = NO_CUT;   // five cuts now
  assert.ok(!validate(p).checks.some(c => /prefers 2–4/.test(c.msg)));
});

/* Measured on one prompt and seed: single-stage landed every seam as a
 * dissolve, two-stage landed the same seams as hard cuts. */
test("on LTX-2.5 single-stage with cuts suggests the two-stage build; two-stage says nothing", () => {
  const p = three();
  p.render.engine = "ltx25"; p.render.variant = "ltx_single";
  assert.ok(validate(p).checks.some(c => /Two-stage 8\+3/.test(c.msg)));
  p.render.variant = "ltx_two";
  assert.ok(!validate(p).checks.some(c => /Two-stage 8\+3/.test(c.msg)));
  p.render.variant = "ltx_single";
  p.shots[1].cutVerb = NO_CUT; p.shots[2].cutVerb = NO_CUT;   // no cuts to harden
  assert.ok(!validate(p).checks.some(c => /Two-stage 8\+3/.test(c.msg)));
});

test("a dissolve is written as the guide's verb", () => {
  const p = three();
  p.shots[2].cutVerb = "the shot dissolves to";
  assert.match(compilePrompt(p).text, /\[Shot 3\] At 00:06\.000, the shot dissolves to/);
});

test("no cut is not an unapproved verb, and the cut-time checks still see the row", () => {
  const p = three();
  p.shots[1].cutVerb = NO_CUT;
  const m = validate(p).checks.map(c => c.msg);
  assert.ok(!m.some(x => /not one of the five approved/.test(x)), m.join("\n"));
  p.shots[1].at = 6;   // the same instant as shot 3 — a row that continues the take is still a moment in time
  assert.ok(validate(p).checks.some(c => /must strictly increase/.test(c.msg)));
});

test("on LTX-2.5 dialogue is quoted prose with the voice named, no tags", () => {
  const p = three();
  p.render.engine = "ltx25";
  p.shots[0].dialogue = [{ id: "d1", speaker: "S1", identity: "the woman with the short grey hair", voice: "warm, unhurried voice", delivery: "says", text: "We cut it four ways." }];
  p.shots[1].dialogue = [{ id: "d2", speaker: "S1", text: "And every cut is real." }];
  const { text } = compilePrompt(p);
  assert.ok(!/<d>|\(S1\)/.test(text), text);
  assert.match(text, /The woman with the short grey hair says in a warm, unhurried voice: "We cut it four ways"\./);
  assert.match(text, /The woman with the short grey hair says: "And every cut is real"\./);
});

/* ── Cuts LTX-2.5 actually renders ──────────────────────────
 * A six-shot argument came back from LTX with no cut at all: every shot was
 * front-facing, every shot carried the same "shakes slightly while panning
 * right", and every cut was the identical clause. To the model that is one
 * take. */
test("on LTX-2.5 the second hard cut is worded the guide's other way", () => {
  const p = three();
  p.render.engine = "ltx25";
  const { text } = compilePrompt(p);
  assert.match(text, /A hard cut transitions to a close-up shot/);
  assert.match(text, /Another hard cut jumps to a medium shot/);
  assert.equal(cutVerbFor("the camera cuts to", "ltx25", 0), "a hard cut transitions to");
  assert.equal(cutVerbFor("the camera cuts to", "ltx25", 1), "another hard cut jumps to");
  assert.equal(cutVerbFor("the camera cuts to", "ltx25", 2), "a hard cut transitions to");
  assert.equal(cutVerbFor("the camera cuts to", "minimax", 1), "the camera cuts to");
});

test("on LTX-2.5 same angle and same move on every shot is flagged: the seams land as dissolves", () => {
  const p = three();
  p.render.engine = "ltx25";
  for (const s of p.shots) s.camera = { ...s.camera, type: "handheld", speed: "fast", secondary: "pan right" };
  const msgs = () => validate(p).checks.map(c => c.msg);
  assert.ok(msgs().some(m => /dissolves rather than cuts/.test(m)), msgs().join("\n"));
  p.shots[1].viewpoint = "over-the-shoulder";
  assert.ok(msgs().some(m => /runs through every cut/.test(m)));
  assert.ok(!msgs().some(m => /dissolves rather than cuts/.test(m)));
  p.shots[1].camera.type = "static"; p.shots[1].camera.secondary = "none";
  assert.ok(!msgs().some(m => /runs through every cut|dissolves rather than cuts|All 3 shots/.test(m)), msgs().join("\n"));
  p.render.engine = "minimax";
  p.shots[1].viewpoint = "front-facing";
  assert.ok(!msgs().some(m => /dissolves rather than cuts|runs through/.test(m)), "MiniMax reads [Shot N] markers, not prose");
});

/* The Create page's Pace dial, not the LLM, decides how many shots a 30 s
 * piece gets — and it gave LTX six, all front-facing, all "shakes slightly
 * while panning right", which came back with every seam dissolved. */
test("Create's steering on a single LTX-2.5 render: at most 5 shots, a new angle at every cut, no move repeated across a cut", async () => {
  const { applySteering, DEFAULT_DIALS } = await import("../web/js/steer.js");
  const { cameraSentence } = await import("../web/js/prompt.js");
  const make = (engine) => {
    const p = blankProject();
    p.render.engine = engine; p.render.duration = 30;
    p.creative.dials = { ...DEFAULT_DIALS, pace: 85, energy: 85 };
    p.creative.pool = { beats: ["gestures at the air", "counters with a nod", "both move to the centre", "her eyes light up", "he leans in with a smirk", "they both laugh"] };
    p.shots[0].subject = "a woman in a sleek turtleneck and a man in a structured blazer";
    applySteering(p);
    return p;
  };
  const ltx = make("ltx25");
  assert.ok(ltx.shots.length <= 5 && ltx.shots.length >= 2, `${ltx.shots.length} shots`);
  for (let i = 1; i < ltx.shots.length; i++) {
    assert.notEqual(ltx.shots[i].viewpoint, ltx.shots[i - 1].viewpoint, `shot ${i + 1} repeats the angle`);
    assert.notEqual(cameraSentence(ltx.shots[i].camera), cameraSentence(ltx.shots[i - 1].camera), `shot ${i + 1} repeats the move`);
  }
  assert.ok(!validate(ltx).checks.some(c => /dissolves rather than cuts|runs through every cut|All \d shots are/.test(c.msg)));
  const h3 = make("minimax");
  assert.equal(h3.shots.length, 6, "H3 keeps the [Shot N] ceiling of six");
  assert.notEqual(cameraSentence(h3.shots[1].camera), cameraSentence(h3.shots[0].camera), "the mirrored shot flips its pan too");
});

/* Measured on this app's own renders, 28 Aug 2026: a four-shot lighthouse
 * with speech only in shot 1 and a fast two-axis arc on shot 1 came back as
 * one take (five renders, both samplers, 10 s and 20 s); with a sentence in
 * every shot and small or static cameras it cut at every shot. */
test("on one LTX-2.5 render the steering tames the camera and deals the line across the shots", async () => {
  const { applySteering, DEFAULT_DIALS } = await import("../web/js/steer.js");
  const p = blankProject();
  p.render.engine = "ltx25"; p.render.duration = 20;
  p.creative.dials = { ...DEFAULT_DIALS, pace: 70, energy: 75 };
  p.creative.pool = { beats: ["looks up at the dark lantern room", "climbs the spiral stairs", "throws the brass lever", "looks out to sea"] };
  p.shots[0].subject = "a lighthouse keeper in a yellow oilskin";
  p.shots[0].dialogue = [{ id: "d1", speaker: "S1", language: "English", text: "Not tonight. Nobody drowns tonight.", voiceover: false, note: "", identity: "a woman in her forties", delivery: "" }];
  applySteering(p);
  assert.ok(p.shots.length >= 2);
  for (const s of p.shots) {
    assert.notEqual(s.camera.speed, "fast", `shot at ${s.at}s moves fast`);
    assert.ok(!s.camera.secondary || s.camera.secondary === "none", `shot at ${s.at}s adds a second axis`);
  }
  const spoken = p.shots.filter(s => (s.dialogue || []).some(l => (l.text || "").trim()));
  assert.equal(spoken.length, 2, "two sentences, two shots speaking — even though the line fits shot 1");
  const silent = validate(p).checks.find(c => /Only shot 1 speaks|Nobody speaks/.test(c.msg));
  assert.ok(!silent, "a dealt line satisfies the silent-cuts check");
  for (const s of p.shots) s.dialogue = [];
  assert.ok(validate(p).checks.some(c => /Nobody speaks/.test(c.msg)), "silent, same subject in every shot");
  p.shots[1].subject = "the black waves on the rocks";
  assert.ok(!validate(p).checks.some(c => /Nobody speaks|Only shot 1 speaks/.test(c.msg)), "a cutaway is the remedy, so a cutaway silences it");
});
