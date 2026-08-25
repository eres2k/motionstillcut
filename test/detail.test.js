/* THE DETAIL DIAL — how much each shot says. It steers the writer, never
 * the render, and never rewrites text by itself. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DIALS, DEFAULT_DIALS, detailToWriting, detailSays, explainDials, applySteering } from "../web/js/steer.js";
import { blankProject, newBeat } from "../web/js/state.js";

test("detail is a dial with a default, and it is not per-shot", () => {
  const d = DIALS.find(x => x.id === "detail");
  assert.ok(d && !d.perShot);
  assert.equal(DEFAULT_DIALS.detail, 50);
});

test("four bands, each with a word target and a concrete rule", () => {
  assert.deepEqual([0, 30, 60, 100].map(v => detailToWriting(v).name), ["spare", "measured", "rich", "exhaustive"]);
  const words = [0, 30, 60, 100].map(v => detailToWriting(v).wordsPerShot);
  assert.ok(words.every((w, i) => i === 0 || w > words[i - 1]), "targets rise with the dial");
  for (const v of [0, 30, 60, 100]) assert.match(detailToWriting(v).rules, /subject|RICH|EXHAUSTIVE/i);
  assert.equal(detailToWriting(-5).name, "spare");
  assert.equal(detailToWriting(500).name, "exhaustive");
});

test("the explain line states the target per shot and for the clip", () => {
  const p = blankProject();
  p.creative.dials = { ...DEFAULT_DIALS, detail: 80 };
  const e = explainDials(p).find(x => x.id === "detail");
  assert.match(e.text, /exhaustive · about 100 words a shot/);
  assert.equal(detailSays(10, 3), "spare · about 25 words a shot, ~75 in all");
});

test("moving the dial rewrites nothing the creator typed", () => {
  const p = blankProject();
  p.shots[0].subject = "a courier in a wet jacket";
  p.shots[0].beats = [newBeat("shakes the rain off")];
  p.shots[0].details = "a cracked phone screen glows in the pocket";
  p.creative.dials = { ...DEFAULT_DIALS, detail: 0 };
  applySteering(p);
  assert.equal(p.shots[0].subject, "a courier in a wet jacket");
  assert.equal(p.shots[0].details, "a cracked phone screen glows in the pocket");
  assert.equal(p.shots[0].beats[0].text, "shakes the rain off");
});
