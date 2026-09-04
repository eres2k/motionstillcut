/* The Resolve handoff: validate, stage persistent media, then import one
 * editable timeline through the user's MCP server. Never render in Resolve.
 * Each request has its own directory and receipt to make retries safe. */
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
import { DATA_DIR, loadSettings } from "./settings.js";
import { McpClient } from "./mcp.js";
import { fetchSource, ffmpeg, ffmpegAvailable, probe, editLayout, safeId } from "./film.js";
import { resolveXml } from "./resolve-xml.js";

const DIR = resolve(DATA_DIR, "resolve");
const pending = new Map();
let sending = false;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const client = () => { const s = loadSettings().resolve; return new McpClient(s.url, { token: s.apiKey }); };

async function inspect(mcp) {
  await mcp.connect();
  const tools = await mcp.listTools();
  if (!tools.some(t => t.name === "resolve_status")) throw new Error("This MCP server does not expose resolve_status.");
  const status = await mcp.call("resolve_status");
  const importer = tools.find(t => t.name === "import_timeline");
  const props = importer?.inputSchema?.properties || {};
  const compatible = ["file_path", "expected_project", "request_id", "expected_clips"].every(key => key in props);
  return {
    ...status, connected: true, ready: compatible && !!status.project && !status.rendering,
    canImport: compatible, tools: tools.length, server: mcp.info?.name || "Resolve MCP",
    message: !compatible ? "Update the Resolve MCP server to include Motionstill Cut's import_timeline tool."
      : !status.project ? "Open a project in Resolve, then check the connection again."
        : status.rendering ? "Resolve is rendering. Wait for it to finish before sending clips."
          : `Ready to create a timeline in ${status.project}.`,
  };
}

export async function resolveStatus() {
  let mcp;
  try { mcp = client(); return { ok: true, ...(await inspect(mcp)) }; }
  catch (err) { return { ok: true, mcpConnected: !!mcp?.info, connected: false, ready: false, message: err.message }; }
  finally { await mcp?.close(); }
}

/** A configured local ComfyUI root is the only filesystem shortcut accepted.
 * Otherwise the usual authenticated ComfyUI fetch supplies the bytes. */
export function localOutput(source, root) {
  if (!root || !source?.filename || (source.type || "output") !== "output" || !existsSync(root)) return null;
  const base = realpathSync(root);
  const file = resolve(base, source.subfolder || "", source.filename);
  const rel = relative(base, file);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw fail("Clip path escapes the ComfyUI output folder.");
  if (!existsSync(file)) return null;
  const actual = realpathSync(file), actualRel = relative(base, actual);
  if (isAbsolute(actualRel) || actualRel === ".." || actualRel.startsWith(`..${sep}`)) throw fail("Clip symlink escapes the ComfyUI output folder.");
  return actual;
}

async function prepare(body, dir) {
  const s = loadSettings().resolve;
  const cached = new Map();
  async function source(spec, name, audioOnly = false) {
    const key = JSON.stringify([spec, audioOnly]);
    if (cached.has(key)) return cached.get(key);
    const stem = `source-${cached.size + 1}`;
    let file = localOutput(spec, s.comfyOutputDir) || await fetchSource(spec, dir, stem, name);
    let info = await probe(file);
    if (audioOnly && !info.hasAudio) throw fail(`${name} has no audio stream.`);
    if (s.prepareAudio) {
      const output = join(dir, `${stem}-resolve${audioOnly ? ".wav" : ".mov"}`);
      const args = ["-y", "-nostdin", "-v", "error", "-i", file];
      if (audioOnly) args.push("-map", "0:a:0", "-vn", "-c:a", "pcm_s16le", "-ar", "48000");
      else {
        args.push("-map", "0:v:0", "-map", "0:a:0?");
        if (["h264", "hevc", "prores", "dnxhd", "mpeg4", "mjpeg"].includes(info.videoCodec)) args.push("-c:v", "copy");
        else args.push("-c:v", "prores_ks", "-profile:v", "2", "-pix_fmt", "yuv422p10le", "-threads", "4");
        args.push("-c:a", "pcm_s16le", "-ar", "48000", "-movflags", "+faststart");
      }
      const result = await ffmpeg([...args, output]);
      if (result.code !== 0) throw new Error(`Could not prepare ${name} for Resolve: ${result.stderr.slice(-600)}`);
      file = output; info = await probe(file);
    }
    const result = { file, probe: info, name };
    cached.set(key, result);
    return result;
  }
  const clips = [];
  for (const [i, c] of body.clips.entries()) {
    const media = await source(c.source, c.name || `Clip ${i + 1}`);
    clips.push({ ...c, ...media, name: c.name || media.name, label: c.name || media.name });
  }
  const layout = editLayout({ clips, width: body.width, height: body.height });
  const audio = [];
  for (const [i, a] of (body.audio || []).entries()) {
    const media = await source({ mediaId: a.mediaId }, a.name || `Audio ${i + 1}`, true);
    audio.push({ ...a, ...media, name: a.name || media.name });
  }
  return {
    ...layout, fps: body.fps, name: body.name,
    clips: layout.clips.map((c, i) => ({ ...c, probe: clips[i].probe, name: clips[i].name })), audio,
  };
}

export function validateTransfer(body) {
  if (!safeId(body?.requestId)) throw fail("A valid Resolve transfer ID is required.");
  if (!Array.isArray(body.clips) || !body.clips.length || body.clips.length > 32) throw fail("Send between 1 and 32 clips.");
  if (!Array.isArray(body.audio) || body.audio.length > 8) throw fail("Send at most 8 audio tracks.");
  if (![24, 25, 30].includes(body.fps)) throw fail("Choose 24, 25 or 30 fps for the edit.");
  for (const key of ["width", "height"]) if (!Number.isInteger(body[key]) || body[key] < 0 || body[key] > 8192) throw fail(`Invalid ${key}.`);
  if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 200) throw fail("Give the Resolve timeline a name (up to 200 characters).");
  for (const c of body.clips) {
    if (!c?.source || !(c.source.filename || safeId(c.source.mediaId))) throw fail("A clip is missing its source.");
    if (!Number.isFinite(c.in) || c.in < 0 || (c.out != null && (!Number.isFinite(c.out) || c.out <= c.in))) throw fail("A clip has an invalid trim range.");
  }
  for (const a of body.audio) {
    if (!safeId(a?.mediaId) || !Number.isFinite(a.at) || a.at < 0 || !Number.isFinite(a.gain) || a.gain < 0 || a.gain > 100) throw fail("An audio track has invalid media, timing or gain.");
  }
}

export async function sendToResolve(body) {
  validateTransfer(body);
  const fingerprint = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  if (pending.has(body.requestId)) {
    const run = pending.get(body.requestId);
    if (run.fingerprint !== fingerprint) throw fail("This transfer ID already belongs to a different edit.", 409);
    return run.promise;
  }
  const dir = join(DIR, body.requestId), receipt = join(dir, "transfer.json");
  if (existsSync(receipt)) {
    const saved = JSON.parse(readFileSync(receipt, "utf8"));
    if (saved.fingerprint !== fingerprint) throw fail("This transfer ID already belongs to a different edit.", 409);
    if (saved.result) return saved.result;
    if (saved.importing) throw fail("This transfer may already be in Resolve. Check its timeline before starting another send.", 409);
  }
  if (sending) throw fail("Another Resolve transfer is in progress. Wait for it to finish.", 409);
  sending = true;
  const promise = (async () => {
    let mcp;
    try {
      mcp = client();
      const status = await inspect(mcp);
      if (!status.ready) throw fail(status.message, 503);
      if (!(await ffmpegAvailable())) throw fail("Install ffmpeg on the Cut server to prepare Resolve media.", 503);
      mkdirSync(dir, { recursive: true });
      const spec = await prepare(body, dir);
      const file = join(dir, "timeline.fcpxml");
      writeFileSync(file, resolveXml(spec));
      writeFileSync(receipt, JSON.stringify({ fingerprint, importing: true, project: status.project, file }, null, 2));
      const imported = await mcp.call("import_timeline", {
        file_path: file, name: body.name, expected_project: status.project,
        expected_clips: body.clips.length, request_id: body.requestId,
      }, { timeout: 120000 });
      if (imported.ok !== true || !imported.timeline) throw new Error("Resolve did not confirm the import. Check its timeline before sending again.");
      const result = { ok: true, ...imported, clips: body.clips.length, audio: body.audio.length, duration: spec.duration, file };
      writeFileSync(receipt, JSON.stringify({ fingerprint, result }, null, 2));
      return result;
    } finally { sending = false; await mcp?.close(); }
  })();
  pending.set(body.requestId, { fingerprint, promise });
  try { return await promise; } finally { pending.delete(body.requestId); }
}
