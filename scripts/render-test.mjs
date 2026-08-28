#!/usr/bin/env node
/* RENDER TEST — idea or prompt in, a scored LTX-2.5 render out.
 *
 * Runs the app's real chain headlessly: Create's interview (readMaterial) →
 * writeAnswers → applySteering → compilePrompt → buildWorkflow → ComfyUI →
 * mp4 → ffmpeg scene scores (scripts/scenes.py). Built 28 Aug 2026 to find
 * out why a four-shot lighthouse rendered as one take; the answers are in
 * steer.js / prompt.js / interview.js comments and were only reachable this
 * way — reasoning from the prompt guide got it wrong five times.
 *
 *   node scripts/render-test.mjs --idea "A keeper climbs the tower…" [--duration 20]
 *   node scripts/render-test.mjs --prompt path/to/prompt.txt --label mytest
 *   node scripts/render-test.mjs --idea "…" --dry        # generator only, no render
 *
 * Options: --duration N  --resolution WxH  --variant ltx_single|ltx_two
 *          --seed N  --label NAME  --out DIR (default ./render-tests)
 * Env:     CUT_COMFY_URL (default http://127.0.0.1:8188)
 *          CUT_LLM_URL   (default http://127.0.0.1:1234, OpenAI-compatible)
 *          COMFY_OUTPUT  (default /opt/ComfyUI/output — where SaveVideo lands)
 *
 * Note: the local LLM gateway refuses calls while ComfyUI is rendering, so
 * the generator step retries until the card is free. */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "web", "js") + "/";
const { blankProject, orderedShots } = await import(ROOT + "state.js");
const { applySteering, DEFAULT_DIALS } = await import(ROOT + "steer.js");
const { compilePrompt, validate } = await import(ROOT + "prompt.js");
const { buildWorkflow } = await import(ROOT + "workflow.js");
const { DEFAULT_MODELS } = await import(ROOT + "backend/settings.js");
const { parseLooseJson } = await import(ROOT + "backend/parse.js");
const { api } = await import(ROOT + "api.js");
const { readMaterial } = await import(ROOT + "interview.js");

const LLM = process.env.CUT_LLM_URL || "http://127.0.0.1:1234";
const COMFY = process.env.CUT_COMFY_URL || "http://127.0.0.1:8188";
const COMFY_OUTPUT = process.env.COMFY_OUTPUT || "/opt/ComfyUI/output";

/* The app's chat call, pointed straight at the gateway. */
api.chat = async (body) => {
  const messages = [...(body.system ? [{ role: "system", content: body.system }] : []), { role: "user", content: `${body.prompt}\n/no_think` }];
  const t0 = Date.now();
  const r = await fetch(`${LLM}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "local-model", messages, temperature: body.temperature ?? 0.7, max_tokens: body.maxTokens ?? 1600, response_format: { type: "json_object" }, chat_template_kwargs: { enable_thinking: false } }) });
  const d = await r.json();
  const text = d.choices?.[0]?.message?.content || "";
  if (!text) console.error("LLM:", JSON.stringify(d).slice(0, 300));
  return { text, json: parseLooseJson(text, body.expect || []), model: d.model, ms: Date.now() - t0 };
};

export function makeProject({ duration = 20, resolution = "832x480", variant = "ltx_single", seed = 4242, name = "render-test" } = {}) {
  const p = blankProject();
  p.name = name;
  Object.assign(p.render, { engine: "ltx25", variant, duration, resolution, seed, fps: 24 });
  return p;
}

/* Exactly what Create's runRead does after readMaterial (pages/create.js). */
export function adopt(draft, proposal) {
  draft.creative.proposal = proposal;
  draft.creative.answers = { subject: proposal.subject, setting: proposal.setting, beats: proposal.beats, speech: proposal.speaks ? proposal.line : "", voice: proposal.speaks ? proposal.voice : "", extra: {} };
  draft.creative.dials = { ...DEFAULT_DIALS, ...proposal.dials };
  draft.creative.pool = { beats: proposal.beats };
  draft.creative.stage = "steer";
  const a = draft.creative.answers;
  for (const shot of draft.shots) { shot.subject = a.subject || shot.subject; shot.setting = a.setting || shot.setting; }
  if (a.speech?.trim()) {
    const voice = (a.voice || "").trim() || (a.subject || "").trim();
    draft.shots[0].dialogue = [{ id: "d-1", speaker: "S1", language: "English", text: a.speech.trim(), voiceover: /off-screen|narrat|voiceover/i.test(voice), note: "", identity: voice, delivery: "" }];
  } else for (const shot of draft.shots) shot.dialogue = [];
  applySteering(draft);
  return draft;
}

export async function create(idea, opts = {}) {
  const p = makeProject(opts);
  p.creative.material.text = idea;
  let proposal = null;
  for (let i = 0; i < 20 && !proposal; i++) {
    try { proposal = await readMaterial(p); }
    catch (e) { console.error(`generator: ${e.message} — retry ${i + 1}`); await new Promise(r => setTimeout(r, 15000)); }
  }
  if (!proposal) throw new Error("the generator never answered");
  adopt(p, proposal);
  return { project: p, proposal };
}

export const scenes = (path) => execFileSync("python3", [join(HERE, "scenes.py"), path]).toString().trim();

export async function render(project, label, { promptOverride = null, out = "render-tests" } = {}) {
  mkdirSync(out, { recursive: true });
  const wf = buildWorkflow(project, { models: DEFAULT_MODELS, comfy: { outputPrefix: "render-test" } });
  if (promptOverride) wf.prompt["5"].inputs.text = promptOverride;
  wf.prompt["35"].inputs.filename_prefix = `render-test/${label}`;
  const text = wf.prompt["5"].inputs.text;
  writeFileSync(join(out, `${label}.prompt.txt`), text);
  const t0 = Date.now();
  const q = await (await fetch(`${COMFY}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: wf.prompt, client_id: "render-test" }) })).json();
  if (!q.prompt_id) throw new Error("queue failed: " + JSON.stringify(q).slice(0, 500));
  let file = null;
  while (!file) {
    await new Promise(r => setTimeout(r, 5000));
    const h = await (await fetch(`${COMFY}/history/${q.prompt_id}`)).json();
    const e = h[q.prompt_id];
    if (e?.status?.status_str === "error") throw new Error("render error: " + JSON.stringify(e.status.messages).slice(0, 800));
    if (e?.status?.completed) file = Object.values(e.outputs).flatMap(v => v.images || v.gifs || []).find(o => /\.mp4$/.test(o.filename));
  }
  const path = join(COMFY_OUTPUT, file.subfolder || "", file.filename);
  const sc = scenes(path);
  const line = `[${label}] ${((Date.now() - t0) / 1000).toFixed(0)}s render · ${path}\n  ${sc}`;
  console.log(line);
  writeFileSync(join(out, `${label}.result.txt`), line + "\n\n" + text);
  return { file: path, scenes: sc, text };
}

/* ── CLI ─────────────────────────────────────────────────── */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith("--")) args[a.slice(2)] = process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] == null ? true : process.argv[++i];
  }
  const opts = { duration: Number(args.duration) || 20, resolution: args.resolution || "832x480", variant: args.variant || "ltx_single", seed: args.seed != null ? Number(args.seed) : 4242 };
  const label = args.label || `t${Date.now().toString(36)}`;
  if (args.prompt) {
    await render(makeProject(opts), label, { promptOverride: readFileSync(args.prompt, "utf8"), out: args.out });
  } else if (args.idea) {
    const { project, proposal } = await create(args.idea, opts);
    const text = compilePrompt(project).text;
    console.log(`beats: ${JSON.stringify(proposal.beats)}\nshots:\n  ${orderedShots(project).map(s => `${s.at}s ${s.shotType}/${s.viewpoint} cam=${s.camera.type}/${s.camera.speed} lines=${(s.dialogue || []).map(d => d.text).join("|")}`).join("\n  ")}\nprompt:\n${text}\nchecks:\n  ${validate(project).checks.map(c => `${c.level}: ${c.msg}`).join("\n  ")}`);
    if (!args.dry) await render(project, label, { out: args.out });
  } else {
    console.log("usage: render-test.mjs --idea '…' | --prompt file [--dry] [--duration N] [--resolution WxH] [--variant ltx_single|ltx_two] [--seed N] [--label NAME] [--out DIR]");
  }
}
