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
 *   ASSEMBLE — not possible without ffmpeg, and not faked. The route answers
 *   exactly like a server without ffmpeg did (503, code "no-ffmpeg"), the
 *   health probe reports ffmpeg:false, and the UI already knows what that
 *   means: every clip still renders and lands in the Library — the local
 *   version with server saving enabled does the join.
 */

import { comfyFetch } from "./engine.js";

export const NO_FFMPEG = () => Object.assign(
  new Error("Joining clips needs ffmpeg, which the hosted app does not have. Every clip is rendered and in the Library — download them and join them in any editor, or run the local Cut app with server saving enabled and it joins them for you."),
  { status: 503, code: "no-ffmpeg" },
);

const once = (el, ev) => new Promise((resolve, reject) => {
  el.addEventListener(ev, resolve, { once: true });
  el.addEventListener("error", () => reject(new Error(`the browser could not decode the clip (${ev})`)), { once: true });
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
