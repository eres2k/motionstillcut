/* MOTIONSTILL CUT — the film, without a server.
 *
 * The Cut server did two ffmpeg jobs: the exact final frame of a clip (so the
 * next clip can start from it) and the join at the end. The public client-only
 * release has no ffmpeg, so:
 *
 *   LAST FRAME — decoded in the browser instead. The clip is fetched from
 *   ComfyUI as bytes (so the canvas stays untainted), seeked to just inside
 *   its end, and drawn to a canvas. Seeking a <video> is less exact than
 *   ffmpeg — what you get depends on the decoder and how the seek rounded —
 *   so where the API is available the frame is confirmed through
 *   requestVideoFrameCallback, which reports the frame actually presented.
 *   In practice on ComfyUI's H.264 output this lands on the final frame; at
 *   worst it is one frame early, which continues cleanly.
 *
 *   PROBE — how long a clip is and how big, for the Editor page. The same
 *   decoder answers: loadedmetadata carries duration and the picture size.
 *   It does not carry the frame rate, and whether there is a soundtrack is
 *   only knowable on some browsers — so those come back as 0 and null, and
 *   the page treats "unknown" as exactly that.
 *
 *   ASSEMBLE — not possible without ffmpeg, and not faked. The route answers
 *   exactly like a server without ffmpeg did (503, code "no-ffmpeg"), the
 *   health probe reports ffmpeg:false, and the UI already knows what that
 *   means: every clip still renders and lands in the Library — the local
 *   version with server saving enabled does the join.
 */

import { comfyFetch } from "./engine.js";
import { getBlob } from "../media.js";

export const NO_FFMPEG = () => Object.assign(
  new Error("Joining clips needs ffmpeg, which the hosted app does not have. Every clip is rendered and in the Library — download them and join them in any editor, or run the local Cut app with server saving enabled and it joins them for you."),
  { status: 503, code: "no-ffmpeg" },
);

/* A browser that cannot decode the clip does not always say so: some
 * codecs and some decoders simply never fire the event, and never fire
 * "error" either. A wait with no end here left a film run sitting at
 * "taking its last frame…" after clip 1 forever, with nothing to report —
 * which read as "it only rendered the first clip". So every wait has a
 * deadline; a miss rejects, and the runner carries on with the next clip
 * started fresh, which it already knew how to do. */
const DECODE_DEADLINE_MS = 20000;
const once = (el, ev, ms = DECODE_DEADLINE_MS) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`the browser did not decode the clip within ${Math.round(ms / 1000)} s (${ev})`)), ms);
  el.addEventListener(ev, () => { clearTimeout(timer); resolve(); }, { once: true });
  el.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`the browser could not decode the clip (${ev})`)); }, { once: true });
});

/** The final frame of a rendered clip, as a PNG data URL. */
export async function lastFrame({ filename, subfolder = "", type = "output" } = {}) {
  if (!filename) throw new Error("a clip has no filename");
  const qs = new URLSearchParams({ filename, subfolder, type });
  const r = await comfyFetch(`/view?${qs}`, { raw: true, timeout: 300000 });
  if (!r.ok) throw new Error(`ComfyUI would not serve ${filename} (HTTP ${r.status})`);
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;

  try {
    await once(video, "loadedmetadata");
    if (!isFinite(video.duration) || video.duration <= 0) throw new Error("the clip reports no duration");
    // Just inside the end: asking for the exact duration makes some decoders
    // snap back to an earlier keyframe or to black.
    const target = Math.max(0, video.duration - 1 / 60);

    const seeked = once(video, "seeked");
    // Where supported, wait for the frame to actually be PRESENTED — "seeked"
    // alone can fire before the new frame reaches the element.
    const presented = typeof video.requestVideoFrameCallback === "function"
      ? new Promise((resolve) => video.requestVideoFrameCallback(() => resolve()))
      : null;
    video.currentTime = target;
    await seeked;
    if (presented) await Promise.race([presented, new Promise(res => setTimeout(res, 500))]);

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    if (!canvas.width || !canvas.height) throw new Error("the browser decoded no video frames from the clip");
    canvas.getContext("2d").drawImage(video, 0, 0);
    return canvas.toDataURL("image/png");
  } finally {
    video.removeAttribute("src");
    video.load?.();
    URL.revokeObjectURL(url);
  }
}

/** Bytes for a source, as an object URL the caller revokes: a ComfyUI output
 *  is fetched (so nothing is tainted), a media item comes out of the pool. */
async function sourceUrl(source) {
  if (source?.filename) {
    const qs = new URLSearchParams({ filename: source.filename, subfolder: source.subfolder || "", type: source.type || "output" });
    const r = await comfyFetch(`/view?${qs}`, { raw: true, timeout: 300000 });
    if (!r.ok) throw new Error(`ComfyUI would not serve ${source.filename} (HTTP ${r.status})`);
    return URL.createObjectURL(await r.blob());
  }
  if (source?.mediaId) {
    const dataUrl = await getBlob(source.mediaId);
    if (!dataUrl) throw new Error("that file is not in this browser's media pool");
    // A data URL would do as a src, but a very long one is slow to hand to
    // the decoder; a blob URL is the same bytes without the string.
    return URL.createObjectURL(await (await fetch(dataUrl)).blob());
  }
  throw new Error("a source is {filename, subfolder, type} or {mediaId}");
}

/** Whether the decoded clip has a soundtrack, where the browser will say. */
function audioPresence(video) {
  if (typeof video.mozHasAudio === "boolean") return video.mozHasAudio;
  if (video.audioTracks && typeof video.audioTracks.length === "number") return video.audioTracks.length > 0;
  if (typeof video.webkitAudioDecodedByteCount === "number") return video.webkitAudioDecodedByteCount > 0;
  return null;
}

/** { duration, width, height, fps: 0, hasAudio } for a source, as the server's
 *  ffprobe route reports it — minus what a <video> cannot know. An audio file
 *  loads in a <video> element too; it simply has no picture (0×0). */
export async function probeSource(source) {
  const url = await sourceUrl(source);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.src = url;
  try {
    await once(video, "loadedmetadata");
    const duration = isFinite(video.duration) && video.duration > 0 ? video.duration : null;
    return { duration, width: video.videoWidth || 0, height: video.videoHeight || 0, fps: 0, hasAudio: audioPresence(video) };
  } finally {
    video.removeAttribute("src");
    video.load?.();
    URL.revokeObjectURL(url);
  }
}
