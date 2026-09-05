/* Scene presets: one shot per picture, each citing its own, on the engine's
 * length grid, with guidance every writer reads while the preset is on. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { blankProject, shotCitations, DURATION_FRAMES, activeEngine, normaliseMedia } from "../web/js/state.js";
import { SCENE_PRESETS, MOOD_PRESETS, QUALITY_PRESETS, applyPreset, applyMood, applyQuality, presetContext, presetDuration, presetGuidance } from "../web/js/presets.js";
import { compilePrompt, validate } from "../web/js/prompt.js";
import { buildWorkflow } from "../web/js/workflow.js";
import { DEFAULT_MODELS } from "../web/js/backend/settings.js";

function flat(n) {
  const p = blankProject();
  p.mode = "r2v";
  p.refs.images = Array.from({ length: n }, (_, i) => ({ id: `room${i}`, name: `room${i}.jpg`, label: `room ${i + 1}`, kind: "image", comfyName: `room${i}.jpg` }));
  return p;
}

test("every scene preset keeps a single picture in I2V with the selected LTX build", () => {
  for (const preset of SCENE_PRESETS) {
    const p = flat(1);
    normaliseMedia(p);
    const first = p.frames.first;
    p.render.engine = "ltx25";
    p.render.variant = "ltx_single";
    assert.deepEqual(presetContext(p), { tags: ["<Picture 1>"], picCount: 1, mode: "i2v" });

    applyPreset(p, preset.key);

    assert.equal(p.mode, "i2v", preset.key);
    assert.equal(activeEngine(p), "ltx25", preset.key);
    assert.equal(p.render.variant, "ltx_single", preset.key);
    assert.equal(p.frames.first, first, "the selected picture stays the first frame");
    assert.deepEqual(p.refs.images, []);
    assert.ok(p.shots.every(s => s.subject === "<Picture 1>"), preset.key);
    const report = validate(p);
    assert.equal(report.errors, 0, `${preset.key}: ${report.checks.filter(c => c.level === "err").map(c => c.msg).join("; ")}`);
    const { prompt, meta, compiled } = buildWorkflow(p, { models: { ...DEFAULT_MODELS } });
    assert.equal(meta.engine, "ltx25", preset.key);
    assert.equal(compiled.dialect, "ltx25", preset.key);
    assert.ok(Object.values(prompt).some(n => n.class_type === "LoadImage" && n.inputs.image === first.comfyName));
    assert.ok(Object.values(prompt).some(n => n.class_type === "LTXVAddGuide" && n.inputs.frame_idx === 0));
  }
});

test("applying or clearing a scene repairs a single picture left in Ref2V", () => {
  for (const key of ["apartment", ""]) {
    const p = flat(1);
    p.render.engine = "ltx25";
    p.render.variant = "ref_full";
    p.creative.preset = "apartment";
    p.shots[0].subject = "<Subject 1>";
    applyPreset(p, key);
    assert.equal(p.mode, "i2v");
    assert.equal(activeEngine(p), "ltx25");
    assert.equal(p.render.variant, "ltx_two");
    assert.equal(p.frames.first.id, "room0");
    assert.equal(p.shots[0].subject, "<Picture 1>");
  }
});

test("scene previews count all attached pictures and derive their citation labels without changing the project", () => {
  const p = flat(1);
  normaliseMedia(p);
  p.refs.images.push({ id: "room1", name: "room1.jpg", kind: "image" });
  const before = structuredClone(p);
  assert.deepEqual(presetContext(p), { tags: ["<Subject 1>", "<Subject 2>"], picCount: 2, mode: "r2v" });
  assert.deepEqual(p, before);
});

test("a scene with a picture and audio still uses Ref2V", () => {
  const p = flat(1);
  normaliseMedia(p);
  p.render.engine = "ltx25";
  p.refs.audios.push({ id: "sound", kind: "audio", name: "sound.wav" });
  applyPreset(p, "apartment");
  assert.equal(p.mode, "r2v");
  assert.equal(activeEngine(p), "minimax");
  assert.equal(p.frames.first, null);
  assert.equal(p.refs.images.length, 1);
  assert.equal(p.refs.audios.length, 1);
  assert.equal(p.shots[0].subject, "<Subject 1>");
});

test("apartment showcase: six pictures become six shots, each citing its own room, in order", () => {
  const p = flat(6);
  const preset = applyPreset(p, "apartment");
  assert.equal(preset.key, "apartment");
  assert.equal(p.shots.length, 6);
  p.shots.forEach((s, i) => {
    const cites = shotCitations(p, s).map(e => e.tag);
    assert.deepEqual(cites, [`<Subject ${i + 1}>`], `shot ${i + 1} cites only its own room`);
  });
  const ats = p.shots.map(s => s.at);
  assert.deepEqual([...ats].sort((a, b) => a - b), ats, "in order");
  assert.ok(ats.every((a, i) => i === 0 || a > ats[i - 1]), "strictly increasing");
  assert.ok(DURATION_FRAMES[p.render.duration], `length ${p.render.duration}s is on the grid`);
  assert.ok(p.render.duration >= 6 * 2.5, "long enough for six rooms at 2.5 s");
  assert.ok(ats.every(a => a < p.render.duration));
  assert.equal(p.creative.shotCount, 6);
  assert.equal(p.creative.preset, "apartment");
  assert.equal(p.mode, "r2v");
});

test("the guidance rides on the project while the preset is set, and goes when it is cleared", () => {
  const p = flat(3);
  applyPreset(p, "apartment");
  assert.match(presetGuidance(p), /^Scene preset — Apartment showcase: /);
  assert.match(presetGuidance(p), /exactly ONE room/);
  applyPreset(p, "");
  assert.equal(presetGuidance(p), "");
  assert.equal(p.shots.length, 3, "clearing keeps the shots");
});

test("every preset builds a valid, compilable project from three pictures", () => {
  for (const preset of SCENE_PRESETS) {
    const p = flat(3);
    applyPreset(p, preset.key);
    assert.ok(p.shots.length >= 1, preset.key);
    const compiled = compilePrompt(p);
    assert.ok(compiled.text.length > 100, `${preset.key} compiles`);
    const report = validate(p);
    assert.equal(report.errors, 0, `${preset.key}: ${report.checks.filter(c => c.level === "err").map(c => c.msg).join("; ")}`);
    assert.ok(p.shots.every(s => shotCitations(p, s).length >= 1), `${preset.key}: every shot cites a picture`);
  }
});

test("no pictures yet: a per-picture preset still gives one shot to start from", () => {
  const p = flat(0);
  applyPreset(p, "product");
  assert.equal(p.shots.length, 1);
  assert.equal(presetContext(p).picCount, 0);
  assert.equal(p.mode, "t2v");
  assert.equal(validate(p).errors, 0);
});

test("lengths snap up to the grid", () => {
  assert.equal(presetDuration(6, 2.5), 15);
  assert.equal(presetDuration(9, 2.5), 25);
  assert.equal(presetDuration(1, 2.5), 5);
  assert.equal(presetDuration(3, 3.5, 10), 15);
  assert.equal(presetDuration(40, 3), 30, "capped at the longest the grid offers");
});

test("mood sets the grade the prompt names and adds its line; quality adds its own; both clear", () => {
  const p = flat(2);
  applyPreset(p, "vehicle");
  applyMood(p, "noir");
  applyQuality(p, "film35");
  assert.match(p.style.grade, /bleach-bypass/);
  const g = presetGuidance(p).split("\n");
  assert.equal(g.length, 3);
  assert.match(g[0], /^Scene preset — Vehicle showcase/);
  assert.match(g[1], /^Mood — Noir/);
  assert.match(g[2], /^Image quality — 35 mm film/);
  assert.match(compilePrompt(p).text, /bleach-bypass/, "the grade reaches the compiled prompt");
  applyMood(p, ""); applyQuality(p, "");
  assert.equal(presetGuidance(p).split("\n").length, 1);
  assert.equal(p.creative.mood, "");
});

test("every mood and quality preset has a key, a name and guidance; moods name a real grade or none", () => {
  for (const m of MOOD_PRESETS) { assert.ok(m.key && m.name && m.guidance.length > 40, m.key); assert.equal(typeof m.grade, "string"); }
  for (const q of QUALITY_PRESETS) assert.ok(q.key && q.name && q.guidance.length > 40, q.key);
  assert.ok(SCENE_PRESETS.length >= 9);
});
