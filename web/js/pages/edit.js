/* EDIT — the cut. Deliver makes clips; this puts them after one another.
 *
 * Three panels, like Deliver: what there is to cut (renders, dropped files),
 * the timeline itself with the export under it, and the two things that
 * make a clip out of a render — a voice-over laid under the cut, and a quick
 * five-second intro, B-roll or outro generated from one line.
 *
 * Every number on this page comes from edit.js's planner, and every change
 * goes through its draft helpers inside update() — so the cut is undoable,
 * saved with the project, and shows the same durations the export will use.
 * The export itself is ffmpeg on the local Cut app; the hosted version keeps
 * the timeline and says where to take it.
 */

import { h, mount, toast, select, segmented, checkbox, textarea, group, row, bytes, readFileAsDataURL } from "../util.js";
import { getProject, update, onProjectSwap } from "../state.js";
import {
  editPlan, exportBody, ensureEdit, renderOutput,
  addRenderClip, addMediaClip, addAudio, moveClip, removeClip, setClip, setAudio, removeAudio,
} from "../edit.js";
import { generateVoiceover, VOICE_ENGINES, VOICE_LANGS } from "../voice.js";
import { voiceoverScript } from "../llm.js";
import { api } from "../api.js";
import { getHealth } from "../config.js";
import { currentJob, onRenderChange, patchLive } from "../render.js";
import { ingest, getBlob, posterFor } from "../media.js";
import { library } from "../library.js";
import { humanTime } from "../workflow.js";
import { resolveButton, resolveGroup, onResolveChange } from "../resolve.js";

let root = null;
let unsub = null;

/* ── Per-project state ──────────────────────────────────────
 * Everything here belongs to ONE project and is reset when another one is
 * opened — see onProjectSwap at the bottom. */
let sel = null;          // { kind: "clip" | "audio", id }
let exportRun = null;    // { running, result: { id, duration, bytes, width, height, v }, error }
let quickPrompt = "";
let quickRole = "broll";
let quickSeconds = 5;
let quickBusy = false;
let quickStatus = "";
let voBusy = false;
let libRows = null;      // renders from OTHER projects, once the library answers

/* ── Machine state — outlives the project ─────────────────── */
let voiceHealth = null;         // { qwen: {ok,…}, voxcpm: {…} } once fetched
let voiceHealthAsked = false;
const voicesByEngine = {};      // engine → { voices, default } | "loading"
const blobUrls = new Map();     // media id → data URL, so a redraw can set <video src> synchronously
const posters = new Map();      // clip id → poster data URL (render clips, grabbed from the file)
let quickMod = null;            // quickgen.js, loaded on first use
let quickModLoading = null;
let quickModError = null;

/* quickgen.js is loaded on first use rather than at boot: it is the newest
 * module on this page and the one most likely to be mid-change — a missing
 * import there should cost the Quick clip box, not the whole app. */
function quickgen() {
  if (quickMod) return Promise.resolve(quickMod);
  quickModLoading ||= import("../quickgen.js")
    .then((m) => { quickMod = m; quickModError = null; return m; })
    .catch((err) => { quickModError = err.message; quickModLoading = null; throw err; });
  return quickModLoading;
}

const PPS = 22;            // pixels per second on the strip
const MIN_CLIP_PX = 64;
const clipPx = (length) => Math.max(MIN_CLIP_PX, Math.round((length || 0) * PPS));

const VO_DEFAULTS = { text: "", language: "de", engine: "qwen", voice: "default", speed: 1, instruct: "" };
const voOf = (p) => ({ ...VO_DEFAULTS, ...(p.edit?.voiceover || {}) });
function setVo(patch, reason = "edit") {
  update((d) => {
    ensureEdit(d);
    d.edit.voiceover ||= { ...VO_DEFAULTS };
    Object.assign(d.edit.voiceover, patch);
  }, reason);
  if (reason !== "text") refresh();
}

const EXPORT_SIZES = [["", "first clip's size"], ["832x480", "832 × 480"], ["1280x720", "1280 × 720"], ["1920x1080", "1920 × 1080"], ["3840x2160", "3840 × 2160"]];

const renderRunning = () => { const j = currentJob(); return !!j && ["queued", "running"].includes(j.status); };

/** A data URL the page can hand a <video> right now, fetching it for next time if not. */
function blobUrl(mediaId) {
  if (blobUrls.has(mediaId)) return blobUrls.get(mediaId);
  getBlob(mediaId).then((data) => { if (data) { blobUrls.set(mediaId, data); refresh(); } });
  return null;
}

/** Length of a sound file, from the browser's decoder. 0 when it cannot say. */
function audioSeconds(dataUrl) {
  return new Promise((resolve) => {
    if (!dataUrl) return resolve(0);
    const a = document.createElement("audio");
    const bail = setTimeout(() => resolve(0), 5000);
    a.preload = "metadata";
    a.onloadedmetadata = () => { clearTimeout(bail); resolve(Number.isFinite(a.duration) ? a.duration : 0); };
    a.onerror = () => { clearTimeout(bail); resolve(0); };
    a.src = dataUrl;
  });
}

/* ── Adding things ───────────────────────────────────────── */
function addRender(job) {
  let clip = null;
  update((d) => { clip = addRenderClip(d, job); }, "shots");
  if (!clip) return toast("No video in that render", "", "warn");
  sel = { kind: "clip", id: clip.id };
  toast("On the timeline", clip.name, "ok");
  refresh();
}

async function importClips(fileList) {
  for (const file of [...fileList]) {
    let item;
    try { item = await ingest(file); } catch (err) { toast("Could not read the file", `${file.name}: ${err.message}`, "err"); continue; }
    if (item.kind !== "video") { toast("Not a video", `${file.name} — a sound file goes under Import audio.`, "warn"); continue; }
    item.poster = await posterFor(await getBlob(item.id));
    let clip = null;
    update((d) => { clip = addMediaClip(d, item); }, "shots");
    if (!clip) continue;
    sel = { kind: "clip", id: clip.id };
    refresh();
    probeClip(clip.id, item.id);
  }
}

/** Ask the server how long a dropped clip is. Best effort: the plan copes
 *  with an unknown length, and the export probes again anyway. */
async function probeClip(clipId, mediaId) {
  try {
    const r = await api.editProbe({ mediaId });
    const patch = {};
    if (r?.duration > 0) patch.duration = r.duration;
    if (r?.width > 0) patch.width = r.width;
    if (r?.height > 0) patch.height = r.height;
    if (!Object.keys(patch).length) return;
    update((d) => setClip(d, clipId, patch), "shots");
    refresh();
  } catch { /* the plan says "?" and the export asks ffprobe */ }
}

async function importAudio(fileList) {
  for (const file of [...fileList]) {
    let item;
    try { item = await ingest(file); } catch (err) { toast("Could not read the file", `${file.name}: ${err.message}`, "err"); continue; }
    if (item.kind !== "audio" && item.kind !== "video") { toast("Not a sound file", file.name, "warn"); continue; }
    item.duration = await audioSeconds(await getBlob(item.id));
    let track = null;
    update((d) => { track = addAudio(d, item); }, "shots");
    if (!track) continue;
    sel = { kind: "audio", id: track.id };
    refresh();
  }
}

/* ── Left: sources ───────────────────────────────────────── */
function loadLibrary() {
  library.list({ limit: 200 }).then((r) => {
    const mine = getProject().id;
    const here = new Set((getProject().jobs || []).map(j => j.id));
    libRows = (r.rows || []).filter(e => e.status === "done" && renderOutput(e)?.filename
      && !(e.project?.id && e.project.id === mine) && !here.has(e.jobId));
    refresh();
  }).catch(() => { libRows = []; });
}

function sourceRow(job, label, meta) {
  const out = renderOutput(job);
  const thumb = h("video.src-thumb", {
    src: api.viewUrl(out), preload: "metadata", playsinline: "", loop: "",
    title: "Hover to play",
    onmouseenter: (e) => { e.currentTarget.play().catch(() => {}); },
    onmouseleave: (e) => { e.currentTarget.pause(); try { e.currentTarget.currentTime = 0; } catch { /* not seekable yet */ } },
  });
  thumb.muted = true;
  return h("div.src-row",
    thumb,
    h("div", { style: { minWidth: "0" } },
      h("div.name", { title: label }, label),
      h("div.meta", meta)),
    h("button.btn.sm", { title: "Put it at the end of the timeline", onclick: () => addRender(job) }, "＋ Add"),
  );
}

function sourcesPanel(p) {
  const jobs = (p.jobs || []).filter(j => j.status === "done" && renderOutput(j)?.filename);
  const clipInput = h("input", { type: "file", accept: "video/*", multiple: "", style: { display: "none" },
    onchange: (e) => { importClips(e.target.files); e.target.value = ""; } });
  const audioInput = h("input", { type: "file", accept: "audio/*,.mp3,.wav,.m4a,.flac,.ogg", multiple: "", style: { display: "none" },
    onchange: (e) => { importAudio(e.target.files); e.target.value = ""; } });

  const zone = (input, title, hint, onFiles) => h("div.dropzone", {
    onclick: () => input.click(),
    ondragover: (e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.add("over"); },
    ondragleave: (e) => e.currentTarget.classList.remove("over"),
    ondrop: (e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove("over"); onFiles(e.dataTransfer.files); },
  }, h("div", title), h("div.hint", { style: { marginTop: "3px" } }, hint));

  return h("div.panel",
    h("div.hd", h("span.title", "Sources"), h("span.spacer"),
      h("button.btn.sm.ghost", { title: "Look again in the library", onclick: () => { libRows = null; refresh(); } }, "⟳")),
    h("div.bd",
      clipInput, audioInput,
      h("h4.sec", { style: { padding: "10px 10px 4px" } }, "Renders"),
      jobs.length
        ? h("div", ...jobs.map(j => sourceRow(j,
            j.variantLabel || `${j.mode?.toUpperCase() || ""} · ${j.meta?.variantLabel || "render"}`,
            `${j.settingsSnapshot?.resolution || ""} · ${j.settingsSnapshot?.duration || "?"}s · ${new Date(j.at).toLocaleTimeString()}`)))
        : h("div.empty-state.tight", h("div.hint", "Nothing rendered in this project yet. Deliver's finished clips appear here; the Quick clip box on the right makes one from a line.")),
      libRows?.length ? h("div",
        h("h4.sec", { style: { padding: "10px 10px 4px" } }, "From the library"),
        ...libRows.slice(0, 40).map(e => sourceRow(e, e.name || e.variantLabel || "render",
          `${e.settings?.resolution || ""} · ${e.settings?.duration || "?"}s · ${new Date(e.at).toLocaleDateString()}`)),
      ) : null,
      h("div", { style: { padding: "12px 10px 4px" } },
        h("h4.sec", "Import clip"),
        zone(clipInput, "Drop a video here, or click to browse", "mp4, mov, webm — it is probed for its length and size", importClips)),
      h("div", { style: { padding: "8px 10px 12px" } },
        h("h4.sec", "Import audio"),
        zone(audioInput, "Drop a sound file here, or click to browse", "mp3, wav — laid under the cut from the start", importAudio)),
    ),
  );
}

/* ── Centre: the timeline ────────────────────────────────── */
function previewFor(p, clip) {
  if (clip) {
    const src = clip.kind === "media" ? blobUrl(clip.mediaId) : (clip.output ? api.viewUrl(clip.output) : null);
    if (src) return h("video", { src, controls: "", playsinline: "", muted: clip.mute ? "" : null });
    return h("div.empty", h("div.big", "▣"), h("div.t", clip.name), h("div.hint", { style: { marginTop: "6px" } }, "Loading the file…"));
  }
  const r = exportRun?.result;
  if (r) return h("video", { src: `${api.filmUrl(r.id)}&v=${r.v}`, controls: "", playsinline: "" });
  return h("div.empty", h("div.big", "⧉"),
    h("div.t", "Nothing selected"),
    h("div.hint", { style: { marginTop: "6px" } }, "Click a clip on the strip to play it here. The export plays here too when it lands."));
}

function strip(p, plan) {
  const clips = p.edit?.clips || [];
  const blocks = plan.clips.map((pc, i) => {
    const c = clips[i];
    const on = sel?.kind === "clip" && sel.id === c.id;
    const poster = c.poster || posters.get(c.id) || null;
    if (!poster && c.kind === "render" && c.output && !posters.has(c.id)) {
      // Best effort: same-origin files give a frame; a cross-origin ComfyUI
      // taints the canvas and the block keeps its gradient.
      posters.set(c.id, null);
      posterFor(api.viewUrl(c.output)).then((img) => { if (img) { posters.set(c.id, img); refresh(); } });
    }
    return h("div", {
      class: `clip${on ? " sel" : ""}${c.kind === "media" ? " media" : ""}${poster ? " poster" : ""}`,
      style: { width: `${clipPx(pc.length)}px`, ...(poster ? { backgroundImage: `url("${poster}")` } : {}) },
      title: `${pc.name} — ${pc.length != null ? `${pc.length.toFixed(1)} s` : "length unknown until probed"}${pc.mute ? " · muted" : ""}`,
      onclick: () => { sel = { kind: "clip", id: c.id }; refresh(); },
    },
      h("span.n", `${i + 1}`),
      h("span.d", pc.name),
      h("span.t", pc.length != null ? `${pc.length.toFixed(1)}s` : "?"),
      pc.mute ? h("span.muted", "mute") : null,
    );
  });
  const totalPx = blocks.reduce((n, b) => n + parseInt(b.style.width, 10) + 2, 0);

  const audio = p.edit?.audio || [];
  const lane = h("div.lane", { style: { minWidth: `${Math.max(totalPx, 200)}px` } },
    audio.length ? null : h("span.lbl", "audio — import a sound file or generate a voice-over"),
    ...audio.map((a) => {
      const on = sel?.kind === "audio" && sel.id === a.id;
      const w = Math.max(60, Math.round((a.duration || 3) * PPS));
      return h("div", {
        class: `a${on ? " sel" : ""}`,
        style: { left: `${Math.round((a.at || 0) * PPS)}px`, width: `${w}px` },
        title: `${a.name} — at ${a.at || 0}s${a.duration ? `, ${a.duration.toFixed(1)} s` : ""}, gain ${a.gain ?? 1}`,
        onclick: () => { sel = { kind: "audio", id: a.id }; refresh(); },
      }, `♪ ${a.name}`);
    }),
  );

  return h("div.tl-edit",
    h("div.strip", blocks.length ? blocks
      : h("div.empty.hint", "Add a render from the left, drop a clip, or generate a quick one — they line up here in order.")),
    lane,
  );
}

function clipInspector(p, clip, plan) {
  const i = p.edit.clips.findIndex(c => c.id === clip.id);
  const pc = plan.clips[i] || {};
  const set = (patch, reason = "shots") => { update((d) => setClip(d, clip.id, patch), reason); if (reason !== "text") refresh(); };
  const num = (v) => (v === "" ? "" : Number(v));

  return group(`Clip ${i + 1}`, {
    id: "e-clip", icon: "▣", accordion: false, open: true,
    badge: clip.kind === "media" ? "file" : "render",
    help: "In and out are seconds into the file; leave out empty to run to the end. Mute drops this clip's own soundtrack from the export — anything on the audio lane still plays under it.",
  },
    row("Name", h("input", { type: "text", value: clip.name || "", oninput: (e) => set({ name: e.target.value }, "text"), onchange: () => refresh() })),
    row("Order", h("div.btn-row",
      h("button.btn.sm", { class: `btn sm${i === 0 ? " disabled" : ""}`, title: "Earlier", onclick: () => { update((d) => moveClip(d, clip.id, -1), "shots"); refresh(); } }, "▲"),
      h("button.btn.sm", { class: `btn sm${i >= p.edit.clips.length - 1 ? " disabled" : ""}`, title: "Later", onclick: () => { update((d) => moveClip(d, clip.id, 1), "shots"); refresh(); } }, "▼"),
      h("span.hint.mono", `${i + 1} of ${p.edit.clips.length} · starts at ${(pc.at || 0).toFixed(1)}s`),
    )),
    row("Sound", checkbox("Mute this clip's own sound", !!clip.mute, (v) => set({ mute: v }))),
    row("Trim", h("div.flex",
      h("input", { type: "number", min: "0", step: "0.1", value: String(clip.in ?? 0), title: "In — seconds into the file", style: { width: "70px" },
        onchange: (e) => set({ in: num(e.target.value) }) }),
      h("span.hint", "→"),
      h("input", { type: "number", min: "0", step: "0.1", value: clip.out == null ? "" : String(clip.out), placeholder: "end", title: "Out — empty runs to the end", style: { width: "70px" },
        onchange: (e) => set({ out: num(e.target.value) }) }),
      h("span.hint.mono", pc.length != null ? `${pc.length.toFixed(1)} s` : "? s"),
    ), clip.duration
      ? `The file is ${clip.duration.toFixed(1)} s${clip.width ? ` at ${clip.width}×${clip.height}` : ""}.`
      : "The file's length is not known yet — the export probes it."),
    h("div.btn-row", { style: { marginTop: "6px" } },
      h("button.btn.sm.ghost", { onclick: () => { update((d) => removeClip(d, clip.id), "shots"); sel = null; refresh(); } }, "✕ Remove from the timeline")),
  );
}

function audioInspector(p, track) {
  const set = (patch, reason = "shots") => { update((d) => setAudio(d, track.id, patch), reason); if (reason !== "text") refresh(); };
  return group("Audio", {
    id: "e-audio", icon: "♪", accordion: false, open: true,
    badge: track.voiceover ? "voice-over" : track.kind === "video" ? "clip's sound" : "file",
    help: "Laid under the cut, not instead of it: the clips' own sound stays unless a clip is muted. `At` is where it starts, in seconds from the head of the timeline; gain 1 is as recorded.",
  },
    row("Name", h("input", { type: "text", value: track.name || "", oninput: (e) => set({ name: e.target.value }, "text"), onchange: () => refresh() })),
    row("At", h("div.flex",
      h("input", { type: "number", min: "0", step: "0.1", value: String(track.at ?? 0), style: { width: "80px" }, onchange: (e) => set({ at: Number(e.target.value) }) }),
      h("span.hint", "s from the start"))),
    row("Gain", h("div.flex",
      h("input", { type: "number", min: "0", max: "4", step: "0.05", value: String(track.gain ?? 1), style: { width: "80px" }, onchange: (e) => set({ gain: Number(e.target.value) }) }),
      h("span.hint", track.duration ? `${track.duration.toFixed(1)} s long` : ""))),
    h("div.btn-row", { style: { marginTop: "6px" } },
      h("button.btn.sm.ghost", { onclick: () => { update((d) => removeAudio(d, track.id), "shots"); sel = null; refresh(); } }, "✕ Remove")),
  );
}

function exportGroup(p, plan) {
  const exp = p.edit?.export || {};
  const setExport = (patch) => { update((d) => Object.assign(ensureEdit(d).export, patch), "shots"); refresh(); };
  const noFfmpeg = getHealth()?.ffmpeg === false;
  const sizeKey = exp.width > 0 && exp.height > 0 ? `${exp.width}x${exp.height}` : "";
  const sizes = EXPORT_SIZES.some(s => s[0] === sizeKey) ? EXPORT_SIZES : [...EXPORT_SIZES, [sizeKey, sizeKey]];
  const busy = !!exportRun?.running;
  const result = exportRun?.result;

  return group("Export", {
    id: "e-export", icon: "⬇", accordion: false, open: true,
    badge: plan.width ? `${plan.width}×${plan.height}` : "first clip",
    help: "One ffmpeg pass on the local Cut app: every clip is trimmed and scaled to the frame, joined, and the audio lane mixed under it. Exporting again replaces the last export of this project.",
  },
    row("Name", h("input", { type: "text", value: exp.name || "", placeholder: p.name || "edit",
      oninput: (e) => update((d) => { ensureEdit(d).export.name = e.target.value; }, "text") })),
    row("Frame rate", segmented([["24", "24"], ["25", "25"], ["30", "30"]], String(plan.fps), (v) => setExport({ fps: Number(v) }))),
    row("Size", select(sizes, sizeKey, (v) => {
      const m = /^(\d+)x(\d+)$/.exec(v);
      setExport(m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 0, height: 0 });
    }), sizeKey ? "Every clip is scaled to this frame." : `The first clip's own size${plan.width ? ` — ${plan.width}×${plan.height}` : ", once it has been probed"}.`),
    noFfmpeg
      ? h("div.note.warn", { style: { marginTop: "7px" } },
          h("b", "Export needs the local Cut app. "),
          "This version has no ffmpeg. The timeline is saved with the project — open it in the local app at ",
          h("code", "http://127.0.0.1:3091"), " and export from there.")
      : h("div.btn-row", { style: { marginTop: "7px" } },
          busy
            ? h("button.btn.wide.disabled", {}, "Exporting…")
            : h("button.btn.wide.record", {
                class: `btn wide record${plan.ok ? "" : " disabled"}`,
                title: plan.ok ? "Cut it together and encode one file" : plan.problems[0],
                onclick: () => doExport(p),
              }, `⧉ Export ${plan.clips.length ? `${plan.clips.length} clip${plan.clips.length === 1 ? "" : "s"}` : ""}`)),
    ...plan.problems.map(m => h("div.hint.warn", { style: { marginTop: "5px" } }, `⚠ ${m}`)),
    exportRun?.error ? h("div.note.bad", { style: { marginTop: "7px" } }, exportRun.error) : null,
    result ? h("div", { style: { marginTop: "9px" } },
      h("video", { src: `${api.filmUrl(result.id)}&v=${result.v}`, controls: "", playsinline: "", style: { width: "100%", borderRadius: "6px", background: "#000" } }),
      h("div.hint", { style: { marginTop: "6px" } },
        `${humanTime(result.duration || 0)} · ${bytes(result.bytes || 0)}${result.width ? ` · ${result.width}×${result.height}` : ""} · ${plan.fps} fps`),
      h("div.btn-row", { style: { marginTop: "6px" } },
        h("a.btn.sm", { href: `${api.filmUrl(result.id)}&v=${result.v}`, download: `${(exp.name || p.name || "edit").replace(/[^\w-]+/g, "_").slice(0, 40)}.mp4` }, "⬇ Download"),
        h("button.btn.sm.ghost", { title: "Show the export in the viewer", onclick: () => { sel = null; refresh(); } }, "Play above")),
    ) : null,
  );
}

async function doExport(p) {
  if (exportRun?.running) return;
  const plan = editPlan(p);
  if (!plan.ok) return toast("Not ready to export", plan.problems[0], "warn");
  exportRun = { running: true, result: null, error: null };
  refresh();
  try {
    const r = await api.editExport(exportBody(p));
    exportRun = { running: false, result: { ...r, v: Date.now() }, error: null };
    sel = null;
    toast("Exported", `${humanTime(r.duration || 0)} · ${bytes(r.bytes || 0)}`, "ok");
  } catch (err) {
    const msg = err.code === "no-ffmpeg"
      ? "This version has no ffmpeg — open the project in the local Cut app (http://127.0.0.1:3091) to export."
      : err.message;
    exportRun = { running: false, result: null, error: msg };
    toast("Export failed", msg, "err");
  }
  refresh();
}

function timelinePanel(p, plan) {
  const clips = p.edit?.clips || [];
  const audio = p.edit?.audio || [];
  const clip = sel?.kind === "clip" ? clips.find(c => c.id === sel.id) : null;
  const track = sel?.kind === "audio" ? audio.find(a => a.id === sel.id) : null;
  if (sel && !clip && !track) sel = null;

  const totals = `${plan.clips.length} clip${plan.clips.length === 1 ? "" : "s"} · ${humanTime(plan.duration)}`
    + (plan.clips.some(c => c.length == null) ? "+" : "")
    + ` · ${plan.width ? `${plan.width}×${plan.height}` : "size of the first clip"} · ${plan.fps} fps`
    + (audio.length ? ` · ${audio.length} audio` : "");

  return h("div.panel.edit-timeline",
    h("div.hd", h("span.title", "Timeline"), h("span.spacer"), resolveButton(p, { compact: true }),
      h("span", { class: `badge ${plan.ok ? "ok" : clips.length ? "busy" : ""}` }, h("span.dot"),
        plan.ok ? "ready to export" : clips.length ? `${plan.problems.length} to fix` : "empty"),
    ),
    h("div.bd", { style: { display: "flex", flexDirection: "column", padding: "0" } },
      h("div.viewer", h("div.surface", previewFor(p, clip))),
      strip(p, plan),
      h("div.tl-edit-totals", totals),
      h("div.insp",
        clip ? clipInspector(p, clip, plan)
          : track ? audioInspector(p, track)
          : clips.length ? h("div.empty-state.tight", h("div.hint", "Select a clip on the strip to name, trim, mute or move it — or a sound on the lane to place it.")) : null,
        resolveGroup(p),
        exportGroup(p, plan),
      ),
    ),
  );
}

/* ── Right: the voice-over ───────────────────────────────── */
function askVoiceHealth() {
  if (voiceHealthAsked) return;
  voiceHealthAsked = true;
  api.voiceHealth().then((r) => { voiceHealth = r?.engines && !r.qwen ? r.engines : r; refresh(); })
    .catch(() => { voiceHealth = { error: true }; });
}

function loadVoices(engine) {
  if (voicesByEngine[engine]) return;
  voicesByEngine[engine] = "loading";
  api.voices(engine).then((r) => { voicesByEngine[engine] = r || { voices: [], default: "default" }; refresh(); })
    .catch(() => { voicesByEngine[engine] = { voices: [], default: "default", failed: true }; refresh(); });
}

function healthDot(engine) {
  const e = voiceHealth?.[engine];
  const cls = !voiceHealth || voiceHealth.error ? "" : e?.ok ? (e.loaded === false && !e.wakeable ? "warm" : "ok") : "bad";
  const title = !voiceHealth ? "checking…" : voiceHealth.error ? "no voice server" : e?.ok ? (e.loaded === false ? "reachable, loads on first use" : "loaded") : "not reachable";
  return h("span", { class: `vdot ${cls}`, title });
}

async function draftScript(p, plan) {
  const vo = voOf(p);
  try {
    const r = await voiceoverScript(getProject(), { seconds: plan.duration || p.render?.duration, language: vo.language });
    if (!r.script) throw new Error("the model returned an empty script");
    setVo({ text: r.script });
    toast("Script drafted", `${r.script.split(/\s+/).filter(Boolean).length} words — read it before you speak it.`, "ok");
  } catch (err) { toast("Could not draft the script", err.message, "err"); }
}

async function speak(p) {
  if (voBusy) return;
  const vo = voOf(p);
  const text = String(vo.text || "").trim();
  if (!text) return toast("Nothing to say", "Write or draft the script first.", "");
  voBusy = true; refresh();
  try {
    const n = (p.edit?.audio || []).filter(a => a.voiceover).length + 1;
    const item = await generateVoiceover({ engine: vo.engine, text, voice: vo.voice || "default", language: vo.language, speed: Number(vo.speed) || 1, instruct: vo.engine === "voxcpm" ? vo.instruct : "", name: `Voice-over ${n}` });
    let track = null;
    update((d) => { track = addAudio(d, item); if (track) track.voiceover = true; }, "shots");
    if (track) sel = { kind: "audio", id: track.id };
    toast("Voice-over on the lane", `${(item.duration || 0).toFixed(1)} s, from the start — move it in the inspector.`, "ok");
  } catch (err) {
    toast(err.code === "no-local" ? "Voice-over needs the local Cut app" : "Could not generate the voice-over",
      err.code === "no-local" ? "The hosted version has no speech server; the script is saved with the project." : err.message, "err");
  } finally { voBusy = false; refresh(); }
}

function cloneForm(p) {
  const vo = voOf(p);
  const name = h("input", { type: "text", placeholder: "Voice name" });
  const file = h("input", { type: "file", accept: "audio/*,video/*" });
  const transcript = h("textarea", { rows: 2, placeholder: "What is said in the clip (optional, helps the clone)", spellcheck: "false" });
  const btn = h("button.btn.sm", {
    onclick: async () => {
      const f = file.files?.[0];
      if (!f) return toast("Pick a clip first", "5–30 seconds of one person speaking, no music.", "");
      if (!name.value.trim()) return toast("Name the voice", "", "");
      btn.classList.add("disabled"); btn.textContent = "adding…";
      try {
        const data = await readFileAsDataURL(f);
        const secs = await audioSeconds(data);
        if (secs && (secs < 5 || secs > 30)) toast("Outside 5–30 s", `${secs.toFixed(1)} s — the clone may be rough.`, "warn");
        const r = await api.addVoice({ engine: vo.engine, name: name.value.trim(), data, transcript: transcript.value.trim(), engines: ["qwen", "voxcpm"] });
        for (const k of Object.keys(voicesByEngine)) delete voicesByEngine[k];
        setVo({ voice: r.id || name.value.trim() });
        toast("Voice added", `${name.value.trim()} — on both engines.`, "ok");
      } catch (err) {
        toast(err.code === "no-local" ? "Cloning needs the local Cut app" : "Could not add the voice", err.message, "err");
      } finally { btn.classList.remove("disabled"); btn.textContent = "Add voice"; }
    },
  }, "Add voice");
  return h("div", { style: { marginTop: "8px" } },
    h("h4.sec", "Clone a voice"),
    h("div.flex", { style: { marginBottom: "5px" } }, name, btn),
    file,
    h("div", { style: { marginTop: "5px" } }, transcript),
    h("div.hint", { style: { marginTop: "4px" } }, "A 5–30 s clip of one voice, no music. Saved for both engines under this name."),
  );
}

function voiceGroup(p, plan) {
  const vo = voOf(p);
  askVoiceHealth();
  loadVoices(vo.engine);
  const voices = voicesByEngine[vo.engine];
  const list = voices && voices !== "loading" ? voices.voices || [] : [];
  const options = [["default", `default${voices?.default && voices.default !== "default" ? ` · ${voices.default}` : ""}`],
    ...list.filter(v => v.id !== "default").map(v => [v.id, `${v.name || v.id}${v.lang ? ` · ${v.lang}` : ""}${v.builtin ? "" : " · cloned"}`])];
  if (vo.voice && !options.some(o => o[0] === vo.voice)) options.push([vo.voice, vo.voice]);
  const words = String(vo.text || "").trim().split(/\s+/).filter(Boolean).length;
  const seconds = plan.duration || p.render?.duration || 0;

  return group("Voice-over", {
    id: "e-voice", icon: "🎙", accordion: false, open: true,
    badge: vo.engine === "voxcpm" ? "VoxCPM2" : "Qwen3",
    help: "Spoken on this machine by the local Cut app and laid on the audio lane as a file, from the start. The script, engine, voice and speed are saved with the project; the speech is not regenerated unless you ask.",
  },
    row("Engine", segmented(VOICE_ENGINES.map(([k, label, title]) => [k, h("span", healthDot(k), label), title]), vo.engine,
      (v) => setVo({ engine: v, voice: "default" }), "stack")),
    row("Language", select(VOICE_LANGS, vo.language, (v) => setVo({ language: v }))),
    row("Voice", h("div.flex",
      select(options, vo.voice || "default", (v) => setVo({ voice: v }), { class: "grow" }),
      h("button.btn.sm.ghost", { title: "Reload the voice list", onclick: () => { delete voicesByEngine[vo.engine]; voiceHealthAsked = false; refresh(); } }, "⟳")),
      voices === "loading" ? "asking the server for its voices…" : voices?.failed ? "the voice server did not answer — the default voice still works" : ""),
    row("Speed", segmented([["0.85", "slower"], ["1", "1×"], ["1.15", "faster"]], String(vo.speed), (v) => setVo({ speed: Number(v) }))),
    vo.engine === "voxcpm" ? row("Style", h("input", { type: "text", value: vo.instruct || "", placeholder: "style note, e.g. ruhig und freundlich",
      oninput: (e) => setVo({ instruct: e.target.value }, "text") }), "VoxCPM2 takes a note on the delivery on top of the voice.") : null,
    h("div", { style: { marginTop: "4px" } },
      h("div.flex", { style: { marginBottom: "4px" } },
        h("label.i-label", { style: { flex: "1" } }, "Script"),
        h("span.hint.mono", words ? `${words} words${seconds ? ` · ~${Math.round(words / 2.3)} s of ${humanTime(seconds)}` : ""}` : "")),
      textarea(vo.text || "", (v) => setVo({ text: v }, "text"), { rows: 7, placeholder: "What the narrator says over the cut…" }),
      h("div.btn-row", { style: { marginTop: "6px" } },
        h("button.btn.sm.ai", {
          title: "The director writes narration for the cut as it stands, at a pace a narrator can speak",
          onclick: async (e) => { const b = e.currentTarget; b.classList.add("disabled"); b.textContent = "writing…"; try { await draftScript(p, plan); } finally { b.classList.remove("disabled"); b.textContent = "✨ AI: draft the script"; } },
        }, "✨ AI: draft the script"),
        h("span.spacer", { style: { flex: "1" } }),
        voBusy
          ? h("button.btn.sm.disabled", {}, "Speaking…")
          : h("button.btn.sm.primary", { class: `btn sm primary${words ? "" : " disabled"}`, onclick: () => speak(p) }, "🎙 Generate voice-over"),
      )),
    cloneForm(p),
  );
}

/* ── Right: the quick clip ───────────────────────────────── */
async function writeQuickLine(btn) {
  btn.classList.add("disabled"); btn.textContent = "writing…";
  try {
    const { quickBrief, QUICK_ROLES } = await quickgen();
    const role = QUICK_ROLES.find(r => r[0] === quickRole) || QUICK_ROLES[1];
    const r = await api.chat({
      json: true,
      system: "You write ONE line that a video model turns into a short clip. Return exactly {\"line\":\"…\"} — a single sentence of at most 25 words: the subject, the place, the light, one thing moving. Concrete and visual, no hashtags, no quotation marks, no camera directions, no dialogue.",
      prompt: `${quickBrief(getProject())}\nThe clip's role: ${role[1]} — ${role[2]}\nLength: ${quickSeconds} seconds.${quickPrompt.trim() ? `\nThe rough idea so far: ${quickPrompt.trim()}` : ""}\nWrite the line.`,
      maxTokens: 200,
    });
    const line = String(r?.json?.line || "").trim();
    if (!line) throw new Error("the model returned no line");
    quickPrompt = line;
    refresh();
  } catch (err) { toast("Could not write the line", err.message, "err"); }
  finally { btn.classList.remove("disabled"); btn.textContent = "✨ AI: write the line"; }
}

async function runQuick() {
  if (quickBusy || renderRunning()) return;
  const prompt = quickPrompt.trim();
  if (!prompt) return toast("Write the line first", "One sentence is enough — or let the AI write it.", "");
  let mod;
  try { mod = await quickgen(); } catch (err) { return toast("Quick clip is unavailable", err.message, "err"); }
  quickBusy = true; quickStatus = "starting…"; refresh();
  try {
    const job = await mod.quickRender({ prompt, seconds: quickSeconds, role: quickRole, onStep: (m) => { quickStatus = m; refresh(); } });
    if (job?.status === "done" && renderOutput(job)?.filename) {
      let clip = null;
      update((d) => { clip = addRenderClip(d, job); }, "shots");
      if (clip) { sel = { kind: "clip", id: clip.id }; toast("Quick clip on the timeline", clip.name, "ok"); }
    } else {
      toast("Quick clip failed", job?.error || "no video came back", "err");
    }
  } catch (err) {
    if (err.message !== "cancelled") toast("Quick clip failed", err.message, "err");
  } finally { quickBusy = false; quickStatus = ""; refresh(); }
}

function quickGroup() {
  const job = currentJob();
  const running = renderRunning();
  const roles = quickMod?.QUICK_ROLES || [["intro", "Intro"], ["broll", "B-roll"], ["outro", "Outro"]];
  if (!quickMod && !quickModError && !quickModLoading) quickgen().then(() => refresh()).catch(() => refresh());

  const bar = running ? h("div", { style: { marginTop: "7px" } },
    h(`div.progress${!job.progress ? ".indet" : ""}`,
      h("i", { style: { width: `${Math.round((job.progress || 0) * 100)}%` } }),
      h("span", { "data-live": "deliver" }, job.status === "running" ? `${job.step || 0}/${job.steps || "?"} — ${job.node ? `node ${job.node}` : "starting"}` : job.status)),
    h("div.hint", { style: { marginTop: "4px" } }, quickBusy ? quickStatus : `A render is running (${job.variantLabel || job.name || "Deliver"}) — the quick clip waits for the GPU.`),
  ) : quickStatus ? h("div.hint", { style: { marginTop: "6px" } }, quickStatus) : null;

  return group("Quick clip", {
    id: "e-quick", icon: "⚡", accordion: false, open: true,
    badge: `${quickSeconds}s`,
    help: "An intro, a piece of B-roll or an outro from one line — a throwaway copy of this project (same engine, canvas and look) with a single shot, on the fastest build, rendered into this project's history and put straight on the timeline.",
  },
    quickModError ? h("div.note.bad", { style: { marginBottom: "8px" } }, `Quick clip is unavailable: ${quickModError}`) : null,
    row("Role", segmented(roles.map(r => [r[0], r[1], r[2]]), quickRole, (v) => { quickRole = v; refresh(); })),
    row("Line", h("input", { type: "text", value: quickPrompt, placeholder: "e.g. a lighthouse at dusk, the beam sweeping the fog",
      oninput: (e) => { quickPrompt = e.target.value; } })),
    row("Length", segmented([["5", "5 s"], ["10", "10 s"]], String(quickSeconds), (v) => { quickSeconds = Number(v); refresh(); })),
    h("div.btn-row", { style: { marginTop: "4px" } },
      h("button.btn.sm.ai", { title: "One visual sentence in the project's own look", onclick: (e) => writeQuickLine(e.currentTarget) }, "✨ AI: write the line"),
      h("span.spacer", { style: { flex: "1" } }),
      quickBusy || running
        ? h("button.btn.sm.disabled", {}, quickBusy ? "Rendering…" : "GPU busy")
        : h("button.btn.sm.record", { onclick: () => runQuick() }, "● Generate"),
    ),
    bar,
  );
}

function rightPanel(p, plan) {
  return h("div.panel",
    h("div.hd", h("span.title", "Voice-over & quick clip")),
    h("div.bd", h("div.insp", voiceGroup(p, plan), quickGroup())),
  );
}

/* ── The page ────────────────────────────────────────────── */
function draw() {
  const p = getProject();
  const plan = editPlan(p);
  if (libRows === null) { libRows = []; loadLibrary(); }
  mount(root, h("div.cols", sourcesPanel(p), timelinePanel(p, plan), rightPanel(p, plan)));
}

onProjectSwap(() => {
  sel = null;
  exportRun = null;
  quickPrompt = "";
  quickStatus = "";
  libRows = null;
  posters.clear();
});

export function render(el) {
  root = el;
  /* Live news (the bar, the node name) is patched in place; only a state
   * change rebuilds. Deliver goes through applyLive, which rebuilds when a
   * preview frame has no img.live to land in — this page shows no frames, so
   * that path would redraw the inspector under your cursor a few times a
   * second while a quick clip renders. */
  if (!unsub) unsub = onRenderChange((job, kind) => {
    if (!root || !root.classList.contains("active")) return;
    if (kind === "live") patchLive(root, job); else draw();
  });
  draw();
}
export function refresh() { if (root) draw(); }
onResolveChange(() => { if (root?.classList.contains("active")) draw(); });

export const shortcuts = {
  Delete: () => {
    if (!sel) return;
    update((d) => (sel.kind === "audio" ? removeAudio(d, sel.id) : removeClip(d, sel.id)), "shots");
    sel = null; refresh();
  },
  Backspace: () => shortcuts.Delete(),
};
