/* WHAT A NEW PROJECT MUST NOT INHERIT.
 *
 * Reported as "unrelated previous assets (prompts/images) get reused with
 * fresh starts", and it was not one bug. The project object, the render
 * preferences, every page module's `let`, the finished-render slot and the
 * name a file is uploaded under each carried something of their own, and each
 * one is a separate way for the last clip to turn up inside the next one.
 *
 * The ones that can be tested without a DOM are here; the rest are in the
 * browser suite, which drives the real pages.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blankProject, newShot, newBeat, clearShotWriting, forgetUploads, overLength, isPristine,
} from "../web/js/state.js";
import { uploadName } from "../web/js/render.js";

/* ── The render preferences ──────────────────────────────── */

test("a length is a property of the clip and is not carried into the next project", async () => {
  // The chain that made this the worst of them: pick 30s once, and every new
  // project starts at 30s — past H3's ceiling — without anybody choosing it.
  const { CARRIED_KEYS } = await import("../web/js/renderprefs.js")
    .then(m => ({ CARRIED_KEYS: m.carriedKeys ? m.carriedKeys() : null }))
    .catch(() => ({ CARRIED_KEYS: null }));
  const src = await import("node:fs").then(fs =>
    fs.readFileSync(new URL("../web/js/renderprefs.js", import.meta.url), "utf-8"));
  const list = src.match(/const CARRIED = \[([\s\S]*?)\];/)[1];
  assert.ok(!/"duration"/.test(list), "duration must not be carried between projects");
  assert.ok(!/"outputPrefix"/.test(list), "nor must the output folder");
  assert.ok(!/"seed"/.test(list), "the seed never was, and still must not be");
  // The genuinely machine-shaped ones stay.
  for (const k of ["resolution", "precision", "tiledDecode"]) {
    assert.ok(new RegExp(`"${k}"`).test(list), `${k} describes the box and should be carried`);
  }
  void CARRIED_KEYS;
});

test("a blank project is inside what H3 renders", () => {
  const p = blankProject();
  assert.ok(!overLength(p.render.duration), `a new project starts at ${p.render.duration}s`);
});

/* ── The checker must not hide a setting that is already wrong ── */

test("an untouched project at an impossible length is not 'pristine'", () => {
  const clean = blankProject();
  assert.equal(isPristine(clean), true, "a genuinely empty project is still pristine");
  clean.render.duration = 30;
  assert.equal(isPristine(clean), false,
    "30s is a render that will repeat — reporting 'nothing written yet' hides it until the first word is typed");
});

/* ── Clearing a shot's writing ───────────────────────────── */

test("clearing a shot's writing keeps the shot and drops the words", () => {
  const shot = Object.assign(newShot(4), {
    subject: "a Spartan warrior", beats: [newBeat("raises the axe", "")],
    setting: "a mountain pass", lighting: "hard sun", details: "fur-lined armour",
    sfx: "wind over stone", continuity: "helmet off",
    dialogue: [{ id: "d1", speaker: "S1", text: "hold" }],
    shotType: "wide", viewpoint: "side",
  });
  shot.camera.custom = "a hand-written camera line";
  clearShotWriting(shot);
  for (const f of ["subject", "setting", "lighting", "details", "sfx", "continuity"]) {
    assert.equal(shot[f], "", `${f} survived`);
  }
  assert.deepEqual(shot.dialogue, []);
  assert.equal(shot.beats.length, 1);
  assert.equal(shot.beats[0].text, "");
  assert.equal(shot.camera.custom, "");
  // Craft, not writing: these belong to the shot and survive a rewrite.
  assert.equal(shot.at, 4);
  assert.equal(shot.shotType, "wide");
  assert.equal(shot.viewpoint, "side");
});

/* ── Media identity ──────────────────────────────────────── */

test("two projects with the same filename do not collide in ComfyUI's input folder", () => {
  // One flat namespace, uploaded with overwrite=true, addressed by bare
  // filename. Under the user's own name, project B's hero.png replaces
  // project A's and project A then renders with B's picture.
  const a = { id: "aaaaaaaa", name: "hero.png" };
  const b = { id: "bbbbbbbb", name: "hero.png" };
  assert.notEqual(uploadName(a), uploadName(b));
  assert.ok(uploadName(a).includes("aaaaaaaa"));
  assert.ok(uploadName(a).endsWith("hero.png"), "and it is still recognisable in the folder");
});

test("an upload name survives a hostile filename", () => {
  const n = uploadName({ id: "12345678", name: "../../etc/pass wd?.png" });
  assert.ok(!n.includes("/"), n);
  assert.ok(!n.includes(".."), n);
  assert.ok(!/\s/.test(n), n);
});

test("a project that travels forgets where its media was uploaded", () => {
  const p = blankProject();
  p.frames.first = { id: "f1", name: "a.png", comfyName: "a.png" };
  p.refs.images = [{ id: "i1", name: "b.png", comfyName: "b.png" }];
  p.refs.videos = [{ id: "v1", name: "c.mp4", comfyName: "c.mp4" }];
  p.refs.audios = [{ id: "a1", name: "d.wav", comfyName: "d.wav" }];
  forgetUploads(p);
  assert.equal(p.frames.first.comfyName, "");
  for (const kind of ["images", "videos", "audios"]) {
    assert.equal(p.refs[kind][0].comfyName, "", `${kind} kept its comfyName`);
  }
  // The user's own labels are untouched — only the ComfyUI-side cache goes.
  assert.equal(p.refs.images[0].name, "b.png");
});
