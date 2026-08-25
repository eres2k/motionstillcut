/* MOTIONSTILL CUT — first-use setup, for the hosted version.
 *
 * The local Node app has a wizard at /setup; someone opening the public web
 * link has nothing between them and an interface pointing at engines they may
 * not have started. This is the same conversation, as one modal on the first
 * visit: where your work lives, where the two engines are (with detect), and
 * the one CORS flag each needs — plus which local model to feed the director.
 *
 * Everything here can be changed later on Setup; the wizard only fills the
 * same settings. It never shows when the page came from the local app —
 * /setup already had this conversation there.
 */

import { h, modal, toast } from "./util.js";
import { api, LOCAL_SERVER } from "./api.js";
import { getSettings, saveSettings } from "./config.js";
import { showQuickGuide } from "./quickguide.js";

const DONE_KEY = "mscut.firstrun.done";

const seen = () => { try { return localStorage.getItem(DONE_KEY) === "1"; } catch { return true; } };
const markSeen = () => { try { localStorage.setItem(DONE_KEY, "1"); } catch { /* private mode */ } };

const fieldStyle = {
  width: "100%", background: "#161616", border: "1px solid var(--line)", borderRadius: "4px",
  color: "var(--fg-bright)", padding: "7px 9px", font: "inherit", fontSize: "12px",
};

export function showFirstRunSetup() {
  const s = getSettings();
  const comfyIn = h("input", { type: "text", spellcheck: "false", value: s?.comfy?.url || "http://127.0.0.1:8188", style: fieldStyle });
  const llmIn = h("input", { type: "text", spellcheck: "false", value: s?.llm?.url || "http://127.0.0.1:1234", style: fieldStyle });
  const comfyStatus = h("div.hint", { style: { minHeight: "15px", marginTop: "3px" } });
  const llmStatus = h("div.hint", { style: { minHeight: "15px", marginTop: "3px" } });

  const detect = (what, input, status, label) => async () => {
    status.textContent = "Probing the usual addresses…";
    status.style.color = "";
    try {
      const r = await api.detect(what);
      const hits = r[what] || [];
      if (!hits.length) {
        status.textContent = `Nothing answered. Start ${label} (with CORS on — see below) and press Detect again, or type its address.`;
        status.style.color = "var(--warn, #d99a35)";
        return;
      }
      input.value = hits[0].url;
      status.textContent = `Found: ${hits.map(x => x.url + (x.device ? ` (${x.device})` : x.flavour ? ` (${x.flavour})` : "")).join(" · ")}`;
      status.style.color = "var(--ok, #5aa06a)";
    } catch (err) {
      status.textContent = err.message;
      status.style.color = "var(--warn, #d99a35)";
    }
  };

  const row = (label, input, btnClick, status) => h("div", { style: { marginBottom: "8px" } },
    h("div.hint", { style: { marginBottom: "3px", fontSize: "11px", textTransform: "uppercase", letterSpacing: ".06em" } }, label),
    h("div", { style: { display: "flex", gap: "6px" } },
      input,
      h("button.btn.sm", { onclick: btnClick, style: { flex: "none" } }, "Detect")),
    status,
  );

  const body = h("div",
    h("div.note.info", { style: { marginTop: "0" } },
      h("b", "Welcome. "),
      "This editor runs entirely on your side of the wire: everything you make stays in ", h("b", "this browser"),
      " (export a backup any time from Setup), and the two engines it drives — ComfyUI for rendering, a local LLM for the prompt work — run on ",
      h("b", "your own machine"), ". Nothing is uploaded anywhere."),

    h("h4.sec", "Where are the engines?"),
    h("div.hint", { style: { marginBottom: "8px" } },
      "Neither has to be running right now — without them this is still a full prompt editor with previz and checks, and the workflow downloads as a ComfyUI graph."),
    row("ComfyUI — renders the clips", comfyIn, detect("comfy", comfyIn, comfyStatus, "ComfyUI"), comfyStatus),
    row("LLM server — writes and critiques with you (LM Studio · Ollama · llama.cpp)", llmIn, detect("llm", llmIn, llmStatus, "the LLM server"), llmStatus),

    h("div.note", { style: { marginTop: "6px" } },
      h("b", "One flag each, once: "),
      "a web page may only call a local server that answers CORS. Start ComfyUI with ",
      h("span.mono", "--enable-cors-header"),
      "; LM Studio has a CORS switch under Developer settings; Ollama takes ",
      h("span.mono", "OLLAMA_ORIGINS=*"),
      ". (The downloadable local app proxies both instead — no flags anywhere.)"),

    h("h4.sec", { style: { marginTop: "12px" } }, "Which model for the director?"),
    h("div.hint", { style: { lineHeight: "1.55" } },
      h("b", "Gemma 3 12B"), " (instruct) is the sweet spot: strong prose, reliable JSON, and it has ",
      h("b", "vision"), " — so the interview and “Describe with the LLM” can actually read your reference images. ~8 GB in Q4. ",
      "Smaller cards: Gemma 3 4B or Llama 3.1 8B. Big cards: Gemma 3 27B or Qwen3 32B (keep Thinking Off — the default). ",
      "VRAM saver means the LLM and the video model take turns on the card, so run the best model your card fits."),
  );

  const save = async () => {
    try {
      await saveSettings({ comfy: { url: comfyIn.value.trim() }, llm: { url: llmIn.value.trim() } });
    } catch (err) {
      toast("Could not save the addresses", err.message, "err");
    }
  };

  markSeen();
  return modal({
    title: "First-use setup",
    wide: true,
    body,
    actions: [
      { label: "Skip for now", onClick: (done) => done(false) },
      { label: "Save, then read the guide", onClick: async (done) => { await save(); done(true); showQuickGuide(); } },
      { label: "Save & start", kind: "primary", onClick: async (done) => { await save(); toast("Ready", "Both addresses live on Setup whenever you need them.", "ok"); done(true); } },
    ],
  });
}

/** Show once, on the hosted version only. Resolves true when the wizard was
 *  shown (the caller then skips its own first-run guide). */
export function maybeShowFirstRun() {
  if (LOCAL_SERVER || seen()) return Promise.resolve(false);
  return new Promise((resolve) => {
    setTimeout(() => { showFirstRunSetup(); resolve(true); }, 400);
  });
}
