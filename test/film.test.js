/* WHERE A FILM IS CUT — the arithmetic behind more than one clip.
 *
 * Every number here is H3's rather than ours, and the planner exists because
 * getting one of them wrong is invisible until the render comes back:
 *
 *   Past 15 seconds the node does not error, it repeats. So a clip that ends
 *   up 20 s long because a plan rounded the wrong way looks like a bug in the
 *   prompt, not a limit of the model.
 *
 *   The joint audio/video latent only lands on the DURATION_FRAMES grid, so a
 *   clip length that is not on it is silently rounded inside the node and the
 *   clip is not the length the plan says it is.
 *
 *   A clip may only break at a cut. Breaking inside a shot would hand the
 *   second half of it to a model that has never seen the first.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { blankProject, newShot, newBeat, DURATION_FRAMES, H3_DURATION, filmSpan, FILM_LIMITS } from "../web/js/state.js";
import { planFilm, clipProject, clipLengthFor, canChain, describePlan, CLIP_LENGTHS, CLIP_MAX } from "../web/js/film.js";
import { validate } from "../web/js/prompt.js";

/** A film with `count` shots evenly spaced across `seconds`. */
function film(seconds, cuts = []) {
  const p = blankProject();
  p.film = { ...p.film, enabled: true, seconds };
  p.sound.soundscape = "rain on a tin roof, a bus two streets away";
  p.sound.musicOff = true;
  p.shots = [0, ...cuts].map((at, i) => {
    const s = newShot(at);
    s.subject = `a courier in a wet jacket`;
    s.setting = "a loading bay at first light";
    s.beats = [newBeat(`beat ${i + 1}`)];
    return s;
  });
  return p;
}

/* ── The grid ────────────────────────────────────────────── */

test("a clip only ever gets a length the latent grid holds", () => {
  for (const l of CLIP_LENGTHS) {
    assert.ok(DURATION_FRAMES[l], `${l}s is not in DURATION_FRAMES`);
    assert.equal(DURATION_FRAMES[l] % 17, 5, `${l}s is off H3's frame grid`);
    assert.ok(l <= H3_DURATION.max, `${l}s is past H3's window`);
  }
});

test("a span rounds UP to the next renderable length, never down", () => {
  assert.equal(clipLengthFor(0), 5);
  assert.equal(clipLengthFor(4.2), 5);
  assert.equal(clipLengthFor(5), 5);
  assert.equal(clipLengthFor(5.1), 10);
  assert.equal(clipLengthFor(10), 10);
  assert.equal(clipLengthFor(12.5), 15);
  assert.equal(clipLengthFor(15), 15);
  // Past the window there is nothing longer to round to — the caller is
  // expected to have trimmed it, and this must not invent a 20 s clip.
  assert.equal(clipLengthFor(19), CLIP_MAX);
});

/* ── The split ───────────────────────────────────────────── */

test("no clip carries more writing than H3 can render", () => {
  const p = film(120, [8, 15, 21, 30, 44, 52, 60, 71, 80, 92, 100, 111]);
  const plan = planFilm(p);
  assert.ok(plan.clips.length > 1);
  for (const c of plan.clips) {
    assert.ok(c.span <= CLIP_MAX + 1e-9, `clip ${c.index} holds ${c.span}s of writing`);
    assert.ok(c.seconds <= CLIP_MAX, `clip ${c.index} renders ${c.seconds}s`);
    assert.ok(CLIP_LENGTHS.includes(c.seconds));
  }
});

test("every shot lands in exactly one clip, in order", () => {
  const p = film(90, [6, 13, 19, 28, 40, 55, 70, 82]);
  const plan = planFilm(p);
  const ids = plan.clips.flatMap(c => c.shots.map(s => s.id));
  assert.deepEqual(ids, p.shots.map(s => s.id));
  assert.equal(new Set(ids).size, ids.length, "a shot was duplicated across clips");
});

test("a clip breaks at a cut, so its first shot is a shot the author wrote", () => {
  const p = film(60, [12, 25, 38, 50]);
  for (const c of planFilm(p).clips) {
    assert.ok(p.shots.some(s => s.id === c.shots[0].id));
    assert.equal(c.at, c.shots[0].at, "a clip must start where its first shot cuts");
  }
});

test("the film is as long as its clips add up to, and says so when that is not what was written", () => {
  // Three shots of 7 s each: every clip rounds 7 → 10, so 21 s of writing
  // becomes 30 s of film. Silently would be the wrong way to do that.
  const p = film(21, [7, 14]);
  const plan = planFilm(p);
  assert.equal(plan.authored, 21);
  assert.equal(plan.seconds, plan.clips.reduce((n, c) => n + c.seconds, 0));
  assert.ok(plan.seconds > plan.authored);
  assert.ok(plan.notes.some(n => n.level === "info" && /rounded up/.test(n.msg)));
});

test("two short shots share a clip rather than each taking one", () => {
  const p = film(10, [5]);
  const plan = planFilm(p);
  assert.equal(plan.clips.length, 1);
  assert.equal(plan.clips[0].shots.length, 2);
  assert.equal(plan.clips[0].seconds, 10);
});

test("a shot longer than the window becomes its own clip, trimmed, and says how much it lost", () => {
  const p = film(40, [22]);          // shot 1 runs 22 s, shot 2 runs 18 s
  const plan = planFilm(p);
  assert.equal(plan.clips.length, 2);
  for (const c of plan.clips) {
    assert.equal(c.shots.length, 1);
    assert.equal(c.seconds, CLIP_MAX);
    assert.ok(c.trimmed > 0);
  }
  const warned = plan.notes.filter(n => n.level === "warn" && /past H3's 15s window/.test(n.msg));
  assert.equal(warned.length, 2);
});

test("a long shot in the middle does not swallow the shots around it", () => {
  const p = film(41, [4, 26, 31]);   // spans: 4 · 22 · 5 · 10
  const plan = planFilm(p);
  const shape = plan.clips.map(c => c.shots.length);
  // The 22 s shot stands alone and is trimmed; the 4 s one before it is not
  // dragged in, and the 5 + 10 after it pack into one clip that fits exactly.
  assert.deepEqual(shape, [1, 1, 2]);
  assert.ok(plan.clips[1].trimmed > 0);
  assert.equal(plan.clips[2].seconds, 15);
});

test("a single-shot timeline inside the window is one clip", () => {
  const p = film(12);
  const plan = planFilm(p);
  assert.equal(plan.clips.length, 1);
  assert.equal(plan.clips[0].seconds, 15);
});

/* ── The clip as a renderable project ────────────────────── */

test("a clip's shots are re-based to it, and stay inside it", () => {
  const p = film(60, [12, 25, 38, 50]);
  const plan = planFilm(p);
  plan.clips.forEach((clip, i) => {
    const cp = clipProject(p, clip, { index: i, total: plan.clips.length, filmId: "f1" });
    assert.equal(cp.shots[0].at, 0, "shot 1 is pinned to 0");
    assert.equal(cp.render.duration, clip.seconds);
    let prev = -1;
    for (const s of cp.shots) {
      assert.ok(s.at > prev, "cut times must strictly increase");
      assert.ok(s.at < cp.render.duration, `a shot at ${s.at}s is past the ${cp.render.duration}s clip`);
      prev = s.at;
    }
  });
});

test("a clip renders at a length the app can actually queue", () => {
  const p = film(75, [9, 18, 27, 36, 48, 61]);
  for (const clip of planFilm(p).clips) {
    const cp = clipProject(p, clip, {});
    assert.ok(DURATION_FRAMES[cp.render.duration], `${cp.render.duration}s has no frame count`);
    assert.ok(!validate(cp).checks.some(c => c.level === "err" && /past H3's/.test(c.msg)),
      "a planned clip must not trip the ceiling check it exists to avoid");
  }
});

test("a clip snapshot carries no render history and no selection", () => {
  const p = film(30, [10, 20]);
  p.jobs = [{ id: "j1" }];
  p.selectedShot = p.shots[1].id;
  const cp = clipProject(p, planFilm(p).clips[0], {});
  assert.equal(cp.jobs, undefined);
  assert.equal(cp.selectedShot, undefined);
  assert.equal(p.jobs.length, 1, "the source project must not be mutated");
});

test("handing a clip the frame before it turns it into an I2V continuation", () => {
  const p = film(30, [10, 20]);
  const plan = planFilm(p);
  const first = { id: "tail1", name: "tail.png", comfyName: "mscut_tail.png" };
  const cp = clipProject(p, plan.clips[0], { index: 1, total: 2, first });
  assert.equal(cp.mode, "i2v");
  assert.equal(cp.frames.first.comfyName, "mscut_tail.png");
  assert.equal(cp.prompt.alignKeyframe, true, "a continuation must emit the keyframe-alignment line");
});

test("a Ref2V film is never switched to I2V — that checkpoint has no keyframe input", () => {
  const p = film(30, [10, 20]);
  p.mode = "r2v";
  assert.equal(canChain(p), false);
  const cp = clipProject(p, planFilm(p).clips[0], { index: 1, total: 2, first: { id: "t", name: "t.png", comfyName: "t.png" } });
  assert.equal(cp.mode, "r2v");
  assert.equal(cp.frames?.first ?? null, null);
});

/* ── What the checker says about a film ──────────────────── */

test("a shot late in a film is not reported as past the clip", () => {
  const p = film(60, [12, 25, 38, 50]);
  assert.equal(filmSpan(p), 60);
  const errs = validate(p).checks.filter(c => c.level === "err");
  assert.deepEqual(errs, [], errs.map(e => e.msg).join(" · "));
});

test("the same timeline without film mode is an error, and stays one", () => {
  // The ceiling check is the app's loudest warning and the reason film mode
  // exists — turning film mode ON must not be a way to silence it for a single
  // over-long clip.
  const p = film(60, [12, 25, 38, 50]);
  p.film.enabled = false;
  p.render.duration = 30;
  assert.ok(validate(p).checks.some(c => c.level === "err" && /past H3's 15s ceiling/.test(c.msg)));
});

test("a film past the app's own ceiling is refused", () => {
  const p = film(FILM_LIMITS.max + 30, [20, 60, 100, 130]);
  assert.ok(validate(p).checks.some(c => c.level === "err" && /past this app's/.test(c.msg)));
});

test("a hand-written description cannot be cut into clips", () => {
  const p = film(45, [15, 30]);
  p.prompt.manual = true;
  p.prompt.description = "one long description of the whole film";
  const plan = planFilm(p);
  assert.ok(plan.notes.some(n => n.level === "err" && /hand-written/.test(n.msg)));
});

test("the plan describes itself the way the button has to read", () => {
  assert.equal(describePlan(planFilm(film(45, [15, 30]))), "3 × 15s — 45s");
  assert.match(describePlan(planFilm(film(20, [5, 12]))), /^2 clips \(/);
});

/* ── Every hard cut its own clip (LTX-2.5) ───────────────── */

function ltxFilm(seconds, cuts, verbs = {}) {
  const p = film(seconds, cuts);
  p.render.engine = "ltx25";
  p.render.variant = "ltx_two";
  for (const [i, v] of Object.entries(verbs)) p.shots[Number(i)].cutVerb = v;
  return p;
}

test("splitting at cuts gives one clip per hard cut on LTX-2.5", async () => {
  const { splitsAtCuts, clipLengthsFor } = await import("../web/js/film.js");
  const p = ltxFilm(20, [4, 8, 14]);
  p.film.splitAtCuts = true;
  assert.ok(splitsAtCuts(p));
  const plan = planFilm(p);
  assert.equal(plan.clips.length, 4);
  assert.deepEqual(plan.clips.map(c => c.shots.length), [1, 1, 1, 1]);
  assert.deepEqual(plan.clips.map(c => c.seconds), [5, 5, 10, 10], "each rounds up on LTX's grid");
  assert.deepEqual(clipLengthsFor(p), [5, 10, 15, 20, 25, 30]);
  assert.ok(plan.notes.some(n => /own clip/.test(n.msg)));
});

test("a row that continues the take stays inside its clip", () => {
  const p = ltxFilm(20, [4, 8, 14], { 2: "none" });
  p.film.splitAtCuts = true;
  const plan = planFilm(p);
  assert.equal(plan.clips.length, 3);
  assert.deepEqual(plan.clips.map(c => c.shots.length), [1, 2, 1]);
});

test("MiniMax ignores the switch and packs shots as before", async () => {
  const { splitsAtCuts } = await import("../web/js/film.js");
  const p = film(20, [4, 8, 14]);
  p.film.splitAtCuts = true;
  assert.ok(!splitsAtCuts(p));
  assert.equal(planFilm(p).clips.length, 2);
});

test("LTX clips may be longer than H3's window, and a 25 s take is one clip", () => {
  const p = ltxFilm(30, [25]);
  const plan = planFilm(p);
  assert.equal(plan.clips.length, 1, "25 + 5 fits one 30 s LTX clip");
  assert.equal(plan.clips[0].seconds, 30);
  assert.ok(!plan.notes.some(n => /trimmed|loses/.test(n.msg)));
});

test("a short split piece is not warned about as too short for a film", () => {
  const p = ltxFilm(10, [5]);
  p.film.splitAtCuts = true;
  assert.ok(!validate(p).checks.some(c => /short enough to be one or two clips/.test(c.msg)));
});
