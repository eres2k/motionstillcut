/* A CUT IS A NEW SHOT — a model that writes "hard cut to close-up" as a
 * beat has written a shot list with the cuts folded into one shot. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitCutBeats, cutInBeat, readFraming } from "../web/js/shotlist.js";

test("a beat that opens with a cut is recognised, with its verb", () => {
  assert.equal(cutInBeat("Hard cut to close-up, glances at laptop").verb, "the camera cuts to");
  assert.equal(cutInBeat("the view cuts to a wide shot by the window").remainder, "wide shot by the window");
  assert.equal(cutInBeat("dissolve to a medium shot of the desk").verb, "the shot dissolves to");
  assert.equal(cutInBeat("glances at laptop"), null);
  assert.equal(cutInBeat("cuts the bread"), null, "\"cuts\" without \"to\" is an action");
});

test("the framing named after the cut becomes the shot type, the rest the first beat", () => {
  assert.deepEqual(readFraming("close-up, glances at laptop"), { shotType: "close-up", rest: "glances at laptop", framingOf: "" });
  assert.equal(readFraming("wide shot by the window").shotType, "wide");
  assert.equal(readFraming("medium close-up of her hands, taps once").shotType, "medium close-up");
  assert.equal(readFraming("medium close-up of her hands, taps once").framingOf, "her hands");
});

test("one shot with cuts written as beats becomes four shots, spaced across the clip", () => {
  const raw = [{
    at: 0, shotType: "medium", subject: "a woman in her forties with short grey hair",
    beats: ["Sits at desk, looking into lens", "Speaks while resting hands on desk",
      "Hard cut to close-up, glances at laptop", "Taps the trackpad once",
      "Hard cut to wide shot by the window", "Turns from window and gestures to monitor",
      "Hard cut to medium close-up, back at the desk", "Gives a small nod"],
    setting: "a small editing room", lighting: "single practical lamp",
  }];
  const shots = splitCutBeats(raw, 20);
  assert.equal(shots.length, 4);
  assert.deepEqual(shots.map(s => s.at), [0, 5, 10, 15]);
  assert.deepEqual(shots.map(s => s.shotType), ["medium", "close-up", "wide", "medium close-up"]);
  assert.deepEqual(shots[1].beats, ["glances at laptop", "Taps the trackpad once"]);
  assert.equal(shots[1].cutVerb, "the camera cuts to");
  assert.equal(shots[1].setting, "a small editing room", "the setting carries over");
  assert.equal(shots[0].beats.length, 2);
});

test("a list with real shots and real times is left alone", () => {
  const raw = [{ at: 0, beats: ["a"] }, { at: 6, beats: ["b", "c"] }, { at: 12, beats: ["d"] }];
  const shots = splitCutBeats(raw, 20);
  assert.deepEqual(shots.map(s => s.at), [0, 6, 12]);
  assert.deepEqual(shots.map(s => s.beats.length), [1, 2, 1]);
});

test("a split inside a timed list lands between its neighbours", () => {
  const raw = [{ at: 0, beats: ["a", "cut to wide, b"] }, { at: 10, beats: ["c"] }];
  const shots = splitCutBeats(raw, 20);
  assert.deepEqual(shots.map(s => s.at), [0, 5, 10]);
});

/* ── The same rule on Create's path: steering, not breakdown ── */
import { applySteering, cutSegments, DEFAULT_DIALS } from "../web/js/steer.js";
import { blankProject } from "../web/js/state.js";

test("a beat pool cut at its cuts is the shot list, whatever Pace wants", () => {
  const p = blankProject();
  p.render.duration = 20;
  p.creative.dials = { ...DEFAULT_DIALS, pace: 20 };   // below 45: Pace alone would make ONE shot
  p.creative.pool = { beats: [
    "sits at the desk, looking into the lens", "rests both hands on the desk",
    "Cut to close-up, glances at the laptop", "taps the trackpad once",
    "Cut to wide shot by the window, turns to face the room",
    "Cut to medium close-up, gives a small nod",
  ] };
  applySteering(p);
  assert.equal(p.shots.length, 4);
  assert.deepEqual(p.shots.map(s => s.shotType), [p.shots[0].shotType, "close-up", "wide", "medium close-up"]);
  assert.deepEqual(p.shots[1].beats.map(b => b.text), ["glances at the laptop", "taps the trackpad once"]);
  assert.equal(p.shots[1].cutVerb, "the camera cuts to");
  assert.ok(!p.shots.some(s => s.beats.some(b => /^cut to/i.test(b.text))), "the cut phrase is not a beat");
  assert.equal(cutSegments(["a", "b"]).length, 1, "no cuts: one segment, Pace decides");
});

test("an exact shot count from the first screen outranks Pace; written cuts outrank both", () => {
  const p = blankProject();
  p.render.duration = 20;
  p.creative.dials = { ...DEFAULT_DIALS, pace: 20 };
  p.creative.shotCount = 3;
  p.creative.pool = { beats: ["a", "b", "c", "d", "e", "f"] };
  applySteering(p);
  assert.equal(p.shots.length, 3);
  p.creative.pool = { beats: ["a", "Cut to close-up, b", "c", "Cut to wide, d", "Cut to medium, e"] };
  applySteering(p);
  assert.equal(p.shots.length, 4, "four written cuts beat a count of three");
});

/* ── A cut phrase never reaches the prompt as an action ─────── */
import { stripCutPrefix } from "../web/js/shotlist.js";
import { compilePrompt, validate } from "../web/js/prompt.js";
import { newBeat } from "../web/js/state.js";

test("a beat that opens with a cut is compiled without the cut, and the checker says so", () => {
  assert.equal(stripCutPrefix("Cut to medium shot, the camera glides toward the tower"), "the camera glides toward the tower");
  assert.equal(stripCutPrefix("looks up"), "looks up");
  const p = blankProject();
  p.render.duration = 10; p.render.engine = "ltx25";
  p.shots[0].subject = "a castle"; p.shots[0].beats = [newBeat("high aerial view of the whole complex")];
  const s2 = { ...p.shots[0], id: "s2", at: 5, beats: [newBeat("Cut to close-up, detail of the stone textures")] };
  p.shots.push(s2);
  const { text } = compilePrompt(p);
  assert.ok(!/Cut to close-up/i.test(text), text);
  assert.match(text, /Detail of the stone textures/);
  assert.equal((text.match(/hard cut transitions/g) || []).length, 1, "one cut, from the timeline, not two");
  assert.ok(validate(p).checks.some(c => /begins with a cut/.test(c.msg)));
});
