/**
 * MOTIONSTILL CUT — VRAM arbiter.
 *
 * VRAM saver mode: ONE engine on the GPU at a time. A 24 GB card cannot hold
 * a 32B Qwen3-VL text encoder for the prompt work AND MiniMax H3's ~20 GB DiT
 * for the render, and the failure mode when it tries is not an error — the
 * driver quietly spills to shared memory and the render takes ten times as
 * long. So the arbiter makes the swap explicit:
 *
 *   claim("comfy") → unload every resident LLM model, then let ComfyUI queue
 *   claim("llm")   → POST /free to ComfyUI (unload_models + free_memory),
 *                    then let the completion through
 *
 * A claim while a render is executing is refused rather than honoured: freeing
 * ComfyUI's models mid-sample would kill the run that is already using the
 * card. The UI surfaces that as "GPU busy — rendering" instead of a failure.
 *
 * Model LIFECYCLE is proprietary per backend even though completions are
 * OpenAI-compatible everywhere, so the unload dialect is detected once by
 * asking which endpoint doesn't 404, then remembered:
 *
 *   LM Studio       POST /api/v1/models/unload  {instance_id}
 *   Nexus gateway   POST /v1/models/unload      {model}   (drops everything)
 *   llama.cpp       POST /models/unload         {model}   (router mode only)
 *   llama-swap      POST /unload                (drops everything)
 *   Ollama          POST /api/generate          {model, keep_alive: 0}
 *   plain llama-server — no unload API at all; the model is resident until
 *   the process exits, and the arbiter says so once instead of hammering
 *   dead endpoints before every render.
 */

import { loadSettings } from "./settings.js";

const UNLOAD_ALL_STYLES = new Set(["nexus", "llamaswap"]);

let _style = null;        // 'lmstudio' | 'nexus' | 'llamacpp' | 'llamaswap' | 'ollama' | 'none'
let _styleNoted = false;

const state = {
  owner: null,            // 'comfy' | 'llm' | null
  since: 0,
  lastAction: null,       // human-readable, shown in the UI badge tooltip
  lastError: null,
  rendering: 0,           // in-flight ComfyUI jobs this server queued
  lastQueuedAt: 0,        // when the most recent one was queued
};

/* A queued render is only "in flight" while the client is still following it.
 * A closed tab, a crashed browser or a curl that never polls would otherwise
 * leave this counter above zero forever, and every later LLM call would be
 * refused with "a render is using the GPU" on a machine that is idle.
 *
 * So the counter is a hint, and ComfyUI's own queue is the authority: before
 * refusing anything, ask it. Empty queue means the render is over, whatever
 * the counter says. */
const STALE_RENDER_MS = 30 * 60 * 1000;

async function stillRendering() {
  if (state.rendering <= 0) return false;
  try {
    const q = await comfyFetch("/queue", { timeout: 5000 });
    const busy = (q?.queue_running?.length || 0) + (q?.queue_pending?.length || 0);
    if (!busy) {
      state.rendering = 0;
      state.lastAction = "queue is empty — cleared a stale render hold";
      return false;
    }
    return true;
  } catch {
    // ComfyUI unreachable: it certainly isn't rendering anything for us, but
    // a blip shouldn't drop a real hold either — fall back to the clock.
    if (Date.now() - state.lastQueuedAt > STALE_RENDER_MS) {
      state.rendering = 0;
      state.lastAction = "render hold expired";
      return false;
    }
    return true;
  }
}

export function llmHeaders() {
  const { llm } = loadSettings();
  return {
    "Content-Type": "application/json",
    ...(llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {}),
  };
}

export async function llmFetch(path, { method = "GET", body = null, timeout = 120000, stream = false } = {}) {
  const { llm } = loadSettings();
  const r = await fetch(`${llm.url}${path}`, {
    method,
    headers: llmHeaders(),
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeout),
  });
  return stream ? r : r;
}

export async function comfyFetch(path, { method = "GET", body = null, timeout = 60000, raw = false } = {}) {
  const { comfy } = loadSettings();
  const r = await fetch(`${comfy.url}${path}`, {
    method,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeout),
  });
  if (raw) return r;
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!r.ok) {
    const err = new Error(data?.error?.message || data?.error || text.slice(0, 400) || `ComfyUI ${r.status}`);
    err.status = r.status;
    err.detail = data;
    throw err;
  }
  return data;
}

/* Which models are actually RESIDENT?  llama.cpp's router mode carries a
 * per-model status object on GET /models, and its /v1/models lists every
 * AVAILABLE model — unloading from that list would fire pointless requests
 * for models that were never loaded. LM Studio's /v1/models lists only the
 * loaded ones, so it stays the fallback. */
async function loadedModelIds() {
  const { llm } = loadSettings();
  try {
    const r = await fetch(`${llm.url}/api/ps`, { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const list = (await r.json().catch(() => null))?.models;
      if (Array.isArray(list)) { _style = "ollama"; return list.map(m => m.model || m.name).filter(Boolean); }
    }
  } catch { /* not Ollama */ }
  try {
    const r = await fetch(`${llm.url}/models`, { headers: llmHeaders(), signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const list = (await r.json().catch(() => null))?.data;
      if (Array.isArray(list) && list.length && list[0] && list[0].status !== undefined) {
        return list.filter(m => ["loaded", "loading", "sleeping"].includes(m.status?.value)).map(m => m.id).filter(Boolean);
      }
    }
  } catch { /* not llama.cpp router */ }
  try {
    const r = await fetch(`${llm.url}/v1/models`, { headers: llmHeaders(), signal: AbortSignal.timeout(4000) });
    if (!r.ok) return [];
    return (((await r.json())?.data) || []).map(m => m.id).filter(Boolean);
  } catch { return []; }
}

async function unloadOne(id) {
  if (_style === "none") return false;
  const { llm } = loadSettings();
  const styles = _style ? [_style] : ["lmstudio", "ollama", "nexus", "llamacpp", "llamaswap"];
  for (const style of styles) {
    const [path, body] =
      style === "lmstudio" ? ["/api/v1/models/unload", { instance_id: id }] :
      style === "ollama"   ? ["/api/generate", { model: id, keep_alive: 0 }] :
      style === "nexus"    ? ["/v1/models/unload", { model: id }] :
      style === "llamacpp" ? ["/models/unload", { model: id }] :
                             ["/unload", null];
    try {
      const r = await fetch(`${llm.url}${path}`, {
        method: "POST",
        headers: llmHeaders(),
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20000),
      });
      if (r.status === 404) continue;    // endpoint absent — try the next dialect
      _style = style;
      return r.ok;
    } catch {
      return false;                       // server unreachable; nothing to unload
    }
  }
  _style = "none";
  if (!_styleNoted) {
    _styleNoted = true;
    console.warn("[VRAM] LLM backend has no unload endpoint — a plain llama-server holds its model until "
      + "the process exits. Run it in router mode (--models-dir, no -m) or use LM Studio / Ollama for VRAM saving.");
  }
  return false;
}

/** Drop every resident LLM model. Best effort: a backend that cannot unload
 *  is reported, not treated as a failure — the render still has to run. */
export async function unloadLLM() {
  const ids = await loadedModelIds();
  if (!ids.length) return { ok: true, unloaded: 0, style: _style || "unknown" };
  let n = 0;
  for (const id of ids) {
    const ok = await unloadOne(id);
    if (ok) n++;
    if (_style === "none") break;
    if (ok && UNLOAD_ALL_STYLES.has(_style)) break;  // one call dropped everything
  }
  return { ok: _style !== "none", unloaded: UNLOAD_ALL_STYLES.has(_style) ? ids.length : n, style: _style || "unknown" };
}

/** Unload ComfyUI's models and release its cached VRAM. This is ComfyUI's own
 *  /free — the process keeps running, it just stops holding the DiT. */
export async function freeComfy() {
  try {
    const r = await comfyFetch("/free", { method: "POST", body: { unload_models: true, free_memory: true }, timeout: 30000, raw: true });
    return { ok: r.ok, status: r.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** The badge's view of the world. Cheap and synchronous — the authoritative
 *  queue check happens on a claim, not on every poll. */
export function vramState() {
  const { vram } = loadSettings();
  // Don't report a hold that has clearly expired, even before a claim clears it.
  if (state.rendering > 0 && Date.now() - state.lastQueuedAt > STALE_RENDER_MS) state.rendering = 0;
  return {
    saver: !!vram.saver,
    releaseAfterRender: !!vram.releaseAfterRender,
    owner: state.owner,
    since: state.since,
    rendering: state.rendering > 0,
    lastAction: state.lastAction,
    lastError: state.lastError,
    llmUnloadStyle: _style,
  };
}

export function renderStarted() { state.rendering++; state.lastQueuedAt = Date.now(); }
export async function renderFinished() {
  state.rendering = Math.max(0, state.rendering - 1);
  const { vram } = loadSettings();
  if (state.rendering === 0 && vram.saver && vram.releaseAfterRender) {
    const r = await freeComfy();
    if (r.ok) { state.owner = null; state.lastAction = "released ComfyUI after render"; }
  }
}

/**
 * Take the GPU for `owner`, evicting the other engine first.
 *
 * With the saver off this only records who is using the card, so the badge in
 * the UI still tells the truth — nothing is unloaded.
 *
 * Returns { ok, owner, evicted, detail }. Refusal (a render in flight, LLM
 * side) comes back as an Error carrying .status = 409 so the HTTP layer can
 * pass the reason straight through to the user.
 */
export async function claim(owner, { force = false } = {}) {
  if (owner !== "comfy" && owner !== "llm") throw Object.assign(new Error("owner must be 'comfy' or 'llm'"), { status: 400 });
  const { vram } = loadSettings();

  if (!vram.saver) {
    state.owner = owner;
    state.since = Date.now();
    state.lastAction = "saver off — no eviction";
    return { ok: true, owner, evicted: null, saver: false, detail: "VRAM saver is off — both engines may hold the card." };
  }

  if (owner === "llm" && !force && await stillRendering()) {
    throw Object.assign(
      new Error("A render is using the GPU. VRAM saver will not unload ComfyUI mid-sample — wait for the render to finish, or turn the saver off."),
      { status: 409, code: "gpu_busy" },
    );
  }

  let evicted = null;
  if (owner === "comfy") {
    const r = await unloadLLM();
    evicted = { engine: "llm", ...r };
    state.lastAction = r.unloaded
      ? `unloaded ${r.unloaded} LLM model(s) via ${r.style}`
      : (r.style === "none" ? "LLM backend cannot unload" : "no LLM model was resident");
  } else {
    const r = await freeComfy();
    evicted = { engine: "comfy", ...r };
    state.lastAction = r.ok ? "freed ComfyUI models" : `ComfyUI free failed: ${r.error || r.status}`;
  }
  state.owner = owner;
  state.since = Date.now();
  state.lastError = evicted.ok === false ? state.lastAction : null;
  return { ok: true, owner, evicted, saver: true, detail: state.lastAction };
}

/** Hand the card back without giving it to anyone — used by the "Release GPU"
 *  button, and by a shutdown that wants to leave the box clean. */
export async function releaseAll() {
  const llm = await unloadLLM().catch(e => ({ ok: false, error: e.message }));
  const comfy = await freeComfy();
  state.owner = null;
  state.since = Date.now();
  state.lastAction = "released both engines";
  return { ok: true, llm, comfy };
}
