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

/* ── The film path: every clip carries its own words ─────────── */
import { planFilm, clipProject } from "../web/js/film.js";

test("a line written into shot 1 is dealt across the clips of a film", () => {
  const p = blankProject();
  p.render.engine = "ltx25";
  p.film = { ...p.film, enabled: true, seconds: 20, splitAtCuts: true };
  p.sound.musicOff = true; p.sound.soundscape = "room tone";
  p.shots[0].subject = "a woman"; p.shots[0].beats = [newBeat("looks up")];
  for (const at of [5, 10, 15]) { const s = newShot(); s.at = at; s.subject = "the woman"; s.beats = [newBeat("nods")]; p.shots.push(s); }
  p.shots[0].dialogue = [{ id: "d1", speaker: "S1", text: LINE }];
  const plan = planFilm(p);
  assert.equal(plan.clips.length, 4);
  const perClip = plan.clips.map(c => c.shots.flatMap(s => s.dialogue || []).map(l => l.text).join(" "));
  assert.ok(perClip.every(t => t.trim()), `every clip speaks: ${JSON.stringify(perClip)}`);
  assert.equal(perClip.join(" ").replace(/\s+/g, " "), LINE.replace(/\s+/g, " "));
  assert.ok(plan.notes.some(n => /dealt across/.test(n.msg)));
  // The timeline itself is untouched — the deal is the plan's, not the creator's.
  assert.equal(p.shots[0].dialogue[0].text, LINE);
  assert.equal((p.shots[1].dialogue || []).length, 0);
  // And a clip snapshot carries exactly its share.
  const snap = clipProject(p, plan.clips[2], { index: 2, total: 4 });
  assert.equal(snap.shots.flatMap(s => s.dialogue).map(l => l.text).join(" "), perClip[2]);
});
