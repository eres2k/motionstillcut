/* MOTIONSTILL CUT — THE EDIT, planned.
 *
 * film.js decides where a film's clips fall before anything is rendered. This
 * is the other end of the pipe: the renders exist, the dropped files exist,
 * and the question is what goes after what, trimmed how, with what under it.
 *
 * Everything here is arithmetic on the project's `edit` object and nothing
 * else — no DOM, no fetch, no ffmpeg — so the Editor page can show the same
 * numbers the export will use, and a test can check them without a server.
 * The one thing the plan cannot know is the length of a file nobody has
 * probed yet; it says so (length null) rather than guessing, and the server
 * asks ffprobe when the export runs.
 *
 * The helpers at the bottom are mutations on a DRAFT. Pages call them inside
 * update(), which is what puts them on the undo stack — an edit is exactly
 * the kind of thing you want to take back.
 */

import { uid } from "./util.js";

/* Below this a trim is a mistake, not a clip: ffmpeg's concat is happy to
 * join a two-frame segment, and nobody has ever meant to. */
export const MIN_CLIP = 0.1;

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const known = (d) => Number.isFinite(d) && d > 0;

/** What the export reads the clip's bytes from, or null if it has nothing. */
export function clipSource(clip) {
  if (clip?.kind === "media") return clip.mediaId ? { mediaId: clip.mediaId } : null;
  const o = clip?.output;
  if (!o?.filename) return null;
  return { filename: o.filename, subfolder: o.subfolder || "", type: o.type || "output" };
}

/**
 * The cut, as numbers: each clip's trimmed length and where it starts, the
 * total, and the frame the export will be.
 *
 * `problems` is the list a page shows and the export refuses on; an empty
 * list means the server has everything it needs. A media clip whose length
 * is unknown is NOT a problem — the server probes it — which is why `at`
 * only accumulates the lengths it knows and the duration is a floor until
 * every clip has been probed.
 */
export function editPlan(project) {
  const edit = project?.edit || {};
  const clips = Array.isArray(edit.clips) ? edit.clips : [];
  const audio = Array.isArray(edit.audio) ? edit.audio : [];
  const exp = edit.export || {};
  const problems = [];

  if (!clips.length) problems.push("nothing on the timeline");

  let at = 0;
  const planned = clips.map((c, index) => {
    const label = c?.name || `clip ${index + 1}`;
    const source = clipSource(c);
    if (!source) problems.push(`${label} has no video behind it`);

    const start = Math.max(0, num(c?.in));
    const duration = known(c?.duration) ? c.duration : null;
    let end = c?.out == null ? duration : num(c.out, null);
    if (end != null && duration != null && end > duration) end = duration;
    let length = end == null ? null : Math.max(MIN_CLIP, end - start);
    if (duration != null && start >= duration) {
      problems.push(`${label} starts after it ends`);
      length = MIN_CLIP;
    }

    const entry = {
      index, id: c?.id, kind: c?.kind === "media" ? "media" : "render", name: label,
      source, mute: !!c?.mute, in: start, out: end, length, at,
    };
    at += length || 0;
    return entry;
  });

  const tracks = audio.map((a, j) => {
    const label = a?.name || `audio ${j + 1}`;
    if (!a?.mediaId) problems.push(`${label} has no file behind it`);
    return { id: a?.id, mediaId: a?.mediaId || null, name: label, at: Math.max(0, num(a?.at)), gain: Math.max(0, num(a?.gain, 1)) };
  });

  // The frame: what was asked for, else the first clip that knows its own
  // size, else 0 — which tells the server "the first clip's, once probed".
  const sized = clips.find(c => known(c?.width) && known(c?.height));
  const width = num(exp.width) > 0 ? Math.round(num(exp.width)) : (sized ? sized.width : 0);
  const height = num(exp.height) > 0 ? Math.round(num(exp.height)) : (sized ? sized.height : 0);

  return {
    ok: problems.length === 0,
    problems,
    clips: planned,
    audio: tracks,
    duration: at,
    fps: num(exp.fps) > 0 ? num(exp.fps) : 24,
    width, height,
  };
}

/** A name that can be a directory on the server (see safeId in server/film.js). */
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/**
 * The id the export lands under. Stable per project on purpose: exporting
 * the cut again replaces the last export, the way saving a project does,
 * rather than leaving a trail of films nobody asked to keep. (The URL is the
 * same both times, so a page that shows the result should bust the cache.)
 */
export function exportId(project) {
  const key = slug(project?.id) || slug(project?.name) || "untitled";
  return `edit-${key}`;
}

/** The JSON POST /edit/export takes. */
export function exportBody(project) {
  const plan = editPlan(project);
  const exp = project?.edit?.export || {};
  return {
    id: exportId(project),
    name: String(exp.name || project?.name || "edit"),
    fps: plan.fps,
    width: plan.width,
    height: plan.height,
    clips: plan.clips.map(c => ({ source: c.source, mute: c.mute, in: c.in, out: c.out })),
    audio: plan.audio.map(a => ({ mediaId: a.mediaId, at: a.at, gain: a.gain })),
  };
}

/* ── Mutations on a draft ────────────────────────────────────
 * Each takes the project draft update() hands out, changes it in place and
 * returns what it made (or whether it did anything). None of them validate
 * beyond what would corrupt the model — the plan reports the rest. */

/** A project from before the Editor existed has no `edit` in memory until it
 *  is reloaded; give it one rather than making every caller check. */
export function ensureEdit(draft) {
  if (!draft.edit) draft.edit = { clips: [], audio: [], export: { name: "", fps: 24, width: 0, height: 0 } };
  if (!Array.isArray(draft.edit.clips)) draft.edit.clips = [];
  if (!Array.isArray(draft.edit.audio)) draft.edit.audio = [];
  if (!draft.edit.export) draft.edit.export = { name: "", fps: 24, width: 0, height: 0 };
  return draft.edit;
}

/**
 * The clip file a render produced — the same choice filmrun.js makes, and
 * repeated here rather than imported because filmrun pulls in the API layer
 * and the DOM with it, and this module has to load in a test. See clipOutput
 * there for why the extension decides and not the key: core SaveVideo reports
 * its .mp4 under "images".
 */
export function renderOutput(job) {
  const outs = job?.outputs || [];
  return outs.find(o => /\.(mp4|webm|mkv|mov)$/i.test(o.filename || ""))
    || outs.find(o => o.kind === "videos" || o.kind === "gifs")
    || outs[0]
    || null;
}

/** "832x480" → [832, 480]; anything else → [0, 0]. */
const parseRes = (r) => {
  const m = /^(\d+)\s*x\s*(\d+)$/i.exec(String(r || "").trim());
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
};

/**
 * Put a render on the timeline. `job` is a job record (project.jobs) or a
 * library entry — both carry `outputs` and a settings snapshot with the
 * canvas and length the render was made at, which is as good as a probe for
 * a file ComfyUI wrote. Returns the clip, or null if the job has no video.
 */
export function addRenderClip(draft, job) {
  const output = renderOutput(job);
  if (!output?.filename) return null;
  const snap = job.settingsSnapshot || job.settings || {};
  const [w, h] = parseRes(snap.resolution);
  const clip = {
    id: uid(), kind: "render",
    name: job.name || job.variantLabel || output.filename,
    output: { filename: output.filename, subfolder: output.subfolder || "", type: output.type || "output" },
    jobId: job.id || null,
    poster: job.poster || null,
    duration: known(snap.duration) ? Number(snap.duration) : undefined,
    width: w || undefined, height: h || undefined,
    mute: false, in: 0, out: null,
  };
  ensureEdit(draft).clips.push(clip);
  return clip;
}

/**
 * Put a dropped file on the timeline. `item` is what media.js's ingest()
 * returns. Only video: a still would need a length nobody has given it, and
 * a sound file belongs on the audio row (addAudio). Returns the clip or null.
 */
export function addMediaClip(draft, item) {
  if (!item?.id || item.kind !== "video") return null;
  const clip = {
    id: uid(), kind: "media",
    name: item.name || item.id,
    mediaId: item.id,
    size: item.size || 0,
    poster: item.poster || null,
    duration: known(item.duration) ? Number(item.duration) : undefined,
    width: known(item.width) ? item.width : undefined,
    height: known(item.height) ? item.height : undefined,
    mute: false, in: 0, out: null,
  };
  ensureEdit(draft).clips.push(clip);
  return clip;
}

/** Lay a sound file under the cut, from the start. A video is accepted too —
 *  its soundtrack is what plays — because "use the audio from that take" is
 *  a real thing to want. Returns the track or null. */
export function addAudio(draft, item) {
  if (!item?.id || (item.kind !== "audio" && item.kind !== "video")) return null;
  const track = {
    id: uid(),
    mediaId: item.id,
    name: item.name || item.id,
    kind: item.kind,
    size: item.size || 0,
    duration: known(item.duration) ? Number(item.duration) : undefined,
    at: 0, gain: 1,
  };
  ensureEdit(draft).audio.push(track);
  return track;
}

/** Swap a clip with its neighbour. `dir` is -1 (earlier) or +1 (later);
 *  returns false at either end, so a button can just not do anything. */
export function moveClip(draft, id, dir) {
  const clips = ensureEdit(draft).clips;
  const i = clips.findIndex(c => c.id === id);
  const j = i + (dir < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= clips.length) return false;
  [clips[i], clips[j]] = [clips[j], clips[i]];
  return true;
}

export function removeClip(draft, id) {
  const clips = ensureEdit(draft).clips;
  const i = clips.findIndex(c => c.id === id);
  if (i < 0) return false;
  clips.splice(i, 1);
  return true;
}

/**
 * Change a clip. The trim is kept sane here rather than in the plan because a
 * number field can only hand back numbers: `in` never negative, `out` either
 * a number past it or null for "to the end" — and out-of-range is left to the
 * plan, which knows the clip's length when it has one.
 */
export function setClip(draft, id, patch = {}) {
  const clip = ensureEdit(draft).clips.find(c => c.id === id);
  if (!clip) return null;
  Object.assign(clip, patch);
  clip.in = Math.max(0, num(clip.in));
  // An emptied field arrives as "" — which Number() reads as 0, and a clip
  // trimmed to nothing is not what clearing the out point means.
  const out = clip.out === "" ? null : clip.out;
  clip.out = out == null || !Number.isFinite(Number(out)) ? null : Math.max(clip.in + MIN_CLIP, Number(out));
  clip.mute = !!clip.mute;
  return clip;
}

export function setAudio(draft, id, patch = {}) {
  const track = ensureEdit(draft).audio.find(a => a.id === id);
  if (!track) return null;
  Object.assign(track, patch);
  track.at = Math.max(0, num(track.at));
  track.gain = Math.max(0, num(track.gain, 1));
  return track;
}

export function removeAudio(draft, id) {
  const audio = ensureEdit(draft).audio;
  const i = audio.findIndex(a => a.id === id);
  if (i < 0) return false;
  audio.splice(i, 1);
  return true;
}
