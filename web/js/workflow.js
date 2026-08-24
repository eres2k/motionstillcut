/* MOTIONSTILL CUT — ComfyUI graph builders.
 *
 * Two engines, one compiled prompt.
 *
 * MiniMax H3 (the native engine): STOCK NODES ONLY. Every class_type in its
 * graphs ships with ComfyUI itself — no custom node packs, no Sol-Attn
 * patcher, no VideoHelperSuite, no free-memory nodes. A graph built here
 * loads on any ComfyUI new enough to have MiniMax H3 support (the 2026-08
 * nightlies) and nothing else has to be installed, which is what makes
 * "download the JSON" a portable deliverable rather than a description of
 * this machine.
 *
 * Three modes, one pipeline: load the DiT + Qwen3-VL encoder + the two VAEs,
 * build a joint audio/video latent from the prompt (and the keyframe or the
 * references), sample it in a single pass, decode both halves, mux, save.
 *
 * Node ids are stable across the three builders, so a graph opened in ComfyUI
 * looks the same whichever mode produced it:
 *
 *    1 DiT · 2 CLIP · 3 video VAE · 4 audio VAE · 5 sigma shift
 *    6/7 first frame (I2V) · 8 Turbo LoRA · 10 conditioning
 *   11 scheduler · 12 sampler · 13 noise · 14 guider · 15 sample
 *   16 decode video · 17 decode audio · 18 mux · 19 save
 *   20–28 reference images (Ref2V) · 33–35 reference audio
 *   40–42 reference video loaders · 43–45 their components
 *
 * LTX-2.5 (the EXPERIMENTAL second engine, T2V and I2V only): the same
 * compiled prompt handed to a different DiT — that sameness is the point of
 * the experiment, see buildLtxWorkflow below. Its graph needs a ComfyUI with
 * LTX-2 AV support (the LTXV* audio/latent nodes); Setup's health check
 * names anything a given build lacks, because unlike the MiniMax graphs this
 * one is not guaranteed stock everywhere.
 */

import { compilePrompt } from "./prompt.js";
import { dimensions, frameCount, activeEngine, orderedShots } from "./state.js";
import { variantFor } from "./vocab.js";

export const randomSeed = () => Math.floor(Math.random() * 0xffffffffff);

/** Long clips can decode in temporal chunks instead of one pass. tile_size is
 *  pinned at or above the long edge so there is exactly one spatial tile and
 *  no seams to worry about. VAEDecodeTiled is core. */
function decodeTemporalSize(numFrames) {
  return numFrames >= 600 ? 64 : numFrames >= 360 ? 96 : 128;
}

function ditFile(project, models) {
  const ref = project.mode === "r2v";
  const nvfp4 = project.render?.precision === "nvfp4";
  if (ref) return nvfp4 ? models.dit_ref2va_nvfp4 : models.dit_ref2va;
  return nvfp4 ? models.dit_fl2va_nvfp4 : models.dit_fl2va;
}

/** A filename ComfyUI will find in its input folder. Uploaded media carries
 *  the name ComfyUI gave it back; media that was only picked locally falls
 *  back to its own filename, which is right for the download-the-JSON path
 *  where the user drops the file into ComfyUI/input themselves. */
const inputName = (m) => (m?.comfyName || m?.name || "").trim();

function safePrefix(project, settings) {
  const custom = (project.render?.outputPrefix || settings?.comfy?.outputPrefix || "MotionstillCut").trim();
  const mode = project.mode.toUpperCase();
  const slug = (project.name || "untitled").replace(/[^\w -]+/g, "").trim().replace(/\s+/g, "_").slice(0, 40) || "untitled";
  return `${custom}/${mode}_${slug}`;
}

/**
 * Build the API-format graph for whichever engine the project renders on.
 * @returns {{ prompt: object, meta: object, compiled: object }}
 */
export function buildWorkflow(project, settings) {
  return activeEngine(project) === "ltx25"
    ? buildLtxWorkflow(project, settings)
    : buildMinimaxWorkflow(project, settings);
}

function buildMinimaxWorkflow(project, settings) {
  const models = { ...(settings?.models || {}) };
  const { width, height } = dimensions(project);
  const numFrames = frameCount(project);
  const fps = project.render?.fps || 24;
  const variant = variantFor(project.mode, project.render?.variant);
  const steps = project.render?.steps || variant.steps;
  const seed = project.render?.seed != null && project.render.seed >= 0 ? project.render.seed : randomSeed();
  const compiled = compilePrompt(project);
  const promptText = compiled.text;
  const isRef = project.mode === "r2v";
  const tiled = !!project.render?.tiledDecode;

  const lora = variant.lora ? models[variant.lora] : null;
  const useLora = !!lora;

  const graph = {};

  graph["1"] = {
    class_type: "UNETLoader",
    _meta: { title: `MiniMax H3 ${isRef ? "Ref2VA" : "FL2VA"} Model` },
    // weight_dtype stays "default": the quantization is baked into the file
    // and the loader reads it from the state dict.
    inputs: { unet_name: ditFile(project, models), weight_dtype: "default" },
  };
  graph["2"] = {
    class_type: "CLIPLoader",
    _meta: { title: "MiniMax Text Encoder (Qwen3-VL 32B)" },
    inputs: { clip_name: models.text_encoder, type: "minimax", device: "default" },
  };
  graph["3"] = { class_type: "VAELoader", _meta: { title: "MiniMax Video VAE" }, inputs: { vae_name: models.video_vae } };
  graph["4"] = { class_type: "VAELoader", _meta: { title: "MiniMax Audio VAE" }, inputs: { vae_name: models.audio_vae } };

  // Model chain: loader → (Turbo LoRA) → sigma shift.
  let modelRef = ["1", 0];
  if (useLora) {
    graph["8"] = {
      class_type: "LoraLoaderModelOnly",
      _meta: { title: `MiniMax Turbo LoRA (${variant.label})` },
      // strength 1.0 for every build: the ComfyUI conversions carry their own
      // alpha, so the loader strength is a plain multiplier on top.
      inputs: { lora_name: lora, strength_model: 1.0, model: ["1", 0] },
    };
    modelRef = ["8", 0];
  }

  graph["5"] = {
    class_type: "MiniMaxH3SigmaShift",
    _meta: { title: "MiniMax Sigma Shift" },
    // The shifts belong to the build: the 768p 4-step distill runs
    // shift_video 6, half of what every other path uses.
    inputs: { model: modelRef, shift_video: variant.shiftVideo, shift_audio: variant.shiftAudio },
  };
  const sampledModel = ["5", 0];

  /* ── Conditioning ─────────────────────────────────────── */
  if (isRef) {
    graph["10"] = {
      class_type: "MiniMaxH3ReferenceToVideo",
      _meta: { title: "MiniMax H3 References" },
      inputs: {
        clip: ["2", 0], vae: ["3", 0], audio_vae: ["4", 0],
        prompt: promptText,
        width, height, length: numFrames,
        ref_image_size: project.render?.refImageSize === "max" ? "max" : "match",
      },
    };
    // References are V3 autogrow inputs — in API-prompt format their keys are
    // the dotted expanded ids, 0-based, mirroring the official R2V template.
    (project.refs?.images || []).slice(0, 9).forEach((img, i) => {
      const id = String(20 + i);
      graph[id] = { class_type: "LoadImage", _meta: { title: `Reference Image ${i + 1}` }, inputs: { image: inputName(img) } };
      graph["10"].inputs[`ref_images.ref_image_${i}`] = [id, 0];
    });
    // Core video loading: LoadVideo hands back a VIDEO, GetVideoComponents
    // splits it into frames (slot 0), its own soundtrack (slot 1) and its fps
    // (slot 2). H3 reads reference frames as 24 fps, so a reference exported at
    // another rate plays back at the wrong speed inside the model — export at
    // 24 and it is exact.
    (project.refs?.videos || []).slice(0, 3).forEach((clip, i) => {
      const loadId = String(40 + i);
      const compId = String(43 + i);
      graph[loadId] = { class_type: "LoadVideo", _meta: { title: `Reference Video ${i + 1}` }, inputs: { file: inputName(clip) } };
      graph[compId] = { class_type: "GetVideoComponents", _meta: { title: `Reference Video ${i + 1} — components` }, inputs: { video: [loadId, 0] } };
      graph["10"].inputs[`ref_videos.ref_video_${i}`] = [compId, 0];
      if (clip.useAudio) graph["10"].inputs[`ref_video_audios.ref_video_audio_${i}`] = [compId, 1];
    });
    (project.refs?.audios || []).slice(0, 3).forEach((aud, i) => {
      const id = String(33 + i);
      graph[id] = { class_type: "LoadAudio", _meta: { title: `Reference Audio ${i + 1}` }, inputs: { audio: inputName(aud) } };
      graph["10"].inputs[`ref_audios.ref_audio_${i}`] = [id, 0];
    });
  } else {
    graph["10"] = {
      class_type: "MiniMaxH3ImageToVideo",
      _meta: { title: "MiniMax H3 Conditioning" },
      inputs: {
        clip: ["2", 0], vae: ["3", 0],
        prompt: promptText,
        width, height, length: numFrames,
      },
    };
    if (project.mode === "i2v" && project.frames?.first) {
      graph["6"] = { class_type: "LoadImage", _meta: { title: "First Frame" }, inputs: { image: inputName(project.frames.first) } };
      // Centre-crop to the target canvas with the core ImageScale node, so the
      // conditioning node's own keyframe stretch can't distort the source.
      graph["7"] = {
        class_type: "ImageScale",
        _meta: { title: "Fit First Frame to Canvas" },
        inputs: { image: ["6", 0], upscale_method: "lanczos", width, height, crop: "center" },
      };
      graph["10"].inputs.first_frame = ["7", 0];
    }
  }

  /* ── Sampling ─────────────────────────────────────────── */
  graph["11"] = {
    class_type: "BasicScheduler",
    _meta: { title: "Scheduler" },
    inputs: { model: sampledModel, scheduler: variant.scheduler, steps, denoise: 1.0 },
  };
  graph["12"] = { class_type: "KSamplerSelect", _meta: { title: "Sampler" }, inputs: { sampler_name: variant.sampler } };
  graph["13"] = { class_type: "RandomNoise", _meta: { title: "Noise" }, inputs: { noise_seed: seed } };
  graph["14"] = { class_type: "BasicGuider", _meta: { title: "Guider" }, inputs: { model: sampledModel, conditioning: ["10", 0] } };
  graph["15"] = {
    class_type: "SamplerCustomAdvanced",
    _meta: { title: "Sample AV Latent" },
    // Slot 1 of the conditioning node is the joint audio/video LATENT.
    inputs: { noise: ["13", 0], guider: ["14", 0], sampler: ["12", 0], sigmas: ["11", 0], latent_image: ["10", 1] },
  };

  /* ── Decode both halves, mux, save ────────────────────── */
  graph["16"] = tiled
    ? {
        class_type: "VAEDecodeTiled",
        _meta: { title: "Decode Video (tiled)" },
        inputs: {
          samples: ["15", 0], vae: ["3", 0],
          tile_size: Math.ceil(Math.max(width, height) / 32) * 32,
          overlap: 64,
          temporal_size: decodeTemporalSize(numFrames),
          temporal_overlap: 8,
        },
      }
    : { class_type: "VAEDecode", _meta: { title: "Decode Video" }, inputs: { samples: ["15", 0], vae: ["3", 0] } };
  graph["17"] = { class_type: "VAEDecodeAudio", _meta: { title: "Decode Audio" }, inputs: { samples: ["15", 0], vae: ["4", 0] } };
  graph["18"] = { class_type: "CreateVideo", _meta: { title: "Create Video" }, inputs: { images: ["16", 0], audio: ["17", 0], fps } };
  graph["19"] = {
    class_type: "SaveVideo",
    _meta: { title: "Save Video" },
    inputs: { video: ["18", 0], filename_prefix: safePrefix(project, settings), format: "auto", codec: "auto" },
  };

  const meta = {
    mode: project.mode,
    engine: "minimax",
    width, height, numFrames, fps, seed, steps,
    variant: variant.key, variantLabel: variant.label,
    lora: lora || null,
    dit: ditFile(project, models),
    sampler: variant.sampler, scheduler: variant.scheduler,
    shiftVideo: variant.shiftVideo, shiftAudio: variant.shiftAudio,
    tiledDecode: tiled,
    stockNodesOnly: true,
    nodeTypes: [...new Set(Object.values(graph).map(n => n.class_type))].sort(),
    promptChars: promptText.length,
    // Every file the graph expects to already be in ComfyUI/input.
    inputs: [
      ...(project.mode === "i2v" && project.frames?.first ? [{ role: "first frame", name: inputName(project.frames.first), media: project.frames.first }] : []),
      ...(isRef ? (project.refs?.images || []).slice(0, 9).map((m, i) => ({ role: `<Picture ${i + 1}>`, name: inputName(m), media: m })) : []),
      ...(isRef ? (project.refs?.videos || []).slice(0, 3).map((m, i) => ({ role: `<Video ${i + 1}>`, name: inputName(m), media: m })) : []),
      ...(isRef ? (project.refs?.audios || []).slice(0, 3).map((m, i) => ({ role: `<Audio>`, name: inputName(m), media: m })) : []),
    ],
  };

  return { prompt: graph, meta, compiled };
}

/* ── LTX-2.5 — the experimental second engine ─────────────────
 *
 * The same compiled prompt, a different model behind it. That is the whole
 * experiment: H3's prompt is a structure this editor already compiles —
 * named fields, [Shot N] markers, camera prose, dialogue tags — and LTX-2.5
 * reads long structured prose well, but it was never trained on that dialect
 * (it has no shot-marker syntax of its own; its rewriter puts cuts in plain
 * prose). So the text goes in VERBATIM and the sweeps and the library are how
 * you find out what carries over and what dilutes. Deliberately NOT a second
 * prompt compiler — the moment the two engines get different text, comparing
 * them stops meaning anything.
 *
 * The pipeline is Lightricks' own distilled pair, transcribed from the main
 * Motionstill app (which matches example_workflows/2.5/…Distilled.json):
 *
 *   two-stage    8 manual-sigma steps at HALF resolution (euler_ancestral,
 *                cfg 1) → 2× latent upscale → 3-step refine (euler, cfg 1).
 *   single-stage the full 8-step schedule straight at target resolution —
 *                no upsampler, no refine, no second warm-up.
 *
 * The sigma ladders are baked into the distill; there is no steps knob. The
 * transformer ships distilled, so no LoRA slot either. Audio rides the same
 * sampler in a joint AV latent (concat → sample → separate), and both passes
 * refine it. Sampling runs at cfg 1, so the negative prompt is inert — it is
 * wired because CFGGuider wants one, with the upstream default text.
 *
 * ANCHORS — where the timeline gets pinned. The graph carries a chain of
 * LTXVAddGuide nodes: in I2V the first frame at frame 0, and — on this
 * engine only — every shot that pins a keyframe image, at that shot's cut
 * time, with a strength per pin. This is the LTX answer to "the cuts drift":
 * a guide conditions specific frame positions, so it pins what the clip
 * looks like when a shot lands. It does not force a hard cut — the model
 * still interpolates toward the pin — but the timeline stops being prompt
 * prose alone. A guide appends conditioning tokens to the latent, so every
 * sampler that consumes a guided latent reads the guided conditioning too,
 * and the appended frames are cropped back off (LTXVCropGuides) before
 * anything upscales or decodes — same discipline as the main app's keyframe
 * pipeline. Guide frame indices snap to the VAE's temporal stride of 8.
 *
 * Node ids (stable, so the two builds diff cleanly in ComfyUI):
 *    1 DiT · 2 CLIP · 3 video VAE · 4 audio VAE
 *    5 positive · 6 negative · 7 LTXVConditioning
 *   11 empty video latent · 12 empty audio latent · 13 concat AV (pass 1)
 *   14 sigmas · 15 guider · 16 noise · 17 sampler · 18 sample   (pass 1)
 *   19 separate AV (pass 1) · 20 crop guides · 21 upscale model · 22 upsample
 *   24 concat AV (pass 2)
 *   25 sigmas · 26 guider · 27 noise · 28 sampler · 29 sample   (pass 2)
 *   30 separate AV (final) · 31 crop guides (final, when anchored)
 *   32 decode video (tiled) · 33 decode audio · 34 mux · 35 save
 *   40+ anchor images · 50+ fit-to-canvas · 60+ guides (pass 1) · 70+ (pass 2)
 */

// The guide chain is bounded so a 12-shot timeline cannot silently build a
// graph the encoder drowns in — the Deliver page reports what was dropped.
export const LTX_MAX_ANCHORS = 8;

// The distill's own schedules — properties of the model, not preferences.
const LTX_SIGMAS_PASS1 = "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0";
const LTX_SIGMAS_PASS2 = "0.85, 0.7250, 0.4219, 0.0";
// Inert at cfg 1 — wired because the guider takes one. Upstream's default.
const LTX_NEGATIVE = "pc game, console game, video game, cartoon, childish, ugly";
// One tiling for every clip: spatial tiles, the whole clip in one temporal
// chunk — the settings the conv LTX VAE has always decoded with.
const LTX_DECODE = { tile_size: 768, overlap: 64, temporal_size: 4096, temporal_overlap: 4 };

function buildLtxWorkflow(project, settings) {
  const models = { ...(settings?.models || {}) };
  const { width, height } = dimensions(project);
  const numFrames = frameCount(project);            // the 8k+1 grid, per state.js
  const fps = project.render?.fps || 24;
  const variant = variantFor(project.mode, project.render?.variant, "ltx25");
  const singleStage = variant.stages === 1;
  const seed = project.render?.seed != null && project.render.seed >= 0 ? project.render.seed : randomSeed();
  // The refine pass draws its own noise. Derived from the pinned seed so a
  // pinned render stays fully reproducible with one number.
  const seed2 = project.render?.seed != null && project.render.seed >= 0 ? seed + 1 : randomSeed();
  const compiled = compilePrompt(project);
  const promptText = compiled.text;
  const halfW = Math.floor(width / 2), halfH = Math.floor(height / 2);
  const firstFrame = project.mode === "i2v" && project.frames?.first ? project.frames.first : null;

  /* The anchor list: the I2V first frame at 0, then every pinned shot at its
   * cut time. Indices snap to the VAE's temporal stride of 8 and collide
   * earliest-wins — a shot pinned at 0 in I2V loses to the first frame,
   * which IS the frame at 0. Strength is per pin (the first frame is always
   * 1.0: it is a fact of the clip, not a suggestion). */
  const snapIdx = (seconds) => Math.max(0, Math.min(numFrames - 1, Math.round((Number(seconds) || 0) * fps / 8) * 8));
  const anchors = [];
  if (firstFrame) anchors.push({ media: firstFrame, at: 0, idx: 0, strength: 1.0, label: "First Frame" });
  const pinnedShots = orderedShots(project).filter(s => s?.keyframe);
  for (const s of pinnedShots) {
    anchors.push({
      media: s.keyframe, at: s.at || 0, idx: snapIdx(s.at),
      strength: Math.min(1, Math.max(0.1, Number(s.keyframeStrength) || 1)),
      label: `Shot Pin @ ${s.at || 0}s`,
    });
  }
  const seen = new Set();
  const usable = anchors.filter(a => !seen.has(a.idx) && seen.add(a.idx)).slice(0, LTX_MAX_ANCHORS);
  const droppedPins = anchors.length - usable.length;

  const graph = {};

  graph["1"] = {
    class_type: "UNETLoader",
    _meta: { title: "LTX-2.5 Transformer" },
    // weight_dtype "default": the INT8 quantization is baked into the file.
    inputs: { unet_name: models.ltx25_dit, weight_dtype: "default" },
  };
  graph["2"] = {
    class_type: "CLIPLoader",
    _meta: { title: "LTX-2.5 Text Encoder (Gemma 4)" },
    // type "ltxv" is the 2.5-support gate: an older ComfyUI loads this file
    // as a plain chat model and CLIPTextEncode fails. Setup checks for it.
    inputs: { clip_name: models.ltx25_text_encoder, type: "ltxv", device: "default" },
  };
  graph["3"] = { class_type: "VAELoader", _meta: { title: "LTX-2.5 Video VAE" }, inputs: { vae_name: models.ltx25_video_vae } };
  graph["4"] = { class_type: "VAELoader", _meta: { title: "LTX-2.5 Audio VAE" }, inputs: { vae_name: models.ltx25_audio_vae } };

  /* ── The prompt — the SAME compiled text the MiniMax graph gets ── */
  graph["5"] = { class_type: "CLIPTextEncode", _meta: { title: "Positive Prompt" }, inputs: { text: promptText, clip: ["2", 0] } };
  graph["6"] = { class_type: "CLIPTextEncode", _meta: { title: "Negative Prompt" }, inputs: { text: LTX_NEGATIVE, clip: ["2", 0] } };
  graph["7"] = {
    class_type: "LTXVConditioning",
    _meta: { title: "LTXVConditioning" },
    inputs: { frame_rate: fps, positive: ["5", 0], negative: ["6", 0] },
  };

  /* ── Anchor images (first frame + shot pins) ──────────── */
  // One image per anchor at the full canvas feeds BOTH passes' guides —
  // LTXVAddGuide adapts it to whichever latent resolution it conditions.
  usable.forEach((a, i) => {
    graph[String(40 + i)] = { class_type: "LoadImage", _meta: { title: a.label }, inputs: { image: inputName(a.media) } };
    graph[String(50 + i)] = {
      class_type: "ImageScale",
      _meta: { title: `Fit to Canvas (${a.label})` },
      inputs: { image: [String(40 + i), 0], upscale_method: "lanczos", width, height, crop: "center" },
    };
  });

  /* ── Latents (pass 1 at half res in the two-stage build) ── */
  graph["11"] = {
    class_type: "EmptyLTXVLatentVideo",
    _meta: { title: "Empty Video Latent" },
    inputs: { width: singleStage ? width : halfW, height: singleStage ? height : halfH, length: numFrames, batch_size: 1 },
  };
  graph["12"] = {
    class_type: "LTXVEmptyLatentAudio",
    _meta: { title: "Empty Audio Latent" },
    inputs: { frames_number: numFrames, frame_rate: fps, batch_size: 1, audio_vae: ["4", 0] },
  };

  /* ── The pass-1 guide chain — each anchor conditions the last one's
   * output, so one chain carries the first frame and every pin. ── */
  let pos1 = ["7", 0], neg1 = ["7", 1], videoLatent1 = ["11", 0];
  usable.forEach((a, i) => {
    const id = String(60 + i);
    graph[id] = {
      class_type: "LTXVAddGuide",
      _meta: { title: `Guide (Pass 1): ${a.label} → frame ${a.idx}` },
      inputs: {
        positive: pos1, negative: neg1,
        vae: ["3", 0], latent: videoLatent1,
        image: [String(50 + i), 0], frame_idx: a.idx, strength: a.strength,
      },
    };
    pos1 = [id, 0]; neg1 = [id, 1]; videoLatent1 = [id, 2];
  });
  const anchored = usable.length > 0;
  graph["13"] = {
    class_type: "LTXVConcatAVLatent",
    _meta: { title: "Concat AV Latent (Pass 1)" },
    inputs: { video_latent: videoLatent1, audio_latent: ["12", 0] },
  };

  /* ── Pass 1: the full 8-step schedule, cfg 1 ──────────── */
  graph["14"] = { class_type: "ManualSigmas", _meta: { title: "ManualSigmas (Pass 1)" }, inputs: { sigmas: LTX_SIGMAS_PASS1 } };
  graph["15"] = { class_type: "CFGGuider", _meta: { title: "CFGGuider (Pass 1)" }, inputs: { cfg: 1, model: ["1", 0], positive: pos1, negative: neg1 } };
  graph["16"] = { class_type: "RandomNoise", _meta: { title: "Noise (Pass 1)" }, inputs: { noise_seed: seed } };
  graph["17"] = { class_type: "KSamplerSelect", _meta: { title: "Sampler (Pass 1)" }, inputs: { sampler_name: "euler_ancestral" } };
  graph["18"] = {
    class_type: "SamplerCustomAdvanced",
    _meta: { title: "Sample AV Latent (Pass 1)" },
    inputs: { noise: ["16", 0], guider: ["15", 0], sampler: ["17", 0], sigmas: ["14", 0], latent_image: ["13", 0] },
  };

  // What the decoders will read; overwritten by whichever path builds on.
  let finalSampleRef = ["18", 0];
  let videoForDecode = null;

  if (!singleStage) {
    /* ── Between the passes: separate, crop guides, 2× upscale ── */
    graph["19"] = { class_type: "LTXVSeparateAVLatent", _meta: { title: "Separate AV (Pass 1)" }, inputs: { av_latent: ["18", 0] } };
    graph["20"] = {
      class_type: "LTXVCropGuides",
      _meta: { title: "Crop Guides / Clean Conditioning" },
      inputs: { positive: pos1, negative: neg1, latent: ["19", 0] },
    };
    graph["21"] = { class_type: "LatentUpscaleModelLoader", _meta: { title: "Load Latent Upscale Model" }, inputs: { model_name: models.ltx25_upscaler } };
    graph["22"] = {
      class_type: "LTXVLatentUpsampler",
      _meta: { title: "Spatial 2× Upscale" },
      // With guides, the pass-1 latent still carries the appended guide
      // frames — the upsampler must eat the CROPPED latent. Without any the
      // crop is conditioning-only and the raw video half is fine (this is
      // exactly the main app's wiring for its keyframe pipeline).
      inputs: { samples: anchored ? ["20", 2] : ["19", 0], upscale_model: ["21", 0], vae: ["3", 0] },
    };

    /* ── Pass 2: 3-step refine at full resolution ─────────── */
    // Every anchor re-guides the upscaled latent — the frame indices are
    // temporal, so the 2× spatial upscale leaves them untouched.
    let pos2 = ["20", 0], neg2 = ["20", 1], videoLatent2 = ["22", 0];
    usable.forEach((a, i) => {
      const id = String(70 + i);
      graph[id] = {
        class_type: "LTXVAddGuide",
        _meta: { title: `Guide (Pass 2): ${a.label} → frame ${a.idx}` },
        inputs: {
          positive: pos2, negative: neg2,
          vae: ["3", 0], latent: videoLatent2,
          image: [String(50 + i), 0], frame_idx: a.idx, strength: a.strength,
        },
      };
      pos2 = [id, 0]; neg2 = [id, 1]; videoLatent2 = [id, 2];
    });
    graph["24"] = {
      class_type: "LTXVConcatAVLatent",
      _meta: { title: "Concat AV Latent (Pass 2)" },
      inputs: { video_latent: videoLatent2, audio_latent: ["19", 1] },
    };
    graph["25"] = { class_type: "ManualSigmas", _meta: { title: "ManualSigmas (Pass 2)" }, inputs: { sigmas: LTX_SIGMAS_PASS2 } };
    graph["26"] = { class_type: "CFGGuider", _meta: { title: "CFGGuider (Pass 2)" }, inputs: { cfg: 1, model: ["1", 0], positive: pos2, negative: neg2 } };
    graph["27"] = { class_type: "RandomNoise", _meta: { title: "Noise (Pass 2)" }, inputs: { noise_seed: seed2 } };
    graph["28"] = { class_type: "KSamplerSelect", _meta: { title: "Sampler (Pass 2)" }, inputs: { sampler_name: "euler" } };
    graph["29"] = {
      class_type: "SamplerCustomAdvanced",
      _meta: { title: "Sample AV Latent (Pass 2)" },
      inputs: { noise: ["27", 0], guider: ["26", 0], sampler: ["28", 0], sigmas: ["25", 0], latent_image: ["24", 0] },
    };
    finalSampleRef = ["29", 0];
    if (anchored) {
      graph["30"] = { class_type: "LTXVSeparateAVLatent", _meta: { title: "Separate AV (Final)" }, inputs: { av_latent: finalSampleRef } };
      graph["31"] = { class_type: "LTXVCropGuides", _meta: { title: "Crop Guides (Final)" }, inputs: { positive: pos2, negative: neg2, latent: ["30", 0] } };
      videoForDecode = ["31", 2];
    }
  } else if (anchored) {
    // Single-stage with guides: crop the appended frames off before decode.
    graph["30"] = { class_type: "LTXVSeparateAVLatent", _meta: { title: "Separate AV (Final)" }, inputs: { av_latent: finalSampleRef } };
    graph["31"] = { class_type: "LTXVCropGuides", _meta: { title: "Crop Guides" }, inputs: { positive: pos1, negative: neg1, latent: ["30", 0] } };
    videoForDecode = ["31", 2];
  }

  if (!graph["30"]) {
    graph["30"] = { class_type: "LTXVSeparateAVLatent", _meta: { title: "Separate AV (Final)" }, inputs: { av_latent: finalSampleRef } };
  }
  if (!videoForDecode) videoForDecode = ["30", 0];

  /* ── Decode both halves, mux, save ────────────────────── */
  // Always tiled: a 721-frame 1344×768 clip through the conv VAE in one
  // piece is an OOM, and on short clips the tiling is a no-op cost-wise.
  graph["32"] = {
    class_type: "VAEDecodeTiled",
    _meta: { title: "Decode Video (Tiled)" },
    inputs: { ...LTX_DECODE, samples: videoForDecode, vae: ["3", 0] },
  };
  graph["33"] = { class_type: "LTXVAudioVAEDecode", _meta: { title: "Decode Audio" }, inputs: { samples: ["30", 1], audio_vae: ["4", 0] } };
  graph["34"] = { class_type: "CreateVideo", _meta: { title: "Create Video" }, inputs: { images: ["32", 0], audio: ["33", 0], fps } };
  graph["35"] = {
    class_type: "SaveVideo",
    _meta: { title: "Save Video" },
    inputs: { video: ["34", 0], filename_prefix: safePrefix(project, settings), format: "auto", codec: "auto" },
  };

  const meta = {
    mode: project.mode,
    engine: "ltx25",
    width, height, numFrames, fps, seed, seed2,
    steps: variant.steps,
    variant: variant.key, variantLabel: `LTX-2.5 ${variant.label}`,
    stages: variant.stages,
    lora: null,
    dit: models.ltx25_dit,
    sampler: variant.sampler, scheduler: variant.scheduler,
    tiledDecode: true,
    // The MiniMax stock-node guarantee does not extend to this graph: the
    // LTXV* nodes need a ComfyUI with LTX-2 AV support. Setup's health check
    // says which, if any, this install lacks.
    stockNodesOnly: false,
    experimental: true,
    // Where the timeline is pinned — LTXVAddGuide anchors, snapped to the
    // temporal stride. The first frame (I2V) is the anchor at 0.
    guides: usable.map(a => ({ at: a.at, frameIdx: a.idx, strength: a.strength, name: inputName(a.media) })),
    droppedPins,
    nodeTypes: [...new Set(Object.values(graph).map(n => n.class_type))].sort(),
    promptChars: promptText.length,
    inputs: usable.map((a, i) => ({
      role: i === 0 && firstFrame ? "first frame" : `pin @ ${a.at}s (frame ${a.idx})`,
      name: inputName(a.media), media: a.media,
    })),
  };

  return { prompt: graph, meta, compiled };
}

/** A rough wall-clock estimate, good enough to sort "grab a coffee" from
 *  "leave it running". Scaled from measured MiniMax H3 runs at 480p/24fps on a
 *  24 GB card; the numbers move with the machine, which is why it says ~. */
export function estimateSeconds(project) {
  const { width, height } = dimensions(project);
  const numFrames = frameCount(project);
  const pixels = (width * height) / (832 * 480);

  if (activeEngine(project) === "ltx25") {
    // Gemma 4 12B encodes far faster than Qwen3-VL 32B; the two-stage build
    // pays 8 steps at quarter-pixels plus 3 at full, the single-stage 8 at
    // full. Seeded from the main app's LTX timings, same ~ health warning.
    const variant = variantFor(project.mode, project.render?.variant, "ltx25");
    const encode = 12;
    const effectiveSteps = variant.stages === 2 ? 8 * 0.25 + 3 : 8;
    const sample = effectiveSteps * numFrames * 0.017 * pixels;
    const decode = numFrames * 0.06 * pixels;
    return Math.round(encode + sample + decode);
  }

  const variant = variantFor(project.mode, project.render?.variant);
  const steps = project.render?.steps || variant.steps;
  const encode = project.mode === "r2v" ? 55 : 35;          // Qwen3-VL 32B pass
  const perStepPerFrame = 0.019 * pixels;
  const sample = steps * numFrames * perStepPerFrame;
  const decode = numFrames * 0.05 * pixels;
  return Math.round(encode + sample + decode);
}

export function humanTime(seconds) {
  if (!isFinite(seconds)) return "—";
  const m = Math.floor(seconds / 60), s = Math.round(seconds % 60);
  return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}
