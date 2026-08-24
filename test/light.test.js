/* THE LIGHT DIAL — one axis, and a frame that shows it.
 *
 * This dial was two dials wearing one coat, and the bug class it produced is
 * the reason these tests exist rather than a comment:
 *
 *   · the named source and the grade came off separate ladders with separate
 *     band edges (15/32/50/68/85 against 20/40/60/80), so a one-point drag
 *     could move either, both or neither at nine places nobody could see;
 *   · neither ladder was ordered by contrast, the thing the slider's two ends
 *     have always claimed it controls;
 *   · the key light crossed from the left of the face to the right partway up,
 *     so asking for more contrast moved the lamp;
 *   · and the top of the dial handed the model "harsh midday sun" together
 *     with "most of the frame in shadow" — two different frames, in the same
 *     breath, neither one of them what was asked for.
 *
 * Every one of those is a property you can assert, so they are asserted. The
 * second half checks the other end of the same fix: previz reading a lighting
 * line back into something it can draw, because a dial whose effect you cannot
 * see is indistinguishable from a dial that does nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { LIGHT_BANDS, lightToLighting, lightToGrade, lightSays, DEFAULT_DIALS } from "../web/js/steer.js";
import { lightingLook, lightingLayers, lightSentence } from "../web/js/previz.js";
import { LIGHTING, GRADES } from "../web/js/vocab.js";

const DIAL = Array.from({ length: 101 }, (_, v) => v);
const look = (v) => lightingLook(lightToLighting(v), lightToGrade(v));

/* ── One axis ─────────────────────────────────────────────── */

test("the source and the grade change at the same points", () => {
  const edges = (pick) => DIAL.filter(v => v > 0 && pick(v) !== pick(v - 1));
  assert.deepEqual(
    edges(lightToLighting), edges(lightToGrade),
    "the two halves of the dial step at different values — one moves without the other",
  );
});

test("the dial has as many stops as it has bands", () => {
  assert.equal(new Set(DIAL.map(lightToLighting)).size, LIGHT_BANDS.length);
  assert.equal(new Set(DIAL.map(lightToGrade)).size, LIGHT_BANDS.length);
});

test("contrast only ever goes up", () => {
  let lastHard = -Infinity, lastFill = Infinity;
  for (const v of DIAL) {
    const l = look(v);
    assert.ok(l.hard >= lastHard, `light ${v} (${lightToLighting(v)}) is softer than the band below it`);
    assert.ok(l.fill <= lastFill, `light ${v} (${lightToGrade(v)}) opens the shadows the band below it closed`);
    lastHard = l.hard;
    lastFill = l.fill;
  }
});

test("the key never crosses the frame on the way up", () => {
  // Asking for harder light is not asking for the lamp to move. Where the
  // light comes FROM is the shot's own Lighting field.
  const sides = new Set(DIAL.map(v => Math.sign(look(v).key[0] - 50)).filter(s => s !== 0));
  assert.ok(sides.size <= 1, "the key light is on the left at one end of the dial and the right at the other");
});

test("no band asks for a bright frame and a dark one at once", () => {
  for (const band of LIGHT_BANDS) {
    // Crushed blacks describe the toe of the curve, not how much of the frame
    // is lit: bleach bypass under a harsh sun is a real look, not a
    // contradiction. "Most of the frame in shadow" is the claim that fights.
    const shadowed = /most of the frame in shadow|low-key/i.test(band.grade);
    const everywhere = /midday|overcast|daylight|sun\b/i.test(band.lighting);
    assert.ok(
      !(shadowed && everywhere),
      `"${band.lighting}" lights the whole frame and "${band.grade}" leaves most of it black`,
    );
  }
});

/* ── …written in words the rest of the app already knows ─── */

test("every source and grade the dial writes is in the vocabulary", () => {
  const grades = GRADES.map(([value]) => value);
  for (const band of LIGHT_BANDS) {
    assert.ok(LIGHTING.includes(band.lighting), `"${band.lighting}" is not in LIGHTING`);
    assert.ok(grades.includes(band.grade), `"${band.grade}" is not in GRADES`);
  }
});

test("the readout names the grade as well as the source", () => {
  // The grade used to be rewritten in silence: the dial said "single practical
  // lamp in frame" and changed the colour treatment without mentioning it.
  const said = lightSays(DEFAULT_DIALS.light);
  assert.match(said, new RegExp(lightToLighting(DEFAULT_DIALS.light)));
  assert.ok(said.length > lightToLighting(DEFAULT_DIALS.light).length, "the readout is still only the source");
});

/* ── Previz reads it back ─────────────────────────────────── */

test("previz reads the direction out of the words", () => {
  assert.ok(lightingLook("soft key light from the left").key[0] < 50);
  assert.ok(lightingLook("hard key light from the right").key[0] > 50);
  assert.ok(lightingLook("harsh midday sun").key[1] < 20, "an overhead source should be at the top of the frame");
  assert.ok(lightingLook("firelight flicker").key[1] > 60, "firelight comes from below");
  // Behind beats sideways: it is the fact that changes the picture.
  assert.deepEqual(lightingLook("backlit with a bright rim from the left").key, lightingLook("backlit with a bright rim").key);
});

test("previz reads the hardness out of the words", () => {
  assert.ok(lightingLook("soft key light from the left").hard < lightingLook("hard key light from the left").hard);
  assert.ok(lightingLook("overcast diffused daylight").hard < lightingLook("harsh midday sun").hard);
});

test("a shot that says nothing about light is drawn as the plate", () => {
  const nothing = lightingLook("", "", "");
  assert.equal(nothing.hasKey, false);
  assert.equal(nothing.lit, false);
  assert.equal(nothing.filter, "");
  const layers = lightingLayers(nothing);
  assert.equal(layers.key, "", "an unlit shot should not have a key drawn on it");
  assert.equal(layers.shadow, "", "an unlit shot should not be shadowed");
});

test("a monochrome look drains the colour whatever the grade says", () => {
  assert.match(lightingLook("soft key light from the left", "", "black-and-white").filter, /saturate\(0\.00\)/);
});

test("every band the dial writes draws something", () => {
  for (const v of [0, 25, 45, 70, 100]) {
    const layers = lightingLayers(look(v));
    assert.ok(layers.key, `light ${v} draws no key`);
    assert.match(layers.key, /^radial-gradient/);
  }
});

test("the sentence on the frame carries both halves", () => {
  const said = lightSentence("soft key light from the left", "neutral Rec.709 grade with true blacks");
  assert.match(said, /soft key light from the left/);
  assert.match(said, /Rec\.709 neutral/, "the grade should be named by its short name, not its sentence");
  assert.equal(lightSentence("", ""), "", "nothing said, nothing written on the frame");
});
