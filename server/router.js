/**
 * MOTIONSTILL CUT — the local app's API + static handler.
 *
 * This is the optional Node half of the public release: `node server/server.js`
 * serves the same web/ folder the hosted version ships, plus — when the
 * first-run wizard at /setup enables LOCAL SERVER SAVING — the original Cut
 * server's API: projects, the library, the rulebook and the cast as plain
 * JSON under data/, both engines proxied (no CORS setup in ComfyUI or the LLM
 * server needed), and ffmpeg joins for multi-clip films.
 *
 * With saving OFF this process is a static host and nothing more; the app in
 * the browser then behaves exactly like the hosted version — everything stays
 * in the browser's own storage, and the persistence routes below answer 403
 * so nothing can land on disk by accident.
 *
 * Kept as a plain (req, res, next) function — no framework, no dependencies.
 */

import { createReadStream, existsSync, statSync, readFileSync } from "node:fs";
import { join, normalize, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WEB_DIR, loadSettings, saveSettings, publicSettings, DEFAULT_MODELS } from "./settings.js";
import { claim, releaseAll, vramState, comfyFetch, llmFetch, llmHeaders, renderStarted, renderFinished, freeComfy, unloadLLM } from "./vram.js";
import * as store from "./store.js";
import * as projects from "./projects.js";
import { ffmpegAvailable, lastFrame, assemble, filmPath, exportEdit, probeSource } from "./film.js";
import { voiceHealth, listVoices, speak, addReferenceVoice, removeReferenceVoice, ENGINES as VOICE_ENGINES } from "./voice.js";
import { resolveStatus, sendToResolve } from "./resolve.js";

export const CUT_VERSION = "1.0.0";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

/** Is this instance persisting anything? One place decides. */
export const savingEnabled = () => loadSettings().local?.saving !== false;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".mjs":  "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".tsv":  "text/tab-separated-values; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico":  "image/x-icon",
  ".woff2":"font/woff2",
  ".mp4":  "video/mp4",
  ".webm": "video/webm",
};

const MAX_BODY = 96 * 1024 * 1024;   // base64 reference images travel in the JSON body

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(text);
}

async function readBody(req) {
  // Express (or another framework) may already have parsed it.
  if (req.body !== undefined && req.body !== null && typeof req.body === "object") return req.body;
  if (req.method === "GET" || req.method === "HEAD") return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf-8");
  try { return JSON.parse(text); } catch { throw Object.assign(new Error("body must be JSON"), { status: 400 }); }
}

/* The shell has to know where it is mounted.
 *
 * Every asset in index.html is referenced relatively, which is what lets the
 * same files serve from "/" standalone and from "/cut/" inside the main app.
 * But a URL without the trailing slash — http://host/cut — has a base of "/",
 * so "css/resolve.css" resolves to "/css/resolve.css", the host app's SPA
 * fallback answers it with its own index.html, and the browser renders an
 * unstyled page with no scripts. A <base> makes the shell immune to that
 * whichever way it is reached. */
function shellWithBase(file, req) {
  const mount = req.baseUrl && req.baseUrl !== "/" ? `${req.baseUrl.replace(/\/+$/, "")}/` : "/";
  const html = readFileSync(file, "utf-8");
  /* The one thing the shell needs to know that the static files cannot say:
   * whether a saving server is behind this page. api.js reads the marker and
   * routes every request to /api (saving on) or answers it in the tab
   * (saving off — the page then behaves exactly like the hosted version,
   * seeded with the engine addresses the wizard chose). The JSON is escaped
   * so a hostile settings value cannot close the script tag. */
  const s = loadSettings();
  const marker = JSON.stringify({
    saving: s.local?.saving !== false,
    version: CUT_VERSION,
    seed: { comfy: { url: s.comfy.url }, llm: { url: s.llm.url } },
  }).replace(/</g, "\\u003c");
  return html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n<base href="${mount}">\n<script>window.__MSCUT_LOCAL__=${marker}</script>`);
}

function serveStatic(req, res, pathname, next) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) return sendText(res, 403, "forbidden");
  if (!existsSync(file) || statSync(file).isDirectory()) {
    // SPA fallback — every unknown path is a page of the editor, except the
    // asset folders, where a 404 is the honest answer (and much easier to
    // debug than an HTML file served as JavaScript).
    if (/^\/(js|css|assets)\//.test(pathname)) {
      if (next) return next();
      return sendText(res, 404, "not found");
    }
    file = join(WEB_DIR, "index.html");
    if (!existsSync(file)) {
      if (next) return next();
      return sendText(res, 404, "not found");
    }
  }
  const type = MIME[extname(file).toLowerCase()] || "application/octet-stream";
  if (file.endsWith("index.html")) {
    const html = shellWithBase(file, req);
    res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
    return res.end(html);
  }
  res.writeHead(200, {
    "Content-Type": type,
    // The editor is developed live; a cached module is a confusing bug.
    "Cache-Control": "no-cache",
  });
  createReadStream(file).pipe(res);
}

/* Candidate addresses the auto-detect button probes. Ordered by how likely
 * each one is to be the thing the user actually installed. */
const COMFY_CANDIDATES = [
  "http://127.0.0.1:8188", "http://localhost:8188",
  "http://127.0.0.1:8189", "http://127.0.0.1:8000", "http://127.0.0.1:3000",
];
const LLM_CANDIDATES = [
  "http://127.0.0.1:1234",   // LM Studio
  "http://127.0.0.1:11434",  // Ollama
  "http://127.0.0.1:8080",   // llama.cpp server
  "http://127.0.0.1:8081",   // llama-swap
  "http://127.0.0.1:5001",   // KoboldCpp
  "http://127.0.0.1:3000",   // Nexus gateway
];

async function probeComfy(url, timeout = 2500) {
  try {
    const r = await fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(timeout) });
    if (!r.ok) return { url, ok: false, status: r.status };
    const data = await r.json();
    const dev = data?.devices?.[0] || {};
    return {
      url, ok: true,
      version: data?.system?.comfyui_version || null,
      python: data?.system?.python_version?.split(" ")[0] || null,
      device: dev.name || null,
      vramTotalGB: dev.vram_total ? +(dev.vram_total / 1073741824).toFixed(1) : null,
      vramFreeGB: dev.vram_free ? +(dev.vram_free / 1073741824).toFixed(1) : null,
    };
  } catch (e) { return { url, ok: false, error: e.message }; }
}

async function probeLLM(url, timeout = 2500) {
  const headers = { ...llmHeaders() };
  for (const path of ["/v1/models", "/api/tags"]) {
    try {
      const r = await fetch(`${url}${path}`, { headers, signal: AbortSignal.timeout(timeout) });
      if (!r.ok) continue;
      const data = await r.json();
      const models = Array.isArray(data?.data) ? data.data.map(m => m.id)
        : Array.isArray(data?.models) ? data.models.map(m => m.name || m.model)
        : [];
      return {
        url, ok: true,
        flavour: path === "/api/tags" ? "ollama" : "openai",
        models: models.filter(Boolean).slice(0, 200),
      };
    } catch { /* try the next shape */ }
  }
  return { url, ok: false };
}

/* Which MiniMax nodes does this ComfyUI actually have? A missing node is the
 * difference between "queued" and a 400 nobody can read, so the Setup page
 * checks for them by name before the Deliver page offers to send anything. */
/* Every one of these ships with ComfyUI — this project deliberately uses no
 * custom node packs, so "missing" here means the ComfyUI build is too old for
 * MiniMax H3, never that something needs installing from GitHub. */
const REQUIRED_NODES = {
  MiniMaxH3ImageToVideo:      "T2V / I2V conditioning",
  MiniMaxH3ReferenceToVideo:  "Ref2V conditioning",
  MiniMaxH3SigmaShift:        "flow sigma shift",
  CLIPLoader:                 "Qwen3-VL text encoder",
  UNETLoader:                 "H3 DiT loader",
  VAELoader:                  "video + audio VAEs",
  SamplerCustomAdvanced:      "the sampling pass",
  VAEDecodeAudio:             "audio decode",
  CreateVideo:                "video mux",
  SaveVideo:                  "save",
};
const OPTIONAL_NODES = {
  LoraLoaderModelOnly: "Turbo distill LoRAs",
  ImageScale:          "fitting the I2V first frame to the canvas",
  LoadVideo:           "reference clips (Ref2V)",
  GetVideoComponents:  "reference clip frames + soundtrack (Ref2V)",
  LoadAudio:           "reference audio (Ref2V)",
  VAEDecodeTiled:      "tiled decode on long clips",
  // The one custom-pack probe: Deliver ▸ Audio's vocal separation. Missing
  // means "install ComfyUI-MelBandRoFormer", never "your ComfyUI is old" —
  // which is why it sits here and not with the LTX group below.
  MelBandRoFormerSampler: "vocal separation for audio conditioning (ComfyUI-MelBandRoFormer pack)",
};

/* What the EXPERIMENTAL LTX-2.5 engine additionally needs. These are not part
 * of the stock-nodes promise above — they arrive with ComfyUI's LTX-2 AV
 * support, and a build can have every MiniMax node while missing all of them.
 * That is why they get their own group in the health payload instead of a
 * place in REQUIRED_NODES: missing LTX nodes must never paint the MiniMax
 * modes red. (The loaders — UNETLoader, CLIPLoader, VAELoader — and the
 * sampling stack are already checked above; only the LTX-specific ones are
 * listed here.) */
const LTX_NODES = {
  LTXVConditioning:         "prompt conditioning with a frame rate",
  EmptyLTXVLatentVideo:     "the video latent (8k+1 frame grid)",
  LTXVEmptyLatentAudio:     "the audio latent",
  LTXVConcatAVLatent:       "joins video + audio into one AV latent",
  LTXVSeparateAVLatent:     "splits it again for decode",
  LTXVAudioVAEDecode:       "audio decode",
  ManualSigmas:             "the distill's baked sigma ladders",
  CFGGuider:                "cfg-1 guidance",
  LTXVAddGuide:             "I2V first-frame anchor",
  LTXVCropGuides:           "crops guide frames back off the latent",
  LatentUpscaleModelLoader: "loads the ×2 upscaler (two-stage build)",
  LTXVLatentUpsampler:      "the 2× latent upscale (two-stage build)",
  LTXVAudioVAEEncode:       "audio conditioning — encodes a supplied track",
  TrimAudioDuration:        "audio conditioning — trims the track to the clip",
  LTXVReferenceAudio:       "voice cloning — a ~5 s reference patches the speaker identity (2.5 core)",
};

const COMFY_FOLDER_SOURCES = {
  diffusion_models: ["UNETLoader",           "unet_name"],
  loras:            ["LoraLoaderModelOnly",  "lora_name"],
  vae:              ["VAELoader",            "vae_name"],
  text_encoders:    ["CLIPLoader",           "clip_name"],
  // The LTX-2.5 two-stage build's upscaler lives in its own folder. On a
  // ComfyUI without the loader the enum is simply empty, which the Setup
  // page reads as "no autocomplete", not as an error.
  latent_upscale_models: ["LatentUpscaleModelLoader", "model_name"],
};

let _objectInfo = { at: 0, data: null, url: "" };
async function objectInfo(maxAgeMs = 60000) {
  const { comfy } = loadSettings();
  if (_objectInfo.data && _objectInfo.url === comfy.url && Date.now() - _objectInfo.at < maxAgeMs) return _objectInfo.data;
  const data = await comfyFetch("/object_info", { timeout: 60000 });
  _objectInfo = { at: Date.now(), data, url: comfy.url };
  return data;
}

function enumOf(info, node, input) {
  const spec = info?.[node]?.input?.required?.[input] ?? info?.[node]?.input?.optional?.[input];
  if (!Array.isArray(spec)) return [];
  // Two schemas. The older nodes put the list itself in the first slot; the
  // V3 nodes (ComfyUI 0.34 moved the core loaders, and every recent pack
  // ships this way) put the word "COMBO" there and the list under options.
  const list = Array.isArray(spec[0]) ? spec[0]
    : spec[0] === "COMBO" && Array.isArray(spec[1]?.options) ? spec[1].options
    : null;
  return Array.isArray(list) ? list.filter(v => typeof v === "string") : [];
}

/* ── The LLM call every prompt feature goes through ──────────
 * One place that claims the GPU, talks OpenAI-compatible, and unwraps the
 * answer — so the VRAM arbiter cannot be bypassed by a new feature calling
 * the model directly. */
/* What each backend accepted, remembered per address+model rather than per
 * process: one failed probe instead of one per call, but pointing Setup at a
 * different server — or loading a different model into the same one — starts
 * over, because the answer genuinely may have changed. */
const probes = new Map();   // "url::model" → { json: bool|null, quiet: bool|null }

function probeFor(url, model) {
  const key = `${url}::${model}`;
  if (!probes.has(key)) {
    if (probes.size > 20) probes.delete(probes.keys().next().value);
    probes.set(key, { json: null, quiet: null, strength: null });
  }
  return probes.get(key);
}

/** `auto` (probe once) · `off` (never ask, never mind) — from settings. */
const jsonMode = (llm) => String(llm?.jsonMode || "auto").toLowerCase();

/** The shapes a backend uses to say "I do not know that key". */
const COMPLAINT = /unsupported|not supported|unrecognized|unknown (?:field|parameter|argument|key)|invalid (?:field|parameter|argument|key)|extra inputs|unexpected keyword|no such/;

/**
 * Does this failure name THIS extra?
 *
 * The matchers have to be precise about which key was complained about. They
 * were not: "Unrecognized request argument supplied: chat_template_kwargs"
 * matched the response_format detector on the word "unrecognized" alone, so a
 * backend objecting to the anti-thinking key had JSON mode switched off for
 * the whole session — and was then asked about the anti-thinking key again,
 * because the wrong extra had been dropped.
 */
function rejectsJsonMode(status, data, text) {
  if (![400, 422, 500, 501].includes(status)) return false;
  const msg = String(data?.error?.message || data?.error || text || "").toLowerCase();
  if (/chat_template_kwargs|enable_thinking|reasoning_effort|\bthink\b/.test(msg)) return false;   // not ours
  return /response_format|json_object|json_schema|json[ _-]?mode|structured output|guided/.test(msg);
}

/** A 400 that names one of the keys we add to quieten a reasoning model. */
function rejectsUnknownField(status, data, text) {
  if (![400, 422, 500, 501].includes(status)) return false;
  const msg = String(data?.error?.message || data?.error || text || "").toLowerCase();
  if (/response_format|json_object|json_schema/.test(msg)) return false;           // not ours
  return /chat_template_kwargs|enable_thinking|\bthink(?:ing)?\b/.test(msg) && COMPLAINT.test(msg);
}

/** A 400 that names the reasoning-strength key. */
function rejectsStrength(status, data, text) {
  if (![400, 422, 500, 501].includes(status)) return false;
  const msg = String(data?.error?.message || data?.error || text || "").toLowerCase();
  return /reasoning_effort|reasoning_strength/.test(msg) && COMPLAINT.test(msg);
}

/** Reasoning strength, only while thinking is on. gpt-oss reads
 *  reasoning_effort natively; llama.cpp binds it — and reasoning_strength —
 *  into any chat template that reads either ("none" is its off switch, which
 *  is why this is never sent with thinking off: to a model that treats it as
 *  a floor, "low" asks for MORE thinking than saying nothing). Other runtimes
 *  ignore an unknown key, and one that objects gets it dropped on retry. */
function strengthFor(llm, suppress) {
  const v = String(llm.reasoning || "default").toLowerCase();
  return !suppress && ["low", "medium", "high"].includes(v) ? v : "";
}

async function llmChat(body) {
  const { llm } = loadSettings();
  await claim("llm");
  // Whatever the user has learned on this box rides along with every rewrite.
  // A suite that only knows the vendor's guide forgets last week.
  const house = body.useRulebook === false ? "" : store.rulebookPrompt(body.mode || "");
  const system = house && body.system ? `${body.system}\n\n${house}` : (body.system || house);
  const messages = Array.isArray(body.messages) && body.messages.length
    ? body.messages
    : [
        ...(system ? [{ role: "system", content: system }] : []),
        {
          role: "user",
          content: body.images?.length
            ? [
                { type: "text", text: String(body.prompt || "") },
                ...body.images.map(url => ({ type: "image_url", image_url: { url } })),
              ]
            : String(body.prompt || ""),
        },
      ];
  const model = body.model || (body.images?.length && llm.visionModel) || llm.model || "local-model";

  /* Reasoning models are the single biggest cause of "the model did not answer
   * with JSON", and the cause is almost never that thinking is switched OFF.
   * It is that thinking is switched ON and eats the whole token budget before
   * the answer starts, or that the runtime files the thought in a separate
   * field and leaves `content` empty.
   *
   * So for a structured call we ask the model NOT to think. Every backend
   * spells that differently and none of them mind an unknown key, so we send
   * all of the dialects at once and let each ignore the others. `thinking:
   * "auto"` opts out of this for someone who wants the reasoning anyway. */
  const think = String(llm.thinking || "off").toLowerCase();
  const suppress = think === "off";

  /* Each of these is one backend's spelling. They are best-effort by design —
   * a backend that does not know a key ignores it, and one that objects gets
   * the whole set dropped on the retry above.
   *
   * `reasoning_effort` is deliberately NOT here. On gpt-oss its values are
   * low/medium/high with no "off", and on llama.cpp the disabling value is
   * "none" — so one value cannot serve both, and sending "low" to a model that
   * reads it as a floor asks for MORE thinking than saying nothing would.
   * Some models (DeepSeek-R1) cannot be told to stop at all; that is what the
   * rest of this file is for. */
  const quiet = suppress ? {
    chat_template_kwargs: {
      enable_thinking: false,   // Qwen3 via vLLM / SGLang / llama.cpp
      thinking: false,          // DeepSeek-V3.x's spelling of the same switch
    },
    think: false,               // Ollama's native flag
  } : {};

  const base = {
    // A call carrying images goes to the vision model when one is configured:
    // the text model is usually the better writer, and it cannot see.
    model, messages,
    temperature: body.temperature ?? llm.temperature ?? 0.7,
    // A reasoning model needs room for the thought AND the answer. Asking for
    // 1600 and getting 1600 tokens of thinking is not a model that cannot do
    // JSON; it is a budget that was never big enough.
    max_tokens: body.maxTokens ?? llm.maxTokens ?? 1600,
    stream: false,
    ...quiet,
  };
  const probe = probeFor(llm.url || "", model);
  let useQuiet = suppress && probe.quiet !== false;
  const effort = strengthFor(llm, suppress);
  let useStrength = !!effort && probe.strength !== false;

  /* Qwen3's soft switch. It is the only lever that survives a runtime which
   * never plumbs chat_template_kwargs through to the template — LM Studio's
   * passthrough is unreliable — and it is inert everywhere else, because to
   * any other model it is four characters of prompt. */
  if (suppress && String(llm.noThinkTag ?? "on") !== "off") {
    const last = base.messages[base.messages.length - 1];
    if (last && typeof last.content === "string") last.content = `${last.content}\n/no_think`;
    else if (last && Array.isArray(last.content)) {
      const t = last.content.find(part => part?.type === "text");
      if (t) t.text = `${t.text}\n/no_think`;
    }
  }

  /* JSON mode is optional, everywhere. llama.cpp's server, older Ollama
   * builds, most proxies and plenty of LM Studio model runtimes reject
   * `response_format` outright — and because we sent it on every structured
   * call, one unsupported backend broke every assistant feature in the app
   * with a raw 400. So: ask for it, and if the backend says no, ask again
   * without it and remember that for the rest of the process. The prompts
   * already say "JSON only" and parseLooseJson already digs the object out of
   * prose, so losing the flag costs reliability, not function. */
  const wantJson = !!body.json && jsonMode(llm) !== "off";
  let useFlag = wantJson && probe.json !== false;

  /* Two optional extras, two probes, and they must not undo one another: the
   * old code re-attached response_format inside the anti-thinking fallback,
   * so a backend that rejected BOTH was asked for the rejected one again.
   * One builder, one send, one place that drops a rejected extra. */
  const build = () => {
    const out = { ...base };
    if (!useQuiet) for (const k of QUIET_KEYS) delete out[k];
    if (useStrength) {
      out.reasoning_effort = effort;
      out.chat_template_kwargs = { ...(out.chat_template_kwargs || {}), reasoning_effort: effort, reasoning_strength: effort };
    }
    if (useFlag) out.response_format = { type: "json_object" };
    return out;
  };

  const t0 = Date.now();
  let r, text, data;
  const send = async () => {
    r = await llmFetch("/v1/chat/completions", { method: "POST", body: build(), timeout: body.timeout ?? 600000 });
    text = await r.text();
    data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
  };
  await send();

  // Up to two retries, each dropping exactly the extra the backend named.
  for (let attempt = 0; attempt < 2 && !r.ok; attempt++) {
    if (useFlag && rejectsJsonMode(r.status, data, text)) { probe.json = false; useFlag = false; }
    else if (useQuiet && rejectsUnknownField(r.status, data, text)) { probe.quiet = false; useQuiet = false; }
    else if (useStrength && (rejectsStrength(r.status, data, text) || rejectsUnknownField(r.status, data, text))) { probe.strength = false; useStrength = false; }
    else break;
    await send();
  }
  if (r.ok && useFlag) probe.json = true;
  if (r.ok && useQuiet) probe.quiet = true;
  if (r.ok && useStrength) probe.strength = true;

  if (!r.ok) {
    throw Object.assign(new Error(data?.error?.message || data?.error || text.slice(0, 400) || `LLM ${r.status}`), { status: r.status === 404 ? 502 : r.status });
  }

  const out = readChoice(data, { allowReasoningFallback: !!body.json });
  return {
    text: out.text,
    model: data?.model || model,
    usage: data?.usage || null,
    ms: Date.now() - t0,
    // Everything the caller needs to say something USEFUL when the answer will
    // not parse, instead of "try a bigger model".
    finish: out.finish,
    reasoned: out.reasoned,
    fromReasoning: out.fromReasoning,
    jsonMode: useFlag,
    truncated: out.finish === "length",
  };
}

/** The extras a backend might not recognise, dropped as one set on rejection. */
const QUIET_KEYS = ["chat_template_kwargs", "think"];

/**
 * Why an answer would not parse, in terms of the thing to change.
 * Every branch here is a failure seen from a real local backend.
 */
export function diagnoseJson(r) {
  const text = String(r?.text || "");
  const onlyThought = r?.fromReasoning || /^<(think|thinking|thought)>/i.test(text);
  if (r?.truncated) {
    return {
      cause: "truncated",
      title: r.reasoned ? "The model ran out of room while thinking" : "The model ran out of room",
      detail: r.reasoned
        ? `It spent its whole token budget${r.retriedWith ? ` (retried at ${r.retriedWith})` : ""} on reasoning and never reached the answer. Turn thinking off for this model, or raise Max tokens on Setup.`
        : `The answer was cut off${r.retriedWith ? ` even at ${r.retriedWith} tokens` : ""}. Raise Max tokens on Setup.`,
      fix: r.reasoned ? "thinking" : "maxTokens",
    };
  }
  if (!text.trim()) {
    return {
      cause: "empty",
      title: "The model returned nothing",
      detail: "No content and no reasoning came back. Check that a model is actually loaded, and that the model name on Setup matches one the server has.",
      fix: "model",
    };
  }
  if (onlyThought) {
    return {
      cause: "thought-only",
      title: "The model thought but never answered",
      detail: "The whole reply was reasoning, with no answer after it. Turn thinking off for this model on Setup — reasoning models often need to be told to stop.",
      fix: "thinking",
    };
  }
  return {
    cause: "not-json",
    title: "The model answered, but not with JSON",
    detail: "It wrote prose instead of the object it was asked for. An instruct-tuned model of 7B or more usually fixes this; a base or heavily quantised model often cannot follow the format.",
    fix: "model",
    sample: text.slice(0, 240),
  };
}

/**
 * The assistant's text, wherever this runtime decided to put it.
 *
 * vLLM, SGLang, LM Studio, Ollama and OpenRouter all ship the chain of thought
 * in a field of their own — `reasoning_content`, `reasoning`, `thinking` — and
 * several of them will leave `content` EMPTY when the model only thought, or
 * when the answer never arrived. Reading `content` alone turned all of those
 * into "the model did not answer with JSON" with nothing to go on.
 */
function readChoice(data, { allowReasoningFallback = true } = {}) {
  const choice = data?.choices?.[0];
  const msg = choice?.message || {};
  const asText = (v) => typeof v === "string" ? v
    : Array.isArray(v) ? v.map(p => (typeof p === "string" ? p : p?.text || "")).join("")
    : "";
  const content = asText(msg.content).trim();
  const reasoning = [msg.reasoning_content, msg.reasoning, msg.thinking]
    .map(asText).find(v => v.trim()) || "";
  // Chain-of-thought is a fallback only where something will try to parse an
  // object out of it. For a prose call — a rewritten description, a caption —
  // falling back would paste the model's private deliberation straight into
  // the project, which is worse than an empty answer.
  const useReasoning = allowReasoningFallback && !content && !!reasoning.trim();
  const source = useReasoning ? reasoning : content;
  const { outside } = stripReasoning(source);
  return {
    /* A structured call gets the text UNTOUCHED, because parseLooseJson does
     * its own splitting and needs to see the scratchpad to rank around it.
     * A prose call gets only what was written outside the scratchpad — an
     * unterminated thought yields "", which is honest, where returning the
     * thought would paste the model's deliberation into the project. */
    text: (allowReasoningFallback ? source : outside).trim(),
    fromReasoning: useReasoning,
    reasoned: !!reasoning.trim()
      || Number(data?.usage?.completion_tokens_details?.reasoning_tokens || 0) > 0,
    finish: choice?.finish_reason || "",
  };
}

/* ── Getting JSON out of a local model ────────────────────────
 *
 * Without JSON mode — which most local backends reject — this is the only
 * thing standing between a good answer and "the model did not answer with
 * JSON". Reasoning models make it harder still: they emit a scratchpad full of
 * braces and quotes before the answer, and they sometimes wrap the answer in
 * tags of their own.
 *
 * The order matters. Strip the reasoning first (its contents routinely include
 * a JSON *example*, which is a trap), then try the largest candidates before
 * the smallest, so a nested array is never mistaken for the whole answer —
 * which is what happened before: a reply the parser could not read whole came
 * back as its own `actions: []`, silently and wrongly, instead of failing.
 */

/** Everything a reasoning model puts around its answer. */
function stripReasoning(raw) {
  let s = String(raw)
    // Zero-width and BOM: some runtimes prepend them and JSON.parse chokes.
    .replace(/^[\uFEFF\u200B-\u200D\u2060]+/, "")
    // Closed scratchpads, whatever they are called.
    .replace(/<(think|thinking|thought|reasoning|scratchpad)>[\s\S]*?<\/\1>/gi, "")
    // Magistral / Devstral, and Kimi's unicode brackets.
    .replace(/\[THINK\][\s\S]*?\[\/THINK\]/gi, "")
    .replace(/\u25c1think\u25b7[\s\S]*?\u25c1\/think\u25b7/gi, "")
    // gpt-oss / harmony: keep the final channel, drop analysis and commentary.
    .replace(/<\|channel\|>(?:analysis|commentary)<\|message\|>[\s\S]*?(?=<\|(?:end|start|channel|return)\|>|$)/gi, "")
    .replace(/<\|[a-z_]+\|>/gi, "")
    .trim();
  /* An unterminated scratchpad: a closer with no opener, or an opener with no
   * closer. The well-formed pairs are already gone, so whatever is left is a
   * fragment — and BOTH sides of it can hold the answer:
   *
   *   "{answer} <think>wait, should I…"     the answer is BEFORE the opener
   *   "<think>thinking… {answer}"           the answer is AFTER it
   *   "<think>the schema is {…}, so I'll"   there is NO answer, only a thought
   *
   * Slicing to one side loses a real answer on the other; keeping the thought
   * wholesale hands back the model's own schema echo as if it were the answer.
   * So neither side is thrown away — they are RANKED. Text outside the
   * scratchpad is searched first, the thought only as a last resort, and
   * anything found in there still has to survive the placeholder check below.
   */
  const close = s.search(/<\/(?:think|thinking|thought|reasoning|scratchpad)>|\[\/THINK\]/i);
  if (close !== -1) return { outside: s.slice(close).replace(/^(?:<\/[a-z]+>|\[\/THINK\])/i, "").trim(), inside: "" };
  const open = s.search(/<(?:think|thinking|thought|reasoning|scratchpad)>|\[THINK\]/i);
  if (open !== -1) {
    return {
      outside: s.slice(0, open).trim(),
      inside: s.slice(open).replace(/^(?:<[a-z]+>|\[THINK\])/i, "").trim(),
    };
  }
  return { outside: s, inside: "" };
  // (unreachable — every branch above returns)
}

/** Unwrap an answer the model chose to put in tags of its own. */
function unwrap(s) {
  const wrapped = String(s).match(/<(answer|output|final|json|result)>([\s\S]*?)<\/\1>/i);
  return wrapped ? wrapped[2].trim() : String(s);
}

/**
 * Is this the model's schema echo rather than its answer?
 *
 * A reasoning model restates the shape it was given before filling it in, and
 * when it never reaches the answer that restatement is the only object in the
 * reply. Handing it back is worse than failing: the caller gets a shot list
 * whose every subject is the literal string "…", and no error to explain it.
 * A real answer has real words in it.
 */
function isPlaceholder(value) {
  const leaves = [];
  const walk = (v, depth = 0) => {
    if (depth > 6 || leaves.length > 60) return;
    if (typeof v === "string") leaves.push(v.trim());
    else if (Array.isArray(v)) v.forEach(x => walk(x, depth + 1));
    else if (v && typeof v === "object") Object.values(v).forEach(x => walk(x, depth + 1));
  };
  walk(value);
  const bare = /^(?:\u2026|\.{2,3})$/;
  // One field whose whole value is an ellipsis is conclusive: that is the
  // shape as it was handed to the model, not anything it decided.
  if (leaves.some(t => bare.test(t))) return true;
  if (leaves.length < 2) return false;
  return leaves.every(t => !t || /^(?:-|_|x+|todo|tbd|string|placeholder|your \w+ here)$/i.test(t));
}

/** Every substring that could be the answer, most promising first. */
function candidates(cleaned) {
  const out = [cleaned];
  // Fenced blocks anywhere in the reply, not only at the ends.
  for (const m of cleaned.matchAll(/```(?:json5?|javascript|js)?\s*([\s\S]*?)```/gi)) {
    out.push(m[1].trim());
  }
  /* Every balanced object or array, as {start, end}. Two orderings matter,
   * and in this priority:
   *
   *   TOP-LEVEL, LAST FIRST. A model that thinks out loud writes its schema
   *   echo, its abandoned draft and its worked example BEFORE the answer, and
   *   the answer is the last complete object it emits. Longest-first alone
   *   picks whichever of those happened to be biggest — the sweep's strongest
   *   finding, and the reason a reasoning model could return its own notes.
   *
   *   THEN EVERYTHING ELSE, LONGEST FIRST, as a net: if no top-level span
   *   parses, an outer object still beats one of its own nested arrays.
   */
  const spans = [];
  for (let i = 0; i < cleaned.length; i++) {
    const open = cleaned[i];
    if (open !== "{" && open !== "[") continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < cleaned.length; j++) {
      const c = cleaned[j];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        if (--depth === 0) { spans.push({ start: i, end: j, text: cleaned.slice(i, j + 1) }); break; }
      }
    }
  }
  const nested = (sp) => spans.some(o => o !== sp && o.start < sp.start && o.end >= sp.end);
  const top = spans.filter(sp => !nested(sp)).sort((a, b) => b.start - a.start);
  const rest = spans.filter(sp => nested(sp)).sort((a, b) => b.text.length - a.text.length);
  out.push(...top.map(sp => sp.text), ...rest.map(sp => sp.text));
  // A truncated answer: nothing balanced, so offer the tail from each opener
  // and let the repairs close it.
  if (!spans.length) {
    for (let i = 0; i < cleaned.length; i++) {
      if (cleaned[i] === "{" || cleaned[i] === "[") { out.push(cleaned.slice(i)); break; }
    }
  }
  return out;
}

/**
 * @param {string} text  the model's reply
 * @param {string[]} [expect]  keys the caller actually wants. When a reply
 *   contains more than one parseable object — a worked example, an abandoned
 *   draft, a trailing aside — no ordering heuristic can tell which is the
 *   answer, but the caller always knows what it asked for. Given the keys, the
 *   guessing stops.
 */
export function parseLooseJson(text, expect = []) {
  return parseLooseJsonDetailed(text, expect).value;
}

/**
 * The same search, plus where the answer came from.
 *
 * An object found INSIDE an unterminated scratchpad is not necessarily an
 * answer — it may be a draft the model then talked itself out of. Nothing in
 * the text distinguishes the two, so the parser does not pretend to: it says
 * where it looked, and the caller — which knows whether the reply was also cut
 * off — decides whether to trust it or ask again with more room.
 *
 * @returns {{ value: any, fromScratchpad: boolean }}
 */
export function parseLooseJsonDetailed(text, expect = []) {
  if (!text) return { value: null, fromScratchpad: false };
  const { outside, inside } = stripReasoning(text);
  const wanted = Array.isArray(expect) ? expect.filter(Boolean) : [];

  // Outside the scratchpad first, inside it only if nothing else is there.
  for (const region of [outside, inside]) {
    if (!region) continue;
    const isInside = region === inside && !!inside;
    const got = searchRegion(unwrap(region), wanted, isInside);
    if (got !== undefined) return { value: got, fromScratchpad: isInside };
  }
  return { value: null, fromScratchpad: false };
}

/**
 * @param {boolean} suspect  true when this text came from inside a scratchpad,
 *   where a schema echo is likelier than an answer and has to prove itself.
 */
function searchRegion(cleaned, wanted, suspect) {
  if (!cleaned) return undefined;
  const parsed = [];
  for (const c of candidates(cleaned)) {
    const got = tryParse(c);
    if (got === undefined) continue;
    // A doubly-encoded answer: the object arrived as a JSON string.
    const value = typeof got === "string" && /^[\s]*[{[]/.test(got) ? (tryParse(got) ?? got) : got;
    // A restatement of the shape is not an answer, wherever it was found.
    if (isPlaceholder(value)) continue;
    if (wanted.length && value && typeof value === "object" && !Array.isArray(value)
        && wanted.some(k => k in value)) {
      return value;   // it has what was asked for; nothing beats that
    }
    parsed.push(value);
  }
  // Inside a scratchpad, an object that does not even carry the keys the
  // caller asked for is a draft or an aside — not worth guessing at.
  if (suspect && wanted.length) return undefined;
  // Otherwise the candidate order decides: last top-level span first, because
  // a model that thinks out loud writes its notes before its answer.
  return parsed.length ? parsed[0] : undefined;
}

/**
 * JSON.parse, then the repairs that account for nearly every local-model
 * near-miss, applied in increasing order of how much they assume. Returns
 * undefined when nothing works, so a legitimately parsed `null` is not
 * mistaken for failure.
 */
function tryParse(raw) {
  if (!raw || !/[{[]/.test(raw)) return undefined;
  const repairs = [
    (s) => s,
    // A comma before a closer.
    (s) => s.replace(/,(\s*[}\]])/g, "$1"),
    // Curly quotes, from a model that "prettified" its own output.
    (s) => s.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'"),
    // Python's literals, which small models reach for constantly.
    (s) => s.replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false").replace(/\bNone\b/g, "null"),
    // A raw newline inside a string is illegal JSON and very common in prose
    // fields; escape the ones that fall between quotes.
    escapeNewlinesInStrings,
    // Single-quoted keys and values, when the reply uses no double quotes at
    // all — safe precisely because there is nothing to confuse it with.
    (s) => (s.includes('"') ? s : s.replace(/'/g, '"')),
    // // and /* */ comments, which small models add to be helpful.
    (s) => stripComments(s),
    // Bare keys, the JavaScript object literal a model writes when it forgets
    // it was asked for JSON. Only outside strings.
    (s) => quoteBareKeys(s),
  ];
  let s = raw;
  for (const repair of repairs) {
    s = repair(s);
    try { return JSON.parse(s); } catch { /* next repair */ }
  }
  return closeAndParse(s);
}

/** Drop // and /* *\/ comments that fall outside strings. */
function stripComments(raw) {
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (esc) { out += c; esc = false; continue; }
    if (c === "\\") { out += c; esc = true; continue; }
    if (c === '"') { inStr = !inStr; out += c; continue; }
    if (!inStr && c === "/" && raw[i + 1] === "/") { while (i < raw.length && raw[i] !== "\n") i++; out += "\n"; continue; }
    if (!inStr && c === "/" && raw[i + 1] === "*") { i += 2; while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++; i++; continue; }
    out += c;
  }
  return out;
}

/** Quote bare object keys — `{reply: "x"}` — leaving string contents alone. */
function quoteBareKeys(raw) {
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (esc) { out += c; esc = false; continue; }
    if (c === "\\") { out += c; esc = true; continue; }
    if (c === '"') { inStr = !inStr; out += c; continue; }
    if (inStr) { out += c; continue; }
    const rest = raw.slice(i);
    const key = /^([A-Za-z_$][\w$]*)(\s*):/.exec(rest);
    if (key && /[{,]\s*$/.test(out)) { out += `"${key[1]}"${key[2]}:`; i += key[0].length - 1; continue; }
    out += c;
  }
  return out;
}

/** Escape newlines that sit inside a JSON string, leave the structural ones. */
function escapeNewlinesInStrings(raw) {
  let out = "", inStr = false, esc = false;
  for (const c of raw) {
    if (esc) { out += c; esc = false; continue; }
    if (c === "\\") { out += c; esc = true; continue; }
    if (c === '"') { inStr = !inStr; out += c; continue; }
    if (inStr && (c === "\n" || c === "\r")) { out += c === "\n" ? "\\n" : "\\r"; continue; }
    if (inStr && c === "\t") { out += "\\t"; continue; }
    out += c;
  }
  return out;
}

/** An answer cut off by max_tokens: drop the half-written tail and close what
 *  is still open. Better a plan missing its last action than no plan at all. */
function closeAndParse(raw) {
  const depth = [];
  let inStr = false, esc = false, lastSafe = -1;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{" || c === "[") depth.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") depth.pop();
    else if (c === "," && depth.length) lastSafe = i;
  }
  if (!depth.length) return undefined;
  const stem = lastSafe > 0 ? raw.slice(0, lastSafe) : raw.replace(/[,\s]*"[^"]*"?\s*:?\s*$/, "");
  // Re-close from the stem, which may have a different depth than the whole.
  const stack = [];
  let str = false, e2 = false;
  for (let i = 0; i < stem.length; i++) {
    const c = stem[i];
    if (e2) { e2 = false; continue; }
    if (c === "\\") { e2 = true; continue; }
    if (c === '"') { str = !str; continue; }
    if (str) continue;
    if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") stack.pop();
  }
  try { return JSON.parse(stem + stack.reverse().join("")); } catch { return undefined; }
}

/**
 * @param {object} opts
 * @param {(req) => Promise<boolean>} [opts.auth]  gate for /api/* (not the shell)
 * @param {(password) => Promise<string|null>} [opts.login] password → token
 * @param {string} [opts.label] shown in the boot banner
 */
export function createCutHandler({ auth = null, login = null } = {}) {
  return async function cutHandler(req, res, next) {
    const url = new URL(req.url || "/", "http://cut.local");
    const pathname = url.pathname;

    if (!pathname.startsWith("/api/")) {
      /* The first-use wizard. Served at /setup always (the choices can be
       * revisited), and everything that is a PAGE redirects there until the
       * wizard has run once — assets keep resolving so the wizard itself can
       * load, and /api stays open so it can probe and save. */
      if (pathname === "/setup" || pathname === "/setup/") {
        const html = readFileSync(join(SERVER_DIR, "setup.html"), "utf-8");
        res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
        return res.end(html);
      }
      if (!loadSettings().local?.setupDone && !/^\/(js|css|assets)\//.test(pathname)) {
        res.writeHead(302, { Location: "/setup" });
        return res.end();
      }
      return serveStatic(req, res, pathname === "/" ? "/index.html" : pathname, next);
    }

    const route = pathname.slice(4);   // "/api/comfy/prompt" → "/comfy/prompt"
    const method = req.method || "GET";

    try {
      // ── Auth ────────────────────────────────────────────
      if (route === "/auth") {
        // POST only, and the password is only ever read from the JSON body.
        // A GET that answered 200 read as "accepted" to anything probing it,
        // and a route that takes credentials at all should refuse a method
        // that would put them in a URL — query strings end up in logs, in
        // history and in Referer headers.
        if (method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: "POST", "Cache-Control": "no-store" });
          return res.end(JSON.stringify({ ok: false, error: "POST a JSON body: {\"password\": \"…\"}" }));
        }
        if (!login) return sendJson(res, 200, { ok: true, required: false });
        const body = await readBody(req);
        const token = await login(String(body.password || ""));
        if (!token) return sendJson(res, 401, { ok: false, error: "wrong password" });
        return sendJson(res, 200, { ok: true, token });
      }
      if (auth && !(await auth(req))) {
        return sendJson(res, 401, { ok: false, error: "unauthorized", authRequired: true });
      }

      const body = method === "GET" || method === "HEAD" ? {} : await readBody(req);

      /* With saving off, nothing may land on disk: the browser answers these
       * routes itself and never calls them — this is the guard for anything
       * else that might. */
      const PERSISTENCE = ["/library", "/rulebook", "/cast", "/projects", "/projects/media", "/library/import", "/library/stats"];
      if (!savingEnabled() && PERSISTENCE.includes(route)) {
        return sendJson(res, 403, {
          ok: false, code: "saving-off",
          error: "Server saving is off — this instance only hosts the interface, and everything is stored in the browser. Re-run /setup to enable it.",
        });
      }

      switch (route) {
        // ── The first-use wizard's one write ────────────
        case "/local/setup": {
          if (method !== "POST") return sendJson(res, 405, { ok: false, error: "POST {saving, comfyUrl, llmUrl}" });
          const patch = {
            ...(body.comfyUrl ? { comfy: { url: String(body.comfyUrl).trim() } } : {}),
            ...(body.llmUrl ? { llm: { url: String(body.llmUrl).trim() } } : {}),
            local: { saving: body.saving !== false, setupDone: true },
          };
          const r = saveSettings(patch);
          _objectInfo = { at: 0, data: null, url: "" };
          return sendJson(res, r.ok ? 200 : 500, { ok: r.ok, error: r.error, settings: publicSettings() });
        }

        // ── State / settings ────────────────────────────
        case "/state":
          return sendJson(res, 200, {
            ok: true, version: CUT_VERSION,
            settings: publicSettings(), vram: vramState(),
            defaultModels: DEFAULT_MODELS,
            authRequired: !!auth,
            local: { saving: savingEnabled() },
          });

        case "/settings": {
          if (method === "GET") return sendJson(res, 200, { ok: true, settings: publicSettings() });
          const r = saveSettings(body);
          // A new ComfyUI address invalidates the node catalog behind it.
          _objectInfo = { at: 0, data: null, url: "" };
          return sendJson(res, r.ok ? 200 : 500, { ok: r.ok, error: r.error, settings: publicSettings() });
        }

        // ── Health of both engines, plus the node check ──
        case "/health": {
          const s = loadSettings();
          const [comfy, llm, info, ffmpeg] = await Promise.all([
            probeComfy(s.comfy.url, 5000),
            probeLLM(s.llm.url, 5000),
            objectInfo().catch(() => null),
            // Not a ComfyUI node and not required to render anything — it is
            // what joins a film's clips afterwards, so the client can hide
            // that button rather than offer it and fail.
            ffmpegAvailable().catch(() => false),
          ]);
          const nodes = { required: {}, optional: {}, missing: [], ltx: {}, ltxMissing: [], ltx25Support: null };
          if (info) {
            for (const [name, why] of Object.entries(REQUIRED_NODES)) {
              nodes.required[name] = { present: !!info[name], why };
              if (!info[name]) nodes.missing.push(name);
            }
            for (const [name, why] of Object.entries(OPTIONAL_NODES)) {
              nodes.optional[name] = { present: !!info[name], why };
            }
            // The experimental engine's own group — kept out of `missing` so
            // an LTX-less build never reads as unable to render MiniMax.
            for (const [name, why] of Object.entries(LTX_NODES)) {
              nodes.ltx[name] = { present: !!info[name], why };
              if (!info[name]) nodes.ltxMissing.push(name);
            }
            // The 2.5-support gate: without the "ltxv" CLIPLoader type the
            // Gemma 4 file loads as a plain chat model and encoding fails.
            nodes.ltx25Support = enumOf(info, "CLIPLoader", "type").includes("ltxv");
          }
          return sendJson(res, 200, { ok: true, comfy, llm, nodes: info ? nodes : null, vram: vramState(), ffmpeg });
        }

        // ── Find the servers on this machine ─────────────
        case "/detect": {
          const which = url.searchParams.get("what") || "both";
          const out = {};
          if (which === "both" || which === "comfy") {
            out.comfy = (await Promise.all(COMFY_CANDIDATES.map(u => probeComfy(u, 1500)))).filter(r => r.ok);
          }
          if (which === "both" || which === "llm") {
            out.llm = (await Promise.all(LLM_CANDIDATES.map(u => probeLLM(u, 1500)))).filter(r => r.ok);
          }
          return sendJson(res, 200, { ok: true, ...out });
        }

        // ── ComfyUI ─────────────────────────────────────
        case "/comfy/models": {
          const info = await objectInfo();
          const folders = {};
          for (const [folder, [node, input]] of Object.entries(COMFY_FOLDER_SOURCES)) {
            folders[folder] = enumOf(info, node, input);
          }
          folders.samplers = enumOf(info, "KSamplerSelect", "sampler_name");
          folders.schedulers = enumOf(info, "BasicScheduler", "scheduler");
          return sendJson(res, 200, { ok: true, folders });
        }

        case "/comfy/prompt": {
          if (!body.prompt || typeof body.prompt !== "object") return sendJson(res, 400, { ok: false, error: "prompt (an API-format graph) is required" });
          // VRAM saver: the LLM comes off the card before the DiT goes on.
          const gpu = await claim("comfy");
          const queued = await comfyFetch("/prompt", {
            method: "POST",
            body: { prompt: body.prompt, client_id: body.clientId || undefined, extra_data: body.extraData || undefined },
            timeout: 120000,
          });
          renderStarted();
          return sendJson(res, 200, { ok: true, ...queued, gpu });
        }

        case "/comfy/history": {
          const id = url.searchParams.get("id");
          const max = Math.min(200, Number(url.searchParams.get("max")) || 20);
          const data = await comfyFetch(id ? `/history/${encodeURIComponent(id)}` : `/history?max_items=${max}`);
          if (id && data && data[id]) {
            const entry = data[id];
            const status = entry.status || {};
            const done = status.completed === true || status.status_str === "success" || status.status_str === "error";
            if (done) await renderFinished();
            const outputs = [];
            for (const nodeOut of Object.values(entry.outputs || {})) {
              for (const key of ["videos", "images", "gifs", "audio"]) {
                for (const f of nodeOut[key] || []) outputs.push({ ...f, kind: key });
              }
            }
            return sendJson(res, 200, { ok: true, id, done, status, outputs, messages: status.messages || [] });
          }
          return sendJson(res, 200, { ok: true, history: data });
        }

        case "/comfy/queue": {
          const data = await comfyFetch("/queue");
          return sendJson(res, 200, { ok: true, ...data });
        }

        case "/comfy/interrupt": {
          await comfyFetch("/interrupt", { method: "POST", body: {}, raw: true, timeout: 15000 }).catch(() => null);
          await renderFinished();
          return sendJson(res, 200, { ok: true });
        }

        case "/comfy/upload": {
          // Base64 in, multipart out — keeps this server dependency-free while
          // still speaking ComfyUI's own upload API.
          const { filename, data, type = "input", subfolder = "", overwrite = true } = body;
          if (!filename || !data) return sendJson(res, 400, { ok: false, error: "filename and data are required" });
          const bytes = Buffer.from(String(data).replace(/^data:[^;]+;base64,/, ""), "base64");
          const form = new FormData();
          form.append("image", new Blob([bytes]), filename);
          form.append("type", type);
          if (subfolder) form.append("subfolder", subfolder);
          form.append("overwrite", overwrite ? "true" : "false");
          const { comfy } = loadSettings();
          const r = await fetch(`${comfy.url}/upload/image`, { method: "POST", body: form, signal: AbortSignal.timeout(180000) });
          const text = await r.text();
          if (!r.ok) return sendJson(res, 502, { ok: false, error: text.slice(0, 400) || `ComfyUI ${r.status}` });
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { /* older builds answer with a bare name */ }
          return sendJson(res, 200, { ok: true, ...(parsed || { name: filename, subfolder, type }) });
        }

        case "/comfy/view": {
          const { comfy } = loadSettings();
          const qs = url.searchParams.toString();
          const upstream = await fetch(`${comfy.url}/view?${qs}`, { signal: AbortSignal.timeout(300000) });
          res.writeHead(upstream.status, {
            "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
            ...(upstream.headers.get("content-length") ? { "Content-Length": upstream.headers.get("content-length") } : {}),
            "Cache-Control": "no-store",
          });
          if (!upstream.body) return res.end();
          for await (const chunk of upstream.body) {
            if (!res.write(Buffer.from(chunk))) await new Promise(r2 => res.once("drain", r2));
          }
          return res.end();
        }

        /* ── The film: several clips, joined ─────────────
         * Neither of these renders anything. They are the two ffmpeg jobs a
         * multi-clip film needs — the frame one clip ends on, so the next can
         * start from it, and the join at the end. Both answer 503 rather than
         * 500 when ffmpeg is missing: the machine is fine, the tool is not
         * installed, and the client says so instead of showing a stack. */
        case "/film/lastframe": {
          if (method !== "POST") return sendJson(res, 405, { ok: false, error: "POST a clip: {filename, subfolder, type}" });
          if (!(await ffmpegAvailable())) {
            return sendJson(res, 503, { ok: false, code: "no-ffmpeg", error: "ffmpeg is not installed on the Cut server — clips cannot be chained without it." });
          }
          const dataUrl = await lastFrame({
            filename: String(body.filename || ""),
            subfolder: String(body.subfolder || ""),
            type: String(body.type || "output"),
          });
          return sendJson(res, 200, { ok: true, dataUrl });
        }

        case "/film/assemble": {
          if (method !== "POST") return sendJson(res, 405, { ok: false, error: "POST {clips, name, audio}" });
          if (!(await ffmpegAvailable())) {
            return sendJson(res, 503, { ok: false, code: "no-ffmpeg", error: "ffmpeg is not installed on the Cut server — the clips are rendered, but nothing here can join them." });
          }
          const r = await assemble({
            clips: Array.isArray(body.clips) ? body.clips : [],
            name: body.name,
            audio: body.audio === "mute" ? "mute" : "keep",
            id: body.id || null,
          });
          return sendJson(res, 200, { ok: true, ...r });
        }

        /* ── The edit: anything after anything ───────────
         * The Editor page's export — clips of any origin trimmed, fitted and
         * joined, with audio mixed under — and the probe it uses to learn a
         * clip's length before that. Same rule as the film: 503 without
         * ffmpeg, and the result lands where /film/view already serves it. */
        case "/resolve/status": {
          if (method !== "GET") return sendJson(res, 405, { ok: false, error: "GET required" });
          return sendJson(res, 200, await resolveStatus());
        }
        case "/resolve/send": {
          if (method !== "POST") return sendJson(res, 405, { ok: false, error: "POST required" });
          return sendJson(res, 200, await sendToResolve(body));
        }
        case "/edit/export": {
          if (method !== "POST") return sendJson(res, 405, { ok: false, error: "POST {id, name, fps, width, height, clips, audio}" });
          if (!(await ffmpegAvailable())) {
            return sendJson(res, 503, { ok: false, code: "no-ffmpeg", error: "ffmpeg is not installed on the Cut server — the clips are all there, but nothing here can cut them together." });
          }
          const r = await exportEdit({
            id: body.id || null,
            name: body.name,
            fps: Number(body.fps) || 24,
            width: Number(body.width) || 0,
            height: Number(body.height) || 0,
            clips: Array.isArray(body.clips) ? body.clips : [],
            audio: Array.isArray(body.audio) ? body.audio : [],
          });
          return sendJson(res, 200, { ok: true, ...r });
        }

        // ── Voice-over ───────────────────────────────────
        // The two TTS services on the Nexus box, reached from here so the
        // browser never has to (they have no CORS, and the gateway wants a
        // cookie). See server/voice.js.
        case "/voice/health":
          return sendJson(res, 200, { ok: true, engines: await voiceHealth(), labels: Object.fromEntries(Object.entries(VOICE_ENGINES).map(([k, v]) => [k, v.label])) });

        case "/voice/voices": {
          const engine = String(url.searchParams.get("engine") || body.engine || "qwen");
          return sendJson(res, 200, { ok: true, ...(await listVoices(engine)) });
        }

        case "/voice/speak": {
          if (method !== "POST") return sendJson(res, 405, { ok: false, error: "POST {engine, text, voice, language, speed, instruct}" });
          const r = await speak(String(body.engine || "qwen"), body);
          return sendJson(res, 200, {
            ok: true, engine: r.engine, voice: r.voice, language: r.language, sampleRate: r.sampleRate, ms: r.ms,
            bytes: r.bytes.length, mime: r.mime, audio: `data:${r.mime};base64,${r.bytes.toString("base64")}`,
          });
        }

        case "/voice/reference": {
          if (method === "DELETE") return sendJson(res, 200, { ok: true, ...removeReferenceVoice(String(body.engine || "qwen"), body.id) });
          if (method !== "POST") return sendJson(res, 405, { ok: false, error: "POST {engine, name, data, transcript, engines} · DELETE {engine, id}" });
          const r = await addReferenceVoice(String(body.engine || "qwen"), {
            name: body.name, data: body.data, transcript: body.transcript || "",
            engines: Array.isArray(body.engines) && body.engines.length ? body.engines : null,
          });
          return sendJson(res, 200, { ok: true, ...r });
        }

        case "/edit/probe": {
          if (method !== "POST") return sendJson(res, 405, { ok: false, error: "POST {source: {filename, subfolder, type} | {mediaId}}" });
          if (!(await ffmpegAvailable())) {
            return sendJson(res, 503, { ok: false, code: "no-ffmpeg", error: "ffmpeg is not installed on the Cut server — a clip's length cannot be read without it." });
          }
          const info = await probeSource(body.source || {});
          return sendJson(res, 200, { ok: true, ...info });
        }

        case "/film/view": {
          const file = filmPath(url.searchParams.get("id"));
          if (!file) return sendJson(res, 404, { ok: false, error: "no film with that id" });
          const total = statSync(file).size;
          // Range, because a two-minute file is something people scrub, and a
          // <video> that cannot seek reads as a broken player.
          const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
          if (range) {
            const start = range[1] ? Number(range[1]) : 0;
            const end = range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
            if (!(start >= 0 && start <= end && end < total)) {
              res.writeHead(416, { "Content-Range": `bytes */${total}` });
              return res.end();
            }
            res.writeHead(206, {
              "Content-Type": MIME[".mp4"],
              "Content-Range": `bytes ${start}-${end}/${total}`,
              "Accept-Ranges": "bytes",
              "Content-Length": end - start + 1,
              "Cache-Control": "no-store",
            });
            return createReadStream(file, { start, end }).pipe(res);
          }
          res.writeHead(200, {
            "Content-Type": MIME[".mp4"],
            "Content-Length": total,
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-store",
          });
          return createReadStream(file).pipe(res);
        }

        // ── LLM ─────────────────────────────────────────
        case "/llm/models": {
          const s = loadSettings();
          const probe = await probeLLM(s.llm.url, 8000);
          return sendJson(res, 200, { ok: probe.ok, ...probe });
        }

        case "/llm/chat": {
          if (!body.prompt && !(Array.isArray(body.messages) && body.messages.length)) {
            return sendJson(res, 400, { ok: false, error: "prompt or messages is required" });
          }
          let r = await llmChat(body);
          const expect = Array.isArray(body.expect) ? body.expect.slice(0, 12).map(String) : [];
          let found = body.json ? parseLooseJsonDetailed(r.text, expect) : { value: undefined };
          // An object dug out of a scratchpad that was itself cut off is a
          // draft, not a decision. Asking again with room is right; handing it
          // back as the answer is how a shot list ends up full of "…".
          if (found.fromScratchpad && (r.truncated || r.fromReasoning)) found = { value: null, fromScratchpad: true };
          let parsed = found.value;

          /* One retry, and only for the failure that a retry actually fixes:
           * the answer was cut off mid-thought because the budget was spent
           * reasoning. Ask again with room for both. Anything else — a model
           * that simply will not produce JSON — is not improved by asking
           * twice, so we do not. */
          // Not only finish_reason "length": a reply that was ALL reasoning
          // reports "stop", and some backends omit finish_reason entirely. Any
          // of those is a budget problem, and a second, roomier ask is exactly
          // what fixes it.
          if (body.json && !parsed && !body._retried && (r.truncated || r.fromReasoning || r.reasoned)) {
            const roomier = Math.min(8000, Math.max(3000, (body.maxTokens || 1600) * 3));
            r = await llmChat({ ...body, maxTokens: roomier, _retried: true });
            parsed = parseLooseJson(r.text, expect);
            if (parsed == null) parsed = undefined;
            r.retriedWith = roomier;
          }

          return sendJson(res, 200, {
            ok: true, ...r,
            json: parsed,
            // When it did not parse, say WHY in terms the UI can act on. The
            // old answer — "try a larger model" — was wrong most of the time:
            // the usual cause is a reasoning model spending its whole budget
            // thinking, which is a setting, not a capability.
            ...(body.json && !parsed ? { jsonFailure: diagnoseJson(r) } : {}),
          });
        }

        // ── Library · rulebook · cast ───────────────────
        // The half of prompt engineering that happens after the render: what
        // was made, what you thought of it, and what that taught you.
        case "/library":
        case "/rulebook":
        case "/cast": {
          const kind = route.slice(1);
          if (method === "GET") {
            const filter = {};
            for (const [k, v] of url.searchParams.entries()) {
              if (["q", "limit", "offset"].includes(k)) continue;
              filter[k] = v;
            }
            return sendJson(res, 200, {
              ok: true,
              ...store.list(kind, {
                query: url.searchParams.get("q") || "",
                limit: Math.min(2000, Number(url.searchParams.get("limit")) || 500),
                offset: Number(url.searchParams.get("offset")) || 0,
                filter,
              }),
              ...(kind === "library" ? { stats: store.stats() } : {}),
            });
          }
          if (method === "POST") {
            const r = store.put(kind, body);
            return sendJson(res, r.ok ? 200 : 500, { ok: r.ok, error: r.error, entry: r.entry });
          }
          if (method === "PATCH") {
            if (!body.id) return sendJson(res, 400, { ok: false, error: "id is required" });
            const r = store.patch(kind, body.id, body.changes || {});
            return sendJson(res, r.ok ? 200 : 404, r);
          }
          if (method === "DELETE") {
            const id = body.id || url.searchParams.get("id");
            if (!id) return sendJson(res, 400, { ok: false, error: "id is required" });
            return sendJson(res, 200, store.remove(kind, id));
          }
          return sendJson(res, 405, { ok: false, error: "GET, POST, PATCH or DELETE" });
        }

        /* ── Projects ─────────────────────────────────────────────
         * One JSON file each under data/projects, plus their media under
         * data/media so a project saved here is a project that can actually be
         * opened somewhere else. */
        case "/projects": {
          if (method === "GET") {
            const id = url.searchParams.get("id");
            if (id) {
              const p = projects.get(id);
              return p
                ? sendJson(res, 200, { ok: true, project: p })
                : sendJson(res, 404, { ok: false, error: "no such project" });
            }
            return sendJson(res, 200, projects.list());
          }
          if (method === "POST") {
            if (body.duplicate) return sendJson(res, 200, projects.duplicate(body.duplicate, body.name));
            if (!body.project) return sendJson(res, 400, { ok: false, error: "project is required" });
            const r = projects.save(body.project);
            return sendJson(res, r.ok ? 200 : 400, r);
          }
          if (method === "DELETE") {
            const id = body.id || url.searchParams.get("id");
            if (!id) return sendJson(res, 400, { ok: false, error: "id is required" });
            return sendJson(res, 200, projects.remove(id));
          }
          return sendJson(res, 405, { ok: false, error: "GET, POST or DELETE" });
        }

        /* The bytes behind a project's references. The client asks which ids
         * are already here before sending anything, so renaming a project does
         * not re-upload its pictures. */
        case "/projects/media": {
          if (method === "GET") {
            const id = url.searchParams.get("id");
            const data = id ? projects.getMedia(id) : null;
            return data
              ? sendJson(res, 200, { ok: true, id, data })
              : sendJson(res, 404, { ok: false, error: "not stored" });
          }
          if (method === "POST") {
            if (Array.isArray(body.have)) return sendJson(res, 200, { ok: true, have: projects.haveMedia(body.have) });
            const r = projects.putMedia(body.id, body.data);
            return sendJson(res, r.ok ? 200 : 400, r);
          }
          return sendJson(res, 405, { ok: false, error: "GET or POST" });
        }


        /* Everything ComfyUI has rendered that this app can recognise, pulled
         * into the library. A H3 graph carries its own prompt, canvas, build
         * and seed, so a clip made before this editor existed — or made in
         * ComfyUI directly — still ends up on the shelf with everything else. */
        case "/library/import": {
          const max = Math.min(200, Number(body.max) || 50);
          const history = await comfyFetch(`/history?max_items=${max}`, { timeout: 60000 });
          const existing = new Set(store.list("library", { limit: 4000 }).rows.map(r => r.comfyPromptId).filter(Boolean));
          let added = 0, seen = 0, skipped = 0;

          for (const [promptId, entry] of Object.entries(history || {})) {
            seen++;
            if (existing.has(promptId)) { skipped++; continue; }
            const graph = entry?.prompt?.[2];
            if (!graph || typeof graph !== "object") { skipped++; continue; }
            const nodes = Object.values(graph);
            const cond = nodes.find(n => n.class_type === "MiniMaxH3ImageToVideo" || n.class_type === "MiniMaxH3ReferenceToVideo");
            // An LTX AV graph — the experimental second engine's renders (and
            // the main Motionstill app's, which share the pipeline shape).
            const ltxLatent = cond ? null : nodes.find(n => n.class_type === "EmptyLTXVLatentVideo");
            if (!cond && !(ltxLatent && nodes.some(n => n.class_type === "LTXVConcatAVLatent"))) { skipped++; continue; }   // not one of ours

            const unet = nodes.find(n => n.class_type === "UNETLoader")?.inputs?.unet_name || "";
            const lora = nodes.find(n => n.class_type === "LoraLoaderModelOnly")?.inputs?.lora_name || null;
            const sched = nodes.find(n => n.class_type === "BasicScheduler")?.inputs || {};
            const sampler = nodes.find(n => n.class_type === "KSamplerSelect")?.inputs?.sampler_name || null;
            const shift = nodes.find(n => n.class_type === "MiniMaxH3SigmaShift")?.inputs || {};
            const seed = nodes.find(n => n.class_type === "RandomNoise")?.inputs?.noise_seed ?? null;
            const fps = nodes.find(n => n.class_type === "CreateVideo")?.inputs?.fps ?? 24;

            const outputs = [];
            for (const nodeOut of Object.values(entry.outputs || {})) {
              for (const key of ["videos", "images", "gifs"]) {
                for (const f of nodeOut[key] || []) outputs.push({ ...f, kind: key });
              }
            }
            const at = (entry.status?.completed && entry.status?.messages?.[0]?.[1]?.timestamp) || Date.now();
            const status = entry.status?.status_str === "error" ? "error" : "done";

            if (cond) {
              const isRef = cond.class_type === "MiniMaxH3ReferenceToVideo";
              const hasFirstFrame = !!cond.inputs?.first_frame;
              const length = Number(cond.inputs?.length) || 0;
              store.put("library", {
                comfyPromptId: promptId,
                at,
                name: "Imported from ComfyUI",
                imported: true,
                mode: isRef ? "r2v" : hasFirstFrame ? "i2v" : "t2v",
                status,
                promptText: cond.inputs?.prompt || "",
                description: cond.inputs?.prompt || "",
                settings: {
                  mode: isRef ? "r2v" : hasFirstFrame ? "i2v" : "t2v",
                  engine: "minimax",
                  resolution: `${cond.inputs?.width}x${cond.inputs?.height}`,
                  // Frames back to the duration row they came from, when they land on one.
                  duration: Object.entries({ 124: 5, 243: 10, 362: 15, 481: 20, 600: 25, 736: 30 })
                    .find(([f]) => Number(f) === length)?.[1] ?? null,
                  seed,
                  refImageSize: cond.inputs?.ref_image_size || null,
                },
                meta: {
                  engine: "minimax",
                  dit: unet, lora, seed, fps, numFrames: length,
                  width: cond.inputs?.width, height: cond.inputs?.height,
                  steps: sched.steps ?? null, scheduler: sched.scheduler ?? null, sampler,
                  shiftVideo: shift.shift_video ?? null, shiftAudio: shift.shift_audio ?? null,
                  nodeTypes: [...new Set(nodes.map(n => n.class_type))].sort(),
                },
                outputs,
                verdict: { rating: null, tags: [], note: "" },
              });
            } else {
              /* The prompt lives in a CLIPTextEncode rather than on the
               * conditioning node; the latent's canvas is HALF resolution
               * when a two-stage graph upscales it, and the length can be a
               * wire (the main app's auto-duration), in which case Number()
               * honestly answers "unknown" rather than guessing. */
              const positive = nodes.find(n => n.class_type === "CLIPTextEncode" && n._meta?.title === "Positive Prompt")
                || nodes.find(n => n.class_type === "CLIPTextEncode");
              const twoStage = nodes.some(n => n.class_type === "LTXVLatentUpsampler");
              const scale = twoStage ? 2 : 1;
              const width = Number(ltxLatent.inputs?.width) * scale || null;
              const height = Number(ltxLatent.inputs?.height) * scale || null;
              const length = Number(ltxLatent.inputs?.length) || 0;
              const hasFirstFrame = nodes.some(n => n.class_type === "LTXVAddGuide");
              const promptText = typeof positive?.inputs?.text === "string" ? positive.inputs.text : "";
              store.put("library", {
                comfyPromptId: promptId,
                at,
                name: "Imported from ComfyUI",
                imported: true,
                mode: hasFirstFrame ? "i2v" : "t2v",
                status,
                promptText,
                description: promptText,
                settings: {
                  mode: hasFirstFrame ? "i2v" : "t2v",
                  engine: "ltx25",
                  resolution: width && height ? `${width}x${height}` : null,
                  // The 8k+1 grid this time.
                  duration: Object.entries({ 121: 5, 241: 10, 361: 15, 481: 20, 601: 25, 721: 30 })
                    .find(([f]) => Number(f) === length)?.[1] ?? null,
                  seed,
                },
                meta: {
                  engine: "ltx25",
                  dit: unet, lora, seed, fps, numFrames: length || null,
                  width, height,
                  steps: twoStage ? 11 : 8, scheduler: "manual sigmas", sampler,
                  stages: twoStage ? 2 : 1,
                  nodeTypes: [...new Set(nodes.map(n => n.class_type))].sort(),
                },
                outputs,
                verdict: { rating: null, tags: [], note: "" },
              });
            }
            added++;
          }
          return sendJson(res, 200, { ok: true, added, seen, skipped });
        }

        case "/library/stats":
          return sendJson(res, 200, { ok: true, ...store.stats() });

        // ── VRAM arbiter ────────────────────────────────
        case "/vram/state":
          return sendJson(res, 200, { ok: true, ...vramState() });

        case "/vram/claim": {
          const r = await claim(body.owner, { force: !!body.force });
          return sendJson(res, 200, { ok: true, ...r, state: vramState() });
        }

        case "/vram/release": {
          const r = await releaseAll();
          return sendJson(res, 200, { ok: true, ...r, state: vramState() });
        }

        case "/vram/free-comfy":
          return sendJson(res, 200, { ok: true, ...(await freeComfy()), state: vramState() });

        case "/vram/unload-llm":
          return sendJson(res, 200, { ok: true, ...(await unloadLLM()), state: vramState() });

        default:
          return sendJson(res, 404, { ok: false, error: `no such endpoint: /api${route}` });
      }
    } catch (err) {
      const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
      return sendJson(res, status, { ok: false, error: err.message, code: err.code || undefined });
    }
  };
}

export { llmChat, probeComfy, probeLLM };
