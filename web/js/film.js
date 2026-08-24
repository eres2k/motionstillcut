/* MOTIONSTILL CUT — THE FILM: more than one clip, cut together.
 *
 * H3 generates 4–15 seconds. That is the model, not the app: past its window
 * the node keeps rendering and the model fills the extra seconds by repeating
 * what it already made, which is why the length dropdown marks everything
 * over 15 s with "⚠ repeats" and why the checker calls it an error.
 *
 * Two minutes of film is therefore not a longer render. It is eight renders
 * and a join — and the join is the part that has to be planned, because
 * everything that makes a sequence read as one piece (a face, a coat, the
 * light, the room) has to survive a boundary the model cannot see across.
 *
 * WHAT THIS FILE IS. The plan, and nothing that touches the network: given a
 * timeline whose shots run past one clip, work out where the clips break and
 * what each one is. Pure functions in, plain objects out, so the arithmetic
 * that decides where a film is cut can be tested without a GPU.
 * filmrun.js is the half that renders it.
 *
 * THREE RULES, and each one is the model's rather than ours:
 *
 *   A clip breaks at a CUT, never inside a shot. H3 already cuts between
 *   numbered shots inside one clip — [Shot 1], [Shot 2] is prompt syntax it
 *   was trained on — so a shot is the atom here and a clip is a run of them.
 *
 *   A clip lands on a length the latent grid holds: 5, 10 or 15 seconds (the
 *   DURATION_FRAMES entries inside H3's window). A run of shots that adds up
 *   to 7 s is rendered as 10 — rounding UP, because rounding down would drop
 *   the end of a shot that was written.
 *
 *   A shot longer than the window is its own clip and gets trimmed to 15 s,
 *   with a note saying so. Silently stretching it would hand back the repeat
 *   the whole exercise exists to avoid.
 */

import { orderedShots, H3_DURATION, filmSpan, FILM_LIMITS } from "./state.js";

/** The clip lengths a film may use: the DURATION_FRAMES rows inside H3's
 *  4–15 s window. 20/25/30 exist in the table and are deliberately not here —
 *  a film made of clips that each repeat is worse than a longer clip count. */
export const CLIP_LENGTHS = [5, 10, 15];
export const CLIP_MAX = H3_DURATION.max;

const round2 = (n) => Math.round(n * 100) / 100;

/** The shortest renderable clip that holds `seconds` of writing. */
export function clipLengthFor(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  return CLIP_LENGTHS.find((l) => l >= s - 1e-9) ?? CLIP_MAX;
}

/**
 * Where the film breaks into clips.
 *
 * Returns { clips, seconds, authored, notes }:
 *   clips    — [{ index, at, span, seconds, shots, trimmed }] in film order,
 *              `at` in film time, `shots` still carrying their film-time `at`
 *              (clipProject re-bases them; the plan keeps them addressable).
 *   seconds  — what the film will actually be, i.e. the sum of clip lengths.
 *   authored — what the shot list covers, before rounding.
 *   notes    — {level, msg} in the same shape validate() uses.
 */
export function planFilm(project, { span = null } = {}) {
  const shots = orderedShots(project);
  const total = Math.max(0, Number(span ?? filmSpan(project)) || 0);
  const notes = [];

  if (!shots.length) {
    return { clips: [], seconds: 0, authored: 0, notes: [{ level: "err", msg: "The timeline has no shots to cut into clips." }] };
  }
  if (project?.prompt?.manual && (project.prompt.description || "").trim()) {
    notes.push({
      level: "err",
      msg: "The description is hand-written, so it describes the whole film — every clip would be rendered from the same text. "
        + "Turn the override off to cut this into clips.",
    });
  }
  const last = shots[shots.length - 1];
  if ((last.at || 0) >= total && shots.length > 1) {
    notes.push({
      level: "err",
      msg: `The last shot cuts at ${(last.at || 0).toFixed(1)}s, at or past the film's ${total}s. Lengthen the film or move the shot.`,
    });
  }

  /* How long each shot lasts: up to the next cut, and for the last one up to
   * the end of the film. This is the same arithmetic validate() and the beat
   * budget use — a shot's length is never stored, it is always the gap. */
  const spans = shots.map((s, i) => {
    const end = i + 1 < shots.length ? (shots[i + 1].at || 0) : total;
    return Math.max(0, round2(end - (s.at || 0)));
  });

  const clips = [];
  let open = null;
  const close = () => { if (open) { clips.push(open); open = null; } };

  shots.forEach((shot, i) => {
    const span_i = spans[i];

    if (span_i > CLIP_MAX + 1e-9) {
      close();
      clips.push({ at: shot.at || 0, span: CLIP_MAX, shots: [shot], trimmed: round2(span_i - CLIP_MAX) });
      notes.push({
        level: "warn",
        msg: `Shot ${i + 1} runs ${span_i.toFixed(1)}s on its own, past H3's ${CLIP_MAX}s window. It becomes a ${CLIP_MAX}s clip and loses `
          + `${round2(span_i - CLIP_MAX).toFixed(1)}s — cut it in two if you want the rest of it.`,
      });
      return;
    }
    if (!open) { open = { at: shot.at || 0, span: span_i, shots: [shot], trimmed: 0 }; return; }
    if (open.span + span_i <= CLIP_MAX + 1e-9) {
      open.span = round2(open.span + span_i);
      open.shots.push(shot);
    } else {
      close();
      open = { at: shot.at || 0, span: span_i, shots: [shot], trimmed: 0 };
    }
  });
  close();

  const out = clips.map((c, index) => ({ ...c, index, span: round2(c.span), seconds: clipLengthFor(c.span) }));
  const seconds = out.reduce((n, c) => n + c.seconds, 0);
  const authored = round2(out.reduce((n, c) => n + c.span, 0));

  if (seconds > authored + 0.01) {
    notes.push({
      level: "info",
      msg: `${authored.toFixed(0)}s of writing renders as ${seconds}s: a clip can only be ${CLIP_LENGTHS.join(", ")} seconds long, so short ones are `
        + `rounded up. The extra time goes to the last shot of each clip.`,
    });
  }
  if (out.length > FILM_LIMITS.maxClips) {
    notes.push({
      level: "warn",
      msg: `${out.length} clips is a long unattended run. Nothing stops you, but the queue is the safer way past ${FILM_LIMITS.maxClips}.`,
    });
  }
  return { clips: out, seconds, authored, notes };
}

/**
 * One clip as a renderable project.
 *
 * A snapshot, exactly like the queue's: what runs is what was planned, and
 * editing the timeline afterwards cannot change a clip that is already in
 * flight. The shot times are re-based to the clip (the first pinned to 0,
 * which is what the compiler expects and what orderedShots enforces anyway).
 *
 * `first` is the previous clip's last frame. Handing it over turns the clip
 * into an I2V render, which is the only continuity H3 offers across a cut it
 * cannot see: the model has no memory between prompts, so a face carries only
 * because the frame it starts from carries it. R2V films do not use it — the
 * ref2va checkpoint takes references, not a keyframe, and its references are
 * already the thing holding identity across the whole film.
 */
export function clipProject(project, clip, { index = 0, total = 1, filmId = "", first = null } = {}) {
  const p = JSON.parse(JSON.stringify(project));
  delete p.jobs;
  delete p.selectedShot;

  p.shots = clip.shots.map((s, i) => ({ ...s, at: i === 0 ? 0 : round2((s.at || 0) - clip.at) }));
  p.render = { ...p.render, duration: clip.seconds };
  /* Named so the output filename survives slugging: safePrefix() strips
   * anything that is not a word character, a space or a hyphen, which turns
   * "— 3/5" into "35". "clip 3 of 5" comes out the other side readable, and
   * finding clip 3 in ComfyUI's output folder is the whole reason to care. */
  p.name = `${(project.name || "Untitled Timeline").trim()} — clip ${index + 1} of ${total}`;
  p.film = {
    ...(project.film || {}),
    enabled: true,
    id: filmId,
    index,
    total,
    at: clip.at,
  };

  if (first && p.mode !== "r2v") {
    p.mode = "i2v";
    p.frames = { ...(p.frames || {}), first };
    // The alignment line is what tells the model the clip begins in the frame
    // it was handed rather than merely near it. On a continuation that is the
    // whole point, so it is turned on regardless of the project's own setting.
    p.prompt = { ...(p.prompt || {}), alignKeyframe: true };
  }
  return p;
}

/** Can this project's clips be chained by a keyframe at all? R2V cannot: a
 *  different checkpoint, a different node, and no first_frame input on it. */
export const canChain = (project) => project?.mode !== "r2v";

/** A one-line description of the plan, for buttons and toasts. */
export function describePlan(plan) {
  if (!plan?.clips?.length) return "nothing to cut";
  const lengths = plan.clips.map((c) => c.seconds);
  const same = lengths.every((l) => l === lengths[0]);
  return same
    ? `${plan.clips.length} × ${lengths[0]}s — ${plan.seconds}s`
    : `${plan.clips.length} clips (${lengths.join(" + ")}s) — ${plan.seconds}s`;
}
