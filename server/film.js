/**
 * MOTIONSTILL CUT — joining the clips.
 *
 * The one part of a film that is not a render. Two jobs, both ffmpeg:
 *
 *   LAST FRAME — the exact final frame of a rendered clip, so the next clip
 *   can start from it. Seeking a browser <video> to its end would have saved
 *   this file entirely, and it does not work: what comes back depends on the
 *   decoder, the keyframe interval and how the seek rounded, and "nearly the
 *   last frame" is precisely the wrong frame to continue from.
 *
 *   ASSEMBLE — the clips, in order, as one file. Stream copy first (the parts
 *   all come out of the same SaveVideo with the same codec, resolution and
 *   frame rate, so there is nothing to re-encode and nothing to lose), and a
 *   re-encode only as the fallback for when that assumption turns out to be
 *   wrong on someone's build.
 *
 * ffmpeg is NOT a dependency of this app. It is the first thing here that
 * shells out at all, so everything below degrades rather than throws: the
 * health probe reports whether it is there, the client hides what it cannot
 * do, and a machine without it still renders every clip — it just hands you
 * the clips instead of the film.
 *
 * The clips themselves are fetched from ComfyUI rather than read off disk: the
 * Cut server talks to ComfyUI over HTTP and has never assumed the two share a
 * filesystem, which is what lets it sit on a different machine.
 *
 *   EXPORT AN EDIT — the third job, added with the Editor page. Where
 *   assemble() joins renders that already match, an edit is anything after
 *   anything: renders of two sizes, a phone clip, a trim on each, a music
 *   track under the lot. That is one ffmpeg run with a filter graph rather
 *   than a stream copy, and it is always a re-encode — the price of a cut
 *   that is not just the clips in a row. See editArgs() for the graph.
 */

import { spawn } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "./settings.js";
import { comfyFetch } from "./vram.js";
import { MEDIA_DIR } from "./projects.js";

const DIR = join(DATA_DIR, "films");
const FFMPEG = process.env.CUT_FFMPEG || "ffmpeg";
/* ffprobe ships next to ffmpeg, so a pointed-at ffmpeg implies where it is —
 * unless someone says otherwise. */
const FFPROBE = process.env.CUT_FFPROBE || FFMPEG.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
const MAX_CLIPS = 32;
const MAX_TRACKS = 8;

/* An id becomes a directory name here, so it is not allowed to be a path. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const safeId = (id) => (SAFE_ID.test(String(id || "")) ? String(id) : null);

const ensure = (dir) => { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); };

/** Run ffmpeg. Resolves with { code, stderr } — never rejects on a non-zero
 *  exit, because a failed stream copy is a normal step here, not an error. */
function ffmpeg(args, { timeout = 900000 } = {}) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      return resolve({ code: -1, stderr: err.message });
    }
    let stderr = "";
    proc.stderr?.on("data", (b) => { stderr += b.toString(); if (stderr.length > 40000) stderr = stderr.slice(-20000); });
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already gone */ } }, timeout);
    proc.on("error", (err) => { clearTimeout(timer); resolve({ code: -1, stderr: err.message }); });
    proc.on("close", (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

/** Run a tool and keep what it printed. ffprobe answers on stdout, which the
 *  ffmpeg() runner above throws away on purpose. */
function capture(cmd, args, { timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      return resolve({ code: -1, stdout: "", stderr: err.message });
    }
    let stdout = "", stderr = "";
    proc.stdout?.on("data", (b) => { stdout += b.toString(); });
    proc.stderr?.on("data", (b) => { stderr += b.toString(); if (stderr.length > 40000) stderr = stderr.slice(-20000); });
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already gone */ } }, timeout);
    proc.on("error", (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: err.message }); });
    proc.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

let _available = null;
/** Is there an ffmpeg on this machine? Probed once, then remembered — the
 *  answer does not change while the server is up. */
export async function ffmpegAvailable() {
  if (_available !== null) return _available;
  const { code } = await ffmpeg(["-version"], { timeout: 10000 });
  _available = code === 0;
  return _available;
}

/** The tail of ffmpeg's own complaint, which is the only useful part of it. */
const lastLines = (stderr, n = 4) =>
  String(stderr || "").trim().split("\n").slice(-n).join(" · ").slice(0, 400);

/** Pull one of ComfyUI's outputs down as bytes. */
async function fetchOutput({ filename, subfolder = "", type = "output" }) {
  if (!filename) throw new Error("a clip has no filename");
  const qs = new URLSearchParams({ filename, subfolder, type });
  const r = await comfyFetch(`/view?${qs}`, { raw: true, timeout: 300000 });
  if (!r.ok) throw new Error(`ComfyUI would not serve ${filename} (HTTP ${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

/**
 * The final frame of a clip, as a PNG data URL.
 *
 * `-sseof -1 -update 1` decodes the last second and keeps overwriting the same
 * file, so what is left when it finishes is the last frame that decoded —
 * which is the frame the next clip has to begin on.
 */
export async function lastFrame(output) {
  if (!(await ffmpegAvailable())) throw new Error("ffmpeg is not installed on the Cut server");
  ensure(DIR);
  const work = join(DIR, `tmp-${randomUUID()}`);
  ensure(work);
  try {
    const clip = join(work, "clip.mp4");
    writeFileSync(clip, await fetchOutput(output));
    const png = join(work, "last.png");
    const { code, stderr } = await ffmpeg(
      ["-y", "-sseof", "-1", "-i", clip, "-update", "1", "-frames:v", "1", "-q:v", "1", png],
      { timeout: 120000 },
    );
    // Some builds refuse the negative seek on a short clip; decoding the whole
    // thing and keeping the last frame is slower and always works.
    if (code !== 0 || !existsSync(png)) {
      const retry = await ffmpeg(["-y", "-i", clip, "-update", "1", "-q:v", "1", png], { timeout: 300000 });
      if (retry.code !== 0 || !existsSync(png)) {
        throw new Error(`ffmpeg could not read the last frame — ${lastLines(retry.stderr || stderr)}`);
      }
    }
    return `data:image/png;base64,${readFileSync(png).toString("base64")}`;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The clips, in order, as one file.
 *
 * Returns { id, file, bytes, clips, encoded } — `encoded` says whether the
 * stream copy held or the fallback re-encode was needed, which is worth
 * surfacing: a re-encoded film is a generation of quality the copy would have
 * kept.
 */
export async function assemble({ clips = [], name = "film", audio = "keep", id = null } = {}) {
  if (!(await ffmpegAvailable())) throw new Error("ffmpeg is not installed on the Cut server");
  if (!Array.isArray(clips) || clips.length < 2) throw new Error("a film needs at least two clips");
  if (clips.length > MAX_CLIPS) throw new Error(`${clips.length} clips is past the ${MAX_CLIPS} this joins in one go`);

  const filmId = safeId(id) || randomUUID();
  const dir = join(DIR, filmId);
  ensure(dir);

  const parts = [];
  for (let i = 0; i < clips.length; i++) {
    const part = join(dir, `part-${String(i).padStart(3, "0")}.mp4`);
    writeFileSync(part, await fetchOutput(clips[i]));
    parts.push(part);
  }

  // The concat demuxer reads a list of files. Paths are ours and already
  // sanitised, but a quote in one would end the argument early.
  const list = join(dir, "parts.txt");
  writeFileSync(list, parts.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n");

  const out = join(dir, "film.mp4");
  const mute = audio === "mute";
  const copyArgs = ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", ...(mute ? ["-an"] : []), "-movflags", "+faststart", out];
  let encoded = false;
  let { code, stderr } = await ffmpeg(copyArgs);

  if (code !== 0 || !existsSync(out) || statSync(out).size === 0) {
    encoded = true;
    const encodeArgs = [
      "-y", "-f", "concat", "-safe", "0", "-i", list,
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
      ...(mute ? ["-an"] : ["-c:a", "aac", "-b:a", "192k"]),
      "-movflags", "+faststart", out,
    ];
    const retry = await ffmpeg(encodeArgs);
    if (retry.code !== 0 || !existsSync(out)) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`ffmpeg could not join the clips — ${lastLines(retry.stderr || stderr)}`);
    }
  }

  // The parts have served their purpose and are the bulk of the disk.
  for (const p of parts) rmSync(p, { force: true });
  rmSync(list, { force: true });

  const label = String(name || "film").replace(/[^\w .-]+/g, "").trim().slice(0, 60) || "film";
  writeFileSync(join(dir, "film.json"), JSON.stringify({ id: filmId, name: label, clips: clips.length, audio, encoded, at: Date.now() }, null, 2));

  return { id: filmId, file: "film.mp4", name: label, bytes: statSync(out).size, clips: clips.length, encoded };
}

/* ── The edit ─────────────────────────────────────────────── */

/**
 * What ffprobe knows about a file: { duration, width, height, fps, hasAudio }.
 *
 * One call for everything rather than one per stream: the JSON writer lists
 * every stream with its codec_type, so "is there sound" and "how big is the
 * picture" come out of the same read. Numbers that are not there come back
 * as 0 (width/height/fps) or null (duration) — the caller decides whether
 * that is fatal, because for an audio track a missing picture is the norm.
 */
export async function probe(file) {
  const { code, stdout, stderr } = await capture(FFPROBE, [
    "-v", "error",
    "-show_entries", "stream=codec_type,width,height,r_frame_rate,duration:format=duration",
    "-of", "json", file,
  ]);
  if (code !== 0) throw new Error(`ffprobe could not read the file — ${lastLines(stderr)}`);
  let info;
  try { info = JSON.parse(stdout); } catch { throw new Error("ffprobe answered with something that is not JSON"); }
  const streams = info.streams || [];
  const video = streams.find(st => st.codec_type === "video") || null;
  const audio = streams.find(st => st.codec_type === "audio") || null;
  const seconds = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  // r_frame_rate is a fraction ("24/1", "30000/1001"); a bare number is fine too.
  const rate = (r) => {
    const m = /^(\d+)(?:\/(\d+))?$/.exec(String(r || ""));
    if (!m) return 0;
    const d = m[2] ? Number(m[2]) : 1;
    return d > 0 ? Number(m[1]) / d : 0;
  };
  return {
    duration: seconds(info.format?.duration) ?? seconds(video?.duration) ?? seconds(audio?.duration),
    width: Number(video?.width) || 0,
    height: Number(video?.height) || 0,
    fps: video ? rate(video.r_frame_rate) : 0,
    hasAudio: !!audio,
  };
}

/* A source is either a ComfyUI output or a file in the media store. */
const isRender = (source) => !!source?.filename;
const isMedia = (source) => !!source?.mediaId;
const describeSource = (source) => isRender(source) ? source.filename : isMedia(source) ? `media ${source.mediaId}` : "nothing";

/* The store keeps a media file as the data URL the browser sent (see
 * projects.js) — so a file for ffmpeg means splitting the header off and
 * decoding the rest, and the header is also the only place its type is
 * written down. ffmpeg goes by content, not extension, but a sensible one
 * makes the working directory readable when something goes wrong. */
const EXT = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/x-matroska": "mkv",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/flac": "flac", "audio/ogg": "ogg",
  "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac" };

function readMedia(mediaId, label) {
  const key = safeId(mediaId);
  const path = key ? join(MEDIA_DIR, key) : null;
  if (!path || !existsSync(path)) {
    throw new Error(`${label} refers to a file the server does not have — save the project first so its media is uploaded`);
  }
  const text = readFileSync(path, "utf-8");
  const m = /^data:([^;,]*)(;base64)?,/.exec(text);
  if (!m) throw new Error(`${label}'s file is not stored as a data URL`);
  const body = text.slice(m[0].length);
  return { bytes: m[2] ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "latin1"), ext: EXT[m[1]] || "bin" };
}

/** Pull a source's bytes into `dir` under `stem`, and return the path. */
async function fetchSource(source, dir, stem, label) {
  if (isRender(source)) {
    const file = join(dir, `${stem}.mp4`);
    writeFileSync(file, await fetchOutput(source));
    return file;
  }
  if (isMedia(source)) {
    const { bytes, ext } = readMedia(source.mediaId, label);
    const file = join(dir, `${stem}.${ext}`);
    writeFileSync(file, bytes);
    return file;
  }
  throw new Error(`${label} has no source`);
}

/* Probes, remembered by source. A ComfyUI output name is unique per render
 * and a media id is unique per file, so a probe is never stale — and the
 * Editor page asks about every clip it is handed, often the same ones twice. */
const probes = new Map();
const PROBE_CACHE = 200;
const sourceKey = (source) => isRender(source)
  ? `render:${source.type || "output"}/${source.subfolder || ""}/${source.filename}`
  : `media:${source.mediaId}`;

/** What ffprobe says about one source, fetched into a scratch directory
 *  and thrown away again. */
export async function probeSource(source) {
  if (!isRender(source) && !isMedia(source)) throw new Error("a source is {filename, subfolder, type} or {mediaId}");
  if (!(await ffmpegAvailable())) throw new Error("ffmpeg is not installed on the Cut server");
  const key = sourceKey(source);
  if (probes.has(key)) return probes.get(key);
  ensure(DIR);
  const work = join(DIR, `tmp-${randomUUID()}`);
  ensure(work);
  try {
    const file = await fetchSource(source, work, "probe", describeSource(source));
    const info = await probe(file);
    if (probes.size >= PROBE_CACHE) probes.delete(probes.keys().next().value);
    probes.set(key, info);
    return info;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const MIN_CLIP = 0.1;
// libx264 with yuv420p wants even dimensions; a 1-pixel pad would not be seen
// and a refused encode would.
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const secs = (n) => String(Math.round(n * 1000) / 1000);

/**
 * The cut resolved against what ffprobe found: each clip's real start/end
 * and length, the total, and the frame size.
 *
 *   { clips: [{ file, start, end, length, mute, hasAudio }], width, height, duration }
 *
 * Throws where the export cannot go on — a clip whose length nobody knows
 * and whose out point is "the end" has no end to give the concat, and
 * a frame nobody sized from a clip that has no picture is not a film.
 */
export function editLayout({ clips = [], width = 0, height = 0 } = {}) {
  if (!clips.length) throw new Error("nothing on the timeline");
  const laid = clips.map((c, i) => {
    const label = c.label || `clip ${i + 1}`;
    const p = c.probe || {};
    if (!p.width || !p.height) throw new Error(`${label} has no video stream`);
    const start = Math.max(0, Number(c.in) || 0);
    let end = c.out == null ? p.duration : Number(c.out);
    if (!Number.isFinite(end) || end == null) throw new Error(`${label}: ffprobe could not tell how long it is, so it needs an out point`);
    if (p.duration && end > p.duration) end = p.duration;
    if (end - start < MIN_CLIP) throw new Error(`${label}: the trim leaves less than ${MIN_CLIP} s`);
    return { file: c.file, start, end, length: end - start, mute: !!c.mute, hasAudio: !!p.hasAudio };
  });
  const first = clips[0].probe;
  const w = even(Number(width) > 0 ? Number(width) : first.width);
  const h = even(Number(height) > 0 ? Number(height) : first.height);
  return { clips: laid, width: w, height: h, duration: laid.reduce((t, c) => t + c.length, 0) };
}

/**
 * The ffmpeg arguments for one edit. Pure — everything it needs is in the
 * spec, so it can be checked without ffmpeg on the machine.
 *
 *   editArgs({ clips, audio, fps, width, height, out })
 *     clips: [{ file, in, out, mute, probe: {duration, width, height, hasAudio}, label? }]
 *     audio: [{ file, at, gain }]
 *     out:   the output path
 *
 * The graph: every clip is trimmed, fitted into the frame (scaled to fit and
 * padded to it — never cropped, never stretched; a portrait phone clip in a
 * landscape cut gets pillars, which is what every NLE does by default) and
 * brought to one frame rate; its sound is trimmed to match, or replaced with
 * silence of the same length when it is muted or has none — the concat
 * filter wants an audio stream from every segment, and a missing one is the
 * difference between a film and an error. Then the segments are concatenated,
 * each audio track is delayed to its offset and mixed under the result.
 *
 * `-shortest` because a track laid past the end of the picture would
 * otherwise carry the film on over a frozen frame.
 */
export function editArgs({ clips = [], audio = [], fps = 24, width = 0, height = 0, out } = {}) {
  const { clips: laid, width: w, height: h } = editLayout({ clips, width, height });
  const rate = Number(fps) > 0 ? Number(fps) : 24;
  const inputs = [];
  const graph = [];

  laid.forEach((c, i) => {
    inputs.push("-i", c.file);
    graph.push(`[${i}:v]trim=start=${secs(c.start)}:end=${secs(c.end)},setpts=PTS-STARTPTS,`
      + `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${rate}[v${i}]`);
    if (c.hasAudio && !c.mute) {
      graph.push(`[${i}:a]atrim=start=${secs(c.start)}:end=${secs(c.end)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a${i}]`);
    } else {
      graph.push(`anullsrc=r=48000:cl=stereo,atrim=0:${secs(c.length)}[a${i}]`);
    }
  });
  graph.push(`${laid.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${laid.length}:v=1:a=1[vcat][acat]`);

  let mix = "[acat]";
  if (audio.length) {
    audio.forEach((t, j) => {
      const n = laid.length + j;
      inputs.push("-i", t.file);
      const ms = Math.max(0, Math.round((Number(t.at) || 0) * 1000));
      const gain = Number.isFinite(Number(t.gain)) ? Math.max(0, Number(t.gain)) : 1;
      graph.push(`[${n}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${gain},adelay=${ms}|${ms}[t${j}]`);
    });
    // normalize=0: amix would otherwise scale every input down by the count,
    // and the cut's own sound getting quieter because music was added under
    // it is precisely not what "under" means.
    graph.push(`[acat]${audio.map((_, j) => `[t${j}]`).join("")}amix=inputs=${1 + audio.length}:duration=first:normalize=0[aout]`);
    mix = "[aout]";
  }

  return [
    "-y", ...inputs,
    "-filter_complex", graph.join(";"),
    "-map", "[vcat]", "-map", mix,
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart", "-shortest",
    out,
  ];
}

/**
 * Export an edit: fetch every source, probe it, run the one ffmpeg command
 * that makes the film, and put it where /film/view serves it.
 *
 * Returns { id, file, name, bytes, clips, duration, width, height }. The id
 * is the caller's when it gives one (the Editor keeps it stable per project,
 * so an export replaces the last), and the new film only takes the old one's
 * place once it exists — a failed export leaves the previous one alone.
 */
export async function exportEdit({ id = null, name = "edit", fps = 24, width = 0, height = 0, clips = [], audio = [] } = {}) {
  if (!(await ffmpegAvailable())) throw new Error("ffmpeg is not installed on the Cut server");
  if (!Array.isArray(clips) || !clips.length) throw new Error("nothing on the timeline");
  if (clips.length > MAX_CLIPS) throw new Error(`${clips.length} clips is past the ${MAX_CLIPS} this exports in one go`);
  if (!Array.isArray(audio)) audio = [];
  if (audio.length > MAX_TRACKS) throw new Error(`${audio.length} audio tracks is past the ${MAX_TRACKS} this mixes`);

  const filmId = safeId(id) || randomUUID();
  const dir = join(DIR, filmId);
  ensure(dir);
  const scratch = [];

  try {
    const laid = [];
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i] || {};
      const label = `clip ${i + 1} (${describeSource(c.source)})`;
      const file = await fetchSource(c.source, dir, `in-${String(i).padStart(3, "0")}`, label);
      scratch.push(file);
      laid.push({ file, in: c.in, out: c.out, mute: !!c.mute, label, probe: await probe(file) });
    }
    const tracks = [];
    for (let j = 0; j < audio.length; j++) {
      const t = audio[j] || {};
      const label = `audio track ${j + 1}`;
      const file = await fetchSource({ mediaId: t.mediaId }, dir, `aud-${String(j).padStart(3, "0")}`, label);
      scratch.push(file);
      const p = await probe(file);
      if (!p.hasAudio) throw new Error(`${label} has no sound in it`);
      tracks.push({ file, at: t.at, gain: t.gain });
    }

    const layout = editLayout({ clips: laid, width, height });
    const next = join(dir, "film.next.mp4");
    scratch.push(next);
    const args = editArgs({ clips: laid, audio: tracks, fps, width, height, out: next });
    const { code, stderr } = await ffmpeg(args, { timeout: 1800000 });
    if (code !== 0 || !existsSync(next) || statSync(next).size === 0) {
      throw new Error(`ffmpeg could not export the edit — ${lastLines(stderr)}`);
    }
    const out = join(dir, "film.mp4");
    renameSync(next, out);

    const label = String(name || "edit").replace(/[^\w .-]+/g, "").trim().slice(0, 60) || "edit";
    const sidecar = {
      id: filmId, name: label, kind: "edit", clips: clips.length, audio: audio.length,
      fps: Number(fps) > 0 ? Number(fps) : 24, width: layout.width, height: layout.height,
      duration: layout.duration, encoded: true, at: Date.now(),
    };
    writeFileSync(join(dir, "film.json"), JSON.stringify(sidecar, null, 2));
    return { id: filmId, file: "film.mp4", name: label, bytes: statSync(out).size, clips: clips.length,
      duration: layout.duration, width: layout.width, height: layout.height };
  } finally {
    // The inputs are the bulk of the disk, and a half-written output is
    // nothing anyone should find. A directory with no film in it (a first
    // export that failed) goes too, so /film/view never lists a ghost.
    for (const f of scratch) rmSync(f, { force: true });
    if (!existsSync(join(dir, "film.mp4"))) rmSync(dir, { recursive: true, force: true });
  }
}

/** Where a finished film lives, or null if that id has none. */
export function filmPath(id) {
  const safe = safeId(id);
  if (!safe) return null;
  const p = join(DIR, safe, "film.mp4");
  return existsSync(p) ? p : null;
}
