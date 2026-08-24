/* WHAT H3 CAN ACTUALLY DO — the limits the node does not enforce.
 *
 * Every check here exists because ComfyUI accepts the request and the model
 * fails quietly rather than erroring. Ask for a 30-second clip and you get 30
 * seconds of video, the last half of which is a repeat; attach fifteen
 * references and the graph builds. Nothing upstream says no, so this app has
 * to, and these are the numbers it says no with.
 *
 * The numbers are MiniMax's, from the specification table on the model card
 * (huggingface.co/MiniMaxAI/MiniMax-H3):
 *
 *     | Output duration   | 4–15 seconds |
 *     | Output frame rate | 24 FPS       |
 *
 * and, for Ref2VA: "Images: ≤ 9 · Videos: ≤ 3 · Audio: ≤ 3 · Mixed inputs:
 * Maximum number of files across all input types is 12."
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { blankProject, DURATION_FRAMES, H3_DURATION, REF_LIMITS, overLength, newShot, newBeat } from "../web/js/state.js";
import { validate, compilePrompt } from "../web/js/prompt.js";

/** A project with enough written in it that validate() does not short-circuit. */
function written(over = {}) {
  const p = blankProject();
  p.shots[0].subject = "a baker in a flour-dusted apron";
  p.shots[0].beats = [newBeat("lifts the shutter", "")];
  p.shots[0].setting = "a street bakery before sunrise";
  p.sound.soundscape = "a shutter rattling up, early traffic two streets away";
  p.sound.musicOff = true;
  return Object.assign(p, over);
}

const msgs = (p) => validate(p).checks.map(c => `${c.level}: ${c.msg}`);

/* ── Length ──────────────────────────────────────────────── */

test("the frame table stays on H3's latent grid", () => {
  // The VAE's clip_length is 17, so a length off that grid is silently rounded
  // inside the node and the clip is not the length the UI claims.
  for (const [seconds, frames] of Object.entries(DURATION_FRAMES)) {
    assert.equal(frames % 17, 5, `${seconds}s → ${frames} frames is off the grid`);
  }
});

test("every length the app offers past 15s is flagged as past it", () => {
  const over = Object.keys(DURATION_FRAMES).map(Number).filter(overLength);
  assert.deepEqual(over, [20, 25, 30]);
  for (const d of Object.keys(DURATION_FRAMES).map(Number).filter(d => !overLength(d))) {
    assert.ok(d <= H3_DURATION.max, `${d}s should not be in spec`);
  }
});

test("a clip past the ceiling is an error, whatever the shot count", () => {
  // The whole point. The old rule fired only on a SINGLE-shot project, so the
  // multi-shot case — the one the user hit — went unreported.
  for (const shotCount of [1, 3, 6]) {
    const p = written();
    p.render.duration = 30;
    for (let i = 1; i < shotCount; i++) {
      p.shots.push(Object.assign(newShot(i * 4), {
        subject: "the baker", beats: [newBeat("sets a tray down", "")],
      }));
    }
    const long = msgs(p).find(m => m.includes("past H3's 15s ceiling"));
    assert.ok(long, `${shotCount} shot(s) at 30s produced no ceiling error`);
    assert.equal(long.slice(0, 4), "err:", "it has to be an error, not a warning");
    assert.ok(/Adding shots does not help/.test(long),
      "and it must say cuts do not buy seconds — the old message said the opposite");
  }
});

test("a clip inside the spec says nothing about length", () => {
  for (const d of [5, 10, 15]) {
    const p = written();
    p.render.duration = d;
    assert.equal(msgs(p).filter(m => /ceiling|floor/.test(m)).length, 0, `${d}s complained`);
  }
});

/* ── References ──────────────────────────────────────────── */

test("the per-kind reference caps do not add up to the total, and both are checked", () => {
  assert.ok(REF_LIMITS.images + REF_LIMITS.videos + REF_LIMITS.audios > REF_LIMITS.total,
    "if these ever agree this test is pointless — 9 + 3 + 3 is 15 against a cap of 12");
  const p = written();
  p.mode = "r2v";
  const img = (i) => ({ id: `i${i}`, name: `ref${i}.png`, kind: "image", retention: "" });
  p.refs.images = Array.from({ length: 9 }, (_, i) => img(i));
  p.refs.videos = Array.from({ length: 3 }, (_, i) => ({ id: `v${i}`, name: `v${i}.mp4`, kind: "video" }));
  p.refs.audios = Array.from({ length: 3 }, (_, i) => ({ id: `a${i}`, name: `a${i}.wav`, kind: "audio" }));
  // Every per-kind cap is satisfied. The model still refuses 15 files.
  const total = msgs(p).find(m => m.includes("at most 12 files"));
  assert.ok(total, "15 references passed every check");
  assert.equal(total.slice(0, 4), "err:");
});

/* ── Continuity across a cut ─────────────────────────────── */

test("a state change undone by the next shot's repeated subject is flagged", () => {
  const p = written();
  p.render.duration = 15;
  p.shots[0].subject = "a courier in a heavy canvas jacket";
  p.shots[0].beats = [newBeat("takes off the jacket and hangs it on the chair", "")];
  p.shots.push(Object.assign(newShot(7), {
    subject: "a courier in a heavy canvas jacket",   // word for word, jacket and all
    beats: [newBeat("sits down at the table", "")],
  }));
  const warn = msgs(p).find(m => /same words as shot 1/.test(m));
  assert.ok(warn, "the repeated subject after a state change went unreported");
  assert.ok(/Changed since/.test(warn), "and it should say where to fix it");
});

test("saying what is different clears it, and reaches the prompt", () => {
  const p = written();
  p.render.duration = 15;
  p.shots[0].subject = "a courier in a heavy canvas jacket";
  p.shots[0].beats = [newBeat("takes off the jacket and hangs it on the chair", "")];
  p.shots.push(Object.assign(newShot(7), {
    subject: "a courier in a heavy canvas jacket",
    continuity: "in shirtsleeves, the jacket over the chair behind him",
    beats: [newBeat("sits down at the table", "")],
  }));
  assert.equal(msgs(p).filter(m => /same words as shot 1/.test(m)).length, 0);
  const text = compilePrompt(p).description;
  assert.ok(text.includes("now in shirtsleeves, the jacket over the chair behind him"),
    `the amendment never reached the prompt:\n${text}`);
  // It has to land right after the stale clause it corrects, or the model
  // believes the more recent of the two.
  assert.ok(/of a courier in a heavy canvas jacket, now in shirtsleeves/.test(text),
    "the amendment is not adjacent to the description it corrects");
});

test("shot 1 never gets a continuity clause — there is nothing to differ from", () => {
  const p = written();
  p.shots[0].continuity = "should not appear";
  assert.ok(!compilePrompt(p).description.includes("should not appear"));
});

test("two shots that already describe the subject differently are left alone", () => {
  const p = written();
  p.render.duration = 15;
  p.shots[0].subject = "a courier in a heavy canvas jacket";
  p.shots[0].beats = [newBeat("takes off the jacket", "")];
  p.shots.push(Object.assign(newShot(7), {
    subject: "the courier in shirtsleeves",
    beats: [newBeat("sits down", "")],
  }));
  assert.equal(msgs(p).filter(m => /same words as shot/.test(m)).length, 0);
});
