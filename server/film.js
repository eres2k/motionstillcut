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
 */

import { spawn } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "./settings.js";
import { comfyFetch } from "./vram.js";

const DIR = join(DATA_DIR, "films");
const FFMPEG = process.env.CUT_FFMPEG || "ffmpeg";
const MAX_CLIPS = 32;

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

/** Where a finished film lives, or null if that id has none. */
export function filmPath(id) {
  const safe = safeId(id);
  if (!safe) return null;
  const p = join(DIR, safe, "film.mp4");
  return existsSync(p) ? p : null;
}
