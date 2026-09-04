/* MOTIONSTILL CUT — the API, without the server.
 *
 * The Cut server's router answered /api/* over HTTP. The public release
 * answers the same routes as function calls: api.js hands `handle()` the same
 * path and body it would have sent over the wire, and gets back the same
 * objects the wire would have carried — or an Error carrying the same
 * .status/.code the HTTP layer would have attached. The pages cannot tell
 * the difference, which is the point: one front end, two backends.
 *
 * What changed underneath:
 *   settings            → localStorage            (backend/settings.js)
 *   library · rulebook  → IndexedDB               (backend/store.js)
 *   cast · projects     → IndexedDB               (backend/store.js, /projects.js)
 *   project media       → the pool's own store    (../media.js)
 *   ComfyUI · LLM       → fetched directly        (backend/engine.js)
 *   film last-frame     → decoded in the browser  (backend/film.js)
 *   film assemble       → honestly unavailable    (503 no-ffmpeg, UI degrades)
 *   auth                → none; nothing leaves this machine to protect
 */

import { loadSettings, saveSettings, publicSettings, rawSettings, restoreSettings, DEFAULT_MODELS } from "./settings.js";
import { claim, releaseAll, vramState, comfyFetch, llmHeaders, renderStarted, renderFinished, freeComfy, unloadLLM, netHint } from "./engine.js";
import { llmChat } from "./llm.js";
import { parseLooseJson, parseLooseJsonDetailed, diagnoseJson } from "./parse.js";
import { lastFrame, NO_FFMPEG } from "./film.js";
import * as store from "./store.js";
import * as projects from "./projects.js";
import { getBlob, putBlob } from "../media.js";

export const CUT_VERSION = "1.0.0";

const fail = (status, error, code) => { throw Object.assign(new Error(error), { status, ...(code ? { code } : {}) }); };

/* ── Probes and the node check, straight from the server router ── */

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
  } catch (e) {
    const cors = e instanceof TypeError || /fetch/i.test(String(e?.message));
    return { url, ok: false, error: cors ? netHint("comfy", url) : e.message };
  }
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
  return { url, ok: false, error: netHint("llm", url) };
}

/* Which MiniMax nodes does this ComfyUI actually have? Every one of these
 * ships with ComfyUI — "missing" means the build is too old for MiniMax H3,
 * never that something needs installing from GitHub. */
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
  UpscaleModelLoader:    "ESRGAN upscale (Deliver ▸ Upscale)",
  ImageUpscaleWithModel: "ESRGAN upscale (Deliver ▸ Upscale)",
  SeedVR2VideoUpscaler:  "SeedVR2 upscale — the seedvr2_videoupscaler custom pack (Deliver ▸ Upscale)",
  FlashVSRNode:          "FlashVSR upscale — the ComfyUI-FlashVSR_Ultra_Fast custom pack (Deliver ▸ Upscale)",
};

/* What the EXPERIMENTAL LTX-2.5 engine additionally needs — its own group in
 * the health payload, so missing LTX nodes never paint the MiniMax modes red. */
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
};

const COMFY_FOLDER_SOURCES = {
  diffusion_models: ["UNETLoader",           "unet_name"],
  loras:            ["LoraLoaderModelOnly",  "lora_name"],
  vae:              ["VAELoader",            "vae_name"],
  text_encoders:    ["CLIPLoader",           "clip_name"],
  latent_upscale_models: ["LatentUpscaleModelLoader", "model_name"],
  upscale_models:   ["UpscaleModelLoader",    "model_name"],
  seedvr2:          ["SeedVR2LoadDiTModel",   "model"],
  seedvr2_vae:      ["SeedVR2LoadVAEModel",   "model"],
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
  const list = Array.isArray(spec) ? spec[0] : null;
  return Array.isArray(list) ? list.filter(v => typeof v === "string") : [];
}

/* ── Backup — the whole app's state as one downloadable object ──
 * With no server there is no data/ folder to copy, so this is the equivalent:
 * settings, the three stores, every project, and the media bytes the projects
 * reference. */

function mediaIdsOf(project) {
  return [
    project.frames?.first,
    ...(project.refs?.images || []),
    ...(project.refs?.videos || []),
    ...(project.refs?.audios || []),
  ].filter(m => m?.id).map(m => m.id);
}

async function exportBackup() {
  const rows = (kind) => store.list(kind, { limit: 100000 }).rows;
  const projectRows = rows("projects");
  const media = {};
  for (const p of projectRows) {
    for (const id of mediaIdsOf(p)) {
      if (media[id] !== undefined) continue;
      const data = await getBlob(id);
      if (data) media[id] = data;
    }
  }
  return {
    ok: true,
    backup: {
      app: "motionstillcut",
      version: CUT_VERSION,
      at: Date.now(),
      settings: rawSettings(),
      library: rows("library"),
      rulebook: rows("rulebook"),
      cast: rows("cast"),
      projects: projectRows,
      media,
    },
  };
}

async function importBackup(backup) {
  if (!backup || typeof backup !== "object" || backup.app !== "motionstillcut") {
    fail(400, "That file is not a Motionstill Cut backup.");
  }
  if (backup.settings) restoreSettings(backup.settings);
  const counts = {};
  for (const kind of ["library", "rulebook", "cast", "projects"]) {
    counts[kind] = await store.replaceAll(kind, backup[kind] || []);
  }
  let media = 0;
  for (const [id, data] of Object.entries(backup.media || {})) {
    if (typeof data === "string" && data.startsWith("data:")) { await putBlob(id, data); media++; }
  }
  return { ok: true, restored: { ...counts, media }, settings: publicSettings() };
}

/* ── The handler ─────────────────────────────────────────────── */

let _ready = null;
const ready = () => (_ready ??= Promise.all(store.KINDS.map(k => store.ready(k))));

/**
 * @param {string} path  e.g. "/comfy/history?id=abc" — the part after /api
 * @param {{method?: string, body?: object}} opts
 * @returns the same JSON object the Cut server would have sent
 */
export async function handle(path, { method = "GET", body = {} } = {}) {
  await ready();
  const url = new URL(path, "http://cut.local");
  const route = url.pathname;
  body = body || {};

  switch (route) {
    // ── Auth: nothing here to protect — everything already lives on this
    //    machine, in this browser's own storage. ──
    case "/auth":
      return { ok: true, required: false };

    // ── State / settings ────────────────────────────
    case "/state":
      return {
        ok: true, version: CUT_VERSION,
        settings: publicSettings(), vram: vramState(),
        defaultModels: DEFAULT_MODELS,
        authRequired: false,
        client: true, storage: "browser",
      };

    case "/settings": {
      if (method === "GET") return { ok: true, settings: publicSettings() };
      const r = saveSettings(body);
      // A new ComfyUI address invalidates the node catalog behind it.
      _objectInfo = { at: 0, data: null, url: "" };
      if (!r.ok) fail(500, r.error);
      return { ok: true, settings: publicSettings() };
    }

    // ── Health of both engines, plus the node check ──
    case "/health": {
      const s = loadSettings();
      const [comfy, llm, info] = await Promise.all([
        probeComfy(s.comfy.url, 5000),
        probeLLM(s.llm.url, 5000),
        objectInfo().catch(() => null),
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
        for (const [name, why] of Object.entries(LTX_NODES)) {
          nodes.ltx[name] = { present: !!info[name], why };
          if (!info[name]) nodes.ltxMissing.push(name);
        }
        nodes.ltx25Support = enumOf(info, "CLIPLoader", "type").includes("ltxv");
      }
      // ffmpeg: false — joins need the local version. The last-frame job the
      // film chain needs is done in the browser instead.
      return { ok: true, comfy, llm, nodes: info ? nodes : null, vram: vramState(), ffmpeg: false };
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
      return { ok: true, ...out };
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
      return { ok: true, folders };
    }

    case "/comfy/prompt": {
      if (!body.prompt || typeof body.prompt !== "object") fail(400, "prompt (an API-format graph) is required");
      // VRAM saver: the LLM comes off the card before the DiT goes on.
      const gpu = await claim("comfy");
      const queued = await comfyFetch("/prompt", {
        method: "POST",
        body: { prompt: body.prompt, client_id: body.clientId || undefined, extra_data: body.extraData || undefined },
        timeout: 120000,
      });
      renderStarted();
      return { ok: true, ...queued, gpu };
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
        return { ok: true, id, done, status, outputs, messages: status.messages || [] };
      }
      return { ok: true, history: data };
    }

    case "/comfy/queue": {
      const data = await comfyFetch("/queue");
      return { ok: true, ...data };
    }

    case "/comfy/interrupt": {
      await comfyFetch("/interrupt", { method: "POST", body: {}, raw: true, timeout: 15000 }).catch(() => null);
      await renderFinished();
      return { ok: true };
    }

    case "/comfy/upload": {
      // The server took base64 and spoke multipart to ComfyUI; the browser
      // speaks multipart itself.
      const { filename, data, type = "input", subfolder = "", overwrite = true } = body;
      if (!filename || !data) fail(400, "filename and data are required");
      const bytes = atob(String(data).replace(/^data:[^;]+;base64,/, ""));
      const buf = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
      const form = new FormData();
      form.append("image", new Blob([buf]), filename);
      form.append("type", type);
      if (subfolder) form.append("subfolder", subfolder);
      form.append("overwrite", overwrite ? "true" : "false");
      const { comfy } = loadSettings();
      let r;
      try {
        r = await fetch(`${comfy.url}/upload/image`, { method: "POST", body: form, signal: AbortSignal.timeout(180000) });
      } catch (e) {
        fail(502, netHint("comfy", comfy.url));
      }
      const text = await r.text();
      if (!r.ok) fail(502, text.slice(0, 400) || `ComfyUI ${r.status}`);
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* older builds answer with a bare name */ }
      return { ok: true, ...(parsed || { name: filename, subfolder, type }) };
    }

    /* ── The film ────────────────────────────────────
     * The frame a clip ends on comes from the browser's own decoder; the
     * join needs ffmpeg and answers exactly like a server without one. */
    case "/film/lastframe": {
      if (method !== "POST") fail(405, "POST a clip: {filename, subfolder, type}");
      const dataUrl = await lastFrame({
        filename: String(body.filename || ""),
        subfolder: String(body.subfolder || ""),
        type: String(body.type || "output"),
      });
      return { ok: true, dataUrl };
    }

    case "/film/assemble":
      throw NO_FFMPEG();

    // ── LLM ─────────────────────────────────────────
    case "/llm/models": {
      const s = loadSettings();
      const probe = await probeLLM(s.llm.url, 8000);
      return { ok: probe.ok, ...probe };
    }

    case "/llm/chat": {
      if (!body.prompt && !(Array.isArray(body.messages) && body.messages.length)) {
        fail(400, "prompt or messages is required");
      }
      let r = await llmChat(body);
      const expect = Array.isArray(body.expect) ? body.expect.slice(0, 12).map(String) : [];
      let found = body.json ? parseLooseJsonDetailed(r.text, expect) : { value: undefined };
      // An object dug out of a scratchpad that was itself cut off is a draft,
      // not a decision.
      if (found.fromScratchpad && (r.truncated || r.fromReasoning)) found = { value: null, fromScratchpad: true };
      let parsed = found.value;

      /* One retry, and only for the failure a retry actually fixes: the
       * answer was cut off mid-thought because the budget was spent
       * reasoning. Ask again with room for both. */
      if (body.json && !parsed && !body._retried && (r.truncated || r.fromReasoning || r.reasoned)) {
        const roomier = Math.min(8000, Math.max(3000, (body.maxTokens || 1600) * 3));
        r = await llmChat({ ...body, maxTokens: roomier, _retried: true });
        parsed = parseLooseJson(r.text, expect);
        if (parsed == null) parsed = undefined;
        r.retriedWith = roomier;
      }

      return {
        ok: true, ...r,
        json: parsed,
        ...(body.json && !parsed ? { jsonFailure: diagnoseJson(r) } : {}),
      };
    }

    // ── Library · rulebook · cast ───────────────────
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
        return {
          ok: true,
          ...store.list(kind, {
            query: url.searchParams.get("q") || "",
            limit: Math.min(2000, Number(url.searchParams.get("limit")) || 500),
            offset: Number(url.searchParams.get("offset")) || 0,
            filter,
          }),
          ...(kind === "library" ? { stats: store.stats() } : {}),
        };
      }
      if (method === "POST") {
        const r = store.put(kind, body);
        if (!r.ok) fail(500, r.error);
        return { ok: true, entry: r.entry };
      }
      if (method === "PATCH") {
        if (!body.id) fail(400, "id is required");
        const r = store.patch(kind, body.id, body.changes || {});
        if (!r.ok) fail(404, r.error);
        return r;
      }
      if (method === "DELETE") {
        const id = body.id || url.searchParams.get("id");
        if (!id) fail(400, "id is required");
        return store.remove(kind, id);
      }
      fail(405, "GET, POST, PATCH or DELETE");
      break;
    }

    // ── Projects ────────────────────────────────────
    case "/projects": {
      if (method === "GET") {
        const id = url.searchParams.get("id");
        if (id) {
          const p = projects.get(id);
          if (!p) fail(404, "no such project");
          return { ok: true, project: p };
        }
        return projects.list();
      }
      if (method === "POST") {
        if (body.duplicate) {
          const r = projects.duplicate(body.duplicate, body.name);
          if (!r.ok) fail(400, r.error);
          return r;
        }
        if (!body.project) fail(400, "project is required");
        const r = projects.save(body.project);
        if (!r.ok) fail(400, r.error);
        return r;
      }
      if (method === "DELETE") {
        const id = body.id || url.searchParams.get("id");
        if (!id) fail(400, "id is required");
        return projects.remove(id);
      }
      fail(405, "GET, POST or DELETE");
      break;
    }

    case "/projects/media": {
      if (method === "GET") {
        const id = url.searchParams.get("id");
        const data = id ? await projects.getMedia(id) : null;
        if (!data) fail(404, "not stored");
        return { ok: true, id, data };
      }
      if (method === "POST") {
        if (Array.isArray(body.have)) return { ok: true, have: await projects.haveMedia(body.have) };
        const r = await projects.putMedia(body.id, body.data);
        if (!r.ok) fail(400, r.error);
        return r;
      }
      fail(405, "GET or POST");
      break;
    }

    /* Everything ComfyUI has rendered that this app can recognise, pulled
     * into the library. A H3 graph carries its own prompt, canvas, build and
     * seed, so a clip made before this editor existed — or made in ComfyUI
     * directly — still ends up on the shelf with everything else. */
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
        // An LTX AV graph — the experimental second engine's renders.
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
           * conditioning node; the latent's canvas is HALF resolution when a
           * two-stage graph upscales it. */
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
      return { ok: true, added, seen, skipped };
    }

    case "/library/stats":
      return { ok: true, ...store.stats() };

    // ── Backup — export / restore everything ────────
    case "/backup": {
      if (method === "GET") return exportBackup();
      if (method === "POST") return importBackup(body.backup || body);
      fail(405, "GET or POST");
      break;
    }

    // ── VRAM arbiter ────────────────────────────────
    case "/vram/state":
      return { ok: true, ...vramState() };

    case "/vram/claim": {
      const r = await claim(body.owner, { force: !!body.force });
      return { ok: true, ...r, state: vramState() };
    }

    case "/vram/release": {
      const r = await releaseAll();
      return { ok: true, ...r, state: vramState() };
    }

    case "/vram/free-comfy":
      return { ok: true, ...(await freeComfy()), state: vramState() };

    case "/vram/unload-llm":
      return { ok: true, ...(await unloadLLM()), state: vramState() };

    default:
      fail(404, `no such endpoint: /api${route}`);
  }
}
