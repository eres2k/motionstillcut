/* MOTIONSTILL CUT — RUNNING A FILM.
 *
 * film.js decides where the clips fall. This renders them, in order, and hands
 * each one the frame the last one ended on.
 *
 * WHY THIS IS NOT THE QUEUE. The queue runs snapshots that are complete before
 * it starts — that is the whole point of it, and it is why you can queue four
 * clips and walk away. A film cannot be built that way: clip 3 cannot exist
 * until clip 2 has rendered, because the thing that makes clip 3 continue from
 * clip 2 is a frame that does not exist yet. So the film runs its own loop,
 * through the same renderNow() the queue uses, and the queue stays free for
 * the unrelated work it was built for.
 *
 * WHAT CARRIES ACROSS A JOIN, and what does not:
 *
 *   The picture carries, through the last frame. H3 has no memory between
 *   prompts — the coat, the face and the light survive a cut only because the
 *   next clip is an I2V render starting from the frame before it.
 *
 *   The sound does not. H3 writes video and audio together, per clip, and it
 *   has no idea what the previous clip sounded like: room tone shifts and any
 *   score restarts at every join. That is not a bug this code can fix, so the
 *   assembler offers to mute instead — a silent cut you score yourself beats a
 *   soundtrack that lurches every fifteen seconds.
 *
 *   Continuity of INTENT does not carry either. Each clip is compiled from its
 *   own shots, so anything a shot needs the model to know — that the jacket is
 *   already off, that it is now raining — has to be in that shot's own
 *   description. The `continuity` field on a shot is exactly for this.
 */

import { api } from "./api.js";
import { renderNow } from "./render.js";
import { uid } from "./util.js";
import { clipProject, canChain } from "./film.js";

/**
 * The clip file a render produced.
 *
 * The extension identifies it, not the key it arrived under: core SaveVideo
 * reports through PreviewVideo, whose payload is `{"images": […], "animated":
 * true}` — so an H3 clip comes back tagged "images" with an .mp4 name, and a
 * search for kind "videos" finds nothing at all. Node packs that do use
 * "videos" or "gifs" are matched after it, and outputs[0] is the last resort
 * because that is what the rest of the app already treats as the clip.
 */
export function clipOutput(job) {
  const outs = job?.outputs || [];
  return outs.find(o => /\.(mp4|webm|mkv|mov)$/i.test(o.filename || ""))
    || outs.find(o => o.kind === "videos" || o.kind === "gifs")
    || outs[0]
    || null;
}

/**
 * The last frame of a rendered clip, uploaded into ComfyUI's input folder and
 * shaped like a media item so the next clip's graph can just load it.
 *
 * The backend decides how: the local Cut app decodes it exactly with ffmpeg;
 * the client-only version seeks the browser's own decoder to the end and
 * confirms the presented frame, which lands on the final frame or at worst
 * one before it — close enough to continue from, and the honest best a page
 * without ffmpeg can do.
 */
export async function tailFrame(output, index = 0) {
  const { dataUrl } = await api.filmLastFrame(output);
  if (!dataUrl) throw new Error("the server returned no frame");
  const item = { id: uid(), name: `film_tail_${index + 1}.png`, caption: "The final frame of the previous clip." };
  const r = await api.upload(`mscut_${item.id}_${item.name}`, dataUrl);
  item.comfyName = r.subfolder ? `${r.subfolder}/${r.name}` : r.name;
  return item;
}

/**
 * Render every clip in the plan.
 *
 * Stops at the first failure rather than carrying on: the queue is right to
 * keep going when clip 2 of four unrelated clips fails, and a film is the
 * opposite case — clip 3 continues from a frame clip 2 never produced, so
 * everything after a hole is worse than nothing.
 *
 * Returns { filmId, clips: [{ index, clip, job, output, error }], failed }.
 */
export async function runFilm(project, plan, {
  onStep = () => {}, onClip = () => {}, continuity = true, filmId = uid(),
} = {}) {
  const total = plan.clips.length;
  const chain = continuity && canChain(project);
  const results = [];
  let first = null;
  let failed = null;

  for (let i = 0; i < total; i++) {
    const clip = plan.clips[i];
    const label = `Clip ${i + 1}/${total}`;
    const snap = clipProject(project, clip, { index: i, total, filmId, first });
    const step = (m) => onStep(`${label} — ${m}`, i, total);

    step("rendering…");
    let job = null;
    try {
      job = await renderNow({
        project: snap,
        // The snapshot is this loop's own object, so uploaded filenames are
        // written back into it and a second run of the same film does not
        // re-upload every reference.
        commit: (fn) => fn(snap),
        onStep: step,
        experimentId: `film-${filmId}`,
        variantLabel: label,
      });
    } catch (err) {
      failed = { index: i, error: err.message };
      results.push({ index: i, clip, error: err.message });
      onClip({ index: i, clip, error: err.message });
      break;
    }
    if (job?.status !== "done") {
      const error = job?.error || `${label} did not finish`;
      failed = { index: i, error };
      results.push({ index: i, clip, job, error });
      onClip({ index: i, clip, job, error });
      break;
    }

    const output = clipOutput(job);
    results.push({ index: i, clip, job, output });
    onClip({ index: i, clip, job, output });

    if (chain && i + 1 < total) {
      if (!output) {
        // Nothing to continue from. Say so and carry on unchained rather than
        // stopping — an independent next clip is still a clip.
        step("no video came back, so the next clip starts fresh");
        first = null;
      } else {
        step("taking its last frame…");
        try {
          first = await tailFrame(output, i);
        } catch (err) {
          first = null;
          step(`could not take the last frame (${err.message}) — the next clip starts fresh`);
        }
      }
    }
  }
  return { filmId, clips: results, failed };
}

/**
 * Join the rendered clips into one file, server-side.
 *
 * `audio: "mute"` drops the soundtrack — see the note at the top of this file
 * about what H3 does at a join.
 */
export async function assembleFilm(results, { name = "film", audio = "keep", filmId = "" } = {}) {
  const clips = results
    .filter(r => r.output && !r.error)
    .map(r => ({ filename: r.output.filename, subfolder: r.output.subfolder || "", type: r.output.type || "output" }));
  if (clips.length < 2) throw new Error("A film needs at least two rendered clips to join.");
  return api.filmAssemble({ clips, name, audio, id: filmId || undefined });
}
