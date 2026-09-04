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
import { dimensions, frameCount, activeEngine, orderedShots, ltxGuideIdx } from "./state.js";
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
  /* A subfolder is tidier; a flat name is the fallback for when the
   * subfolder belongs to someone else (a root-owned folder from a run
   * under sudo is the usual way) and ComfyUI, running as the user, is
   * refused at save time. The top of the output folder is always ComfyUI's
   * own. */
  return settings?.comfy?.flatOutput ? `${custom}_${mode}_${slug}` : `${custom}/${mode}_${slug}`;
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
  const upscale = appendUpscale(graph, { decode: "16", createVideo: "18", project, models, seed, promptText });

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
    upscale,
    // SeedVR2 is the one custom pack the graph can reach for, and only when asked.
    stockNodesOnly: !upscale || upscale.engine === "esrgan",
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
 * The same timeline, compiled in LTX's own dialect (docs.ltx.io: one paragraph, cuts in prose, no markers). That is the whole
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
  const snapIdx = (seconds) => ltxGuideIdx(seconds, project);
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
  const upscale = appendUpscale(graph, {
    decode: "32", createVideo: "34", project, models, seed, promptText,
    // The LTX refine reuses this graph's own loaders and clean conditioning.
    ltx: { model: ["1", 0], vae: ["3", 0], audioVae: ["4", 0], positive: ["7", 0], negative: ["7", 1] },
  });

  const meta = {
    mode: project.mode,
    engine: "ltx25",
    width, height, numFrames, fps, seed, seed2,
    upscale,
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


/* ── Upscale — after the decode, before the mux ───────────────
 * The clip renders at the canvas size and is delivered larger. Two engines:
 *
 *   seedvr2  — ByteDance's diffusion video restorer, through the
 *              seedvr2_videoupscaler custom pack. Frames go through in
 *              batches (4n+1) with overlap, so motion stays coherent and
 *              detail is invented rather than sharpened. Slow, and the best
 *              result. It diffuses at 1080p-class and a Lanczos resize
 *              finishes 1440p and 4K: true 4K diffusion of a 30 s clip is
 *              over an hour on a big card for very little over 1080p→4K.
 *   flashvsr — FlashVSR v1.1 (CVPR 2026), a one-step streaming diffusion
 *              upscaler at a fixed ×2 or ×4, through the
 *              ComfyUI-FlashVSR_Ultra_Fast pack. Coherent, conservative,
 *              several times faster than SeedVR2. The middle tier.
 *   ltx25    — LTX-2.5 as the upscaler: the frames are encoded into its
 *              latent, doubled by its latent upsampler and put through the
 *              three-step refine pass the two-stage build uses, under the
 *              clip's own prompt. Core nodes only, but the whole LTX-2.5
 *              pack loads for it; from an LTX render the weights are already
 *              on the card. Detail is re-imagined by a video model, ×2.
 *   esrgan   — RealESRGAN ×4 per frame on stock nodes, then a Lanczos resize
 *              to the exact target. Seconds per clip; fine texture can
 *              shimmer between frames because each is upscaled alone.
 *
 * The target names a short edge, so a 16:9 canvas lands on the familiar
 * 1920×1080 / 3840×2160 and a 4:3 one on its own honest size. A target no
 * larger than the canvas is a no-op and the pass is skipped. */
export const UPSCALE_TARGETS = { "720p": 720, "1080p": 1080, "1440p": 1440, "2160p": 2160 };
export const UPSCALE_TARGET_LABELS = { "720p": "720p", "1080p": "1080p · Full HD", "1440p": "1440p · QHD", "2160p": "2160p · 4K UHD" };
export const UPSCALE_ENGINES = ["off", "seedvr2", "flashvsr", "ltx25", "esrgan"];
/** SeedVR2 diffuses no larger than this short edge; a resize finishes the rest. */
export const SEEDVR2_DIFFUSE_CAP = 1080;

export function upscaleSettings(project) {
  const u = project.render?.upscale || {};
  return {
    engine: UPSCALE_ENGINES.includes(u.engine) ? u.engine : "off",
    target: UPSCALE_TARGETS[u.target] ? u.target : "1080p",
  };
}

/** What the pass would do, or null when it would do nothing. */
export function upscalePlan(project) {
  const { engine, target } = upscaleSettings(project);
  if (engine === "off") return null;
  const { width, height } = dimensions(project);
  const shortEdge = UPSCALE_TARGETS[target];
  const from = Math.min(width, height);
  if (shortEdge <= from) return null;
  const factor = shortEdge / from;
  const even = (n) => Math.round(n / 2) * 2;
  const w = even(width * factor), hh = even(height * factor);
  return { engine, target, shortEdge, factor, width: w, height: hh, pixels: w * hh };
}

/** Rough wall-clock for the pass — 1080p frames on a big card, scaled by
 *  pixels. SeedVR2 is diffusion: about a second a frame; ESRGAN is a
 *  convolution: a few hundredths. */
function upscaleSeconds(project) {
  const plan = upscalePlan(project);
  if (!plan) return 0;
  const frames = frameCount(project);
  const { width, height } = dimensions(project);
  // Per 1080p-class DIFFUSED frame on a 5090: SeedVR2 7B fp8 runs ~0.35 fps,
  // FlashVSR tiny ×2 ~0.8 fps, the LTX refine is three steps at 2× canvas,
  // RealESRGAN ×4 ~1.7 fps at 4K (~0.1 s at 1080p).
  const diffused = plan.engine === "seedvr2" ? plan.pixels * Math.min(1, (SEEDVR2_DIFFUSE_CAP / plan.shortEdge) ** 2)
    : plan.engine === "ltx25" ? width * height * 4
    : plan.pixels;
  const perFrame = { seedvr2: 2.8, flashvsr: 1.2, ltx25: 0.35, esrgan: 0.12 }[plan.engine];
  const load = { seedvr2: 20, flashvsr: 20, ltx25: 45, esrgan: 3 }[plan.engine];
  return Math.round(load + (frames * perFrame * diffused) / (1920 * 1080));
}

/** Append the pass to a graph whose decoded frames come out of `decode` and
 *  whose mux is `createVideo`; rewires the mux to the upscaled frames. Node
 *  ids 60-63 and 100-119 are clear of both engines' graphs; 62 is always the
 *  final resize, so the mux has one place to look. */
function appendUpscale(graph, { decode, createVideo, project, models, seed, promptText, ltx = null }) {
  const plan = upscalePlan(project);
  if (!plan) return null;
  const from = [decode, 0];
  const finish = (fromId, title) => {
    graph["62"] = { class_type: "ImageScale", _meta: { title },
      inputs: { image: [fromId, 0], upscale_method: "lanczos", width: plan.width, height: plan.height, crop: "disabled" } };
  };
  if (plan.engine === "seedvr2") {
    const diffuseAt = Math.min(plan.shortEdge, SEEDVR2_DIFFUSE_CAP);
    // The VAE's batched decode is what fills the card — tile it from 1080p up.
    const tiled = diffuseAt >= 1080;
    graph["60"] = { class_type: "SeedVR2LoadDiTModel", _meta: { title: "SeedVR2 DiT" },
      inputs: { model: models.seedvr2_dit, device: "cuda:0" } };
    graph["61"] = { class_type: "SeedVR2LoadVAEModel", _meta: { title: "SeedVR2 VAE" },
      inputs: { model: models.seedvr2_vae, device: "cuda:0", encode_tiled: tiled, decode_tiled: tiled,
        encode_tile_size: 1024, encode_tile_overlap: 128, decode_tile_size: 1024, decode_tile_overlap: 128 } };
    // Batches of 5 visibly flicker; 13 with a 4-frame overlap is the floor
    // the pack's own guidance gives for coherent motion.
    graph["63"] = { class_type: "SeedVR2VideoUpscaler", _meta: { title: `SeedVR2 → ${diffuseAt}p` },
      inputs: { image: from, dit: ["60", 0], vae: ["61", 0], seed,
        resolution: diffuseAt, max_resolution: 0, batch_size: 13, uniform_batch_size: true,
        color_correction: "lab", temporal_overlap: 4, offload_device: "cpu" } };
    finish("63", diffuseAt < plan.shortEdge ? `Resize → ${plan.target}` : `Fit → ${plan.target}`);
  } else if (plan.engine === "ltx25") {
    const fps = project.render?.fps || 24;
    const numFrames = frameCount(project);
    // LTX's VAE works on an 8k+1 frame grid. An LTX render already is one;
    // an H3 clip is trimmed to the nearest grid below — at most seven frames,
    // under a third of a second, off the end.
    const keep = numFrames % 8 === 1 ? numFrames : Math.floor((numFrames - 1) / 8) * 8 + 1;
    let L = ltx;
    if (!L) {
      graph["100"] = { class_type: "UNETLoader", _meta: { title: "LTX-2.5 Transformer (refine)" }, inputs: { unet_name: models.ltx25_dit, weight_dtype: "default" } };
      graph["101"] = { class_type: "CLIPLoader", _meta: { title: "LTX-2.5 Text Encoder (Gemma 4)" }, inputs: { clip_name: models.ltx25_text_encoder, type: "ltxv", device: "default" } };
      graph["102"] = { class_type: "VAELoader", _meta: { title: "LTX-2.5 Video VAE" }, inputs: { vae_name: models.ltx25_video_vae } };
      graph["103"] = { class_type: "VAELoader", _meta: { title: "LTX-2.5 Audio VAE" }, inputs: { vae_name: models.ltx25_audio_vae } };
      graph["104"] = { class_type: "CLIPTextEncode", _meta: { title: "Positive Prompt (refine)" }, inputs: { text: promptText, clip: ["101", 0] } };
      graph["105"] = { class_type: "CLIPTextEncode", _meta: { title: "Negative Prompt (refine)" }, inputs: { text: LTX_NEGATIVE, clip: ["101", 0] } };
      graph["106"] = { class_type: "LTXVConditioning", _meta: { title: "LTXVConditioning (refine)" }, inputs: { frame_rate: fps, positive: ["104", 0], negative: ["105", 0] } };
      L = { model: ["100", 0], vae: ["102", 0], audioVae: ["103", 0], positive: ["106", 0], negative: ["106", 1] };
    }
    let frames = from;
    if (keep !== numFrames) {
      graph["107"] = { class_type: "ImageFromBatch", _meta: { title: `Trim to ${keep} frames (8k+1)` }, inputs: { image: from, batch_index: 0, length: keep } };
      frames = ["107", 0];
    }
    graph["108"] = { class_type: "VAEEncode", _meta: { title: "Encode Frames (LTX-2.5)" }, inputs: { pixels: frames, vae: L.vae } };
    graph["109"] = { class_type: "LatentUpscaleModelLoader", _meta: { title: "Load Latent Upscale Model" }, inputs: { model_name: models.ltx25_upscaler } };
    graph["110"] = { class_type: "LTXVLatentUpsampler", _meta: { title: "Spatial 2× Upscale (refine)" }, inputs: { samples: ["108", 0], upscale_model: ["109", 0], vae: L.vae } };
    // The refine is an AV pass; the audio half is a silent latent that is
    // thrown away — the mux keeps the render's own soundtrack.
    graph["111"] = { class_type: "LTXVEmptyLatentAudio", _meta: { title: "Silent Audio Latent (refine)" }, inputs: { frames_number: keep, frame_rate: fps, batch_size: 1, audio_vae: L.audioVae } };
    graph["112"] = { class_type: "LTXVConcatAVLatent", _meta: { title: "Concat AV Latent (refine)" }, inputs: { video_latent: ["110", 0], audio_latent: ["111", 0] } };
    graph["113"] = { class_type: "ManualSigmas", _meta: { title: "ManualSigmas (refine)" }, inputs: { sigmas: LTX_SIGMAS_PASS2 } };
    graph["114"] = { class_type: "CFGGuider", _meta: { title: "CFGGuider (refine)" }, inputs: { cfg: 1, model: L.model, positive: L.positive, negative: L.negative } };
    graph["115"] = { class_type: "RandomNoise", _meta: { title: "Noise (refine)" }, inputs: { noise_seed: seed } };
    graph["116"] = { class_type: "KSamplerSelect", _meta: { title: "Sampler (refine)" }, inputs: { sampler_name: "euler" } };
    graph["117"] = {
      class_type: "SamplerCustomAdvanced", _meta: { title: "Sample AV Latent (refine)" },
      inputs: { noise: ["115", 0], guider: ["114", 0], sampler: ["116", 0], sigmas: ["113", 0], latent_image: ["112", 0] },
    };
    graph["118"] = { class_type: "LTXVSeparateAVLatent", _meta: { title: "Separate AV (refine)" }, inputs: { av_latent: ["117", 0] } };
    graph["119"] = { class_type: "VAEDecodeTiled", _meta: { title: "Decode Video (refine, tiled)" }, inputs: { ...LTX_DECODE, samples: ["118", 0], vae: L.vae } };
    finish("119", `Fit → ${plan.target}`);
  } else if (plan.engine === "flashvsr") {
    const frames = frameCount(project);
    graph["61"] = { class_type: "FlashVSRNode", _meta: { title: `FlashVSR ×${plan.factor > 2 ? 4 : 2}` },
      inputs: { frames: from, model: "FlashVSR-v1.1", mode: frames > 240 ? "tiny-long" : "tiny",
        scale: plan.factor > 2 ? 4 : 2, tiled_vae: true, tiled_dit: true, unload_dit: true, seed } };
    finish("61", `Resize → ${plan.target}`);
  } else {
    graph["60"] = { class_type: "UpscaleModelLoader", _meta: { title: "ESRGAN ×4" }, inputs: { model_name: models.esrgan } };
    graph["61"] = { class_type: "ImageUpscaleWithModel", _meta: { title: "Upscale frames ×4" }, inputs: { upscale_model: ["60", 0], image: from } };
    finish("61", `Resize → ${plan.target}`);
  }
  graph[createVideo].inputs.images = ["62", 0];
  return plan;
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
    return Math.round(encode + sample + decode) + upscaleSeconds(project);
  }

  const variant = variantFor(project.mode, project.render?.variant);
  const steps = project.render?.steps || variant.steps;
  const encode = project.mode === "r2v" ? 55 : 35;          // Qwen3-VL 32B pass
  const perStepPerFrame = 0.019 * pixels;
  const sample = steps * numFrames * perStepPerFrame;
  const decode = numFrames * 0.05 * pixels;
  return Math.round(encode + sample + decode) + upscaleSeconds(project);
}

export function humanTime(seconds) {
  if (!isFinite(seconds)) return "—";
  const m = Math.floor(seconds / 60), s = Math.round(seconds % 60);
  return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

/* ── Will it fit? ─────────────────────────────────────────────
 * A VRAM estimate for a MiniMax H3 render, so the app can say "this won't
 * fit" before ComfyUI spends twenty seconds loading weights and then dies on
 * the first sampling step. Calibrated on a real failure: 736 frames at
 * 1344x768 with six references at "max" (~235k tokens) asked for a single
 * 18.8 GiB tensor on a 32 GB card. The int8 build's matmuls write int32 —
 * four bytes per value — so every per-layer activation is twice its bf16
 * size; the NVFP4 build's kernels write bf16 directly, which is why it
 * halves the activation cost as well as the weights.
 *
 * Tokens: H3's VAE is 16x spatial and 4x temporal, the DiT patches 2x2, so a
 * latent frame is (w/32)·(h/32) tokens; the first latent frame holds one
 * frame and each later one four. References ride through every step — at
 * "match" scaled down to the clip's pixel area, at "max" to a 2048 px short
 * edge. Audio and text tokens are folded in per frame. The numbers are
 * deliberately rough (it says ≈), but they are on the right side of the
 * failures we have seen. */
export const VRAM_MODEL = {
  activationKBPerToken: { int8: 160, nvfp4: 80 }, // peak per-layer working set
  ditGB: { int8: 20, nvfp4: 12 },                  // the whole DiT, resident
  minWeightsGB: { int8: 2.5, nvfp4: 1.5 },         // what the dynamic loader must keep on the card
  overheadGB: 3,                                   // CUDA context, VAE/TE pins, other tenants
  extraTokensPerFrame: 50,                         // audio + text conditioning
  maxRefShortEdge: 2048,
  assumedMaxRef: { width: 3072, height: 2048 },    // a reference whose size we do not know, at "max"
};

function latentFrameCount(numFrames) {
  return 1 + Math.ceil(Math.max(0, numFrames - 1) / 4);
}

function refImageTokens(img, clipW, clipH, max) {
  let w = +img?.width || 0, h = +img?.height || 0;
  if (!w || !h) {
    if (!max) return Math.floor(clipW / 32) * Math.floor(clipH / 32);
    ({ width: w, height: h } = VRAM_MODEL.assumedMaxRef);
  }
  const s = max
    ? Math.min(1, VRAM_MODEL.maxRefShortEdge / Math.min(w, h))
    : Math.min(1, Math.sqrt((clipW * clipH) / (w * h)));
  return Math.floor((w * s) / 32) * Math.floor((h * s) / 32);
}

function refVideoTokens(clip, perFrame) {
  const frames = +clip?.frames || (clip?.duration ? Math.round(clip.duration * 24) : 124);
  return latentFrameCount(Math.min(frames, 362)) * perFrame;
}

/** @returns null for engines we have no model for (LTX-2.5), else
 *  { tokens, activationsGB, needGB, comfortableGB, cardGB, verdict, … } with
 *  verdict one of "ok" | "tight" | "no" | "unknown" (no card size known). */
export function estimateVram(project, { cardGB = null } = {}) {
  if (activeEngine(project) === "ltx25") return null;
  const { width, height } = dimensions(project);
  const numFrames = frameCount(project);
  const perFrame = Math.floor(width / 32) * Math.floor(height / 32);
  const latentFrames = latentFrameCount(numFrames);
  const video = latentFrames * perFrame;

  let refs = 0;
  if (project.mode === "r2v") {
    const max = project.render?.refImageSize === "max";
    for (const img of (project.refs?.images || []).slice(0, 9)) refs += refImageTokens(img, width, height, max);
    for (const clip of (project.refs?.videos || []).slice(0, 3)) refs += refVideoTokens(clip, perFrame);
  }
  const extra = numFrames * VRAM_MODEL.extraTokensPerFrame;
  const tokens = video + refs + extra;

  const precision = project.render?.precision === "nvfp4" ? "nvfp4" : "int8";
  const activationsGB = (tokens * VRAM_MODEL.activationKBPerToken[precision]) / (1024 * 1024);
  const needGB = activationsGB + VRAM_MODEL.minWeightsGB[precision] + VRAM_MODEL.overheadGB;
  const comfortableGB = activationsGB + VRAM_MODEL.ditGB[precision] + VRAM_MODEL.overheadGB;
  const card = +cardGB || null;
  const verdict = !card ? "unknown" : needGB > card ? "no" : comfortableGB > card ? "tight" : "ok";
  return { tokens, video, refs, extra, latentFrames, numFrames, precision, activationsGB, needGB, comfortableGB, cardGB: card, verdict };
}

/** The levers that would bring a render back under the card, in the order
 *  they pay off — only the ones this project has not pulled already. */
export function vramLevers(project, fit) {
  const out = [];
  if (!fit) return out;
  if ((project.render?.duration || 5) > 5) out.push("a shorter clip");
  const { width, height } = dimensions(project);
  if (width * height > 832 * 480) out.push("a lower resolution");
  if (project.mode === "r2v" && project.render?.refImageSize === "max") out.push("references at “match”");
  if (project.mode === "r2v" && (project.refs?.images || []).length > 3) out.push("fewer reference pictures");
  if (fit.precision !== "nvfp4") out.push("the NVFP4 build");
  return out;
}
