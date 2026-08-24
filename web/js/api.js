/* MOTIONSTILL CUT — the only place that talks to a backend.
 *
 * Two backends, one contract:
 *
 *   CLIENT (the default, and all the hosted release has) — every route is
 *   answered in this tab by backend/router.js: settings in localStorage, the
 *   library and projects in IndexedDB, ComfyUI and the LLM reached directly.
 *   Nothing is sent to the host serving these files — it only hands out the
 *   static app.
 *
 *   SERVER — the local Node app (server/server.js) with saving enabled. It
 *   injects window.__MSCUT_LOCAL__ = { saving: true } into index.html, and
 *   every request goes over HTTP to /api the way the original Cut server
 *   worked: projects and the library on disk under data/, ffmpeg joins, and
 *   the engines proxied so no CORS setup is needed.
 *
 * The base is derived from this module's own URL, so nothing has to be
 * configured wherever the app is served from.
 */

import { modal, h, toast } from "./util.js";
import { loadSettings } from "./backend/settings.js";

export const APP_BASE = new URL("../", import.meta.url).pathname;   // usually "/"
const API = (path) => `${APP_BASE}api${path}`;

const LOCAL = typeof window !== "undefined" ? (window.__MSCUT_LOCAL__ || null) : null;
/** True when a local Cut server with saving enabled is behind this page. */
export const SERVER_BACKED = !!(LOCAL && LOCAL.saving);
/** True when the page came from the local Node app at all (either mode). */
export const LOCAL_SERVER = !!LOCAL;

let _clientRouter = null;
const clientRouter = () => (_clientRouter ??= import("./backend/router.js"));

const TOKEN_KEY = "mscut.token";
/* Mounted inside Motionstill, the session token the main app already holds is
 * the same credential this API wants — so being logged in there means being
 * logged in here, with no second password prompt. */
const HOST_TOKEN_KEY = "motionstill_auth";

let _token = null;
try { _token = localStorage.getItem(TOKEN_KEY) || localStorage.getItem(HOST_TOKEN_KEY) || null; } catch { /* private mode */ }

/** Open the password prompt on demand — the "Sign in" button in the title bar
 *  after the modal has been dismissed. Client mode has no server and nothing
 *  to sign into. */
export async function signIn() { return SERVER_BACKED ? promptLogin() : true; }

export function setToken(t) {
  _token = t || null;
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

function headers(extra = {}) {
  return { "Content-Type": "application/json", ...(_token ? { Authorization: `Bearer ${_token}` } : {}), ...extra };
}

let _loginInFlight = null;
const _authWatchers = new Set();

/** Notified whenever the server says "not signed in" and whenever a sign-in
 *  succeeds. The chrome uses it to show a way back in after the modal is
 *  dismissed — otherwise the only route is a reload. */
export function onAuthState(fn) { _authWatchers.add(fn); return () => _authWatchers.delete(fn); }
const emitAuth = (signedIn) => { for (const fn of _authWatchers) { try { fn(signedIn); } catch (e) { console.error(e); } } };

export const isSignedIn = () => !!_token;

/** The password gate, shown only when the server actually asks for one. */
async function promptLogin() {
  if (_loginInFlight) return _loginInFlight;
  _loginInFlight = (async () => {
    for (;;) {
      const input = h("input", { type: "password", placeholder: "password", autofocus: "" });
      const body = h("div",
        h("div.note.info", "This Motionstill Cut server is password-protected. The same password as the main app when it is mounted there."),
        input);
      const ok = await modal({
        title: "Sign in",
        body,
        actions: [
          { label: "Sign in", kind: "primary", onClick: (done) => done(input.value) },
        ],
      });
      if (!ok) return false;
      const r = await fetch(API("/auth"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: ok }) });
      const data = await r.json().catch(() => ({}));
      if (data?.ok && data.token) { setToken(data.token); emitAuth(true); return true; }
      toast("Wrong password", "", "err");
    }
  })();
  const result = await _loginInFlight;
  _loginInFlight = null;
  return result;
}

async function request(path, { method = "GET", body = null, retry = true, timeout = 620000 } = {}) {
  if (!SERVER_BACKED) {
    // Answered in this tab. The client router throws Errors already carrying
    // the .status/.code the HTTP layer would have attached.
    const m = await clientRouter();
    return m.handle(path, { method, body });
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let r;
  try {
    r = await fetch(API(path), {
      method,
      headers: headers(),
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: ctl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(err.name === "AbortError" ? "request timed out" : `cannot reach the Cut server (${err.message})`);
  }
  clearTimeout(timer);

  if (r.status === 401 && retry) {
    emitAuth(false);
    if (await promptLogin()) return request(path, { method, body, retry: false, timeout });
    throw Object.assign(new Error("not signed in"), { status: 401 });
  }
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON (shouldn't happen on /api) */ }
  if (!r.ok || data?.ok === false) {
    const err = new Error(data?.error || text.slice(0, 300) || `HTTP ${r.status}`);
    err.status = r.status;
    err.code = data?.code;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  state:        () => request("/state"),
  health:       () => request("/health", { timeout: 30000 }),
  getSettings:  () => request("/settings"),
  saveSettings: (patch) => request("/settings", { method: "POST", body: patch }),
  detect:       (what = "both") => request(`/detect?what=${what}`, { timeout: 30000 }),

  comfyModels:  () => request("/comfy/models", { timeout: 90000 }),
  queue:        (prompt, clientId, extraData) => request("/comfy/prompt", { method: "POST", body: { prompt, clientId, extraData } }),
  history:      (id) => request(`/comfy/history?id=${encodeURIComponent(id)}`, { timeout: 30000 }),
  queueState:   () => request("/comfy/queue", { timeout: 20000 }),
  interrupt:    () => request("/comfy/interrupt", { method: "POST", body: {} }),
  upload:       (filename, dataUrl, type = "input") => request("/comfy/upload", { method: "POST", body: { filename, data: dataUrl, type } }),
  /* Client mode has no proxy, so media URLs point straight at ComfyUI —
   * which is also why they need no token. */
  viewUrl:      (f) => SERVER_BACKED
    ? `${APP_BASE}api/comfy/view?filename=${encodeURIComponent(f.filename)}&type=${encodeURIComponent(f.type || "output")}&subfolder=${encodeURIComponent(f.subfolder || "")}${_token ? `&_t=${encodeURIComponent(_token)}` : ""}`
    : `${loadSettings().comfy.url}/view?filename=${encodeURIComponent(f.filename)}&type=${encodeURIComponent(f.type || "output")}&subfolder=${encodeURIComponent(f.subfolder || "")}`,

  /* The film — the two ffmpeg jobs behind a multi-clip render: the frame one
   * clip ends on, and the join at the end. Both are slow enough to need their
   * own timeouts (a two-minute film is eight files fetched from ComfyUI before
   * ffmpeg starts), and both answer 503 with code "no-ffmpeg" on a machine
   * that has none — which the caller reports rather than treating as a fault. */
  filmLastFrame: (output) => request("/film/lastframe", { method: "POST", body: output, timeout: 300000 }),
  filmAssemble:  (body) => request("/film/assemble", { method: "POST", body, timeout: 1800000 }),
  // Client mode never assembles a film, so this URL is only ever built in
  // server mode — where the film lives behind /api.
  filmUrl:       (id) => `${APP_BASE}api/film/view?id=${encodeURIComponent(id)}${_token ? `&_t=${encodeURIComponent(_token)}` : ""}`,

  /* The whole app's state as one downloadable object, and the way back.
   * Client mode only — in server mode the data/ folder is the backup. */
  backupExport:  () => request("/backup", { timeout: 300000 }),
  backupImport:  (backup) => request("/backup", { method: "POST", body: { backup }, timeout: 300000 }),

  llmModels:    () => request("/llm/models", { timeout: 30000 }),
  chat:         (body) => request("/llm/chat", { method: "POST", body, timeout: 900000 }),

  // The stores behind the library, the rulebook and the cast.
  storeList:    (kind, params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ""));
    return request(`/${kind}${q.toString() ? `?${q}` : ""}`, { timeout: 30000 });
  },
  storeSave:    (kind, entry) => request(`/${kind}`, { method: "POST", body: entry, timeout: 30000 }),
  importHistory: (max = 50) => request("/library/import", { method: "POST", body: { max }, timeout: 180000 }),
  storePatch:   (kind, id, changes) => request(`/${kind}`, { method: "PATCH", body: { id, changes }, timeout: 30000 }),
  storeDelete:  (kind, id) => request(`/${kind}`, { method: "DELETE", body: { id }, timeout: 30000 }),

  /* Projects, server-side. One file each, plus the bytes behind their
   * references — a project whose pictures stayed in one browser is not
   * a project you can open anywhere else. */
  projects:      () => request("/projects", { timeout: 30000 }),
  projectGet:    (id) => request(`/projects?id=${encodeURIComponent(id)}`, { timeout: 60000 }),
  projectSave:   (project) => request("/projects", { method: "POST", body: { project }, timeout: 120000 }),
  projectCopy:   (id, name) => request("/projects", { method: "POST", body: { duplicate: id, name }, timeout: 60000 }),
  projectDelete: (id) => request("/projects", { method: "DELETE", body: { id }, timeout: 30000 }),
  mediaHave:     (have) => request("/projects/media", { method: "POST", body: { have }, timeout: 30000 }),
  mediaPut:      (id, data) => request("/projects/media", { method: "POST", body: { id, data }, timeout: 180000 }),
  mediaGet:      (id) => request(`/projects/media?id=${encodeURIComponent(id)}`, { timeout: 180000 }),

  vram:         () => request("/vram/state", { timeout: 15000 }),
  claim:        (owner, force = false) => request("/vram/claim", { method: "POST", body: { owner, force } }),
  release:      () => request("/vram/release", { method: "POST", body: {}, timeout: 120000 }),
  freeComfy:    () => request("/vram/free-comfy", { method: "POST", body: {}, timeout: 120000 }),
  unloadLlm:    () => request("/vram/unload-llm", { method: "POST", body: {}, timeout: 120000 }),
};

/** ComfyUI's progress only exists on its WebSocket. The browser can usually
 *  reach it directly (both are on the same machine); when it can't — a remote
 *  tunnel, a locked-down box — the caller falls back to polling /history and
 *  the render still reports, just without a per-step bar. */
export function openComfyProgress(comfyUrl, clientId, handlers = {}) {
  let ws = null;
  try {
    const u = new URL(comfyUrl);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = "/ws";
    u.searchParams.set("clientId", clientId);
    ws = new WebSocket(u.toString());
    ws.binaryType = "arraybuffer";
  } catch { return { close() {}, ok: false }; }

  ws.onmessage = (ev) => {
    /* ComfyUI streams the sampler's own preview frames as BINARY messages,
     * which this used to drop on the floor. The framing is two big-endian
     * uint32s and then the image: event type (1 = preview image), image type
     * (1 = JPEG, 2 = PNG), bytes. Decoding it is the difference between
     * watching a render and watching a spinner.
     *
     * The previews only exist if ComfyUI was started with a preview method
     * (--preview-method auto/latent2rgb/taesd); without one, nothing arrives
     * and the bar is all you get, which is the behaviour we had. */
    if (typeof ev.data !== "string") {
      if (!handlers.onPreview) return;
      const decode = async () => {
        try {
          const buf = ev.data instanceof Blob ? await ev.data.arrayBuffer() : ev.data;
          if (!buf || buf.byteLength < 12) return;
          const head = new DataView(buf, 0, 8);
          if (head.getUint32(0) !== 1) return;                 // not a preview
          const kind = head.getUint32(4) === 2 ? "image/png" : "image/jpeg";
          handlers.onPreview(new Blob([buf.slice(8)], { type: kind }));
        } catch { /* a malformed frame is not worth failing a render over */ }
      };
      void decode();
      return;
    }
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const d = msg.data || {};
    if (d.prompt_id && handlers.filterPromptId && d.prompt_id !== handlers.filterPromptId && msg.type !== "status") return;
    switch (msg.type) {
      case "progress":         handlers.onProgress?.(d.value, d.max); break;
      case "executing":        handlers.onNode?.(d.node); break;
      case "execution_start":  handlers.onStart?.(d); break;
      case "execution_error":  handlers.onError?.(d); break;
      case "execution_cached": handlers.onCached?.(d); break;
      case "executed":         handlers.onExecuted?.(d); break;
      case "status":           handlers.onStatus?.(d.status); break;
      default: break;
    }
  };
  ws.onerror = () => handlers.onSocketFail?.();
  ws.onclose  = () => handlers.onClose?.();
  return { ok: true, close: () => { try { ws.close(); } catch { /* already gone */ } } };
}
