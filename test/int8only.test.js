/* INT8 IS THE ONLY MINIMAX DiT BUILD.
 *
 * The H3 DiT used to come in two precisions: the INT8-convrot pack and an
 * experimental NVFP4 conversion. The NVFP4 files have been deleted from the
 * box, so the choice is gone — and everything saved while it existed (a
 * project, a job's settings, the remembered render prefs) must still render,
 * on INT8, instead of asking ComfyUI for a file that is not there.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { blankProject, replaceProject, getProject } from "../web/js/state.js";
import { renderPrefs, rememberRender } from "../web/js/renderprefs.js";
import { buildWorkflow } from "../web/js/workflow.js";
import { SWEEP_VARIABLES } from "../web/js/experiments.js";
import { DEFAULT_MODELS } from "../web/js/backend/settings.js";
import { DEFAULT_MODELS as SERVER_MODELS } from "../server/settings.js";

// The render prefs live in localStorage; Node has none, so give it a map —
// and a document, for the "saved" badge replaceProject's autosave touches.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
globalThis.document ??= { getElementById: () => null };
const PREFS = "mscut.render.prefs";

function oldProject(mode) {
  const p = blankProject();
  p.mode = mode;
  p.render.engine = "minimax";
  p.render.variant = mode === "r2v" ? "full" : "turbo";
  p.render.precision = "nvfp4";
  if (mode === "r2v") p.refs.images = [{ id: "r0", name: "r0.jpg", kind: "image", comfyName: "r0.jpg" }];
  return p;
}

const unetOf = (prompt) => Object.values(prompt).find(n => n.class_type === "UNETLoader")?.inputs?.unet_name;

test("a project saved with NVFP4 renders on the INT8 DiT, even with the old model keys still in settings", () => {
  // A settings file written before the change still carries the old names.
  const models = {
    ...DEFAULT_MODELS,
    dit_fl2va_nvfp4: "MiniMax_H3_FL2VA_pruned_nvfp4.safetensors",
    dit_ref2va_nvfp4: "MiniMax_H3_Ref2VA_pruned_nvfp4.safetensors",
  };
  for (const [mode, file] of [["t2v", DEFAULT_MODELS.dit_fl2va], ["r2v", DEFAULT_MODELS.dit_ref2va]]) {
    const { prompt, meta } = buildWorkflow(oldProject(mode), { models });
    assert.equal(unetOf(prompt), file, mode);
    assert.equal(meta.dit, file, mode);
    assert.ok(!/pruned_nvfp4/i.test(JSON.stringify(prompt)), `${mode}: the graph names a deleted file`);
  }
});

test("loading a project saved with NVFP4 brings it back as int8", () => {
  replaceProject(oldProject("r2v"));
  assert.equal(getProject().render.precision, "int8");
});

test("remembered render prefs that say NVFP4 read as int8, and heal on the next save", () => {
  store.set(PREFS, JSON.stringify({ resolution: "1344x768", precision: "nvfp4" }));
  const fresh = blankProject();
  assert.equal(fresh.render.resolution, "1344x768", "the prefs were applied");
  assert.equal(fresh.render.precision, "int8");
  assert.equal(renderPrefs().precision, "int8", "Setup's memory panel shows int8");
  rememberRender({ tiledDecode: true }, "t2v");
  assert.equal(JSON.parse(store.get(PREFS)).precision, "int8");
});

test("nothing offers NVFP4 any more: no sweep variable, no DiT default", () => {
  assert.ok(!SWEEP_VARIABLES.some(v => v.id === "render.precision"));
  for (const models of [DEFAULT_MODELS, SERVER_MODELS]) {
    assert.deepEqual(Object.keys(models).filter(k => /^dit_.*nvfp4/i.test(k)), []);
    assert.ok(!Object.values(models).some(f => /pruned_nvfp4/i.test(f)));
  }
});
