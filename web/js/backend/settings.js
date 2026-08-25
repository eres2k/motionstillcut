/* MOTIONSTILL CUT — settings, client-side.
 *
 * The public release has no server, so the one JSON file the Cut server kept
 * under data/settings.json becomes one localStorage key. Same shape, same
 * deep-merge semantics, same "defaults, then what you chose" order — the
 * Setup page cannot tell the difference.
 *
 * Node-safe on purpose: api.js is imported by modules the test suite loads
 * under `node --test`, so nothing here may touch the DOM, and localStorage is
 * only reached through guards.
 */

const KEY = "mscut.settings";

/* Model files, spelled exactly as ComfyUI lists them. These are the
 * Comfy-Org repack names from huggingface.co/Comfy-Org/MiniMax-H3 plus the
 * lightx2v/ModelTC Turbo distills — the Setup page can repoint every one of
 * them at whatever a given install actually has on disk. */
export const DEFAULT_MODELS = {
  dit_fl2va:      "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
  dit_ref2va:     "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
  dit_fl2va_nvfp4:  "MiniMax_H3_FL2VA_pruned_nvfp4.safetensors",
  dit_ref2va_nvfp4: "MiniMax_H3_REF2VA_pruned_nvfp4.safetensors",
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
};

export const DEFAULT_SETTINGS = {
  comfy: {
    previews: true,
    url: "http://127.0.0.1:8188",
    outputPrefix: "MotionstillCut",
    /* Save "MotionstillCut_T2V_name" at the top of ComfyUI's output folder
     * instead of "MotionstillCut/T2V_name" inside a subfolder. The fallback
     * Deliver offers when the subfolder turns out not to be writable. */
    flatOutput: false,
  },
  llm: {
    url: "http://127.0.0.1:1234",
    apiKey: "",
    model: "",
    visionModel: "",
    temperature: 0.7,
    maxTokens: 1600,
    jsonMode: "auto",
    thinking: "off",
    noThinkTag: "on",
  },
  vram: {
    saver: true,
    releaseAfterRender: false,
  },
  models: { ...DEFAULT_MODELS },
  render: {
    resolution: "832x480",
    duration: 5,
    fps: 24,
    engine: "minimax",
    variant: "turbo",
    steps: null,
    seed: -1,
    solAttn: false,
    freeMemory: true,
    tiledDecode: false,
    easyCache: false,
    refImageSize: "match",
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

const stripTrailingSlash = (url) => (typeof url === "string" ? url.replace(/\/+$/, "") : url);

let _cache = null;

export function loadSettings() {
  if (_cache) return _cache;
  let stored = {};
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    if (raw) stored = JSON.parse(raw);
  } catch {
    // A corrupt value must not stop the editor from opening — the Setup page
    // is where it gets fixed, and it needs the app to load first.
    stored = {};
  }
  /* The local Node app's first-run wizard can hand the browser its engine
   * addresses through the injected marker — defaults only: anything the user
   * later changes on Setup (stored) still wins. */
  const seed = typeof window !== "undefined" ? (window.__MSCUT_LOCAL__?.seed || null) : null;
  _cache = deepMerge(seed ? deepMerge(DEFAULT_SETTINGS, seed) : DEFAULT_SETTINGS, stored);
  return _cache;
}

export function saveSettings(patch) {
  const merged = deepMerge(loadSettings(), patch || {});
  if (merged.comfy) merged.comfy.url = stripTrailingSlash(merged.comfy.url);
  if (merged.llm) merged.llm.url = stripTrailingSlash(merged.llm.url);
  _cache = merged;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(merged));
  } catch (err) {
    return { ok: false, error: `This browser would not keep the settings (${err.message}). They hold for this tab only.`, settings: merged };
  }
  return { ok: true, settings: merged };
}

/** Same contract as the server's publicSettings — the UI reads hasApiKey, and
 *  the raw key stays out of the objects that get rendered and logged. */
export function publicSettings() {
  const s = loadSettings();
  return {
    ...s,
    llm: { ...s.llm, apiKey: undefined, hasApiKey: !!s.llm.apiKey },
    dataFile: "this browser (localStorage + IndexedDB)",
  };
}

/** For a full backup: everything, exactly as stored. */
export function rawSettings() { return loadSettings(); }

/** Restore from a backup, replacing what is here. */
export function restoreSettings(obj) {
  _cache = deepMerge(DEFAULT_SETTINGS, obj && typeof obj === "object" ? obj : {});
  try { if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(_cache)); } catch { /* tab-only */ }
  return _cache;
}
