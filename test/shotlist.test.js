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
