/* The post-render upscale pass: which nodes it adds, where it rewires the
 * mux, when it is a no-op, and how it moves the time estimate. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { blankProject, newBeat } from "../web/js/state.js";
import { buildWorkflow, estimateSeconds, upscalePlan, upscaleSettings } from "../web/js/workflow.js";
import { DEFAULT_MODELS } from "../web/js/backend/settings.js";

const settings = { models: { ...DEFAULT_MODELS } };

function project({ engine = "off", target = "1080p", resolution = "832x480", renderEngine = "minimax" } = {}) {
  const p = blankProject();
  p.mode = "t2v";
  p.render.engine = renderEngine;
  if (renderEngine === "ltx25") p.render.variant = "ltx_two";
  p.render.resolution = resolution;
  p.render.upscale = { engine, target };
  p.shots[0].subject = "a baker in a flour-dusted apron";
  p.shots[0].beats = [newBeat("lifts the shutter", "")];
  return p;
}
const byType = (graph, type) => Object.entries(graph).filter(([, n]) => n.class_type === type);

test("off: no upscale nodes, the mux takes the decoded frames", () => {
  const { prompt, meta } = buildWorkflow(project(), settings);
  assert.equal(byType(prompt, "SeedVR2VideoUpscaler").length, 0);
  assert.equal(byType(prompt, "ImageUpscaleWithModel").length, 0);
  assert.deepEqual(prompt["18"].inputs.images, ["16", 0]);
  assert.equal(meta.upscale, null);
  assert.equal(meta.stockNodesOnly, true);
});

test("SeedVR2 to 1080p: loader, VAE and upscaler, short edge 1080, mux rewired", () => {
  const { prompt, meta } = buildWorkflow(project({ engine: "seedvr2" }), settings);
  const [[id, node]] = byType(prompt, "SeedVR2VideoUpscaler");
  assert.equal(node.inputs.resolution, 1080);
  assert.deepEqual(node.inputs.image, ["16", 0]);
  assert.equal(node.inputs.batch_size % 4, 1, "SeedVR2 batches are 4n+1");
  assert.deepEqual(prompt["18"].inputs.images, [id, 0]);
  assert.equal(byType(prompt, "SeedVR2LoadDiTModel")[0][1].inputs.model, DEFAULT_MODELS.seedvr2_dit);
  assert.equal(byType(prompt, "SeedVR2LoadVAEModel")[0][1].inputs.decode_tiled, false, "1080p decodes untiled");
  assert.equal(meta.upscale.width, 1872);   // 832x480 is 1.733:1, so 1080p is 1872 wide, not 1920
  assert.equal(meta.upscale.height, 1080);
  assert.equal(meta.stockNodesOnly, false);
  assert.ok(meta.nodeTypes.includes("SeedVR2VideoUpscaler"));
});

test("SeedVR2 to 4K tiles its VAE", () => {
  const { prompt, meta } = buildWorkflow(project({ engine: "seedvr2", target: "2160p" }), settings);
  assert.equal(byType(prompt, "SeedVR2LoadVAEModel")[0][1].inputs.decode_tiled, true);
  assert.equal(meta.upscale.height, 2160);
});

test("ESRGAN: ×4 model then an exact Lanczos resize, stock nodes only", () => {
  const { prompt, meta } = buildWorkflow(project({ engine: "esrgan", target: "1440p" }), settings);
  assert.equal(byType(prompt, "UpscaleModelLoader")[0][1].inputs.model_name, DEFAULT_MODELS.esrgan);
  const [[scaleId, scale]] = byType(prompt, "ImageScale").filter(([, n]) => n._meta.title.startsWith("Resize"));
  assert.equal(scale.inputs.width, 2496);
  assert.equal(scale.inputs.height, 1440);
  assert.deepEqual(prompt["18"].inputs.images, [scaleId, 0]);
  assert.equal(meta.stockNodesOnly, true);
});

test("a target no larger than the canvas is a no-op", () => {
  assert.equal(upscalePlan(project({ engine: "seedvr2", target: "720p", resolution: "1344x768" })), null);
  const { prompt, meta } = buildWorkflow(project({ engine: "esrgan", target: "720p", resolution: "1344x768" }), settings);
  assert.equal(byType(prompt, "ImageUpscaleWithModel").length, 0);
  assert.equal(meta.upscale, null);
});

test("the LTX-2.5 graph gets the same pass after its tiled decode", () => {
  const { prompt } = buildWorkflow(project({ engine: "esrgan", renderEngine: "ltx25" }), settings);
  const [[id, node]] = byType(prompt, "ImageUpscaleWithModel");
  assert.deepEqual(node.inputs.image, ["32", 0]);
  const resize = byType(prompt, "ImageScale").find(([, n]) => n.inputs.image?.[0] === id);
  assert.ok(resize);
  assert.deepEqual(prompt["34"].inputs.images, [resize[0], 0]);
});

test("old projects without the field default to off; the ETA grows with the pass", () => {
  const p = project();
  delete p.render.upscale;
  assert.deepEqual(upscaleSettings(p), { engine: "off", target: "1080p" });
  const base = estimateSeconds(project());
  const esr = estimateSeconds(project({ engine: "esrgan" }));
  const seed = estimateSeconds(project({ engine: "seedvr2" }));
  assert.ok(esr > base && seed > esr, `${base} < ${esr} < ${seed}`);
});
