/* MOTIONSTILL CUT — the render pipeline.
 *
 * Two endings, one road: build the graph from the timeline, then either hand
 * the JSON to the browser or hand it to ComfyUI. Sending it also uploads
 * whatever media the graph references, follows the job to completion, and —
 * in VRAM saver mode — makes sure the LLM is off the card before the DiT goes
 * on (the server does the eviction; this only has to ask in the right order).
 */

import { api, openComfyProgress } from "./api.js";
import { explainRenderError } from "./rendererrors.js";
import { saveJobOutputs } from "./downloads.js";
import { getSettings } from "./config.js";
import { getProject, update, onProjectSwap, activeEngine } from "./state.js";
import { buildWorkflow, estimateSeconds, deliveredSize } from "./workflow.js";
import { watermarkSettings, watermarkLayout, watermarkFileName, drawWatermark } from "./watermark.js";
import { getBlob } from "./media.js";
import { uid, toast } from "./util.js";
import { library, recordFor } from "./library.js";

const CLIENT_ID = `mscut-${uid()}`;

let current = null;               // the job in flight
const watchers = new Set();

export const onRenderChange = (fn) => { watchers.add(fn); return () => watchers.delete(fn); };
/* Two kinds of news. "state" is a transition — queued, running, done, an
 * error, outputs — and the pages rebuild for it. "live" is the bar moving,
 * the node name, the sampler's preview frame: several a second, and a page
 * that rebuilt for each one restarted every <video> on it, dropped the
 * focus out of whatever was being typed, and flickered. Live news is
 * coalesced to a few a second and patched into the page in place. */
const emit = (kind = "state") => { for (const fn of watchers) { try { fn(current, kind); } catch (e) { console.error(e); } } };
let liveTimer = null;
const live = () => {
  if (liveTimer) return;
  liveTimer = setTimeout(() => { liveTimer = null; emit("live"); }, 120);
};

/** Patch the live parts of a page in place. Pages tag what moves:
 *   .progress > i          width = progress; .indet while nothing is known
 *   [data-live="deliver"]  "3/8 — node X" (Deliver's bar caption)
 *   [data-live="steps"]    "3/8" | "queued" | "starting"
 *   [data-live="node"]     "node X"
 *   img.live               the sampler's latest preview frame
 * Returns false when the page needs a real rebuild (the first preview
 * frame has nowhere to go yet). */
export function patchLive(root, job) {
  if (!root || !job) return true;
  const running = ["queued", "running"].includes(job.status);
  const known = job.steps > 0 && job.step > 0;
  const pct = Math.round((job.progress || 0) * 100);
  root.querySelectorAll(".progress").forEach(el => {
    const i = el.querySelector("i");
    if (i) i.style.width = known ? `${pct}%` : "";
    el.classList.toggle("indet", running && !known);
  });
  root.querySelectorAll('[data-live="deliver"]').forEach(el => {
    el.textContent = job.status === "running"
      ? `${job.step || 0}/${job.steps || "?"} — ${job.node ? `node ${job.node}` : "starting"}`
      : job.status;
  });
  root.querySelectorAll('[data-live="steps"]').forEach(el => {
    el.textContent = known ? `${job.step}/${job.steps}` : job.status === "queued" ? "queued" : "starting";
  });
  root.querySelectorAll('[data-live="node"]').forEach(el => { el.textContent = job.node ? `node ${job.node}` : ""; });
  if (job.preview && running) {
    const imgs = root.querySelectorAll("img.live");
    if (!imgs.length) return false;
    imgs.forEach(img => { if (img.src !== job.preview) img.src = job.preview; });
  }
  return true;
}

/** What a page's onRenderChange handler does: rebuild on state, patch on live. */
export function applyLive(root, job, kind, draw) {
  if (kind !== "live" || !patchLive(root, job)) draw();
}
export const currentJob = () => current;

/* A finished render outlives its render. `current` is never cleared once a job
 * completes, and both the Deliver viewer and the canvas's Render node draw
 * whatever is in it as long as it has outputs — so opening a different project
 * showed an empty timeline with the PREVIOUS project's clip autoplaying under
 * it. A render still running is left alone: it belongs to the project that
 * started it and will finish there. */
onProjectSwap(() => {
  if (current && !["done", "error", "cancelled"].includes(current.status)) return;
  if (current?.preview) URL.revokeObjectURL(current.preview);
  current = null;
  emit();
});


/**
 * What this file is called inside ComfyUI's input folder.
 *
 * NOT what the user called it. ComfyUI/input is one flat namespace, the upload
 * route overwrites by default, and the graph addresses media by bare filename
 * — so two projects that each contain a `hero.png` were one upload away from
 * silently swapping bytes. The second project's upload clobbers the first's
 * file; the first project still cites "hero.png" and renders with the second
 * project's picture, with no error anywhere and nothing on screen to show it.
 *
 * The media id is already unique and already travels with the item, so it is
 * what the ComfyUI-side key is built from. The user's own name is kept on the
 * item and is still what every label in the app shows.
 */
export function uploadName(item) {
  const clean = String(item.name || "file")
    .replace(/[^\w.-]+/g, "_")   // one flat folder, so nothing that is a path
    .replace(/\.{2,}/g, ".")     // and no ".." left over from one
    .replace(/^[._-]+/, "")
    .slice(-64) || "file";       // keep the tail: that is where the extension is
  return `mscut_${item.id}_${clean}`;
}

/** The watermark PNG for this delivery, drawn at the delivered size and put
 *  in ComfyUI/input under a name that repeats for the same mark, so a
 *  re-render overwrites it. Null when the mark is off or the name is blank. */
async function uploadWatermark(p, settings, onStep = () => {}) {
  const { mode, text } = watermarkSettings(p, settings);
  if (mode === "off" || !text) return null;
  const { width, height } = deliveredSize(p);
  const layout = watermarkLayout(mode, width, height, text);
  onStep("Drawing the watermark…");
  const dataUrl = drawWatermark({ mode, text, width, height });
  const r = await api.upload(watermarkFileName(mode, text, width, height), dataUrl);
  const file = r?.subfolder ? `${r.subfolder}/${r.name}` : r?.name;
  return { file, mode, x: layout.x, y: layout.y };
}

/** Everything the graph expects to find in ComfyUI/input, uploaded if it isn't
 *  there yet. Returns the media list with comfyName filled in. */
export async function uploadPending(onStep = () => {}, ctx = null) {
  /* `ctx` lets the queue render a SNAPSHOT rather than the live project: the
   * uploaded filenames have to be written back into whatever object is being
   * rendered, or the same file is uploaded again on every run. */
  const p = ctx?.project || getProject();
  const commit = ctx?.commit || update;
  const pending = [];
  const collect = (item, where) => { if (item && !item.comfyName) pending.push({ item, where }); };
  if (p.mode === "i2v") collect(p.frames.first, "first");
  if (p.mode === "r2v") {
    (p.refs.images || []).forEach(m => collect(m, "images"));
    (p.refs.videos || []).forEach(m => collect(m, "videos"));
    (p.refs.audios || []).forEach(m => collect(m, "audios"));
  }
  // Shot keyframe pins and the conditioning track ride only in the LTX
  // graph, so they upload only when that graph is about to be built — the
  // MiniMax modes never need the bytes.
  if (activeEngine(p) === "ltx25") {
    (p.shots || []).forEach(s => { if (s.keyframe) collect(s.keyframe, `kf:${s.id}`); });
    collect(p.render?.ltxAudio?.item, "ltxAudio");
    collect(p.render?.ltxVoice?.item, "ltxVoice");
  }
  let done = 0;
  for (const { item, where } of pending) {
    onStep(`Uploading ${item.name}…`, ++done, pending.length);
    const data = await getBlob(item.id);
    if (!data) throw new Error(`${item.name} is no longer in the media pool — re-add it on the Media page.`);
    const r = await api.upload(uploadName(item), data);
    const comfyName = r.subfolder ? `${r.subfolder}/${r.name}` : r.name;
    commit((proj) => {
      if (where === "first" && proj.frames.first?.id === item.id) proj.frames.first.comfyName = comfyName;
      else if (where === "ltxAudio") {
        if (proj.render?.ltxAudio?.item?.id === item.id) proj.render.ltxAudio.item.comfyName = comfyName;
      } else if (where === "ltxVoice") {
        if (proj.render?.ltxVoice?.item?.id === item.id) proj.render.ltxVoice.item.comfyName = comfyName;
      } else if (where.startsWith("kf:")) {
        const s = (proj.shots || []).find(x => x.id === where.slice(3));
        if (s?.keyframe?.id === item.id) s.keyframe.comfyName = comfyName;
      } else {
        const list = proj.refs[where] || [];
        const m = list.find(x => x.id === item.id);
        if (m) m.comfyName = comfyName;
      }
    }, "media");
  }
  return pending.length;
}

export function buildNow() {
  return buildWorkflow(getProject(), getSettings() || { models: {} });
}

/**
 * Queue the current timeline on ComfyUI and follow it to the end.
 * Progress arrives over ComfyUI's WebSocket when the browser can reach it, and
 * over /history polling when it can't — the job completes either way.
 */
export async function renderNow({
  onStep = () => {}, experimentId = null, variantLabel = null,
  /* A queued item renders its own snapshot. Everything downstream — the graph,
   * the job record, the library entry — is built from THIS project rather than
   * from whatever happens to be open, so queueing a clip and then editing it
   * cannot change what comes out of the queue. */
  project = null, commit = null,
} = {}) {
  if (current && !["done", "error", "cancelled"].includes(current.status)) {
    throw new Error("A render is already running.");
  }
  const live = !project;
  const p = project || getProject();
  const settings = getSettings() || { models: {} };

  onStep("Uploading media…");
  await uploadPending((msg) => onStep(msg), live ? null : { project: p, commit });
  const watermark = await uploadWatermark(p, settings, onStep);

  const { prompt, meta, compiled } = buildWorkflow(p, settings, { watermark });
  onStep("Queueing on ComfyUI…");

  current = {
    id: uid(), promptId: null, at: Date.now(), mode: p.mode, name: p.name,
    status: "queued", progress: 0, step: 0, steps: meta.steps, node: "",
    meta, outputs: [], error: null, eta: estimateSeconds(p),
    // What made this clip, kept with it: the exact text that went to the
    // encoder and the settings behind it. Without this, "which prompt was
    // that one?" is unanswerable an hour later.
    promptText: compiled.text,
    experimentId, variantLabel,
    settingsSnapshot: {
      mode: p.mode, engine: meta.engine || "minimax",
      resolution: p.render.resolution, duration: p.render.duration,
      variant: p.render.variant, seed: meta.seed, precision: p.render.precision,
      refImageSize: p.render.refImageSize, tiledDecode: p.render.tiledDecode,
    },
  };
  emit();

  let queued;
  try {
    /* ComfyUI defaults to --preview-method none, and a ComfyUI started
     * without the flag sends no frames at all. Since 0.3.x a prompt can ask
     * for its own preview method in extra_data — so ask, and the switch on
     * Setup is the only thing that has to be on. */
    const wantPreviews = getSettings()?.comfy?.previews !== false;
    queued = await api.queue(prompt, CLIENT_ID, wantPreviews ? { preview_method: "auto" } : undefined);
  } catch (err) {
    current.status = "error";
    current.error = err.message;
    emit();
    throw err;
  }
  current.promptId = queued.prompt_id || queued.promptId || null;
  current.status = "running";
  if (queued.gpu?.evicted?.engine === "llm" && queued.gpu.evicted.unloaded) {
    toast("VRAM saver", `Unloaded ${queued.gpu.evicted.unloaded} LLM model(s) before queueing.`, "ok");
  }
  emit();

  // ComfyUI's per-step progress only exists on its socket. When the browser
  // cannot open it (a tunnel, a locked-down box) the poll below still finishes
  // the job — just without the bar moving between steps.
  const comfyUrl = settings.comfy?.url || "";
  const socket = openComfyProgress(comfyUrl, CLIENT_ID, {
    filterPromptId: current.promptId,
    onProgress: (value, max) => {
      if (!current) return;
      current.sawProgress = true;
      current.step = value; current.steps = max || current.steps;
      current.progress = max ? value / max : 0;
      live();
    },
    onNode: (node) => { if (current) { current.node = node || ""; live(); } },
    /* The sampler's own frames, as they come. Each replaces the last, and the
     * previous object URL is revoked immediately — a 30-second render at 4 fps
     * would otherwise leak a hundred blobs into the tab. */
    onPreview: (blob) => {
      if (!current || getSettings()?.comfy?.previews === false) return;
      current.sawPreview = true;
      const url = URL.createObjectURL(blob);
      if (current.preview) URL.revokeObjectURL(current.preview);
      current.preview = url;
      current.previewAt = Date.now();
      live();
    },
    onError: (d) => {
      if (!current) return;
      const why = explainRenderError(d?.exception_message, { nodeType: d?.node_type });
      current.status = "error"; current.error = why.message; current.errorKind = why.kind; current.errorInfo = why;
      emit();
    },
  });

  try {
    const finished = await pollHistory(current.promptId, () => emit());
    if (current) {
      current.outputs = finished.outputs || [];
      current.status = finished.status?.status_str === "error" ? "error" : "done";
      if (current.status === "error") {
        const why = describeError(finished);
        current.error = why.message; current.errorKind = why.kind; current.errorInfo = why;
      } else {
        current.error = null; current.errorKind = null; current.errorInfo = null;
      }
      current.progress = 1;
      current.tookMs = Date.now() - current.at;
      // The real output is about to replace it.
      if (current.preview) { URL.revokeObjectURL(current.preview); current.preview = null; }
      emit();
      /* Into the user's own folder, when one is chosen (Deliver ▸ Download
       * folder). ComfyUI keeps its copy regardless; this is the one the
       * user asked for, where they asked for it. */
      if (current.status === "done" && current.outputs.length) {
        const r = await saveJobOutputs(current);
        if (current) { current.savedTo = r.saved; current.saveError = r.error; emit(); }
      }
      const job = { ...current };
      /* Onto the project this render was FOR, not whatever happens to be open
       * when it lands. renderNow already takes a `commit` for exactly this and
       * the completion handler ignored it, so a queue run finishing while the
       * user was starting something new wrote the old project's compiled
       * prompt and output files into the new one — where they were then
       * persisted, and uploaded on the next save as if they belonged to it. */
      (commit || update)((proj) => { proj.jobs = [job, ...(proj.jobs || [])].slice(0, 25); }, "jobs");
      // Into the library, always. A render you cannot find again taught you
      // nothing, and the judgement comes later — often much later.
      library.save(recordFor(job, p))
        .then((r) => { if (current) current.libraryId = r?.entry?.id || null; })
        .catch((err) => console.warn("[library] could not record the render:", err.message));
    }
    return current;
  } finally {
    socket.close();
  }
}

function describeError(entry) {
  const msgs = entry.messages || [];
  for (const m of msgs) {
    if (Array.isArray(m) && m[0] === "execution_error") {
      const d = m[1] || {};
      return explainRenderError(d.exception_message || d.exception_type, { nodeType: d.node_type });
    }
  }
  return { kind: "other", message: "ComfyUI reported an execution error — check its console." };
}

async function pollHistory(promptId, tick) {
  if (!promptId) throw new Error("ComfyUI did not return a prompt id.");
  const started = Date.now();
  for (;;) {
    await new Promise(r => setTimeout(r, 1500));
    if (!current || current.status === "cancelled") throw new Error("cancelled");
    let r;
    try { r = await api.history(promptId); }
    catch { continue; }                       // a blip in the poll is not a failure
    if (r.done) return r;
    if (current) { current.elapsed = Date.now() - started; tick(); }
  }
}

/**
 * A seed ladder: the same prompt N times with N different seeds, queued one
 * after another. The most useful thing you can do with a prompt you believe
 * in — H3's variance between seeds is large enough that one clip is a sample,
 * not a result.
 */
export async function renderBatch(count, { onStep = () => {}, onEach = () => {}, experimentId = null } = {}) {
  const results = [];
  const base = getProject().render.seed;
  const runId = experimentId || `seeds-${uid()}`;
  for (let i = 0; i < count; i++) {
    // A fresh seed per run, and the pin is restored afterwards so the batch
    // doesn't quietly rewrite the project's settings.
    update((p) => { p.render.seed = base >= 0 ? base + i : Math.floor(Math.random() * 0xffffffffff); }, "render");
    onStep(`Variation ${i + 1} of ${count}…`);
    try {
      const job = await renderNow({
        onStep: (m) => onStep(`Variation ${i + 1}/${count} — ${m}`),
        experimentId: runId,
        variantLabel: `seed ${getProject().render.seed}`,
      });
      results.push(job);
      onEach(job, i);
    } catch (err) {
      update((p) => { p.render.seed = base; }, "render");
      throw err;
    }
  }
  update((p) => { p.render.seed = base; }, "render");
  return results;
}

export async function cancelRender() {
  if (!current) return;
  current.status = "cancelled";
  emit();
  try { await api.interrupt(); } catch { /* it may already be finished */ }
}
