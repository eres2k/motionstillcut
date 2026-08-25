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

test("on LTX-2.5 a plain cut is named the way Lightricks' guide names one", () => {
  const p = three();
  p.render.engine = "ltx25";
  p.shots[1].cutVerb = "the shot switches to";
  const { text } = compilePrompt(p);
  assert.match(text, /At 00:03\.000, a hard cut transitions to a close-up shot/);
  assert.match(text, /At 00:06\.000, a hard cut transitions to a medium shot/);
  p.shots[2].cutVerb = "the shot dissolves to";
  assert.match(compilePrompt(p).text, /At 00:06\.000, the shot dissolves to/);
  assert.equal(cutVerbFor("the camera cuts to", "minimax"), "the camera cuts to", "MiniMax keeps the guide's verb");
  assert.equal(cutVerbFor(NO_CUT, "ltx25"), NO_CUT);
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
