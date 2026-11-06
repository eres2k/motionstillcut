/* The Resolve handoff: validate, stage persistent media, then import one
 * editable timeline through Resolve Studio's built-in MCP server (ResolveMCP).
 * Its sandboxed run_script tool runs the Resolve-side checks below. Never
 * render in Resolve. Each request has its own directory and receipt to make
 * retries safe. */
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
import { DATA_DIR, loadSettings, resolveMcpCommand } from "./settings.js";
import { McpClient } from "./mcp.js";
import { fetchSource, ffmpeg, ffmpegAvailable, probe, editLayout, safeId } from "./film.js";
import { resolveXml } from "./resolve-xml.js";

const DIR = resolve(DATA_DIR, "resolve");
const pending = new Map();
let sending = false;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const client = () => new McpClient(resolveMcpCommand());

/* run_script caps a script at 60 s; the client waits a little longer so a
 * slow import is reported by Resolve rather than by our own timer. */
const SCRIPT_TIMEOUT = 60;

/* Python run inside ResolveMCP's sandbox (no os/sys/network). `resolve` is
 * injected; arguments arrive as one JSON string literal. */
const STATUS_SCRIPT = `# motionstillcut:status
pm = resolve.GetProjectManager()
proj = pm.GetCurrentProject()
tl = proj.GetCurrentTimeline() if proj else None
result = {
    "product": f"{resolve.GetProductName()} {resolve.GetVersionString()}",
    "page": resolve.GetCurrentPage(),
    "project": proj.GetName() if proj else None,
    "timeline": tl.GetName() if tl else None,
    "rendering": bool(proj.IsRenderingInProgress()) if proj else False,
}
`;

const IMPORT_SCRIPT = `# motionstillcut:import
import json

def main(a):
    pm = resolve.GetProjectManager()
    project = pm.GetCurrentProject()
    if not project:
        raise RuntimeError("No project is open in Resolve.")
    if a["expected_project"] and project.GetName() != a["expected_project"]:
        raise RuntimeError(f"The open project changed to '{project.GetName()}'. Send again after checking the destination.")
    if project.IsRenderingInProgress():
        raise RuntimeError("Resolve is rendering. Wait for it to finish before importing a timeline.")
    tag = "motionstillcut:" + a["request_id"]
    timelines = [project.GetTimelineByIndex(i) for i in range(1, int(project.GetTimelineCount()) + 1)]
    timelines = [tl for tl in timelines if tl]
    for tl in timelines:
        if any(m.get("customData") == tag for m in (tl.GetMarkers() or {}).values()):
            return {"ok": True, "project": project.GetName(), "timeline": tl.GetName(), "reused": True}
    names = {tl.GetName() for tl in timelines}
    unique, i = a["name"], 2
    while unique in names:
        unique = f"{a['name']} ({i})"
        i += 1
    previous = project.GetCurrentTimeline()
    tl = project.GetMediaPool().ImportTimelineFromFile(a["file"], {"timelineName": unique, "importSourceClips": True})
    if not tl:
        if previous:
            project.SetCurrentTimeline(previous)
        raise RuntimeError("Resolve did not confirm the FCPXML import. Check for a new timeline before retrying; no import was retried automatically.")
    # From here on, report warnings rather than a failed send: the timeline
    # exists and repeating the import would create a duplicate.
    warnings = []
    try:
        if not tl.AddMarker(0, "Blue", "Motionstill Cut", "Imported from Motionstill Cut", 1, tag):
            warnings.append("The transfer marker could not be saved.")
        if not project.SetCurrentTimeline(tl):
            warnings.append("Select the imported timeline manually in Resolve.")
        video = [item for i in range(1, int(tl.GetTrackCount("video")) + 1)
                 for item in (tl.GetItemListInTrack("video", i) or [])]
        if len(video) != len(a["clips"]):
            warnings.append(f"Resolve imported {len(video)} video clips; expected {len(a['clips'])}. Review the timeline.")
        else:
            # Resolve may ignore asset-clip display names and srcEnable="video".
            # Apply both to the actual items, keeping muted sound re-enableable.
            sound = [item for i in range(1, int(tl.GetTrackCount("audio")) + 1)
                     for item in (tl.GetItemListInTrack("audio", i) or [])]
            sound_ids = {item.GetUniqueId() for item in sound}
            for spec, item in zip(a["clips"], sorted(video, key=lambda item: item.GetStart())):
                label = spec["label"]
                if label and not item.SetName(label):
                    warnings.append(f"Could not set the display name of {label}.")
                if spec["mute"]:
                    linked = [s for s in (item.GetLinkedItems() or []) if s.GetUniqueId() in sound_ids]
                    if not linked:
                        source = item.GetMediaPoolItem()
                        linked = [s for s in sound if source and s.GetMediaPoolItem()
                                  and s.GetMediaPoolItem().GetUniqueId() == source.GetUniqueId()
                                  and s.GetStart() == item.GetStart() and s.GetEnd() == item.GetEnd()]
                    for s in linked:
                        if not s.SetClipEnabled(False):
                            warnings.append(f"Could not mute {label or 'a clip'}; check its audio in Resolve.")
        if not resolve.OpenPage("edit"):
            warnings.append("Open the Edit page in Resolve to see the timeline.")
        if not pm.SaveProject():
            warnings.append("The timeline was imported but the project could not be saved. Save it in Resolve.")
    except Exception as exc:
        warnings.append(f"Timeline imported; final checks did not finish: {exc}")
    return {"ok": True, "project": project.GetName(), "timeline": tl.GetName(),
            "request_id": a["request_id"], "warnings": warnings}

result = main(json.loads(ARGS))
`;

/** Fills IMPORT_SCRIPT's ARGS placeholder with the arguments as JSON. */
export function scriptWithArgs(script, args) {
  // A JSON string literal is also a valid Python string literal. U+2028/2029
  // are escaped so the script stays one line per statement for every reader.
  const literal = JSON.stringify(JSON.stringify(args)).replace(/[\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16)}`);
  return script.replace(/^result = main\(json\.loads\(ARGS\)\)$/m, () => `result = main(json.loads(${literal}))`);
}
/** Runs a script through ResolveMCP and returns the value it assigned to `result`. */
async function runScript(mcp, script, timeout = SCRIPT_TIMEOUT) {
  const data = await mcp.call("run_script", { script, timeout }, { timeout: (timeout + 15) * 1000 });
  if (!data || typeof data.result !== "object" || data.result === null) throw new Error("Resolve's script returned no result.");
  return data.result;
}

async function inspect(mcp) {
  await mcp.connect();
  const tools = await mcp.listTools();
  const compatible = ["get_resolve_status", "run_script"].every(name => tools.some(t => t.name === name));
  const base = { connected: true, canImport: compatible, tools: tools.length, server: mcp.info?.name || "Resolve MCP" };
  if (!compatible) return { ...base, ready: false, message: "This MCP server is not DaVinci Resolve's built-in server. Use Resolve Studio 21.1 or newer." };
  const running = await mcp.call("get_resolve_status");
  if (!running.running) return { ...base, ready: false, message: "Start DaVinci Resolve Studio and open a project, then check the connection again." };
  const status = await runScript(mcp, STATUS_SCRIPT, 15);
  return {
    ...status, ...base, ready: !!status.project && !status.rendering,
    message: !status.project ? "Open a project in Resolve, then check the connection again."
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
      const missing = [...spec.clips, ...spec.audio].map(c => c.file).find(f => !existsSync(f));
      if (missing) throw new Error(`Prepared media is missing: ${missing}`);
      const file = join(dir, "timeline.fcpxml");
      writeFileSync(file, resolveXml(spec));
      writeFileSync(receipt, JSON.stringify({ fingerprint, importing: true, project: status.project, file }, null, 2));
      const imported = await runScript(mcp, scriptWithArgs(IMPORT_SCRIPT, {
        file, name: body.name.trim(), expected_project: status.project, request_id: body.requestId,
        clips: spec.clips.map(c => ({ label: c.name || "", mute: !!c.mute })),
      }));
      if (imported.ok !== true || !imported.timeline) throw new Error("Resolve did not confirm the import. Check its timeline before sending again.");
      const result = { ok: true, ...imported, clips: body.clips.length, audio: body.audio.length, duration: spec.duration, file };
      writeFileSync(receipt, JSON.stringify({ fingerprint, result }, null, 2));
      return result;
    } finally { sending = false; await mcp?.close(); }
  })();
  pending.set(body.requestId, { fingerprint, promise });
  try { return await promise; } finally { pending.delete(body.requestId); }
}
