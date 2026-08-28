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

test("an exact shot count from the first screen outranks Pace AND the written cuts", () => {
  const p = blankProject();
  p.render.duration = 20;
  p.creative.dials = { ...DEFAULT_DIALS, pace: 20 };
  p.creative.shotCount = 3;
  p.creative.pool = { beats: ["a", "b", "c", "d", "e", "f"] };
  applySteering(p);
  assert.equal(p.shots.length, 3);
  p.creative.pool = { beats: ["a", "Cut to close-up, b", "c", "Cut to wide, d", "Cut to medium, e"] };
  applySteering(p);
  assert.equal(p.shots.length, 3, "four written shots, a count of three: the last cut folds into shot 3");
  assert.deepEqual(p.shots[2].beats.map(b => b.text), ["d", "e"]);
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

/* ── What a model hands back for a camera ──────────────────── */

import { cleanCamera } from "../web/js/state.js";

test("a shot SIZE in the framing slot is dropped, a real framing kept", () => {
  // The breakdown prompt used to ask each shot for its "framing", and the
  // model answered with a size: camera.framing = "wide" on a close-up became
  // "The frame is composed with the subject framed in the wide".
  assert.equal(cleanCamera({ framing: "wide" }).framing, "centered");
  assert.equal(cleanCamera({ framing: "medium close-up" }).framing, "centered");
  assert.equal(cleanCamera({ framing: "left third" }).framing, "left third");
  assert.equal(cleanCamera({ framing: "custom", fx: 20, fy: 70 }).fx, 20);
  assert.equal(cleanCamera({ type: "push in" }).type, "push in");
});

test("a shot heading written inside a beat is flagged; an action that starts with a size word is not", () => {
  const p = blankProject();
  p.shots[0].shotType = "medium wide";
  p.shots[0].beats = [newBeat("Wide low-angle shot of the lighthouse tower as rain hammers down"), newBeat("a blade of gold light sweeps out")];
  const flagged = validate(p).checks.filter(w => /shot heading/.test(w.msg));
  assert.equal(flagged.length, 1, "the heading inside shot 1 should be flagged once");
  assert.match(flagged[0].msg, /Shot 1/);

  p.shots[0].beats = [newBeat("Long shadows fall across the floor"), newBeat("close-up detail on her hands")];
  assert.equal(validate(p).checks.filter(w => /shot heading/.test(w.msg)).length, 0);
});

test("a heading with the 'Cut to' left off is still a cut — except on a shot's first beat, where it names the shot", () => {
  // Gemma wrote "Wide shot, …", "Medium shot, …", "Close-up, …" for a
  // lighthouse and the reader put all three inside shot 1 as actions.
  assert.equal(cutInBeat("Medium shot, the keeper struggles up the winding stone stairs").verb, "the camera cuts to");
  assert.equal(readFraming(cutInBeat("Close-up, her hand reaches out to turn a massive brass crank").remainder).shotType, "close-up");
  assert.equal(readFraming(cutInBeat("Close-up, her hand reaches out to turn a massive brass crank").remainder).rest, "her hand reaches out to turn a massive brass crank");
  assert.equal(cutInBeat("Wide low-angle shot of the tower as rain hammers down"), null, "a description, not a heading — no delimiter");
  assert.equal(cutInBeat("Medium heat rises off the tarmac"), null);
  const raw = [{ at: 0, shotType: "medium", subject: "a keeper", beats: [
    "Wide shot, the lighthouse stands against crashing waves",
    "Medium shot, the keeper climbs the winding stone stairs",
    "Close-up, her hand reaches out to turn a brass crank",
    "Cut to close-up, she looks up at the flame",
  ] }];
  const shots = splitCutBeats(raw, 20);
  assert.equal(shots.length, 4);
  assert.deepEqual(shots.map(s => s.shotType), ["wide", "medium", "close-up", "close-up"]);
  assert.deepEqual(shots.map(s => s.beats[0]), ["the lighthouse stands against crashing waves", "the keeper climbs the winding stone stairs", "her hand reaches out to turn a brass crank", "she looks up at the flame"]);
  assert.deepEqual(shots.map(s => s.at), [0, 5, 10, 15]);
});

test("a shot count the creator typed caps the model's written cuts, and trims a longer list", async () => {
  const { applySteering } = await import("../web/js/steer.js");
  const p = blankProject();
  p.render.engine = "ltx25"; p.render.duration = 20;
  p.creative.shotCount = 4;
  p.creative.pool = { beats: [
    "Wide shot, the lighthouse stands against the waves",
    "Cut to medium shot, the keeper climbs the stairs",
    "Cut to close-up, her hand on the brass crank",
    "Cut to close-up, she looks up at the flame",
    "Cut to wide shot, the lamp bursts into light",
    "Cut to close-up, she closes her eyes",
  ] };
  p.shots[0].subject = "a keeper";
  applySteering(p);
  assert.equal(p.shots.length, 4, "six written cuts, four asked for");
  assert.equal(p.shots[3].beats.length, 3, "the two extra cuts' beats live on in the last shot");
  assert.equal(p.shots[3].beats[1].text, "the lamp bursts into light", "headings dropped, actions kept");
  p.creative.shotCount = 2;
  applySteering(p);
  assert.equal(p.shots.length, 2, "a typed count also trims shots that already exist");
});

test("on auto, one LTX-2.5 render caps written cuts by duration: 20 s → 4, 10 s → 2", async () => {
  const { applySteering } = await import("../web/js/steer.js");
  const six = ["Wide shot, the tower", "Cut to medium shot, the stairs", "Cut to close-up, the crank", "Cut to close-up, the flame", "Cut to wide shot, the lamp", "Cut to close-up, her eyes"];
  const p = blankProject();
  p.render.engine = "ltx25"; p.render.duration = 20; p.creative.shotCount = 0;
  p.creative.pool = { beats: six }; p.shots[0].subject = "a keeper";
  applySteering(p);
  assert.equal(p.shots.length, 4);
  assert.equal(p.shots.flatMap(s => s.beats).filter(b => b.text).length, 6, "every beat survives");
  p.render.duration = 10;
  applySteering(p);
  assert.equal(p.shots.length, 2, "and a shorter clip folds the existing four down");
  p.render.engine = "minimax"; p.render.duration = 20;
  p.creative.pool = { beats: six };
  applySteering(p);
  assert.equal(p.shots.length, 6, "H3 keeps its six");
});
