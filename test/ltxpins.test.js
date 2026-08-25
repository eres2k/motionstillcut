/* WHAT LTXVAddGuide DOES QUIETLY — the two things about timeline pins that
 * ComfyUI accepts without comment and that read as model failure:
 *
 *   1. A guide sits on the video VAE's temporal stride of 8 (comfy_extras/
 *      nodes_lt.py: a single image lands on latent ceil(idx / 8)). The node
 *      rounds to it silently, so a pin off the grid moves by up to 4 frames
 *      and the result looks like drift. The app rounds the same way the
 *      graph does, and shows it.
 *   2. Identical guides at several times tell the model the pose does not
 *      change — the character freezes between them. Reported by testers of
 *      multi-point guidance on LTX-2.5; the intuitive gesture (same cast
 *      picture at every cut) is exactly the one that produces it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { blankProject, newBeat, newShot, ltxGuideIdx, ltxGuideTime, LTX_DURATION_FRAMES } from "../web/js/state.js";
import { validate } from "../web/js/prompt.js";
import { buildWorkflow } from "../web/js/workflow.js";

const img = (id, name = `${id}.png`) => ({ id, name, kind: "image", comfyName: name });

function ltxProject() {
  const p = blankProject();
  p.mode = "t2v";
  p.render.engine = "ltx25";
  p.render.variant = "ltx_two";
  p.render.duration = 10;
  p.shots[0].subject = "a baker in a flour-dusted apron";
  p.shots[0].beats = [newBeat("lifts the shutter", "")];
  p.shots[0].setting = "a street bakery before sunrise";
  p.sound.soundscape = "a shutter rattling up, early traffic two streets away";
  p.sound.musicOff = true;
  const s2 = newShot(); s2.at = 4.2; s2.subject = "the baker"; s2.beats = [newBeat("turns to the oven", "")];
  const s3 = newShot(); s3.at = 8;   s3.subject = "the baker"; s3.beats = [newBeat("pulls out a tray", "")];
  p.shots.push(s2, s3);
  return p;
}
const msgs = (p) => validate(p).checks.map(c => `${c.level}: ${c.msg}`);

test("guide indices sit on the 8-frame stride and inside the clip", () => {
  const p = ltxProject();
  assert.equal(ltxGuideIdx(0, p), 0);
  assert.equal(ltxGuideIdx(4.2, p), 104, "4.2 s × 24 = 100.8 → nearest multiple of 8");
  assert.equal(ltxGuideIdx(8, p), 192);
  assert.equal(ltxGuideIdx(99, p), LTX_DURATION_FRAMES[10] - 1, "clamped to the last frame");
  assert.ok(Math.abs(ltxGuideTime(4.2, p) - 104 / 24) < 1e-9);
});

test("the graph anchors where the helper says it will", () => {
  const p = ltxProject();
  p.shots[1].keyframe = img("a");
  p.shots[2].keyframe = img("b");
  const { meta } = buildWorkflow(p, { models: {} });
  assert.deepEqual(meta.guides.map(g => g.frameIdx), [104, 192]);
});

test("a pin off the grid is reported with where it lands", () => {
  const p = ltxProject();
  p.shots[1].keyframe = img("a");
  const m = msgs(p);
  assert.ok(m.some(x => /shot 2 4\.20s → 4\.33s/.test(x)), m.join("\n"));
});

test("a pin on the grid says nothing about moving", () => {
  const p = ltxProject();
  p.shots[2].keyframe = img("b");
  assert.ok(!msgs(p).some(x => /8-frame grid/.test(x)));
});

test("the same picture pinned at two cuts warns about freezing", () => {
  const p = ltxProject();
  p.shots[1].keyframe = img("same");
  p.shots[2].keyframe = img("same");
  const m = msgs(p);
  assert.ok(m.some(x => x.startsWith("warn:") && /pinned at shot 2, shot 3/.test(x) && /freezes/.test(x)), m.join("\n"));
});

test("the I2V first frame counts as a pin at 0", () => {
  const p = ltxProject();
  p.mode = "i2v";
  p.frames.first = img("same");
  p.shots[2].keyframe = img("same");
  const m = msgs(p);
  assert.ok(m.some(x => /pinned at the first frame, shot 3/.test(x)), m.join("\n"));
});

test("different pictures, or a weak second pin, do not warn", () => {
  const p = ltxProject();
  p.shots[1].keyframe = img("a");
  p.shots[2].keyframe = img("b");
  assert.ok(!msgs(p).some(x => /freezes/.test(x)));
  p.shots[2].keyframe = img("a");
  p.shots[2].keyframeStrength = 0.5;
  assert.ok(!msgs(p).some(x => /freezes/.test(x)));
});

test("none of it fires on the MiniMax engine, which has no guides", () => {
  const p = ltxProject();
  p.render.engine = "minimax";
  p.shots[1].keyframe = img("same");
  p.shots[2].keyframe = img("same");
  const m = msgs(p);
  assert.ok(!m.some(x => /freezes|8-frame grid/.test(x)));
  assert.ok(m.some(x => /pins only apply on the LTX-2.5 engine/.test(x)));
});

/* ── The checks name the switch ───────────────────────────── */

test("a clip past H3's ceiling offers the LTX switch, where LTX can render it", () => {
  const p = ltxProject();
  p.render.engine = "minimax";
  p.render.duration = 20;
  const c = validate(p).checks.find(x => /past H3's/.test(x.msg));
  assert.ok(c, "the ceiling check fires");
  assert.equal(c.action?.kind, "engine");
  assert.equal(c.action?.engine, "ltx25");
});

test("pins on the MiniMax engine offer the switch — but not in Ref2V, which has no LTX", () => {
  const p = ltxProject();
  p.render.engine = "minimax";
  p.shots[1].keyframe = img("a");
  const c = validate(p).checks.find(x => /pins only apply/.test(x.msg));
  assert.equal(c?.action?.engine, "ltx25");
  p.mode = "r2v";
  const r = validate(p).checks.find(x => /pins only apply/.test(x.msg));
  assert.ok(r && !r.action, "Ref2V gets the warning without a switch it cannot make");
});
