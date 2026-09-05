/* WHAT AUDIO CONDITIONING MUST WIRE, EXACTLY — the three things about a
 * conditioned AV latent that ComfyUI accepts silently and that come back as
 * "the model ignored my track":
 *
 *   1. The encoded audio has to be NOISE-MASKED (SetLatentNoiseMask over a
 *      SolidMask of 0). Without the mask the sampler treats the encoded
 *      track as starting noise and denoises it away — the graph runs, the
 *      clip plays, and the sound is the model's own invention.
 *   2. The trim has to match the clip: (numFrames − 1) / fps seconds from
 *      the chosen offset. A track longer than the clip would otherwise
 *      stretch the latent grid, and one trimmed to the wrong length
 *      conditions the wrong seconds.
 *   3. With vocal separation the ENCODER eats the stem but the MUX keeps the
 *      full track — unless the stem is the deliverable. Swapping those two
 *      references produces either a clip that lost its music or lip-sync
 *      fighting the bassline, with nothing erroring anywhere.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { blankProject, newBeat, LTX_DURATION_FRAMES } from "../web/js/state.js";
import { validate } from "../web/js/prompt.js";
import { buildWorkflow, ltxAudioSettings } from "../web/js/workflow.js";

const MODELS = {
  ltx25_dit: "dit.safetensors", ltx25_text_encoder: "te.safetensors",
  ltx25_video_vae: "vvae.safetensors", ltx25_audio_vae: "avae.safetensors",
  ltx25_upscaler: "up.safetensors", mel_band_roformer: "mel.safetensors",
};

function ltxProject() {
  const p = blankProject();
  p.mode = "t2v";
  p.render.engine = "ltx25";
  p.render.variant = "ltx_two";
  p.render.duration = 10;
  p.shots[0].subject = "a singer at a worn microphone";
  p.shots[0].beats = [newBeat("leans in and sings the first line", "")];
  p.shots[0].setting = "a small club after hours";
  return p;
}
const track = (over = {}) => ({ item: { id: "m1", name: "song.wav", kind: "audio", comfyName: "song.wav" }, startSec: 0, separateVocals: false, vocalsOnly: false, ...over });
const build = (p) => buildWorkflow(p, { models: MODELS }).prompt;
const msgs = (p) => validate(p).checks.map(c => `${c.level}: ${c.msg}`);

test("no track — the audio half is the empty latent, as it always was", () => {
  const g = build(ltxProject());
  assert.equal(g["12"].class_type, "LTXVEmptyLatentAudio");
  assert.deepEqual(g["13"].inputs.audio_latent, ["12", 0]);
  assert.deepEqual(g["34"].inputs.audio, ["33", 0]);
  for (const id of ["80", "81", "82", "83", "84", "85"]) assert.equal(g[id], undefined, `node ${id} must not exist without a track`);
});

test("a track replaces the empty latent: load → trim → encode → mask → concat", () => {
  const p = ltxProject();
  p.render.ltxAudio = track({ startSec: 7.5 });
  const g = build(p);
  assert.equal(g["80"].class_type, "LoadAudio");
  assert.equal(g["80"].inputs.audio, "song.wav");
  assert.equal(g["81"].class_type, "TrimAudioDuration");
  assert.equal(g["81"].inputs.start_index, 7.5);
  assert.equal(g["81"].inputs.duration, (LTX_DURATION_FRAMES[10] - 1) / 24, "trimmed to exactly the clip's seconds");
  assert.equal(g["12"].class_type, "LTXVAudioVAEEncode");
  assert.deepEqual(g["12"].inputs.audio, ["81", 0], "the encoder eats the trimmed track");
  assert.equal(g["84"].inputs.value, 0, "SolidMask 0 = keep, not denoise");
  assert.deepEqual(g["85"].inputs.samples, ["12", 0]);
  assert.deepEqual(g["13"].inputs.audio_latent, ["85", 0], "the concat reads the MASKED latent");
  assert.deepEqual(g["34"].inputs.audio, ["33", 0], "without separation the decoded latent is the delivered audio");
  assert.equal(g["82"], undefined, "no separator unless asked");
});

test("vocal separation: the stem drives, the full track is delivered", () => {
  const p = ltxProject();
  p.render.ltxAudio = track({ separateVocals: true });
  const g = build(p);
  assert.equal(g["82"].inputs.model_name, "mel.safetensors");
  assert.deepEqual(g["83"].inputs.audio, ["81", 0]);
  assert.deepEqual(g["12"].inputs.audio, ["83", 0], "the encoder eats the STEM");
  assert.deepEqual(g["34"].inputs.audio, ["81", 0], "the mux keeps the FULL trimmed track");
});

test("vocals-only output delivers the decoded stem instead", () => {
  const p = ltxProject();
  p.render.ltxAudio = track({ separateVocals: true, vocalsOnly: true });
  const g = build(p);
  assert.deepEqual(g["12"].inputs.audio, ["83", 0]);
  assert.deepEqual(g["34"].inputs.audio, ["33", 0], "the decoded latent IS the stem here");
});

test("the meta names the track and the upload list carries it", () => {
  const p = ltxProject();
  p.render.ltxAudio = track({ startSec: 2 });
  const { meta } = buildWorkflow(p, { models: MODELS });
  assert.deepEqual(meta.audioConditioning, { name: "song.wav", startSec: 2, separateVocals: false, vocalsOnly: false });
  assert.ok(meta.inputs.some(i => i.role === "conditioning audio" && i.name === "song.wav"));
});

test("defaults survive a project saved before the card existed", () => {
  const p = ltxProject();
  delete p.render.ltxAudio;
  assert.deepEqual(ltxAudioSettings(p), { item: null, startSec: 0, separateVocals: false, vocalsOnly: false });
  const g = build(p);
  assert.equal(g["12"].class_type, "LTXVEmptyLatentAudio");
});

test("the checker calls out a track the engine will ignore", () => {
  const p = ltxProject();
  p.render.ltxAudio = track();
  p.render.engine = "minimax";
  p.render.variant = "turbo";
  assert.ok(msgs(p).some(m => m.startsWith("warn:") && m.includes("conditioning track") && m.includes("MiniMax graph ignores it")),
    "MiniMax + a set track must warn");
  p.render.engine = "ltx25";
  p.render.variant = "ltx_two";
  assert.ok(!msgs(p).some(m => m.includes("conditioning track")), "on LTX the same track is silent");
  p.film.enabled = true;
  assert.ok(msgs(p).some(m => m.includes("SAME stretch")), "film mode + a track explains the repeat");
});
