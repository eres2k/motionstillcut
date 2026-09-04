/* Which pictures a shot is of, and what the framing sentence does with a
 * "none" that arrived in a camera field. Both came out of the same render: an
 * apartment reel whose compiled prompt named every room in every shot and
 * said "Shot on a none lens, at none." */
import { test } from "node:test";
import assert from "node:assert/strict";
import { blankProject, newShot, newBeat, shotCitations } from "../web/js/state.js";
import { framingSentence } from "../web/js/prompt.js";

function reel() {
  const p = blankProject();
  p.mode = "r2v";
  p.refs.images = ["facade", "bathroom", "bedroom"].map((name, i) => ({ id: `img${i}`, name: `${name}.jpg`, label: name, kind: "image", comfyName: `${name}.jpg` }));
  p.refs.videos = [{ id: "vid0", name: "walk.mp4", kind: "video", comfyName: "walk.mp4", useAudio: true }];
  p.shots = [
    Object.assign(newShot(0), { subject: "<Subject 1>, the building from the street" }),
    Object.assign(newShot(3), { subject: "the bright bathroom", beats: [newBeat("the camera drifts past <Subject 2>", "")] }),
    Object.assign(newShot(6), { subject: "the bedroom", setting: "<Subject 3> in afternoon light", details: "motion as in <Video 1>" }),
    Object.assign(newShot(9), { subject: "a corridor nobody photographed" }),
  ];
  return p;
}

test("a shot cites the references whose tags it names, in any prose field", () => {
  const p = reel();
  const tags = (i) => shotCitations(p, p.shots[i]).map(e => e.tag);
  assert.deepEqual(tags(0), ["<Subject 1>"]);
  assert.deepEqual(tags(1), ["<Subject 2>"]);          // found in a beat
  assert.deepEqual(tags(2), ["<Subject 3>", "<Video 1>"]); // setting + details
  assert.deepEqual(tags(3), []);                        // cites nothing — visibly blank
});

test("a citation carries the reference itself, so a thumbnail can be loaded from it", () => {
  const p = reel();
  const [cite] = shotCitations(p, p.shots[0]);
  assert.equal(cite.ref.id, "img0");
  assert.equal(cite.kind, "picture");
});

test("\"none\" in a camera field is unstated, not a lens called none", () => {
  assert.equal(framingSentence({ lens: "none", height: "none" }), "");
  assert.equal(framingSentence({ lens: "none", height: "eye-level" }), "The camera sits at eye-level.");
  assert.equal(framingSentence({ lens: "85mm", height: "none", depth: "none" }), "Shot on a 85mm lens.");
  assert.equal(framingSentence({ lens: "85mm", height: "eye-level" }), "Shot on a 85mm lens, at eye-level.");
});
