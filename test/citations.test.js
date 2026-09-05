/* Which pictures a shot is of, and what the framing sentence does with a
 * "none" that arrived in a camera field. Both came out of the same render: an
 * apartment reel whose compiled prompt named every room in every shot and
 * said "Shot on a none lens, at none." */
import { test } from "node:test";
import assert from "node:assert/strict";
import { blankProject, newShot, newBeat, newDialogue, shotCitations } from "../web/js/state.js";
import { framingSentence, scopeCitationsToDraft, validate, compileSubjectDefs, firstSentence } from "../web/js/prompt.js";

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

/* ── The rewriter that cited every room in every shot ─────────
 * A local model handed a clean one-subject-per-shot draft came back with all
 * six <Subject> tags re-described inside each shot, against two explicit
 * rules. The scrubber scopes the answer back to the draft's own citations. */
const TAGS = ["<Subject 1>", "<Subject 2>", "<Subject 3>"];
const DRAFT =
  "The target video is in a live-action cinematic style. "
  + "[Shot 1] A wide shot: <Subject 1>, the rooftop pool. The camera pushes in. "
  + "[Shot 2] At 00:05.000, the camera cuts to a medium shot of <Subject 2>, the living room. "
  + "[Shot 3] At 00:10.000, the camera cuts to a wide shot of <Subject 3>, the bedroom.";

test("a tag the draft gives to another shot is scrubbed, appositive and all", () => {
  const answer =
    "[Shot 1] A wide shot, front-facing of <Subject 1>, a rooftop pool deck with loungers and planters, "
    + "<Subject 2>, a bright living room with green chairs, <Subject 3>, a calm bedroom. The camera pushes in with small amplitude. "
    + "[Shot 2] At 00:05.000, the camera cuts to a medium shot of <Subject 1>, a rooftop pool deck, "
    + "<Subject 2>, a bright living room, <Subject 3>, a calm bedroom. <Subject 2> fills the frame. "
    + "[Shot 3] At 00:10.000, the camera cuts to a wide shot of <Subject 3>, a calm bedroom.";
  const out = scopeCitationsToDraft(answer, DRAFT, TAGS);
  const section = (n) => out.split(/\[Shot \d+\]/)[n];
  assert.match(section(1), /<Subject 1>, a rooftop pool deck with loungers and planters\./);
  assert.doesNotMatch(section(1), /<Subject 2>|<Subject 3>/);
  assert.match(section(2), /<Subject 2>, a bright living room\. <Subject 2> fills the frame\./);
  assert.doesNotMatch(section(2), /<Subject 1>|<Subject 3>/);
  assert.match(section(3), /<Subject 3>, a calm bedroom\./);
  // No seams left behind: ", .", " ,", "of ." or doubled spaces.
  assert.doesNotMatch(out, /,\s*[.,]| ,|\bof\s*\.|\s{2}/);
});

test("a preposition whose object was scrubbed does not survive it", () => {
  const answer = "[Shot 1] A wide shot of <Subject 1>, the pool. [Shot 2] At 00:05.000, the camera cuts to a medium shot of <Subject 1>, the pool again. <Subject 2>, the living room, glows.";
  const out = scopeCitationsToDraft(answer, DRAFT, TAGS);
  assert.match(out, /\[Shot 2\] At 00:05\.000, the camera cuts to a medium shot\./);
  assert.match(out, /<Subject 2>, the living room, glows\./);
});

test("a tag the draft places in two shots stays in both, and only there", () => {
  const draft = "[Shot 1] <Subject 1>, the pool. [Shot 2] Elsewhere. [Shot 3] Back at <Subject 1>, the pool.";
  const answer = "[Shot 1] Opening on <Subject 1>, the pool. [Shot 2] A hallway, past <Subject 1>, the pool. [Shot 3] Closing on <Subject 1>, the pool.";
  const out = scopeCitationsToDraft(answer, draft, TAGS);
  assert.equal((out.match(/<Subject 1>/g) || []).length, 2);
  assert.doesNotMatch(out.split(/\[Shot \d+\]/)[2], /<Subject 1>/);
});

test("the scrubber knows when it knows nothing", () => {
  // A tag the draft never places is left alone everywhere.
  const answer = "[Shot 1] A room. <Video 1> guides the motion. [Shot 2] Another room, still following <Video 1>.";
  assert.equal(scopeCitationsToDraft(answer, DRAFT, ["<Video 1>"]), answer);
  // Prose without [Shot N] markers (LTX) is not sectioned and not touched.
  const ltx = "A wide shot of <Subject 1>. A hard cut transitions to <Subject 2>.";
  assert.equal(scopeCitationsToDraft(ltx, "no markers in the draft either", TAGS), ltx);
  // A single-shot draft has nothing to scope between.
  assert.equal(scopeCitationsToDraft("[Shot 1] <Subject 2>, misplaced.", "[Shot 1] <Subject 1>, the pool.", TAGS), "[Shot 1] <Subject 2>, misplaced.");
});

test("German words under an [English] tag draw a warning", () => {
  const p = reel();
  p.shots[0].dialogue = [Object.assign(newDialogue("S1"), {
    text: "Tom Krauss Immobilien präsentiert die Dachterrasse über den Dächern der Stadt.",
    voiceover: true,
  })];
  const warns = validate(p).checks.filter(c => /looks German/.test(c.msg));
  assert.equal(warns.length, 1);
  // Tagged correctly, the same words warn about nothing.
  p.shots[0].dialogue[0].language = "German";
  assert.equal(validate(p).checks.filter(c => /looks German/.test(c.msg)).length, 0);
});

test("a captioned picture defines its subject; an uncaptioned one stays a filename", () => {
  const p = reel();
  p.refs.images[0].caption = "A bright open-plan kitchen with a white island. Green chairs line the table.";
  const defs = compileSubjectDefs(p).split("\n");
  // First sentence only, and no doubled full stop at the seam.
  assert.equal(defs[0], "<Subject 1> is the subject shown in <Picture 1>, facade: A bright open-plan kitchen with a white island.");
  assert.equal(defs[1], "<Subject 2> is the subject shown in <Picture 2>, bathroom.");
});

test("firstSentence takes one sentence, or everything when there is no stop", () => {
  assert.equal(firstSentence("A room. It is bright."), "A room.");
  assert.equal(firstSentence("a fragment with no stop"), "a fragment with no stop");
  assert.equal(firstSentence("  "), "");
  // "3.5" is not a sentence boundary.
  assert.equal(firstSentence("A 3.5 m ceiling throughout. Oak floors."), "A 3.5 m ceiling throughout.");
});

test("\"none\" in a camera field is unstated, not a lens called none", () => {
  assert.equal(framingSentence({ lens: "none", height: "none" }), "");
  assert.equal(framingSentence({ lens: "none", height: "eye-level" }), "The camera sits at eye-level.");
  assert.equal(framingSentence({ lens: "85mm", height: "none", depth: "none" }), "Shot on a 85mm lens.");
  assert.equal(framingSentence({ lens: "85mm", height: "eye-level" }), "Shot on a 85mm lens, at eye-level.");
});
