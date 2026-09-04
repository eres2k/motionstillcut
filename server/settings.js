/**
 * MOTIONSTILL CUT — settings store.
 *
 * One JSON file (data/settings.json, gitignored) holds everything the
 * editor needs to reach a machine: where ComfyUI is, where the LLM server is,
 * which MiniMax H3 files to load, and how the VRAM arbiter should behave.
 *
 * Environment variables win over the file, and the file wins over the
 * defaults — so a box that is configured through the shell keeps working when
 * someone opens the Setup page, and a box that is configured through the
 * Setup page keeps working across restarts.
 *
 * No dependencies: this project runs with `node server/server.js` on a
 * bare Node 18+ install, no npm install anywhere.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(__dirname, "..");
export const WEB_DIR = join(PROJECT_ROOT, "web");
const DATA_DIR = process.env.CUT_DATA || join(PROJECT_ROOT, "data");
const SETTINGS_FILE = join(DATA_DIR, "settings.json");

/* Model files, spelled exactly as ComfyUI lists them. These are the
 * Comfy-Org repack names from huggingface.co/Comfy-Org/MiniMax-H3 plus the
 * lightx2v/ModelTC Turbo distills — the Setup page can repoint every one of
 * them at whatever a given install actually has on disk. */
export const DEFAULT_MODELS = {
  dit_fl2va:      "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
  dit_ref2va:     "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
  dit_fl2va_nvfp4:  "MiniMax_H3_FL2VA_pruned_nvfp4.safetensors",
  dit_ref2va_nvfp4: "MiniMax_H3_REF2VA_pruned_nvfp4.safetensors",
  /* Post-render upscalers (Deliver ▸ Upscale). SeedVR2's loader downloads the
   * 3B fp8 build itself on first use; the 7B builds are the better restorer
   * on a card that holds them. ESRGAN is any ESRGAN-family file in
   * models/upscale_models. */
  seedvr2_dit: "seedvr2_ema_3b_fp8_e4m3fn.safetensors",
  seedvr2_vae: "ema_vae_fp16.safetensors",
  esrgan:      "RealESRGAN_x4plus.safetensors",
  text_encoder:   "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
  video_vae:      "minimax_h3_video_vae_fp16.safetensors",
  audio_vae:      "minimax_h3_audio_vae_fp32.safetensors",
  turbo_lora_8:   "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
  turbo_lora_4:   "minimax_h3_fl2v_turbo_4step_v1.1_768p_comfyui_bf16.safetensors",
  ref_turbo_lora: "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",

  /* The experimental second engine — LTX-2.5's split, Comfy-aligned pack
   * (huggingface.co/Lightricks/LTX-2.5), spelled as the repo ships them. The
   * transformer must be the comfy-int8-convrot conversion: the nvfp4 file in
   * the same repo folder is a CLI-only ModelOpt export ComfyUI cannot load. */
  ltx25_dit:          "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
  ltx25_text_encoder: "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
  ltx25_video_vae:    "ltx-2.5-video-vae-conv-bf16.safetensors",
  ltx25_audio_vae:    "ltx-2.5-audio-vae-bf16.safetensors",
  ltx25_upscaler:     "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",
  // Lightricks' own upscaler: an IC-LoRA that regenerates a clip at 2× with
  // the clip itself as the reference. Gated on Hugging Face (accept the
  // licence), 327 MB, into models/loras. Deliver ▸ Upscale ▸ LTX-2.5.
  ltx25_upscale_lora: "ltx-2.5-22b-ic-lora-pixel-spatial-upscaler-x2-1.0.safetensors",
};

export const DEFAULT_SETTINGS = {
  comfy: {
    // ComfyUI streams the sampler's own frames over its websocket when it was
    // started with --preview-method. Showing them costs a little bandwidth and
    // turns a multi-minute wait into something you can watch.
    previews: true,
    url: "http://127.0.0.1:8188",
    // Prefix every SaveVideo lands under, inside ComfyUI's output folder.
    outputPrefix: "MotionstillCut",
  },
  llm: {
    url: "http://127.0.0.1:1234",
    apiKey: "",
    model: "",         // "" → whatever the server has loaded / JIT-loads
    visionModel: "",   // "" → reuse `model` for image captioning
    temperature: 0.7,
    maxTokens: 1600,
    // Whether to ask the backend for `response_format: json_object`.
    //   auto — ask once; if the backend rejects it, stop asking (the default)
    //   off  — never ask, for a runtime that errors in a way we can't detect
    // Either way the prompts demand JSON and the parser digs it out of prose,
    // so this only ever changes reliability, never capability.
    jsonMode: "auto",
    // Reasoning models are the commonest cause of a structured call coming
    // back unparseable: the thought eats the token budget and the answer never
    // arrives. On "off" we ask the backend to skip thinking for structured
    // calls, in every dialect at once; "auto" leaves the model alone.
    thinking: "off",
    // Qwen3's in-prompt switch, appended on structured calls when thinking is
    // off. Inert to every other model — but if yours echoes it back, set this
    // to "off".
    noThinkTag: "on",
    // How hard a reasoning model thinks, while thinking is on: default | low |
    // medium | high. Sent as reasoning_effort; never sent with thinking off.
    reasoning: "default",
  },
  vram: {
    // The whole point of the mode: one engine on the GPU at a time. The
    // arbiter unloads the LLM before ComfyUI queues, and frees ComfyUI's
    // models before the LLM is asked anything.
    saver: true,
    // Free ComfyUI's models the moment a render finishes, instead of leaving
    // them resident until the LLM next needs the card.
    releaseAfterRender: false,
  },
  // The name the Deliver page's watermark writes — the owner's, the same for
  // every project, so it lives here and not in the project.
  watermark: { text: "" },
  models: { ...DEFAULT_MODELS },
  render: {
    resolution: "832x480",
    duration: 5,
    fps: 24,
    engine: "minimax",    // minimax | ltx25 (experimental second engine)
    variant: "turbo",     // full | turbo | turbo4 | ref4 (r2v) | ltx_two | ltx_single (ltx25)
    steps: null,          // null → the variant's own step count
    seed: -1,             // -1 → random per run
    solAttn: false,
    freeMemory: true,
    tiledDecode: false,
    easyCache: false,
    refImageSize: "match",
  },
  /* The local app's own two switches, set by the first-run wizard at /setup.
   * With saving ON this server persists projects, the library and settings
   * under data/ and proxies both engines — the original Cut behaviour. With
   * saving OFF it only hosts the interface, and the app behaves exactly like
   * the public web version: everything stays in the browser. */
  local: {
    saving: true,
    setupDone: false,
  },
};

function deepMerge(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v && typeof v === "object" && !Array.isArray(v) && base && typeof base[k] === "object" && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function stripTrailingSlash(url) {
  return typeof url === "string" ? url.replace(/\/+$/, "") : url;
}

/* Env overrides, applied on top of whatever is on disk. Named after the
 * project so they can sit in the same .env as the main app's without
 * colliding with COMFYUI_HOST / LMSTUDIO_BASE. */
function envPatch() {
  const p = {};
  const comfy = process.env.CUT_COMFY_URL
    || (process.env.COMFYUI_HOST || process.env.COMFYUI_PORT
        ? `http://${process.env.COMFYUI_HOST || "127.0.0.1"}:${process.env.COMFYUI_PORT || 8188}`
        : "");
  if (comfy) p.comfy = { url: stripTrailingSlash(comfy) };
  const llm = process.env.CUT_LLM_URL || process.env.LMSTUDIO_BASE || "";
  if (llm) p.llm = { url: stripTrailingSlash(llm) };
  const key = process.env.CUT_LLM_KEY || process.env.LM_STUDIO_API_KEY || "";
  if (key) p.llm = { ...(p.llm || {}), apiKey: key };
  const model = process.env.CUT_LLM_MODEL || "";
  if (model) p.llm = { ...(p.llm || {}), model };
  if (process.env.CUT_VRAM_SAVER != null) {
    p.vram = { saver: !/^(0|false|off|no)$/i.test(process.env.CUT_VRAM_SAVER.trim()) };
  }
  // CUT_SAVING=0 turns this instance into a pure static host (and skips the
  // wizard's question ever mattering); CUT_SAVING=1 forces saving on.
  if (process.env.CUT_SAVING != null) {
    p.local = { saving: !/^(0|false|off|no)$/i.test(process.env.CUT_SAVING.trim()) };
  }
  return p;
}

let _cache = null;

export function loadSettings() {
  if (_cache) return _cache;
  let onDisk = {};
  try {
    if (existsSync(SETTINGS_FILE)) onDisk = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
  } catch {
    // A corrupt settings file must not stop the editor from opening — the
    // Setup page is where it gets fixed, and it needs the app to load first.
    onDisk = {};
  }
  _cache = deepMerge(deepMerge(DEFAULT_SETTINGS, onDisk), envPatch());
  return _cache;
}

export function saveSettings(patch) {
  const merged = deepMerge(loadSettings(), patch || {});
  if (merged.comfy) merged.comfy.url = stripTrailingSlash(merged.comfy.url);
  if (merged.llm) merged.llm.url = stripTrailingSlash(merged.llm.url);
  _cache = merged;
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    // Env overrides are re-applied on every load, so writing the merged
    // object back is harmless — but the file stays the record of what the
    // user chose in the UI.
    writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
  } catch (err) {
    return { ok: false, error: err.message, settings: merged };
  }
  return { ok: true, settings: merged };
}

/** Settings safe to hand the browser — the API key never leaves the server,
 *  only the fact that one is set. */
export function publicSettings() {
  const s = loadSettings();
  return {
    ...s,
    llm: { ...s.llm, apiKey: undefined, hasApiKey: !!s.llm.apiKey },
    dataFile: SETTINGS_FILE,
  };
}

export { DATA_DIR, SETTINGS_FILE };
