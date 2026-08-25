/* A FAILED JOB, READ FOR THE USER — ComfyUI hands back the node's Python
 * exception verbatim. The app names the cause, the fix, and the one
 * workaround it controls. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { explainRenderError } from "../web/js/rendererrors.js";
import { blankProject } from "../web/js/state.js";
import { buildWorkflow } from "../web/js/workflow.js";

const denied = "[Errno 13] Permission denied: '/opt/ComfyUI/output/MotionstillCut/T2V_untitled_00001_.mp4'";

test("a refused save is named, with its folder and the fix", () => {
  const why = explainRenderError(denied, { nodeType: "SaveVideo" });
  assert.equal(why.kind, "save-permission");
  assert.equal(why.folder, "/opt/ComfyUI/output/MotionstillCut");
  assert.match(why.fix, /chown -R \$USER "\/opt\/ComfyUI\/output\/MotionstillCut"/);
  assert.match(why.message, /not allowed to write/);
  assert.ok(why.fallback);
});

test("a permission error that names no path but comes from a save node still counts", () => {
  const why = explainRenderError("PermissionError: Permission denied", { nodeType: "SaveVideo" });
  assert.equal(why.kind, "save-permission");
  assert.equal(why.folder, null);
});

test("a permission error elsewhere is not a save problem", () => {
  const why = explainRenderError("PermissionError: Permission denied", { nodeType: "UNETLoader" });
  assert.equal(why.kind, "permission");
});

test("a full disk and an ordinary failure are told apart", () => {
  assert.equal(explainRenderError("[Errno 28] No space left on device", { nodeType: "SaveVideo" }).kind, "disk-full");
  const other = explainRenderError("CUDA out of memory", { nodeType: "SamplerCustomAdvanced" });
  assert.equal(other.kind, "other");
  assert.match(other.message, /SamplerCustomAdvanced — CUDA out of memory/);
});

test("flat output moves the save to the top of the output folder", () => {
  const p = blankProject(); p.name = "My Clip";
  const prefixOf = (settings) => Object.values(buildWorkflow(p, settings).prompt).find(n => n.class_type === "SaveVideo").inputs.filename_prefix;
  assert.equal(prefixOf({ models: {}, comfy: {} }), "MotionstillCut/T2V_My_Clip");
  assert.equal(prefixOf({ models: {}, comfy: { flatOutput: true } }), "MotionstillCut_T2V_My_Clip");
  assert.equal(prefixOf({ models: {}, comfy: { flatOutput: true, outputPrefix: "Renders" } }), "Renders_T2V_My_Clip");
});
