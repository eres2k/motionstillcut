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

test("SeedVR2 to 1080p: loader, VAE and upscaler, short edge 1080, a fit resize, mux rewired", () => {
  const { prompt, meta } = buildWorkflow(project({ engine: "seedvr2" }), settings);
  const [[id, node]] = byType(prompt, "SeedVR2VideoUpscaler");
  assert.equal(node.inputs.resolution, 1080);
  assert.deepEqual(node.inputs.image, ["16", 0]);
  assert.equal(node.inputs.batch_size % 4, 1, "SeedVR2 batches are 4n+1");
  assert.ok(node.inputs.batch_size >= 13, "batches of five visibly flicker");
  assert.ok(node.inputs.temporal_overlap >= 4);
  const [[fitId, fit]] = byType(prompt, "ImageScale").filter(([, n]) => n.inputs.image?.[0] === id);
  assert.equal(fit.inputs.width, 1872);   // 832x480 is 1.733:1, so 1080p is 1872 wide, not 1920
  assert.equal(fit.inputs.height, 1080);
  assert.deepEqual(prompt["18"].inputs.images, [fitId, 0]);
  assert.equal(byType(prompt, "SeedVR2LoadDiTModel")[0][1].inputs.model, DEFAULT_MODELS.seedvr2_dit);
  assert.equal(byType(prompt, "SeedVR2LoadVAEModel")[0][1].inputs.decode_tiled, true, "the batched decode is what fills the card");
  assert.equal(meta.upscale.width, 1872);
  assert.equal(meta.upscale.height, 1080);
  assert.equal(meta.stockNodesOnly, false);
  assert.ok(meta.nodeTypes.includes("SeedVR2VideoUpscaler"));
});

test("SeedVR2 to 4K diffuses at 1080p and a Lanczos resize finishes", () => {
  const { prompt, meta } = buildWorkflow(project({ engine: "seedvr2", target: "2160p" }), settings);
  const [[id, node]] = byType(prompt, "SeedVR2VideoUpscaler");
  assert.equal(node.inputs.resolution, 1080);
  const [[, resize]] = byType(prompt, "ImageScale").filter(([, n]) => n.inputs.image?.[0] === id);
  assert.equal(resize.inputs.height, 2160);
  assert.equal(resize.inputs.upscale_method, "lanczos");
  assert.equal(meta.upscale.height, 2160);
});

test("FlashVSR: ×2 for a 1080p target from 480p, ×4 above, long mode past ten seconds", () => {
  const short = buildWorkflow(project({ engine: "flashvsr" }), settings);
  const [[id, node]] = byType(short.prompt, "FlashVSRNode");
  assert.deepEqual(node.inputs.frames, ["16", 0]);
  assert.equal(node.inputs.scale, 4);        // 480 → 1080 is ×2.25, past what ×2 gives
  assert.equal(node.inputs.mode, "tiny");
  assert.deepEqual(short.prompt["18"].inputs.images, ["202", 0]);
  assert.equal(short.prompt["202"].inputs.image[0], id);
  assert.equal(short.meta.stockNodesOnly, false);
  const p = project({ engine: "flashvsr", target: "720p" });
  p.render.duration = 15;
  const long = buildWorkflow(p, settings);
  const [[, longNode]] = byType(long.prompt, "FlashVSRNode");
  assert.equal(longNode.inputs.scale, 2);    // 480 → 720 is ×1.5
  assert.equal(longNode.inputs.mode, "tiny-long");
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
  assert.deepEqual(upscaleSettings(p), { engine: "off", target: "1080p", ltxMethod: "iclora", ltxFidelity: "balanced" });
  const base = estimateSeconds(project());
  const esr = estimateSeconds(project({ engine: "esrgan" }));
  const seed = estimateSeconds(project({ engine: "seedvr2" }));
  assert.ok(esr > base && seed > esr, `${base} < ${esr} < ${seed}`);
});

test("LTX-2.5 IC-LoRA (the default) on an H3 render: Lightricks' wiring, node for node", () => {
  const p0 = project({ engine: "ltx25" }); p0.render.upscale.ltxFidelity = "creative";   // the official ladder
  const { prompt, meta } = buildWorkflow(p0, settings);   // 124 frames at 832x480
  assert.equal(prompt["100"].class_type, "UNETLoader");
  assert.equal(prompt["107"].inputs.length, 121, "trimmed to LTX's 8k+1 grid");
  assert.deepEqual(prompt["108"].inputs.image, ["107", 0]);
  assert.equal(prompt["108"].inputs.width, 1664);          // Lanczos-doubled canvas: start latent and reference
  assert.deepEqual(prompt["109"].inputs.pixels, ["108", 0]);
  assert.equal(prompt["110"].class_type, "LTXICLoRALoaderModelOnly");
  assert.equal(prompt["110"].inputs.lora_name, DEFAULT_MODELS.ltx25_upscale_lora);
  assert.equal(prompt["110"].inputs.strength_model, 1, "the weights ship pre-scaled: full strength is the default");
  const guide = prompt["112"];
  assert.equal(guide.class_type, "LTXAddVideoICLoRAGuide");
  assert.deepEqual(guide.inputs.latent, ["109", 0]);
  assert.deepEqual(guide.inputs.image, ["108", 0]);
  assert.deepEqual(guide.inputs.latent_downscale_factor, ["110", 1], "the loader reports the LoRA's factor");
  assert.deepEqual(prompt["113"].inputs.video_latent, ["112", 2]);
  assert.equal(prompt["114"].inputs.sigmas.split(",").length, 9, "the full eight-step ladder");
  assert.deepEqual(prompt["115"].inputs.model, ["110", 0]);
  assert.deepEqual(prompt["115"].inputs.positive, ["112", 0]);
  assert.equal(prompt["117"].inputs.sampler_name, "euler_ancestral");
  assert.deepEqual(prompt["120"].inputs.latent, ["119", 0]);
  assert.equal(prompt["121"].class_type, "LTXVTiledVAEDecode");
  assert.deepEqual(prompt["121"].inputs.latents, ["120", 2], "the reference is cropped off before decode");
  assert.deepEqual(prompt["202"].inputs.image, ["121", 0]);
  assert.equal(prompt["202"].inputs.height, 1080);
  assert.deepEqual(prompt["18"].inputs.images, ["202", 0]);
  assert.deepEqual(prompt["18"].inputs.audio, ["17", 0], "the render's own soundtrack is kept");
  assert.equal(meta.stockNodesOnly, false);
});

test("LTX-2.5 refine pass (the fallback): latent upsampler ×2 and three steps, official sampler", () => {
  const p = project({ engine: "ltx25" });
  p.render.upscale.ltxMethod = "refine"; p.render.upscale.ltxFidelity = "creative";
  const { prompt } = buildWorkflow(p, settings);
  assert.equal(prompt["107"].inputs.length, 121);
  assert.equal(prompt["124"].class_type, "LTXVImgToVideoInplace", "the first frame is re-anchored after the upsampler");
  assert.deepEqual(prompt["124"].inputs.latent, ["110", 0]);
  assert.equal(prompt["124"].inputs.strength, 1);
  assert.deepEqual(prompt["112"].inputs.video_latent, ["124", 0]);
  assert.deepEqual(prompt["112"].inputs.audio_latent, ["111", 0], "an H3 render gets a silent audio latent");
  assert.deepEqual(prompt["108"].inputs.pixels, ["107", 0]);
  assert.equal(prompt["110"].class_type, "LTXVLatentUpsampler");
  assert.equal(prompt["113"].inputs.sigmas.split(",").length, 4, "three steps");
  assert.equal(prompt["116"].inputs.sampler_name, "euler_ancestral");
  assert.equal(prompt["119"].class_type, "VAEDecodeTiled");
  assert.deepEqual(prompt["202"].inputs.image, ["119", 0]);
  assert.deepEqual(prompt["18"].inputs.images, ["202", 0]);
  assert.equal(byType(prompt, "LTXAddVideoICLoRAGuide").length, 0, "no reference guide on the refine path");
});

test("LTX-2.5 on an LTX render reuses its loaders and needs no trim", () => {
  const { prompt } = buildWorkflow(project({ engine: "ltx25", renderEngine: "ltx25" }), settings);   // 121 frames
  assert.equal(prompt["100"], undefined);
  assert.equal(prompt["107"], undefined);
  assert.deepEqual(prompt["108"].inputs.image, ["32", 0]);
  assert.deepEqual(prompt["110"].inputs.model, ["1", 0]);
  assert.deepEqual(prompt["112"].inputs.positive, ["7", 0]);
  assert.deepEqual(prompt["113"].inputs.audio_latent, ["30", 1], "an LTX render hands over its own audio latent");
  assert.equal(prompt["111"], undefined, "so no silent one is made");
  assert.deepEqual(prompt["34"].inputs.images, ["202", 0]);
});

test("fidelity trims the ladder from the top and never invents a sigma", () => {
  const ladder = (method, fidelity) => {
    const p = project({ engine: "ltx25" });
    p.render.upscale.ltxMethod = method; p.render.upscale.ltxFidelity = fidelity;
    const { prompt } = buildWorkflow(p, settings);
    const id = method === "iclora" ? "114" : "113";
    return prompt[id].inputs.sigmas.split(",").map(Number);
  };
  const full = ladder("iclora", "creative");
  assert.equal(full.length, 9);
  for (const f of ["balanced", "faithful"]) {
    const l = ladder("iclora", f);
    assert.deepEqual(l, full.slice(full.length - l.length), `${f} is a suffix of the official ladder`);
  }
  assert.equal(ladder("iclora", "balanced")[0], 0.909375);
  assert.equal(ladder("refine", "creative")[0], 0.85);
  assert.equal(ladder("refine", "balanced")[0], 0.725);
  assert.deepEqual(ladder("refine", "faithful"), [0.4219, 0]);
  assert.equal(upscaleSettings(project({ engine: "ltx25" })).ltxFidelity, "balanced", "the default");
  assert.ok(estimateSeconds(Object.assign(project({ engine: "ltx25" }), { render: { ...project({ engine: "ltx25" }).render, upscale: { engine: "ltx25", target: "1080p", ltxFidelity: "creative" } } }))
    > estimateSeconds(Object.assign(project({ engine: "ltx25" }), { render: { ...project({ engine: "ltx25" }).render, upscale: { engine: "ltx25", target: "1080p", ltxFidelity: "faithful" } } })), "more steps, more time");
});

test("an LTX render with a first frame keeps its pass-1 guide at id 60 — the upscale must not overwrite it", () => {
  const p = project({ engine: "seedvr2", renderEngine: "ltx25" });
  p.mode = "i2v";
  p.frames.first = { id: "ff", name: "first.png", kind: "image", comfyName: "first.png" };
  p.render.seed = 624119881696;   // the seed that failed validation on the 5090
  const { prompt } = buildWorkflow(p, settings);
  assert.equal(prompt["60"]?.class_type, "LTXVAddGuide", "pass-1 guide survives");
  assert.equal(prompt["15"].inputs.positive[0], "60");
  assert.equal(prompt["200"].class_type, "SeedVR2LoadDiTModel");
  const [[, seedvr]] = byType(prompt, "SeedVR2VideoUpscaler");
  assert.ok(seedvr.inputs.seed <= 4294967295 && seedvr.inputs.seed >= 0, `32-bit seed, got ${seedvr.inputs.seed}`);
  assert.deepEqual(prompt["34"].inputs.images, ["202", 0]);
  for (const id of ["60", "70", "50"]) assert.notEqual(prompt[id]?.class_type, "SeedVR2LoadDiTModel");
});

test("FlashVSR gets a 32-bit seed too", () => {
  const p = project({ engine: "flashvsr" });
  p.render.seed = 91967862911;
  const { prompt } = buildWorkflow(p, settings);
  const [[, node]] = byType(prompt, "FlashVSRNode");
  assert.ok(node.inputs.seed <= 4294967295);
});

test("the IC-LoRA costs more time than the refine pass", () => {
  const ic = estimateSeconds(project({ engine: "ltx25" }));
  const p = project({ engine: "ltx25" }); p.render.upscale.ltxMethod = "refine";
  assert.ok(ic > estimateSeconds(p));
});
