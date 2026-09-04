/* The VRAM fit estimate: calibrated on one real failure (736 frames at
 * 1344x768, six references at "max", on a 32 GB card) and expected to say
 * "no" to it, "ok" to a plain 5 s clip, and to move the right way with every
 * lever the Deliver page offers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { blankProject } from "../web/js/state.js";
import { estimateVram, vramLevers } from "../web/js/workflow.js";

const CARD = 31.4; // what ComfyUI reports for a 32 GB RTX 5090

function refProject({ resolution = "832x480", duration = 5, refs = 6, refImageSize = "match", precision = "int8" } = {}) {
  const p = blankProject();
  p.mode = "r2v";
  p.render.engine = "minimax";
  p.render.variant = "full";
  p.render.resolution = resolution;
  p.render.duration = duration;
  p.render.refImageSize = refImageSize;
  p.render.precision = precision;
  p.refs.images = Array.from({ length: refs }, (_, i) => ({ id: `r${i}`, name: `r${i}.jpg`, kind: "image", comfyName: `r${i}.jpg` }));
  return p;
}

test("the render that died on the 5090 is called out before it is queued", () => {
  const fit = estimateVram(refProject({ resolution: "1344x768", duration: 30, refImageSize: "max" }), { cardGB: CARD });
  assert.equal(fit.verdict, "no");
  assert.ok(fit.tokens > 200_000 && fit.tokens < 300_000, `tokens ${fit.tokens}`);
  assert.ok(fit.needGB > CARD);
  assert.equal(fit.precision, "int8");
});

test("a plain 5 s clip at 480p is fine", () => {
  const p = blankProject();
  p.mode = "t2v"; p.render.engine = "minimax";
  const fit = estimateVram(p, { cardGB: CARD });
  assert.equal(fit.verdict, "ok");
  assert.equal(fit.refs, 0);
  assert.ok(fit.needGB < 12, `need ${fit.needGB}`);
});

test("30 s at 480p with six references at match fits, but tightly", () => {
  const fit = estimateVram(refProject({ duration: 30 }), { cardGB: CARD });
  assert.equal(fit.verdict, "tight");
  assert.ok(fit.tokens > 90_000 && fit.tokens < 130_000, `tokens ${fit.tokens}`);
});

test("every lever moves the estimate the right way", () => {
  const base = estimateVram(refProject({ resolution: "1344x768", duration: 30, refImageSize: "max" }), { cardGB: CARD });
  const shorter = estimateVram(refProject({ resolution: "1344x768", duration: 15, refImageSize: "max" }), { cardGB: CARD });
  const smaller = estimateVram(refProject({ resolution: "832x480", duration: 30, refImageSize: "max" }), { cardGB: CARD });
  const match = estimateVram(refProject({ resolution: "1344x768", duration: 30, refImageSize: "match" }), { cardGB: CARD });
  const fewer = estimateVram(refProject({ resolution: "1344x768", duration: 30, refImageSize: "max", refs: 2 }), { cardGB: CARD });
  const nvfp4 = estimateVram(refProject({ resolution: "1344x768", duration: 30, refImageSize: "max", precision: "nvfp4" }), { cardGB: CARD });
  for (const [name, fit] of Object.entries({ shorter, smaller, match, fewer, nvfp4 })) {
    assert.ok(fit.needGB < base.needGB, `${name} should need less than ${base.needGB} but needs ${fit.needGB}`);
  }
  // NVFP4 writes bf16 where int8 writes int32: activations halve, and the DiT is 12 GB instead of 20.
  assert.ok(Math.abs(nvfp4.activationsGB * 2 - base.activationsGB) < 0.01);
  assert.ok(nvfp4.comfortableGB < base.comfortableGB - 7);
});

test("references at max cost far more than at match, and known sizes are honoured", () => {
  const match = estimateVram(refProject({ refImageSize: "match" }), { cardGB: CARD });
  const max = estimateVram(refProject({ refImageSize: "max" }), { cardGB: CARD });
  assert.ok(max.refs > match.refs * 4, `max ${max.refs} vs match ${match.refs}`);
  const p = refProject({ refImageSize: "max", refs: 1 });
  p.refs.images[0].width = 640; p.refs.images[0].height = 480; // never upscaled at "max"
  const small = estimateVram(p, { cardGB: CARD });
  assert.equal(small.refs, Math.floor(640 / 32) * Math.floor(480 / 32));
});

test("no model for LTX-2.5, and no verdict without a card size", () => {
  const p = blankProject();
  p.mode = "t2v"; p.render.engine = "ltx25"; p.render.variant = "ltx_two";
  assert.equal(estimateVram(p, { cardGB: CARD }), null);
  const fit = estimateVram(refProject(), {});
  assert.equal(fit.verdict, "unknown");
  assert.equal(fit.cardGB, null);
});

test("the levers list names only what the project has not pulled yet", () => {
  const heavy = refProject({ resolution: "1344x768", duration: 30, refImageSize: "max" });
  assert.deepEqual(vramLevers(heavy, estimateVram(heavy, { cardGB: CARD })),
    ["a shorter clip", "a lower resolution", "references at “match”", "fewer reference pictures", "the NVFP4 build"]);
  const light = refProject({ refs: 2, precision: "nvfp4" });
  assert.deepEqual(vramLevers(light, estimateVram(light, { cardGB: CARD })), []);
});
