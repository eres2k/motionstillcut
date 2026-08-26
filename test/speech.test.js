/* SPEECH HAS A SPEED, AND THE CAMERA FOLLOWS THE SHOT — the two things that
 * made a four-shot talking head jerk: twenty seconds of words in a five-
 * second shot, and a tracking camera on a woman sitting still. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { blankProject, newShot, newBeat } from "../web/js/state.js";
import { applySteering, spreadDialogue, DEFAULT_DIALS, shotMoves, speechSeconds } from "../web/js/steer.js";
import { compilePrompt, validate, identityOf } from "../web/js/prompt.js";

const LINE = "We spent the day on Motionstill Cut. First: every cut between two shots is now a real choice. Hard cut, dissolve, fade — or no cut at all, when one long take just needs another moment. For LTX we write the prompt the way Lightricks asks: one paragraph, every cut named out loud, the sound carried across it. And if you want the cuts to be real, each one renders on its own and we join them. That was today.";

function talkingHead() {
  const p = blankProject();
  p.render.duration = 20;
  p.creative.dials = { ...DEFAULT_DIALS, energy: 30 };
  p.creative.pool = { beats: [
    "rests both hands on the desk and looks into the lens",
    "Cut to close-up, glances at the laptop screen and taps the trackpad",
    "Cut to wide, stands by the window and turns to gesture toward the monitor",
    "Cut to medium close-up, back at the desk, leans in and nods",
  ] };
  p.shots[0].subject = "a woman in her forties with short grey hair";
  p.shots[0].dialogue = [{ id: "d1", speaker: "S1", language: "English", text: LINE, voiceover: false }];
  applySteering(p);
  return p;
}

test("one long line in shot 1 is dealt across the shots by their seconds", () => {
  const p = talkingHead();
  assert.equal(p.shots.length, 4);
  const per = p.shots.map(s => (s.dialogue || []).map(l => l.text).join(" "));
  assert.ok(per.every(t => t.trim()), `every shot speaks: ${JSON.stringify(per)}`);
  assert.equal(per.join(" ").replace(/\s+/g, " "), LINE.replace(/\s+/g, " "), "nothing lost, nothing invented");
  assert.ok(speechSeconds(per[0]) <= 5 + 2.5, `shot 1 no longer overflows: ${per[0]}`);
});

test("speech the creator spread by hand is left alone", () => {
  const p = blankProject();
  p.render.duration = 10;
  const s2 = newShot(); s2.at = 5; s2.beats = [newBeat("x")]; p.shots.push(s2);
  p.shots[0].dialogue = [{ id: "a", speaker: "S1", text: "One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten. Eleven. Twelve. Thirteen. Fourteen. Fifteen. Sixteen." }];
  p.shots[1].dialogue = [{ id: "b", speaker: "S1", text: "Yes." }];
  assert.equal(spreadDialogue(p), false);
});

test("the camera tracks only in the shot where the subject moves", () => {
  const p = talkingHead();
  assert.equal(shotMoves(p.shots[0]), false);
  assert.equal(shotMoves(p.shots[2]), true);
  assert.notEqual(p.shots[0].camera.type, "tracking", "a seated woman is not tracked");
  assert.equal(p.shots[2].camera.type, "tracking");
});

test("with no identifying phrase the speaker is the subject, and LTX reuses her as the same woman", () => {
  const p = talkingHead();
  p.render.engine = "ltx25";
  assert.equal(identityOf(p, "S1"), "the woman");
  const { text } = compilePrompt(p);
  assert.ok(!/The speaker says/.test(text), text);
  assert.match(text, /A hard cut transitions to a [\w -]+ shot, [\w-]+ of the same woman in her forties/);
});

test("too many words for a shot's seconds is a warning", () => {
  const p = blankProject();
  p.render.duration = 10;
  const s2 = newShot(); s2.at = 5; s2.subject = "x"; s2.beats = [newBeat("y")]; p.shots.push(s2);
  p.shots[0].subject = "a baker"; p.shots[0].beats = [newBeat("lifts the shutter")];
  p.shots[0].dialogue = [{ id: "a", speaker: "S1", text: LINE }];
  p.shots[1].dialogue = [{ id: "b", speaker: "S1", text: "Done." }];
  const w = validate(p).checks.find(c => /words of speech/.test(c.msg));
  assert.ok(w && w.level === "warn", w?.msg);
});
