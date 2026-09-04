/* SETUP — where the editor is told about the two servers it drives, and where
 * VRAM saver mode lives.
 *
 * Both engines are optional in the sense that the editor still writes prompts
 * and downloads graphs without them; they are required in the sense that
 * nothing renders and nothing gets rewritten until they answer. So this page
 * is built to get someone from "nothing installed" to "both green" without
 * leaving it: detect what is already running, say what is missing, and hand
 * over the exact commands for the rest.
 */

import { h, mount, toast, select, checkbox, copyText, segmented, modal, download, group, more, row } from "../util.js";
import { api, SERVER_BACKED, LOCAL_SERVER } from "../api.js";
import { getSettings, saveSettings, getHealth, refreshHealth, refreshVram, loadState } from "../config.js";
import { renderPrefs, forgetRenderPrefs } from "../renderprefs.js";
import { resetAllSizes } from "../resize.js";
import { SCALES, uiScale, setUiScale } from "../uiscale.js";

let root = null;
let folders = null;       // ComfyUI's model enums, loaded lazily
let llmModels = [];
let testing = "";

const MODEL_FIELDS = [
  ["dit_fl2va",        "H3 FL2VA DiT",        "diffusion_models", "T2V and I2V run on this checkpoint"],
  ["dit_ref2va",       "H3 Ref2VA DiT",       "diffusion_models", "Ref2V runs on separate weights — the two never mix"],
  ["text_encoder",     "Qwen3-VL text encoder","text_encoders",   "Loaded through CLIPLoader with type \"minimax\""],
  ["video_vae",        "Video VAE",           "vae",              ""],
  ["audio_vae",        "Audio VAE",           "vae",              "H3's audio half decodes through its own VAE"],
  ["turbo_lora_8",     "Turbo LoRA · 8-step", "loras",            "fl2va distill, shifts 12/3"],
  ["turbo_lora_4",     "Turbo LoRA · 4-step 768p", "loras",       "fl2va distill trained at 1344×768, shift_video 6"],
  ["ref_turbo_lora",   "Ref2V Turbo LoRA · 4-step", "loras",      "ref2va distill — never load it onto the fl2va DiT"],
  ["dit_fl2va_nvfp4",  "FL2VA DiT · NVFP4",   "diffusion_models", "Experimental conversion"],
  ["dit_ref2va_nvfp4", "Ref2VA DiT · NVFP4",  "diffusion_models", "Experimental conversion"],
];

/* Post-render upscalers — Deliver ▸ Upscale. */
const UPSCALE_MODEL_FIELDS = [
  ["seedvr2_dit", "SeedVR2 DiT", "seedvr2",        "3B fp8 downloads itself on first use; a 7B build is the better restorer if the card holds it (~16 GB fp8)"],
  ["seedvr2_vae", "SeedVR2 VAE", "seedvr2_vae",    ""],
  ["esrgan",      "ESRGAN ×4",   "upscale_models", "RealESRGAN_x4plus, or any ESRGAN-family model in models/upscale_models"],
];

/* The experimental second engine's files — the same split, Comfy-aligned pack
 * the main Motionstill app renders LTX-2.5 with. Only needed if the LTX-2.5
 * engine chip is ever picked; the MiniMax modes never touch these. */
const LTX_MODEL_FIELDS = [
  ["ltx25_dit",          "LTX-2.5 Transformer",            "diffusion_models",      "The INT8-convrot distilled build — the only ComfyUI-loadable 2.5 quantization"],
  ["ltx25_text_encoder", "LTX-2.5 text encoder (Gemma 4)", "text_encoders",         "Loaded through CLIPLoader with type \"ltxv\" — needs a ComfyUI with LTX-2.5 core support"],
  ["ltx25_video_vae",    "LTX-2.5 video VAE",              "vae",                   "The convolutional decoder — loads anywhere the 2.3 VAE does"],
  ["ltx25_audio_vae",    "LTX-2.5 audio VAE",              "vae",                   ""],
  ["ltx25_upscaler",     "LTX-2.5 latent upscaler ×2",     "latent_upscale_models", "The two-stage build's refine pass runs through this"],
];

async function loadFolders() {
  try {
    const r = await api.comfyModels();
    folders = r.folders;
  } catch { folders = null; }
  refresh();
}

async function loadLlmModels() {
  try {
    const r = await api.llmModels();
    llmModels = r.models || [];
  } catch { llmModels = []; }
  refresh();
}

/* ── ComfyUI ──────────────────────────────────────────────── */
const busyBtn = (e, label) => { const b = e.currentTarget; b.classList.add("disabled"); b.textContent = label; return b; };
const idleBtn = (b, label) => { b.classList.remove("disabled"); b.textContent = label; };

/** A grid of node names, each with its present/missing dot. */
const nodeGrid = (map) => h("div.nodes",
  ...Object.entries(map).map(([name, v]) => h(`div.n${v.present ? ".ok" : ""}`, { title: v.why }, h("span.dot"), name)));
const countPresent = (map) => { const all = Object.values(map || {}); return [all.filter(v => v.present).length, all.length]; };

function comfyPanel(s, health) {
  const c = health.comfy || {};
  const nodes = health.nodes;
  const [reqOk, reqAll] = countPresent(nodes?.required);
  const [ltxOk, ltxAll] = countPresent(nodes?.ltx);
  const allGood = nodes && !nodes.missing?.length;

  return group("ComfyUI", {
    id: "s-comfy", icon: "◉", accordion: false,
    badge: c.ok ? "reachable" : "not reachable",
    help: h("div",
      h("b", "The render engine. "), "Everything this editor emits runs on a stock ComfyUI with MiniMax H3 support (2026-08 nightlies or newer) — no custom node packs. ",
      h("b", "Render previews"), " need ComfyUI started with ", h("code", "--preview-method auto"), " (", h("code", "latent2rgb"), " is cheap, ", h("code", "taesd"), " is good); without it the progress bar still moves, there is just nothing to show. ",
      h("b", "Save flat"), " is the way around an output subfolder ComfyUI is not allowed to write into — one created under sudo belongs to root, ComfyUI runs as you, and the clip renders in full before the save is refused."),
  },
    row("Address", h("div.flex.grow",
      h("input.grow", {
        type: "url", value: s.comfy.url, placeholder: "http://127.0.0.1:8188",
        onchange: async (e) => { await saveSettings({ comfy: { url: e.target.value.trim() } }); await refreshHealth(); loadFolders(); refresh(); },
      }),
      h("button.btn.sm", {
        onclick: async (e) => {
          const b = busyBtn(e, "testing…");
          await refreshHealth();
          idleBtn(b, "Test");
          const ok = getHealth().comfy?.ok;
          toast(ok ? "ComfyUI answered" : "No answer from ComfyUI", ok ? "" : "Check that it is running and that the address is right.", ok ? "ok" : "err");
          loadFolders(); refresh();
        },
      }, "Test"),
      h("button.btn.sm", {
        onclick: async (e) => {
          const b = busyBtn(e, "scanning…");
          try {
            const r = await api.detect("comfy");
            idleBtn(b, "Detect");
            if (!r.comfy?.length) return toast("Nothing found", "No ComfyUI answered on the usual ports.", "warn");
            await saveSettings({ comfy: { url: r.comfy[0].url } });
            await refreshHealth(); loadFolders(); refresh();
            toast("Found ComfyUI", r.comfy[0].url, "ok");
          } catch (err) { idleBtn(b, "Detect"); toast("Scan failed", err.message, "err"); }
        },
      }, "Detect"),
      h("button.btn.sm.ghost", { title: "Open ComfyUI in a new tab", onclick: () => window.open(s.comfy.url, "_blank") }, "↗"),
    ), c.ok ? `${c.version ? `v${c.version} · ` : ""}${c.device || ""}` : "Not answering — start ComfyUI, or Detect."),
    row("Output prefix", h("input", {
      type: "text", value: s.comfy.outputPrefix || "", placeholder: "MotionstillCut",
      onchange: (e) => saveSettings({ comfy: { outputPrefix: e.target.value.trim() } }),
    }), s.comfy.flatOutput
      ? `${s.comfy.outputPrefix || "MotionstillCut"}_T2V_name… at the top of ComfyUI's output folder`
      : `${s.comfy.outputPrefix || "MotionstillCut"}/T2V_name… — a subfolder of ComfyUI's output folder`),
    h("div.opt-list",
      checkbox("Show render previews", s.comfy.previews !== false, (val) => {
        saveSettings({ comfy: { previews: val } }).then(() => toast(val ? "Previews on" : "Previews off", "", "ok"));
      }, "The sampler's own frames while a render runs — needs ComfyUI started with a preview method"),
      checkbox("Save flat, not in a subfolder", !!s.comfy.flatOutput, (val) => {
        saveSettings({ comfy: { flatOutput: val } }); refresh();
      }, "The way around an output subfolder ComfyUI is not allowed to write into"),
    ),

    nodes
      ? more(`Nodes · ${reqOk}/${reqAll} required${nodes.ltx ? ` · ${ltxOk}/${ltxAll} LTX-2.5` : ""}${allGood ? " — all stock, all present" : " — some missing"}`,
          nodes.missing?.length
            ? h("div.note.bad", h("b", "Missing: "), nodes.missing.join(", "),
                " — all of these ship with ComfyUI, so this build is simply older than MiniMax H3 support (2026-08 nightlies). Update it; there is nothing to install from GitHub.")
            : null,
          h("h4.sec", "Required"),
          nodeGrid(nodes.required),
          h("h4.sec", { style: { marginTop: "10px" } }, "Optional"),
          nodeGrid(nodes.optional),
          h("div.hint", { style: { marginTop: "5px" } },
            "LoadVideo and GetVideoComponents are what Ref2V reads reference clips through; ImageScale fits the I2V first frame to the canvas."),
          nodes.ltx ? h("div",
            h("h4.sec", { style: { marginTop: "10px" } }, "LTX-2.5 — experimental engine"),
            nodeGrid(nodes.ltx),
            nodes.ltxMissing?.length
              ? h("div.note.warn", h("b", "Missing: "), nodes.ltxMissing.join(", "),
                  " — the MiniMax modes are unaffected; only the LTX-2.5 engine chip needs these. They arrive with ComfyUI's LTX-2 AV support — update ComfyUI.")
              : nodes.ltx25Support === false
                ? h("div.note.warn", h("b", "No LTX-2.5 core support. "),
                    "CLIPLoader has no \"ltxv\" type on this build, so the Gemma 4 encoder cannot load as the LTX dual-stream encoder. Update ComfyUI; the MiniMax modes are unaffected.")
                : null,
          ) : null,
        )
      : h("div.hint", { style: { marginTop: "8px" } }, "The node check runs once ComfyUI answers."),
  );
}

/* ── LLM ──────────────────────────────────────────────────── */
const LLM_PRESETS = [
  ["http://127.0.0.1:1234",  "LM Studio (1234)"],
  ["http://127.0.0.1:11434", "Ollama (11434)"],
  ["http://127.0.0.1:8080",  "llama.cpp server (8080)"],
  ["http://127.0.0.1:8081",  "llama-swap (8081)"],
  ["http://127.0.0.1:5001",  "KoboldCpp (5001)"],
];

function llmPanel(s, health) {
  const l = health.llm || {};
  const models = (llmModels.length ? llmModels : (l.models || [])).map(m => [m, m]);
  return group("LLM server", {
    id: "s-llm", icon: "✦", accordion: false,
    badge: l.ok ? `${(l.models || []).length} model${(l.models || []).length === 1 ? "" : "s"}` : "not reachable",
    help: h("div",
      h("b", "The prompt rewriter, director and captioner. "), "Any OpenAI-compatible server — LM Studio is the least work; Ollama and llama.cpp both work and both can unload, which VRAM saver needs. ",
      h("b", "Recommended: Gemma 3 12B"), " (instruct) — strong prose, reliable JSON, and vision, so one model covers everything, in ~8 GB at Q4. Smaller cards: Gemma 3 4B or Llama 3.1 8B. Big cards: Gemma 3 27B or Qwen3 32B with Thinking Off. VRAM saver means the LLM and the DiT take turns, so size for your card, not for co-fitting."),
  },
    row("Address", h("div.flex.grow",
      h("input.grow", {
        type: "url", value: s.llm.url, placeholder: "http://127.0.0.1:1234",
        onchange: async (e) => { await saveSettings({ llm: { url: e.target.value.trim() } }); await refreshHealth(); loadLlmModels(); refresh(); },
      }),
      select([["", "Preset…"], ...LLM_PRESETS], "", async (v) => {
        if (!v) return;
        await saveSettings({ llm: { url: v } });
        await refreshHealth(); loadLlmModels(); refresh();
      }, { style: { flex: "0 0 auto", width: "132px" } }),
      h("button.btn.sm", {
        onclick: async (e) => {
          const b = busyBtn(e, "scanning…");
          try {
            const r = await api.detect("llm");
            idleBtn(b, "Detect");
            if (!r.llm?.length) return toast("Nothing found", "No OpenAI-compatible server answered on the usual ports.", "warn");
            await saveSettings({ llm: { url: r.llm[0].url } });
            await refreshHealth(); loadLlmModels(); refresh();
            toast("Found an LLM server", `${r.llm[0].url} · ${(r.llm[0].models || []).length} model(s)`, "ok");
          } catch (err) { idleBtn(b, "Detect"); toast("Scan failed", err.message, "err"); }
        },
      }, "Detect"),
    ), l.ok ? `${l.flavour === "ollama" ? "Ollama" : "OpenAI-compatible"} · ${(l.models || []).length} model(s) loaded` : "Not answering — start the server, pick a preset, or Detect."),
    row("Model", h("div.flex.grow",
      select([["", "— whatever is loaded —"], ...models], s.llm.model || "", (v) => saveSettings({ llm: { model: v } }), { class: "grow" }),
      h("button.btn.sm", { title: "Re-read the model list", onclick: () => loadLlmModels() }, "⟳"),
    )),
    row("Vision model", select([["", "— same as above —"], ...models], s.llm.visionModel || "", (v) => saveSettings({ llm: { visionModel: v } })),
      "For \"Describe with the LLM\" on Media. A vision-capable model (Qwen3-VL, Gemma, Llava…) is what makes I2V's opening match its first frame."),
    row("API key", h("input", {
      type: "password", value: "", placeholder: s.llm.hasApiKey ? "•••••••• (set)" : "optional",
      onchange: (e) => saveSettings({ llm: { apiKey: e.target.value } }).then(() => toast("Key saved", "", "ok")),
    })),
    h("div.btn-row", { style: { marginTop: "4px" } },
      h("button.btn.sm", {
        onclick: async (e) => {
          const b = busyBtn(e, "testing…");
          testing = "llm";
          try {
            const r = await api.chat({ prompt: "Reply with the single word: ready.", maxTokens: 12, temperature: 0 });
            toast("LLM answered", `${r.model} — "${(r.text || "").slice(0, 40)}" in ${(r.ms / 1000).toFixed(1)}s`, "ok");
          } catch (err) { toast("LLM test failed", err.message, "err"); }
          finally { testing = ""; idleBtn(b, "Test a completion"); refreshHealth().then(refresh); }
        },
      }, "Test a completion"),
      h("button.btn.sm", {
        title: "Ask for JSON the way every assistant feature does, and report what came back",
        onclick: async (e) => {
          const b = busyBtn(e, "checking…");
          try {
            const r = await api.chat({
              json: true, maxTokens: 120, temperature: 0,
              system: "Answer with JSON only. No prose, no code fences.",
              prompt: 'Return exactly {"ok":true,"note":"hello"}',
            });
            if (r.json?.ok) {
              toast("Structured answers work",
                `${r.model}${r.reasoned ? " · thinking detected and handled" : ""}${r.jsonMode ? " · JSON mode accepted" : " · JSON mode not used"}`,
                "ok");
            } else {
              // Say what the server worked out, not what this button used to
              // guess. The old copy blamed the model size for a problem that
              // is usually a thinking budget.
              const why = r.jsonFailure;
              await modal({
                title: why?.title || "Structured answers need help",
                body: h("div",
                  h("p", why?.detail || "The reply could not be parsed as JSON."),
                  h("div.hint", { style: { marginTop: "8px" } },
                    `${r.model}`,
                    r.reasoned ? " · this model reasons" : "",
                    r.truncated ? " · the reply was cut off" : "",
                    r.jsonMode ? " · JSON mode accepted" : " · JSON mode not used",
                    r.retriedWith ? ` · retried at ${r.retriedWith} tokens` : ""),
                  h("h4.sec", "What came back"),
                  h("pre.code", { style: { maxHeight: "220px", overflow: "auto" } },
                    (r.text || "(nothing)").slice(0, 1500)),
                ),
              });
            }
          } catch (err) { toast("Structured test failed", err.message, "err"); }
          finally { idleBtn(b, "Test structured answers"); }
        },
      }, "Test structured answers"),
    ),
    more("Answer format & thinking",
      row("Thinking", select([["off", "Off — ask the model not to think"], ["auto", "Auto — leave the model alone"]],
        s.llm.thinking || "off", (v) => saveSettings({ llm: { thinking: v } }).then(refresh)),
        "The commonest cause of \"the model did not answer\" is a reasoning model (Qwen3, DeepSeek-R1, gpt-oss, GLM) spending its whole budget thinking. Off sends every backend's spelling of \"skip the reasoning\"; the reasoning is stripped either way, and a reply that ran out of room is retried with a bigger budget."),
      (s.llm.thinking || "off") !== "off"
        ? row("Reasoning strength", select([["default", "Model default"], ["low", "Low — quick"], ["medium", "Medium"], ["high", "High — slow and thorough"]],
          s.llm.reasoning || "default", (v) => saveSettings({ llm: { reasoning: v } })),
          "Sent as reasoning_effort while thinking is on. gpt-oss reads it natively; llama.cpp hands it to any chat template that reads reasoning_effort or reasoning_strength; other models ignore it. Give Max tokens room to match.")
        : null,
      row("JSON mode", select([["auto", "Auto — ask once, stop if refused"], ["off", "Off — never ask"]],
        s.llm.jsonMode || "auto", (v) => saveSettings({ llm: { jsonMode: v } })),
        "llama.cpp, some LM Studio runtimes and most proxies reject response_format. On Auto the server probes once, then stops asking; answers are parsed out of prose regardless."),
      row("Max tokens", h("input", {
        type: "number", min: "256", max: "32000", step: "256", value: String(s.llm.maxTokens ?? 1600),
        onchange: (e) => saveSettings({ llm: { maxTokens: Math.max(256, Number(e.target.value) || 1600) } }).then(() => toast("Saved", "", "ok")),
      }), "The budget for one answer. A reasoning model needs room for the thought AND the answer — 4000 or more if thinking stays on."),
    ),
  );
}

/* ── VRAM saver ───────────────────────────────────────────── */
function vramPanel(s, health) {
  const v = health.vram || {};
  const owner = v.owner === "comfy" ? "ComfyUI" : v.owner === "llm" ? "the LLM" : "nobody";

  return group("VRAM saver", {
    id: "s-vram", icon: "▤", accordion: false,
    badge: v.saver ? "on" : "off",
    help: h("div", h("b", "One engine on the GPU at a time. "),
      "MiniMax H3's DiT is around 20 GB and Qwen3-VL 32B is another 20 — on one card they do not co-fit, and the failure mode is not an error: the driver spills to shared memory and the render takes ten times as long. With the saver on, asking for a rewrite unloads ComfyUI's models first, and queueing a render unloads the LLM first."),
  },
    h("div.opt-list",
      checkbox("VRAM saver mode — the engines take turns", !!v.saver, async (val) => {
        await saveSettings({ vram: { saver: val } });
        await refreshVram(); refresh();
        toast(val ? "VRAM saver on" : "VRAM saver off", val ? "The engines will take turns." : "Both engines may hold the card.", "ok");
      }),
      checkbox("Free ComfyUI as soon as a render finishes", !!v.releaseAfterRender, async (val) => {
        await saveSettings({ vram: { releaseAfterRender: val } });
        await refreshVram(); refresh();
      }, "Otherwise ComfyUI keeps the models resident until the LLM next needs the card — faster for back-to-back renders"),
    ),
    h("div.flex.wrap", { style: { marginTop: "10px" } },
      h("span", { class: `badge ${v.owner === "comfy" ? "gpu-comfy" : v.owner === "llm" ? "gpu-llm" : ""}` }, h("span.dot"), `GPU held by ${owner}`),
      v.rendering ? h("span.badge.busy", h("span.dot"), "rendering") : null,
      h("span.spacer", { style: { flex: "1" } }),
      h("button.btn.sm", { onclick: async () => { await api.release(); await refreshVram(); refresh(); toast("GPU released", "Both engines unloaded.", "ok"); } }, "Release both"),
      h("button.btn.sm.ghost", { onclick: async () => { await api.freeComfy(); await refreshVram(); refresh(); toast("ComfyUI freed", "", "ok"); } }, "Free ComfyUI"),
      h("button.btn.sm.ghost", { onclick: async () => { const r = await api.unloadLlm(); await refreshVram(); refresh(); toast("LLM unloaded", `${r.unloaded || 0} model(s) via ${r.style}`, "ok"); } }, "Unload LLM"),
    ),
    v.lastAction ? h("div.hint", { style: { marginTop: "6px" } }, `Last: ${v.lastAction}`) : null,
    v.llmUnloadStyle === "none"
      ? h("div.note.warn", h("b", "This LLM backend cannot unload."),
          " A plain llama-server holds its model until the process exits. Run it in router mode (--models-dir, no -m), or use LM Studio, Ollama or llama-swap, and the saver can do its job.")
      : null,
  );
}

/* ── Models ───────────────────────────────────────────────── */
function modelsPanel(s) {
  const list = folders || {};
  const datalists = [];
  for (const [folder, values] of Object.entries(list)) {
    datalists.push(h("datalist", { id: `dl-${folder}` }, ...values.map(v => h("option", { value: v }))));
  }
  const presence = ([key, , folder]) => { const known = list[folder]; return known ? known.includes(s.models[key] || "") : null; };
  const tally = (fields) => {
    const known = fields.map(presence).filter(v => v !== null);
    return known.length ? `${known.filter(Boolean).length}/${fields.length} installed` : `${fields.length} files`;
  };

  const fieldRow = (f) => {
    const [key, label, folder, note] = f;
    const present = presence(f);
    return h("div.model-row",
      h("span.lbl", { title: note || "" }, label),
      present === false ? h("span.badge.bad", { title: `Not in ComfyUI's ${folder} folder` }, h("span.dot"), "not found")
        : present === true ? h("span.badge.ok", h("span.dot"), "installed")
        : h("span.badge", { title: "ComfyUI has not answered, so nothing can be checked" }, h("span.dot"), "unknown"),
      h("input", {
        type: "text", value: s.models[key] || "", list: `dl-${folder}`, spellcheck: "false", title: note || label,
        onchange: (e) => saveSettings({ models: { [key]: e.target.value.trim() } }).then(refresh),
      }),
    );
  };

  const actions = h("div.btn-row", { style: { marginTop: "10px" } },
    h("button.btn.sm", { onclick: () => loadFolders() }, "⟳ Re-read ComfyUI's folders"),
    h("button.btn.sm.ghost", {
      onclick: async () => {
        const r = await api.state();
        await saveSettings({ models: r.defaultModels });
        toast("Reset to the Comfy-Org repack names", "", "ok");
        refresh();
      },
    }, "Reset to defaults"),
  );

  return h("div",
    ...datalists,
    group("MiniMax H3 files", {
      id: "s-h3", icon: "▣", accordion: false, badge: tally(MODEL_FIELDS),
      help: "Spelled exactly as ComfyUI lists them. Where ComfyUI is reachable these autocomplete from what is actually installed, and each row says whether its file was found. Hover a name for what the file is for.",
    },
      ...MODEL_FIELDS.map(fieldRow),
      actions,
    ),
    group("LTX-2.5 files", {
      id: "s-ltx", icon: "▣", accordion: false, badge: tally(LTX_MODEL_FIELDS),
      help: "Only needed for the LTX-2.5 engine chip on the Deliver page. Roughly 40 GB across the five; the MiniMax modes never load any of them.",
    },
      ...LTX_MODEL_FIELDS.map(fieldRow),
    ),
    group("Upscalers", {
      id: "s-up", icon: "⤢", accordion: false, badge: tally(UPSCALE_MODEL_FIELDS),
      help: "Only used when Deliver ▸ Upscale is on. SeedVR2 needs the seedvr2_videoupscaler custom pack (ComfyUI Manager has it); its loader downloads the 3B fp8 build on first use. ESRGAN runs on stock nodes.",
    },
      ...UPSCALE_MODEL_FIELDS.map(fieldRow),
    ),
  );
}

/* ── Install guide ────────────────────────────────────────── */
const cmd = (text) => h("div.cmd", {
  onclick: async (e) => { await copyText(text); e.currentTarget.style.borderColor = "var(--green)"; setTimeout(() => { e.currentTarget.style.borderColor = ""; }, 700); toast("Copied", "", "ok"); },
}, text);

function guidePanel() {
  const step = (title, ...content) => h("div.step", h("div.step-t", title), ...content);
  return group("Install guide", {
    id: "s-guide", icon: "☰", accordion: false, open: false, badge: "local box",
    help: "Everything here runs on the machine that has the GPU. This editor only needs to reach the two addresses above — it never loads a model itself. Click a command to copy it.",
  },
    step("1 · ComfyUI",
      cmd("git clone https://github.com/comfyanonymous/ComfyUI\ncd ComfyUI && python -m venv venv && . venv/bin/activate\npip install -r requirements.txt\npython main.py --listen 127.0.0.1 --port 8188"),
      h("div.hint", "MiniMax H3 support landed in the 2026-08 nightlies — an older build will not have the nodes.")),
    step("2 · The H3 weights",
      cmd(`pip install -U "huggingface_hub[cli]"
hf download Comfy-Org/MiniMax-H3 --include "split_files/*" --local-dir ComfyUI/models`),
      h("div.hint", "Puts the DiTs in diffusion_models/, the Qwen3-VL encoder in text_encoders/ and both VAEs in vae/. Ref2V needs the ref2va checkpoint as well as the fl2va one."),
      cmd(`hf download lightx2v/Minimax-h3-Turbo --include "*comfyui*" --local-dir ComfyUI/models/loras`),
      h("div.hint", "The Turbo distills. Optional — the Full builds work without them, they are just slower.")),
    step("3 · Custom nodes — none",
      h("div.hint", "Every node this editor emits ships with ComfyUI, so the workflow JSON runs on someone else's install. One consequence: H3 reads reference clips as 24 fps and the stock loader passes a file's own rate through, so export Ref2V reference clips at 24 fps.")),
    step("Optional · LTX-2.5",
      cmd(`hf download Lightricks/LTX-2.5 \\
  --include "*int8-convrot*" "*video-vae-conv-bf16*" "*audio-vae-bf16*" "*latent-spatial-upscaler*" \\
  --local-dir ComfyUI/models`),
      h("div.hint", "Five files, ~40 GB: the INT8-convrot transformer and Gemma 4 encoder, the conv video VAE, the audio VAE and the ×2 latent upscaler. Needs a ComfyUI with LTX-2 AV support (the node check above has its own LTX row).")),
    step("4 · An LLM for the prompt work",
      h("div.hint", "Any OpenAI-compatible server. LM Studio is the least work; Ollama and llama.cpp can unload, which VRAM saver needs."),
      cmd("# LM Studio: enable the local server (Developer ▸ Start Server, port 1234)\n# then load an instruct model — a 7–14B is plenty for prompt rewriting"),
      cmd("# Ollama\nollama serve\nollama pull qwen3:14b"),
      cmd("# llama.cpp in ROUTER mode — no -m, so it can load and unload on demand\nllama-server --host 127.0.0.1 --port 8080 --models-dir ~/models")),
    step("5 · This editor",
      cmd("CUT_COMFY_URL=http://127.0.0.1:8188 \\\nCUT_LLM_URL=http://127.0.0.1:1234 \\\nnode cut/server/server.js"),
      h("div.hint", "Or mounted inside the main Motionstill server, where it lives at /cut and shares its session.")),
  );
}

/* ── What this machine remembers ──────────────────────────────
 * Two things now outlive a project: the render settings you last chose, and
 * the sizes you dragged your panels to. Both are conveniences, and a
 * convenience you cannot see or undo is a bug waiting to be reported — so
 * they are listed here with the button that clears them. */
/* Where the work actually lives — the one thing someone opening the public
 * release from a link must not find out the hard way. Server mode names the
 * folder; client mode says "this browser" and offers the way out: a full
 * backup as one JSON file, and the way back in. */
function storagePanel() {
  const s = getSettings();

  if (SERVER_BACKED) {
    return group("Where your work lives", { id: "s-store", icon: "⌂", accordion: false, badge: "on disk" },
      h("div.hint", { style: { lineHeight: "1.6" } },
        "Projects, the library, the rulebook, the cast and these settings are saved by the local Cut app as plain JSON under ",
        h("b", String(s?.dataFile || "the app's data/ folder")),
        " — readable, diffable, and backed up with a copy. Re-run ", h("b", "/setup"), " to change this."),
    );
  }

  const restore = () => {
    const input = h("input", { type: "file", accept: ".json,application/json", style: { display: "none" } });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const backup = parsed.backup || parsed;
        const ok = await modal({
          title: "Restore this backup?",
          body: h("div.hint", { style: { lineHeight: "1.6" } },
            `From ${backup.at ? new Date(backup.at).toLocaleString() : "an unknown date"} — ${(backup.projects || []).length} project(s), ${(backup.library || []).length} library entr${(backup.library || []).length === 1 ? "y" : "ies"}, ${(backup.rulebook || []).length} rule(s), ${(backup.cast || []).length} cast entr${(backup.cast || []).length === 1 ? "y" : "ies"}. `,
            h("b", "It replaces everything this browser currently holds.")),
          actions: [{ label: "Replace and restore", kind: "primary", onClick: (done) => done(true) }],
        });
        if (!ok) return;
        const r = await api.backupImport(backup);
        toast("Restored", `${r.restored.projects} project(s), ${r.restored.library} library entr${r.restored.library === 1 ? "y" : "ies"}, ${r.restored.media} media file(s). Reloading…`, "ok");
        setTimeout(() => location.reload(), 1200);
      } catch (err) {
        toast("Could not restore", err.message, "err");
      }
    };
    document.body.appendChild(input);
    input.click();
    input.remove();
  };

  return group("Where your work lives", { id: "s-store", icon: "⌂", accordion: false, badge: "this browser" },
    h("div.hint", { style: { lineHeight: "1.6" } },
      "Everything is stored in ", h("b", "this browser"), " — settings in localStorage, projects, the library and media in IndexedDB. Nothing is sent to the server hosting these files; it only hands out the app. That also means clearing this browser's site data throws the lot away, so export a backup once in a while",
      LOCAL_SERVER
        ? h("span", " — or re-run ", h("b", "/setup"), " on the local app and switch on local server saving, which keeps everything in a data/ folder on disk instead.")
        : h("span", ". For on-disk saving and ffmpeg film joins, run the local app from the repository (", h("b", "node server/server.js"), ")."),
    ),
    h("div.btn-row", { style: { marginTop: "10px" } },
      h("button.btn.sm", {
        title: "Everything — settings, projects, library, rulebook, cast, and the media your projects reference — as one JSON file",
        onclick: async () => {
          try {
            const r = await api.backupExport();
            const stamp = new Date().toISOString().slice(0, 10);
            download(`motionstillcut-backup-${stamp}.json`, JSON.stringify(r.backup));
            toast("Backup exported", "One JSON file, media included. Keep it somewhere that is not this browser.", "ok");
          } catch (err) { toast("Export failed", err.message, "err"); }
        },
      }, "⬇ Export backup"),
      h("button.btn.sm", { title: "Restore a backup exported here — replaces what this browser holds", onclick: restore }, "⬆ Restore backup"),
      h("button.btn.sm", {
        title: "The first-visit conversation again: engines, CORS flags, model advice",
        onclick: async () => { const { showFirstRunSetup } = await import("../firstrun.js"); showFirstRunSetup(); },
      }, "↻ First-use setup"),
    ),
  );
}

function memoryPanel() {
  const r = renderPrefs();
  /* The length is deliberately NOT here any more, and neither is the output
   * folder. Both used to be carried and both are properties of a clip rather
   * than of this machine — carrying the length meant one try at 30 s made
   * every later project 30 s, past what H3 renders, as a setting nobody had
   * chosen twice. The seed was already excluded for the same reason. */
  const bits = [
    r.resolution, r.precision,
    r.engine === "ltx25" ? "LTX-2.5 engine (experimental)" : null,
    r.variants?.fl2va ? `${r.variants.fl2va} (T2V/I2V)` : null,
    r.variants?.ref2va ? `${r.variants.ref2va} (Ref2V)` : null,
    r.variants?.ltx25 ? `${r.variants.ltx25} (LTX-2.5)` : null,
    r.tiledDecode ? "tiled decode" : null,
  ].filter(Boolean);

  return group("This machine", {
    id: "s-machine", icon: "▭", accordion: false, badge: `UI ${SCALES.find(x => String(x[0]) === String(uiScale()))?.[1] || uiScale()}`,
    help: "Two things outlive a project: the render settings you last chose, and the sizes you dragged your panels to. Both are conveniences, and a convenience you cannot see or undo is a bug waiting to be reported — so they are listed here with the button that clears them.",
  },
    h("h4.sec", "Remembered render settings"),
    h("div.hint", { style: { lineHeight: "1.6" } },
      bits.length
        ? h("span", "New projects start from the render settings you chose last: ",
            h("b", bits.join(" · ")),
            ". The checkpoint variant is kept once per family, so switching between text and reference to video does not lose it. The clip's LENGTH, its seed and where it delivers are not remembered — those belong to a clip, not to this box.")
        : "Nothing yet. The render settings you choose become the defaults for your next project.",
    ),
    h("h4.sec", { style: { marginTop: "14px" } }, "Interface size"),
    h("div.hint", { style: { lineHeight: "1.6", marginBottom: "6px" } },
      "Drawn at 11px, like a tool made for a 27-inch monitor. ", h("b", "⌘+"), " / ", h("b", "⌘−"), " step it too."),
    segmented(SCALES.map(([v, label]) => [v, label]), String(uiScale()), (v) => { setUiScale(v); refresh(); }),

    h("div.btn-row", { style: { marginTop: "12px" } },
      h("button.btn.sm", {
        title: "Go back to 832×480, 5s, turbo, int8",
        onclick: () => { forgetRenderPrefs(); toast("Forgotten", "New projects start from the built-in defaults again.", "ok"); refresh(); },
      }, "Forget render settings"),
      h("button.btn.sm", {
        title: "Put every panel on every page back to the width it ships with",
        onclick: () => { resetAllSizes(); toast("Layout reset", "Every section is back to its default size.", "ok"); },
      }, "Reset panel sizes"),
    ),
  );
}

/* The three facts someone opens this page for, before anything else:
 * is ComfyUI up, is the LLM up, who holds the GPU. */
function statusStrip(health) {
  const c = health.comfy || {}, l = health.llm || {}, v = health.vram || {};
  const tile = (label, ok, value, sub) => h("div.stat",
    h("div.k", label),
    h("div.v", h("span", { class: `dot ${ok === true ? "ok" : ok === false ? "bad" : ""}` }), value),
    h("div.s", { title: sub || "" }, sub || "—"),
  );
  return h("div.stat-strip",
    tile("ComfyUI", !!c.ok, c.ok ? "Reachable" : "Offline", c.ok ? `${c.device || ""}${c.vramTotalGB ? ` · ${c.vramFreeGB ?? "?"}/${c.vramTotalGB} GB free` : ""}` : "Start it, or Detect below"),
    tile("LLM", !!l.ok, l.ok ? "Reachable" : "Offline", l.ok ? `${l.flavour === "ollama" ? "Ollama" : "OpenAI-compatible"} · ${(l.models || []).length} model(s)` : "Start it, or Detect below"),
    tile("GPU", v.rendering ? null : v.owner ? true : null,
      v.rendering ? "Rendering" : v.owner === "comfy" ? "ComfyUI" : v.owner === "llm" ? "LLM" : "Free",
      v.saver ? "VRAM saver on — the engines take turns" : "VRAM saver off"),
  );
}

function draw() {
  const s = getSettings();
  const health = getHealth();
  if (!s) { mount(root, h("div", { style: { padding: "20px" } }, h("div.hint", "Loading settings…"))); return; }

  mount(root,
    h("div.cols",
      h("div.panel",
        h("div.hd", h("span.title", "Engines"), h("span.spacer"),
          h("button.btn.sm", { onclick: async () => { await refreshHealth(); await refreshVram(); loadFolders(); loadLlmModels(); refresh(); } }, "⟳ Re-check")),
        h("div.bd",
          statusStrip(health),
          h("div.insp", comfyPanel(s, health), llmPanel(s, health), vramPanel(s, health))),
      ),
      h("div.panel",
        h("div.hd", h("span.title", "Models & this machine")),
        h("div.bd", h("div.insp", modelsPanel(s), storagePanel(), memoryPanel(), guidePanel())),
      ),
    ),
  );
}

export function render(el) {
  root = el;
  draw();
  if (!folders) loadFolders();
  if (!llmModels.length) loadLlmModels();
  refreshHealth().then(refresh);
}
export function refresh() { if (root) draw(); }
