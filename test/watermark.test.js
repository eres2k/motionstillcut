/* The watermark: where the signature lands, what the client mark covers, and
 * the three stock nodes that stamp it onto every frame after the upscale. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { blankProject, newBeat } from "../web/js/state.js";
import { buildWorkflow, deliveredSize } from "../web/js/workflow.js";
import { watermarkLayout, watermarkFileName, watermarkSettings } from "../web/js/watermark.js";
import { DEFAULT_MODELS } from "../web/js/backend/settings.js";

const settings = { models: { ...DEFAULT_MODELS }, watermark: { text: "Erwin Esener" } };

function project({ watermark = "signature", upscale = null, engine = "minimax" } = {}) {
  const p = blankProject();
  p.mode = "t2v";
  p.render.engine = engine;
  if (engine === "ltx25") p.render.variant = "ltx_two";
  p.render.watermark = watermark;
  if (upscale) p.render.upscale = upscale;
  p.shots[0].subject = "a baker in a flour-dusted apron";
  p.shots[0].beats = [newBeat("lifts the shutter", "")];
  return p;
}

test("the signature is a small box inside the bottom-right corner", () => {
  const l = watermarkLayout("signature", 1920, 1080, "Erwin Esener");
  assert.equal(l.mode, "signature");
  assert.ok(l.width < 1920 / 3 && l.height < 1080 / 8, `${l.width}x${l.height}`);
  assert.ok(l.x + l.width < 1920 && l.y + l.height < 1080, "inside the frame");
  assert.ok(l.x > 1920 * 0.6 && l.y > 1080 * 0.85, "in the corner");
  const small = watermarkLayout("signature", 832, 480, "Erwin Esener");
  assert.ok(small.font < l.font, "type scales with the frame");
  assert.ok(small.font >= 14, "and never below legible");
});

test("the client mark covers the whole frame and still carries the signature", () => {
  const l = watermarkLayout("client", 1872, 1080, "Erwin Esener");
  assert.equal(l.mode, "client");
  assert.deepEqual([l.x, l.y, l.width, l.height], [0, 0, 1872, 1080]);
  assert.ok(l.tile.font > l.font * 3, "the tiled text is big");
  assert.ok(l.tile.opacity > 0 && l.tile.opacity < 0.5, "and translucent");
  assert.ok(l.signature.x + l.signature.boxW <= 1872 && l.signature.y + l.signature.boxH <= 1080);
});

test("the input file name repeats for the same mark and changes with the name or size", () => {
  const a = watermarkFileName("client", "Erwin Esener", 1920, 1080);
  assert.equal(a, watermarkFileName("client", "Erwin Esener", 1920, 1080));
  assert.notEqual(a, watermarkFileName("client", "Someone Else", 1920, 1080));
  assert.notEqual(a, watermarkFileName("client", "Erwin Esener", 3840, 2160));
  assert.notEqual(a, watermarkFileName("signature", "Erwin Esener", 1920, 1080));
  assert.match(a, /^mscut_wm_client_[0-9a-f]{8}\.png$/);
});

test("mode comes from the project, the name from the browser's settings", () => {
  assert.deepEqual(watermarkSettings(project({ watermark: "client" }), settings), { mode: "client", text: "Erwin Esener" });
  assert.deepEqual(watermarkSettings(project({ watermark: "client" }), { watermark: { text: "  " } }), { mode: "client", text: "" });
  const old = project(); delete old.render.watermark;
  assert.equal(watermarkSettings(old, settings).mode, "off");
});

test("without an uploaded mark the graph is untouched", () => {
  const { prompt, meta } = buildWorkflow(project(), settings);
  assert.equal(prompt["210"], undefined);
  assert.deepEqual(prompt["18"].inputs.images, ["16", 0]);
  assert.equal(meta.watermark, null);
});

test("with one, three stock nodes stamp every frame last — after the upscale", () => {
  const wm = { file: "mscut_wm_signature_deadbeef.png", mode: "signature", x: 1500, y: 1000 };
  const plain = buildWorkflow(project(), settings, { watermark: wm });
  assert.equal(plain.prompt["210"].class_type, "LoadImage");
  assert.equal(plain.prompt["210"].inputs.image, wm.file);
  assert.deepEqual(plain.prompt["211"].inputs.mask, ["210", 1]);
  const stamp = plain.prompt["212"];
  assert.equal(stamp.class_type, "ImageCompositeMasked");
  assert.deepEqual(stamp.inputs.destination, ["16", 0]);
  assert.deepEqual(stamp.inputs.mask, ["211", 0]);
  assert.equal(stamp.inputs.x, 1500);
  assert.equal(stamp.inputs.resize_source, false);
  assert.deepEqual(plain.prompt["18"].inputs.images, ["212", 0]);
  assert.deepEqual(plain.meta.watermark, { mode: "signature", file: wm.file });
  assert.equal(plain.meta.stockNodesOnly, true, "the stamp is stock");

  const up = buildWorkflow(project({ upscale: { engine: "esrgan", target: "1080p" } }), settings, { watermark: wm });
  assert.deepEqual(up.prompt["212"].inputs.destination, ["202", 0], "stamped after the resize");
  assert.deepEqual(up.prompt["18"].inputs.images, ["212", 0]);

  const ltx = buildWorkflow(project({ engine: "ltx25" }), settings, { watermark: wm });
  assert.deepEqual(ltx.prompt["212"].inputs.destination, ["32", 0]);
  assert.deepEqual(ltx.prompt["34"].inputs.images, ["212", 0]);
});

test("the mark is drawn at the delivered size, upscale included", () => {
  assert.deepEqual(deliveredSize(project()), { width: 832, height: 480 });
  assert.deepEqual(deliveredSize(project({ upscale: { engine: "esrgan", target: "2160p" } })), { width: 3744, height: 2160 });
});
