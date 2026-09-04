/* MOTIONSTILL CUT — voice-over.
 *
 * Text-to-speech lives on the Nexus box, not here: two Python services with
 * the same shape — Qwen3-TTS (fast, ~4 GB, clones from a reference clip) and
 * VoxCPM2 (the better clone, 48 kHz, ~8 GB, style steer on top of a clone).
 * Both answer GET /health, GET /voices, POST /tts (JSON in, audio/wav out),
 * POST /admin/unload, and both take a reference voice as a file dropped
 * into their voices/ folder — the file stem is the voice id, a same-stem
 * .txt is its transcript.
 *
 * Two ways in. Through the Nexus gateway (a session cookie from a password
 * login, exactly how Tricorder does it): the gateway wakes a service that is
 * stopped or unloaded and counts the call for its Smart Memory. Or straight
 * to the service port, which works whenever the process is up. The gateway
 * is tried first when a password is configured; the port is the fallback.
 *
 *   CUT_NEXUS_URL        gateway (default http://127.0.0.1:3000)
 *   CUT_NEXUS_PASSWORD   its login password — unset = never use the gateway
 *   CUT_NEXUS_SERVICES   where the services live (default /opt/nexus/services)
 *   CUT_QWEN_TTS_URL     default http://127.0.0.1:8766
 *   CUT_VOXCPM_URL       default http://127.0.0.1:8767
 */
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

const NEXUS = (process.env.CUT_NEXUS_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const PASSWORD = (process.env.CUT_NEXUS_PASSWORD || "").trim();
const SERVICES = process.env.CUT_NEXUS_SERVICES || "/opt/nexus/services";
const FFMPEG = process.env.CUT_FFMPEG || "ffmpeg";

export const ENGINES = {
  qwen:   { label: "Qwen3-TTS · fast",    url: (process.env.CUT_QWEN_TTS_URL || "http://127.0.0.1:8766").replace(/\/+$/, ""), gateway: "/api/qwen-tts", voicesDir: join(SERVICES, "qwen-tts", "voices"), rate: 24000 },
  voxcpm: { label: "VoxCPM2 · best clone", url: (process.env.CUT_VOXCPM_URL || "http://127.0.0.1:8767").replace(/\/+$/, ""),   gateway: "/api/voxcpm",   voicesDir: join(SERVICES, "voxcpm", "voices"),   rate: 48000 },
};
export const engineOf = (id) => ENGINES[id] || ENGINES.qwen;

/* ── The gateway session ─────────────────────────────────── */
let cookie = null, cookieAt = 0;
const COOKIE_TTL = 20 * 60 * 60 * 1000;   // the gateway's sessions last a day

async function login(force = false) {
  if (!PASSWORD) return null;
  if (!force && cookie && Date.now() - cookieAt < COOKIE_TTL) return cookie;
  const r = await fetch(`${NEXUS}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }), signal: AbortSignal.timeout(8000),
  });
  const set = r.headers.get("set-cookie") || "";
  const m = set.match(/nexus_session=([^;]+)/);
  if (!r.ok || !m) throw Object.assign(new Error("Nexus login failed — check CUT_NEXUS_PASSWORD"), { status: 502 });
  cookie = `nexus_session=${m[1]}`; cookieAt = Date.now();
  return cookie;
}

/** One call, gateway first (wakes the service), port second. Returns the
 *  Response; throws a 502 with a plain explanation when neither answers. */
async function call(engine, path, { method = "GET", body = null, timeout = 300000 } = {}) {
  const init = { method, headers: {}, signal: AbortSignal.timeout(timeout) };
  if (body) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
  const errors = [];
  if (PASSWORD) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const c = await login(attempt > 0);
        const r = await fetch(`${NEXUS}${engine.gateway}${path}`, { ...init, headers: { ...init.headers, Cookie: c } });
        if (r.status === 401 && attempt === 0) continue;
        return r;
      } catch (e) { errors.push(`gateway: ${e.message}`); break; }
    }
  }
  try {
    return await fetch(`${engine.url}${path}`, init);
  } catch (e) {
    errors.push(`service: ${e.message}`);
    throw Object.assign(new Error(`${engine.label} is not reachable (${errors.join("; ")}). Start it from Nexus, or set CUT_NEXUS_PASSWORD so this app can wake it.`), { status: 502, code: "tts-offline" });
  }
}

/* ── What the page asks ─────────────────────────────────── */
export async function voiceHealth() {
  const out = {};
  for (const [id, engine] of Object.entries(ENGINES)) {
    try {
      const r = await fetch(`${engine.url}/health`, { signal: AbortSignal.timeout(2500) });
      out[id] = r.ok ? { ok: true, ...(await r.json().catch(() => ({}))), label: engine.label } : { ok: false, status: r.status, label: engine.label };
    } catch (e) {
      out[id] = { ok: false, error: e.message, label: engine.label, wakeable: !!PASSWORD };
    }
  }
  return out;
}

export async function listVoices(engineId) {
  const engine = engineOf(engineId);
  const r = await call(engine, "/voices", { timeout: 60000 });
  if (!r.ok) throw Object.assign(new Error(`${engine.label}: /voices ${r.status}`), { status: 502 });
  const data = await r.json();
  return { engine: engineId, voices: data.voices || [], default: data.default || "default" };
}

/** Speak `text`; returns the WAV bytes and what made them. */
export async function speak(engineId, { text, voice = "default", language = "de", speed = null, instruct = "" } = {}) {
  const engine = engineOf(engineId);
  const clean = String(text || "").trim();
  if (!clean) throw Object.assign(new Error("Nothing to say."), { status: 400 });
  const payload = { text: clean, voice: voice || "default", language: language || "de" };
  if (speed && Number(speed) !== 1) payload.speed = Number(speed);
  if (instruct) payload.instruct = instruct;
  const t0 = Date.now();
  const r = await call(engine, "/tts", { method: "POST", body: payload, timeout: 600000 });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw Object.assign(new Error(`${engine.label}: ${detail.slice(0, 300) || r.status}`), { status: r.status >= 400 && r.status < 500 ? r.status : 502 });
  }
  const bytes = Buffer.from(await r.arrayBuffer());
  return { bytes, mime: "audio/wav", ms: Date.now() - t0, engine: engineId, voice: payload.voice, language: payload.language, sampleRate: engine.rate };
}

/* ── Reference voices: a clip in the service's voices/ folder ── */
const VOICE_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export function voiceId(name) {
  const id = String(name || "").toLowerCase().normalize("NFKD").replace(/[^\x00-\x7f]/g, "").replace(/[^a-z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "").slice(0, 40);
  if (!VOICE_ID.test(id)) throw Object.assign(new Error("A voice name needs a letter or digit to start, then letters, digits, _ or -."), { status: 400 });
  return id;
}

function run(cmd, args, { timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    let stderr = "";
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, stderr: e.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

/** Save a reference clip for cloning. `data` is a data URL (any audio the
 *  browser can pick, or a video — ffmpeg pulls the sound out and writes a
 *  clean mono WAV at the engine's rate; without ffmpeg the bytes are saved
 *  as they are, which both services also accept for wav/mp3/flac/ogg). */
export async function addReferenceVoice(engineId, { name, data, transcript = "", engines = null } = {}) {
  const id = voiceId(name);
  const m = String(data || "").match(/^data:([^;]+);base64,(.+)$/s);
  if (!m) throw Object.assign(new Error("A reference clip is needed."), { status: 400 });
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length < 2000) throw Object.assign(new Error("That clip is too short to clone from — five to thirty seconds of clean speech."), { status: 400 });
  const targets = (engines || [engineId]).map(engineOf);
  const saved = [];
  for (const engine of targets) {
    mkdirSync(engine.voicesDir, { recursive: true });
    const tmp = join(tmpdir(), `mscut_voice_${id}_${Date.now()}`);
    writeFileSync(tmp, bytes);
    const wav = join(engine.voicesDir, `${id}.wav`);
    const { code } = await run(FFMPEG, ["-y", "-i", tmp, "-vn", "-ac", "1", "-ar", String(engine.rate), "-t", "30", wav]);
    if (code !== 0) {
      // No ffmpeg, or a format it could not read: keep the original bytes under the right extension.
      const ext = (m[1].split("/")[1] || "wav").replace("mpeg", "mp3").replace("x-wav", "wav");
      try { unlinkSync(wav); } catch { /* not written */ }
      writeFileSync(join(engine.voicesDir, `${id}.${ext}`), bytes);
    }
    try { unlinkSync(tmp); } catch { /* gone */ }
    if (String(transcript || "").trim()) writeFileSync(join(engine.voicesDir, `${id}.txt`), String(transcript).trim() + "\n");
    saved.push({ engine: Object.keys(ENGINES).find(k => ENGINES[k] === engine), dir: engine.voicesDir });
  }
  return { id, saved };
}

export function removeReferenceVoice(engineId, id) {
  const engine = engineOf(engineId);
  const clean = voiceId(id);
  let removed = 0;
  if (existsSync(engine.voicesDir)) {
    for (const f of readdirSync(engine.voicesDir)) {
      if (f.replace(/\.[a-z0-9]+$/i, "") === clean) { unlinkSync(join(engine.voicesDir, f)); removed++; }
    }
  }
  return { id: clean, removed, file: removed ? basename(engine.voicesDir) : null };
}
