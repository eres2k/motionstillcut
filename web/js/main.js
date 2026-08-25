/* MOTIONSTILL CUT — boot, page routing and the chrome.
 *
 * Five pages, one project object, two servers. Everything else is in the
 * modules; this file only wires them to the window. */

import { $, $$, h, toast, debounce, modal, closeModal, download, copyText } from "./util.js";
import {
  loadProject, getProject, update, subscribe, replaceProject, blankProject,
  exportProject, MODES, undo, redo, canUndo, canRedo, duplicateShot, selectedShot,
  normaliseMedia, forgetUploads,
  activeEngine, setEngine, ENGINES, H3_DURATION, LTX25_DURATION,
} from "./state.js";
import { loadState, refreshHealth, refreshVram, getHealth, getSettings, saveSettings } from "./config.js";
import { currentJob, onRenderChange } from "./render.js";
import { showQuickGuide, maybeShowOnFirstRun } from "./quickguide.js";
import { maybeShowFirstRun, showFirstRunSetup } from "./firstrun.js";
import { registerCommands, togglePalette, isPaletteOpen, closePalette } from "./palette.js";
import { pickCharacter, castLine, loadKnownCast } from "./knowncast.js";
import { api, onAuthState, signIn } from "./api.js";
import { TEMPLATES } from "./templates.js";
import { validate, compilePrompt, setHouseRules, setCast } from "./prompt.js";
import { rulebook, cast } from "./library.js";
import { estimateSeconds, humanTime } from "./workflow.js";
import { ingest, kindOf, posterFor, getBlob } from "./media.js";
import { startResizers, resetAllSizes } from "./resize.js";
import { applyUiScale, stepUiScale, uiScale } from "./uiscale.js";

import * as projectsPage from "./pages/projects.js";
import * as createPage from "./pages/create.js";
import * as simplePage from "./pages/simple.js";
import * as mediaPage from "./pages/media.js";
import * as cutPage from "./pages/cut.js";
import * as soundPage from "./pages/sound.js";
import * as deliverPage from "./pages/deliver.js";
import * as libraryPage from "./pages/library.js";
import * as setupPage from "./pages/setup.js";

const PAGES = {
  projects: { mod: projectsPage, el: null, drawn: false },
  create:  { mod: createPage,  el: null, drawn: false },
  simple:  { mod: simplePage,  el: null, drawn: false },
  media:   { mod: mediaPage,   el: null, drawn: false },
  cut:     { mod: cutPage,     el: null, drawn: false },
  sound:   { mod: soundPage,   el: null, drawn: false },
  deliver: { mod: deliverPage, el: null, drawn: false },
  library: { mod: libraryPage, el: null, drawn: false },
  setup:   { mod: setupPage,   el: null, drawn: false },
};

let activePage = "cut";
let lastStudioPage = "cut";

function showPage(name) {
  if (!PAGES[name]) return;
  activePage = name;
  // Simple mode is one canvas: the page bar and the studio chrome would only
  // be a second way to do the same thing.
  document.body.classList.toggle("simple-view", name === "simple");
  document.body.classList.toggle("create-view", name === "create");
  document.body.classList.toggle("projects-view", name === "projects");
  const view = name === "simple" ? "simple"
    : name === "create" ? "create"
      : name === "projects" ? "projects" : "studio";
  $$("#view-seg button, .stepbtn").forEach(b => b.classList.toggle("on", b.dataset.view === view));
  // The pair dims while you are in Create: it is the step before them, not a
  // third peer alongside them.
  $(".viewflow")?.classList.toggle("at-create", view === "create" || view === "projects");
  for (const [key, page] of Object.entries(PAGES)) {
    page.el.classList.toggle("active", key === name);
  }
  $$(".page-btn").forEach(b => b.classList.toggle("active", b.dataset.page === name));
  if (name !== "simple" && name !== "create" && name !== "projects") lastStudioPage = name;
  const page = PAGES[name];
  if (!page.drawn) { page.mod.render(page.el); page.drawn = true; }
  else page.mod.refresh?.();
  try { history.replaceState(null, "", `#${name}`); } catch { /* file:// */ }
}

/* Only structural changes redraw — typing into a textarea must never rebuild
 * the DOM under the cursor, which is what the "text" reason means. */
const refreshActive = debounce(() => PAGES[activePage]?.drawn && PAGES[activePage].mod.refresh?.(), 40);

/* ── Title-bar chrome ─────────────────────────────────────── */
function paintBadges() {
  const health = getHealth();
  const v = health.vram || {};
  const job = currentJob();

  const gpu = $("#badge-gpu");
  const owner = v.owner === "comfy" ? "ComfyUI" : v.owner === "llm" ? "LLM" : "idle";
  gpu.className = `badge${v.owner === "comfy" ? " gpu-comfy" : v.owner === "llm" ? " gpu-llm" : ""}${job && ["queued", "running"].includes(job.status) ? " busy" : ""}`;
  gpu.querySelector(".txt").textContent = v.saver ? `GPU · ${owner}` : "GPU shared";
  gpu.title = v.saver
    ? `VRAM saver is on — one engine at a time.\n${v.lastAction || "Nothing has claimed the card yet."}`
    : "VRAM saver is off — ComfyUI and the LLM may both hold the card.";

  const comfy = $("#badge-comfy");
  comfy.className = `badge ${health.comfy?.ok ? "ok" : "bad"}`;
  comfy.title = health.comfy?.ok
    ? `ComfyUI ${health.comfy.version || ""} · ${health.comfy.device || ""}${health.comfy.vramTotalGB ? ` · ${health.comfy.vramFreeGB ?? "?"}/${health.comfy.vramTotalGB} GB free` : ""}`
    : `ComfyUI is not answering at ${getSettings()?.comfy?.url || "?"}`;

  const llm = $("#badge-llm");
  llm.className = `badge ${health.llm?.ok ? "ok" : "bad"}`;
  llm.title = health.llm?.ok
    ? `${(health.llm.models || []).length} model(s) at ${getSettings()?.llm?.url}`
    : `No LLM server at ${getSettings()?.llm?.url || "?"}`;
}

function paintTitlebar() {
  const p = getProject();
  const name = $("#project-name");
  if (document.activeElement !== name) name.value = p.name;
  const badge = $("#mode-badge");
  if (badge) {
    const inputs = (p.frames?.first ? 1 : 0) + (p.refs?.images || []).length
      + (p.refs?.videos || []).length + (p.refs?.audios || []).length;
    badge.replaceChildren(
      h("span.dot"),
      document.createTextNode(MODES[p.mode].label),
    );
    badge.title = `${MODES[p.mode].label} — ${inputs === 0
      ? "nothing is attached"
      : inputs === 1 && p.mode === "i2v"
        ? "one picture, which anchors the first frame"
        : `${inputs} references attached`}. The mode follows from what you attach.`;
  }
  /* The engine is a render setting, but it decides what the timeline may
   * do — 15 s or 30 s, pins or no pins — so it is shown beside the mode on
   * every page, not only on Deliver. */
  const eng = $("#engine-badge");
  if (eng) {
    const engine = activeEngine(p);
    const label = ENGINES[engine]?.label || engine;
    eng.classList.toggle("ok", engine === "ltx25");
    eng.replaceChildren(h("span.dot"), document.createTextNode(label));
    eng.disabled = p.mode === "r2v";
    eng.title = p.mode === "r2v"
      ? "Ref2V renders on MiniMax H3 only — LTX-2.5 has no reference pipeline."
      : engine === "ltx25"
        ? `${label} (experimental) — same compiled prompt, up to ${LTX25_DURATION.max} s, timeline pins. Click to switch to MiniMax H3.`
        : `${label} — up to ${H3_DURATION.max} s, no timeline pins. Click to switch to LTX-2.5 (experimental).`;
  }
}

/* The footer's left corner is a real status bar: what the prompt currently
 * weighs, what it would cost, and whether anything is wrong with it. */
const paintStatus = debounce(() => {
  const p = getProject();
  const el = $("#status-line");
  if (!el) return;
  let report;
  try { report = validate(p); } catch { return; }
  const eta = humanTime(estimateSeconds(p));
  el.innerHTML = "";
  el.append(
    h("span", {
      class: `badge ${report.pristine ? "" : report.errors ? "bad" : report.warnings ? "busy" : "ok"}`,
      title: report.pristine ? "Nothing written yet" : "Prompt checks",
    },
      h("span.dot"),
      report.pristine ? "empty timeline"
        : report.errors ? `${report.errors} error${report.errors === 1 ? "" : "s"}`
        : report.warnings ? `${report.warnings} warning${report.warnings === 1 ? "" : "s"}` : "checks pass"),
    h("span.hint", `${report.wordCount} words`),
    h("span.hint", `${p.shots.length} shot${p.shots.length === 1 ? "" : "s"} · ${p.render.duration}s`),
    h("span.hint", `≈ ${eta}`),
    h("span.hint.faint", { id: "save-state" }, "saved"),
  );
}, 200);

async function doSaveProject() {
  const { saveProject } = await import("./projects.js");
  try {
    const r = await saveProject();
    toast("Saved", r.missed
      ? `${r.missed} media file(s) could not be found in this browser and were not sent.`
      : `“${getProject().name}” is on the server.`, r.missed ? "warn" : "ok");
    if (activePage === "projects") PAGES.projects.mod.reload?.();
  } catch (err) {
    toast("Could not save", err.message, "err");
  }
}

/* The director exists in both views. Which one answers is whichever one you
 * are already in — being thrown into a different layout to ask a question is
 * the opposite of help. Create has no inspector of its own, so it hands over
 * to the canvas it is there to build. */
function askDirector(request = "", runner = null) {
  if (activePage === "simple" || activePage === "create") {
    showPage("simple");
    return simplePage.askDirector(request, runner);
  }
  showPage("cut");
  return cutPage.askDirector(request, runner);
}

/* ── Keyboard ─────────────────────────────────────────────── */
const PAGE_KEYS = { "`": "create", 0: "simple", 1: "media", 2: "cut", 3: "sound", 4: "deliver", 5: "library", 6: "setup", 9: "projects" };

function onKey(e) {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;

  if (e.key === "F1") { e.preventDefault(); return showQuickGuide(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); return togglePalette(); }
  /* The app scales itself rather than letting the browser do it: this layout is
   * a full-height grid, and browser zoom leaves you panning a scaled page with
   * the chrome half off screen. */
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    // The browser's own Save is a page of HTML nobody wants; this is the one
    // people mean.
    e.preventDefault();
    return doSaveProject();
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === "+" || e.key === "=")) {
    e.preventDefault();
    const n = stepUiScale(1); return toast("Interface size", `${Math.round(n * 100)}%`, "ok");
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === "-" || e.key === "_")) {
    e.preventDefault();
    const n = stepUiScale(-1); return toast("Interface size", `${Math.round(n * 100)}%`, "ok");
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "j") {
    e.preventDefault();
    return askDirector("");
  }
  if (e.key === " " && e.shiftKey && !typing) { e.preventDefault(); return simplePage.openReadthrough(); }
  if (e.key === "Escape") { closePalette(); closeModal(null); return; }
  if (isPaletteOpen()) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    const moved = e.shiftKey ? redo() : undo();
    if (!moved) return toast(e.shiftKey ? "Nothing to redo" : "Nothing to undo", "", "");
    Object.values(PAGES).forEach(pg => pg.drawn && pg.mod.refresh?.());
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
    e.preventDefault();
    if (redo()) Object.values(PAGES).forEach(pg => pg.drawn && pg.mod.refresh?.());
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
    e.preventDefault();
    const sel = selectedShot(getProject());
    if (sel) { duplicateShot(sel.id); toast("Shot duplicated", "", "ok"); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    showPage("deliver");
    return deliverPage.doRender(getProject());
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    return doExportProject();
  }
  if (typing) return;

  if (PAGE_KEYS[e.key]) { e.preventDefault(); return showPage(PAGE_KEYS[e.key]); }
  const fn = PAGES[activePage]?.mod.shortcuts?.[e.key];
  if (fn) { e.preventDefault(); fn(); }
}

function doExportProject() {
  const p = getProject();
  download(`${(p.name || "timeline").replace(/[^\w-]+/g, "_")}.mscut.json`, exportProject());
  toast("Project exported", "Media stays in the browser — re-attach files after importing.", "ok");
}

async function doImportProject() {
  const input = h("input", { type: "file", accept: ".json,application/json", style: { display: "none" } });
  document.body.appendChild(input);
  input.onchange = async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      // It came from another machine — nothing in it is in this ComfyUI yet.
      replaceProject(forgetUploads(data));
      Object.values(PAGES).forEach(p => { p.drawn = false; });
      showPage(activePage);
      paintTitlebar();
      toast("Project loaded", data.name || file.name, "ok");
    } catch (err) { toast("Could not read the project", err.message, "err"); }
  };
  input.click();
}

/* ── Commands ─────────────────────────────────────────────── */
function installCommands() {
  const go = (page) => () => showPage(page);
  registerCommands([
    { id: "page.create",  group: "Go to", label: "Create — material, steering, takes", hint: "`", keywords: ["guided", "start", "new", "idea"], run: go("create") },
    { id: "page.simple",  group: "Go to", label: "Simple node canvas", hint: "0", keywords: ["node", "easy", "quick"], run: go("simple") },
    { id: "page.media",   group: "Go to", label: "Media pool",  hint: "1", run: go("media") },
    { id: "page.cut",     group: "Go to", label: "Cut",         hint: "2", run: go("cut") },
    { id: "page.sound",   group: "Go to", label: "Sound",       hint: "3", run: go("sound") },
    { id: "page.deliver", group: "Go to", label: "Deliver",     hint: "4", run: go("deliver") },
    { id: "page.library", group: "Go to", label: "Library — every render and its prompt", hint: "5", keywords: ["history", "compare", "rated"], run: go("library") },
    { id: "page.setup",   group: "Go to", label: "Setup",       hint: "6", run: go("setup") },

    /* No "switch to T2V" any more — the mode is what the media says it is. The
     * command explains that rather than pretending to offer a choice. */
    { id: "mode.explain", group: "Mode", label: "What decides the generation mode?",
      keywords: ["t2v", "i2v", "r2v", "ref2v", "switch", "mode"],
      run: () => {
        const p = getProject();
        const n = (p.frames?.first ? 1 : 0) + (p.refs?.images || []).length
          + (p.refs?.videos || []).length + (p.refs?.audios || []).length;
        toast(MODES[p.mode].label,
          `It follows from what you attach — nothing is Text to Video, one picture is Image to Video, more is Reference to Video. You have ${n} attached. Add or remove media to change it.`,
          "");
      } },

    { id: "shot.add", group: "Timeline", label: "Add a shot at the playhead", hint: "＋", run: () => { showPage("cut"); cutPage.addShotAt(getProject().render.duration / 2); } },
    { id: "shot.dup", group: "Timeline", label: "Duplicate the selected shot", hint: "⌘D", run: () => { const s2 = selectedShot(getProject()); if (s2) duplicateShot(s2.id); } },
    { id: "tpl.open", group: "Timeline", label: "Shot structures (templates)…", keywords: ["template", "structure", "preset"], run: () => { showPage("cut"); cutPage.openTemplates(); } },
    ...TEMPLATES.map(t => ({
      id: `tpl.${t.key}`, group: "Templates", label: `Apply template — ${t.name}`, hint: `${t.duration}s`,
      keywords: [t.key, t.blurb], run: () => { showPage("cut"); cutPage.applyTemplate(t); },
    })),

    /* The director, from anywhere. It edits the project rather than handing
     * back text, so it belongs beside the other verbs and not on one page. */
    { id: "ai.ask", group: "Director", label: "Ask the director…", hint: "⌘J",
      keywords: ["llm", "ai", "assistant", "help", "change"],
      run: () => askDirector("") },
    { id: "ai.check", group: "Director", label: "Check this prompt — what will go wrong",
      keywords: ["llm", "review", "critique", "problems"],
      run: async () => {
        const { critique } = await import("./agent.js");
        askDirector("", (p) => critique(p));
      } },
    { id: "ai.next", group: "Director", label: "That didn't work — what to change",
      keywords: ["llm", "fix", "diagnose", "retry", "again"],
      run: async () => {
        const { nextTake } = await import("./agent.js");
        const p = getProject();
        askDirector("", () => nextTake(p, p.jobs?.slice(-1)[0]?.verdict));
      } },

    { id: "project.manager", group: "Project", label: "Projects — open, save, start a new one", hint: "9",
      keywords: ["open", "load", "new", "save", "manager", "recent", "template", "starter"],
      run: () => showPage("projects") },
    { id: "project.save", group: "Project", label: "Save this project to the server", hint: "⌘S",
      keywords: ["save", "store", "persist", "server"],
      run: () => doSaveProject() },

    { id: "view.bigger", group: "Viewer", label: "Make the interface bigger", hint: "⌘+",
      keywords: ["zoom", "scale", "text size", "larger", "accessibility", "mobile"],
      run: () => { const n = stepUiScale(1); toast("Interface size", `${Math.round(n * 100)}%`, "ok"); } },
    { id: "view.smaller", group: "Viewer", label: "Make the interface smaller", hint: "⌘−",
      keywords: ["zoom", "scale", "text size", "smaller", "compact"],
      run: () => { const n = stepUiScale(-1); toast("Interface size", `${Math.round(n * 100)}%`, "ok"); } },

    { id: "view.sizes", group: "Viewer", label: "Put every panel back to its default size",
      keywords: ["resize", "layout", "reset", "columns", "width", "panel"],
      run: () => { resetAllSizes(); toast("Layout reset", "Every section is back to its default size.", "ok"); } },

    { id: "view.readthrough", group: "Viewer", label: "Readthrough — watch the whole prompt play", hint: "⇧Space",
      keywords: ["play", "preview", "timeline", "simulate", "score", "what will it do"],
      run: () => simplePage.openReadthrough() },
    { id: "view.previz", group: "Viewer", label: "Previz — play the prompt back", hint: "Space", run: () => { showPage("cut"); cutPage.setViewerMode("previz"); } },
    { id: "view.prompt", group: "Viewer", label: "Show the compiled prompt", run: () => { showPage("cut"); cutPage.setViewerMode("prompt"); } },
    { id: "view.checks", group: "Viewer", label: "Show the prompt checks", run: () => { showPage("cut"); cutPage.setViewerMode("checks"); } },

    { id: "render.now",   group: "Render", label: "Render on ComfyUI", hint: "⌘⏎", run: () => { showPage("deliver"); deliverPage.doRender(getProject()); } },
    { id: "render.json",  group: "Render", label: "Download the workflow JSON", keywords: ["export", "graph"], run: () => deliverPage.doDownload(getProject()) },
    { id: "render.copy",  group: "Render", label: "Copy the compiled prompt", run: async () => {
        const { copyText } = await import("./util.js");
        await copyText(compilePrompt(getProject()).text);
        toast("Prompt copied", "", "ok");
      } },

    { id: "gpu.release", group: "GPU", label: "Release the GPU — unload both engines", run: async () => { await api.release(); await refreshVram(); paintBadges(); toast("GPU released", "", "ok"); } },
    { id: "gpu.comfy",   group: "GPU", label: "Free ComfyUI's models", run: async () => { await api.freeComfy(); await refreshVram(); paintBadges(); toast("ComfyUI freed", "", "ok"); } },
    { id: "gpu.llm",     group: "GPU", label: "Unload the LLM", run: async () => { const r = await api.unloadLlm(); await refreshVram(); paintBadges(); toast("LLM unloaded", `${r.unloaded || 0} model(s)`, "ok"); } },
    { id: "gpu.saver",   group: "GPU", label: "Toggle VRAM saver mode", run: async () => {
        const on = !(getHealth().vram?.saver);
        await saveSettings({ vram: { saver: on } });
        await refreshVram(); paintBadges();
        toast(on ? "VRAM saver on" : "VRAM saver off", on ? "The engines will take turns." : "Both engines may hold the card.", "ok");
      } },

    { id: "proj.export", group: "Project", label: "Export the project file", hint: "⌘S", run: () => doExportProject() },
    { id: "proj.import", group: "Project", label: "Import a project file…", run: () => doImportProject() },
    { id: "proj.new",    group: "Project", label: "New empty project", run: () => window.MSCUT.newProject() },
    { id: "cast.known",  group: "Director", label: "Who does H3 already know? — the character index",
      keywords: ["character", "actor", "celebrity", "likeness", "franchise", "cast"],
      run: async () => {
        const entry = await pickCharacter();
        if (!entry) return;
        const line = castLine(entry);
        await copyText(line);
        toast(entry.name, `Copied “${line}” — paste it into a subject.`, "ok");
      } },
    { id: "help.guide",  group: "Project", label: "Guide", hint: "F1", run: () => showQuickGuide() },
    { id: "help.firstrun", group: "Project", label: "First-use setup", hint: "engines · storage", run: () => showFirstRunSetup() },
    { id: "edit.undo",   group: "Project", label: "Undo", hint: "⌘Z", when: () => canUndo(), run: () => { undo(); Object.values(PAGES).forEach(pg => pg.drawn && pg.mod.refresh?.()); } },
    { id: "edit.redo",   group: "Project", label: "Redo", hint: "⇧⌘Z", when: () => canRedo(), run: () => { redo(); Object.values(PAGES).forEach(pg => pg.drawn && pg.mod.refresh?.()); } },
  ]);
}

/* Drop a file anywhere in the window and it lands in the bin that matches it —
 * an image on I2V becomes the first frame, on Ref2V a reference; a clip or a
 * sound file always goes to its own bin. No hunting for the right dropzone. */
function installGlobalDrop() {
  const veil = h("div", {
    style: {
      position: "fixed", inset: "0", zIndex: "110", display: "none",
      alignItems: "center", justifyContent: "center", pointerEvents: "none",
      background: "rgba(20,32,48,.72)", border: "2px dashed var(--accent)",
      color: "var(--fg-bright)", fontSize: "15px", letterSpacing: ".05em",
    },
  }, h("div", "Drop to add to the media pool"));
  document.body.appendChild(veil);

  let depth = 0;
  window.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    depth++; veil.style.display = "flex";
  });
  window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; veil.style.display = "none"; } });
  window.addEventListener("dragover", (e) => { if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); });
  window.addEventListener("drop", async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    depth = 0; veil.style.display = "none";
    const p = getProject();
    let added = 0, ignored = 0;
    for (const file of e.dataTransfer.files) {
      const kind = kindOf(file);
      // A .mscut.json is a project, not media.
      if (/\.json$/i.test(file.name)) {
        try { replaceProject(JSON.parse(await file.text())); Object.values(PAGES).forEach(pg => { pg.drawn = false; }); showPage(activePage); toast("Project loaded", file.name, "ok"); }
        catch (err) { toast("Not a project file", err.message, "err"); }
        continue;
      }
      let item;
      try { item = await ingest(file); } catch (err) { toast("Could not read the file", err.message, "err"); continue; }
      if (item.kind === "video") item.poster = await posterFor(await getBlob(item.id));
      const placed = update((proj) => {
        if (item.kind === "audio") { if ((proj.refs.audios || []).length < 3) { proj.refs.audios.push(item); added++; } else ignored++; return; }
        if (item.kind === "video") { if ((proj.refs.videos || []).length < 3) { proj.refs.videos.push(item); added++; } else ignored++; return; }
        if (proj.mode === "i2v" && !proj.frames.first) { proj.frames.first = item; added++; return; }
        if (proj.mode === "i2v") { proj.frames.first = item; added++; return; }
        if ((proj.refs.images || []).length < 9) { proj.refs.images.push(item); added++; } else ignored++;
      }, "media");
      void placed;
    }
    if (added) toast(`${added} file${added > 1 ? "s" : ""} added`, ignored ? `${ignored} ignored — that bin is full.` : "Media page ▸ to set roles and retention.", "ok");
    Object.values(PAGES).forEach(pg => pg.drawn && pg.mod.refresh?.());
  });
}

/* ── Boot ─────────────────────────────────────────────────── */
async function boot() {
  loadProject();

  for (const [key, page] of Object.entries(PAGES)) page.el = $(`#page-${key}`);

  $$(".page-btn").forEach(b => b.addEventListener("click", () => showPage(b.dataset.page)));
  $$("#view-seg button, .stepbtn").forEach(b => b.addEventListener("click", () => {
    const view = b.dataset.view;
    try { localStorage.setItem("mscut.view", view); } catch { /* private mode */ }
    showPage(view === "studio" ? (lastStudioPage || "cut") : view);
  }));
  /* The mode is derived now, so there is nothing to click. Whenever the media
   * changes, put it in the slot the derived mode reads from and repaint. */
  subscribe((_, reason) => {
    if (reason !== "media" && reason !== "mode") return;
    let moved = false;
    update((p) => { moved = normaliseMedia(p); }, "modeSync");
    paintTitlebar();
    if (moved) Object.values(PAGES).forEach(pg => { if (pg.drawn) pg.mod.refresh?.(); });
  });

  $("#project-name").addEventListener("input", (e) => update((p) => { p.name = e.target.value; }, "text"));
  $("#engine-badge")?.addEventListener("click", () => {
    const p = getProject();
    if (p.mode === "r2v") return;
    const next = activeEngine(p) === "ltx25" ? "minimax" : "ltx25";
    setEngine(next);
    toast("Engine switched", `${ENGINES[next].label}${next === "ltx25" ? " (experimental)" : ""} — the prompt is unchanged; the checks now use its limits.`, "ok");
  });
  $("#btn-refresh-health").addEventListener("click", async (e) => {
    e.currentTarget.classList.add("disabled");
    await refreshHealth(); await refreshVram();
    e.currentTarget.classList.remove("disabled");
    paintBadges();
    PAGES[activePage]?.mod.refresh?.();
  });
  $("#btn-quickguide").addEventListener("click", () => showQuickGuide());
  $("#modal-x").addEventListener("click", () => closeModal(null));
  $("#overlay").addEventListener("mousedown", (e) => { if (e.target.id === "overlay") closeModal(null); });

  $("#btn-render-now").addEventListener("click", () => { showPage("deliver"); deliverPage.doRender(getProject()); });
  $("#btn-download-json").addEventListener("click", () => deliverPage.doDownload(getProject()));
  $("#btn-release-gpu").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.classList.add("disabled");
    try {
      const { api } = await import("./api.js");
      await api.release();
      await refreshVram();
      paintBadges();
      toast("GPU released", "Both engines unloaded.", "ok");
    } catch (err) { toast("Could not release the GPU", err.message, "err"); }
    finally { btn.classList.remove("disabled"); }
  });

  $("#btn-palette").addEventListener("click", () => togglePalette());

  // Dismissing the password prompt used to leave no way back in short of a
  // reload; now the title bar keeps a button until a request succeeds.
  const signInBtn = $("#btn-signin");
  signInBtn.addEventListener("click", async () => {
    if (await signIn()) {
      signInBtn.hidden = true;
      await loadState().catch(() => {});
      await refreshHealth();
      paintBadges();
      PAGES[activePage]?.mod.refresh?.();
    }
  });
  onAuthState((signedIn) => { signInBtn.hidden = !!signedIn; });
  installCommands();
  installGlobalDrop();

  subscribe((_p, reason) => {
    paintTitlebar();
    paintStatus();
    if (reason !== "text") refreshActive();
  });
  onRenderChange(() => { paintBadges(); refreshVram(); });

  window.addEventListener("keydown", onKey);

  paintTitlebar();
  paintStatus();
  /* Where the app opens.
   *
   * On the project manager, unless this browser already has a project with
   * work in it — the way an NLE does. "Start something new" should never be
   * the same gesture as "overwrite what you had", which is what a single
   * implicit project made it. */
  let startPage = location.hash?.slice(1);
  if (!(startPage in PAGES)) {
    // Create is the front door: it is where a rough idea becomes a canvas.
    let stored = "create";
    try { stored = localStorage.getItem("mscut.view") || "create"; } catch { /* private mode */ }
    startPage = stored === "studio" ? "cut" : stored === "simple" ? "simple" : stored === "projects" ? "projects" : "create";
  }
  {
    const { validate } = await import("./prompt.js");
    const { openProjectId } = await import("./projects.js");
    // Nothing written and nothing open means there is nothing to come back to.
    if (validate(getProject()).pristine && !openProjectId()) startPage = "projects";
  }
  /* Forwarded from the main Motionstill app: /cut/?open=<project id> opens
   * that project — media restored from the server — and lands on Create,
   * where the forwarded material is in front of you. The param is one
   * gesture, not a bookmark, so it is stripped immediately: a reload must
   * not re-open it over whatever you moved on to. */
  let openForwarded = null;
  try { openForwarded = new URL(location.href).searchParams.get("open"); } catch { /* no URL API, no param */ }
  if (openForwarded) {
    startPage = "create";
    try { history.replaceState(null, "", location.pathname + location.hash); } catch { /* cosmetic */ }
  }
  // Before the first paint: how big this interface is on this screen.
  applyUiScale();
  showPage(startPage);
  // Every main section on every page becomes draggable from here on —
  // the pages themselves do not have to know.
  startResizers();

  try {
    await loadState();
    paintBadges();
  } catch (err) {
    toast("Cannot reach the Cut server", err.message, "err");
  }

  if (openForwarded) {
    try {
      const { openProject } = await import("./projects.js");
      const { missing } = await openProject(openForwarded);
      Object.values(PAGES).forEach(p => { p.drawn = false; });
      showPage("create");
      toast("Project opened",
        missing.length ? `Media the server does not hold: ${missing.join(", ")}` : "Forwarded from Motionstill.",
        missing.length ? "err" : "ok");
    } catch (err) {
      toast("Could not open the forwarded project", err.message, "err");
    }
  }
  refreshHealth().then(() => { paintBadges(); PAGES[activePage]?.mod.refresh?.(); });

  // What this machine has learned rides along with the checks from now on.
  rulebook.list()
    .then((r) => { setHouseRules(r.rows || []); paintStatus(); PAGES[activePage]?.mod.refresh?.(); })
    .catch(() => { /* an empty rulebook is the normal case */ });
  cast.list()
    .then((r) => { setCast(r.rows || []); PAGES[activePage]?.mod.refresh?.(); })
    .catch(() => { /* likewise */ });
  /* And which characters H3 can render from the name alone. The checks read
   * it, so it is fetched here rather than when the picker first opens —
   * otherwise the one warning that matters most in a fan-film prompt only
   * appears after you have been to the Cast page. */
  loadKnownCast().then((rows) => {
    if (!rows.length) return;
    paintStatus();
    PAGES[activePage]?.mod.refresh?.();
  });

  // The badges are the only thing that polls: everything else reacts.
  setInterval(() => { refreshVram().then(paintBadges); }, 20000);
  setInterval(() => { refreshHealth().then(paintBadges); }, 90000);

  // The hosted version's first visit gets the setup conversation; everywhere
  // else (and every visit after) the guide keeps its old first-run behaviour.
  maybeShowFirstRun().then((shown) => { if (!shown) maybeShowOnFirstRun(); });
}

window.MSCUT = {
  get project() { return getProject(); },
  showPage, doExportProject, doImportProject, showQuickGuide,
  async newProject() {
    /* Through projects.js, which is the only thing that gives a project an id.
     *
     * This used to be replaceProject(blankProject()) — and blankProject()
     * has no `id` at all, while localStorage still pointed "the open project"
     * at the previous one. saveProject resolves its target as
     * `project.id || openProjectId()`, so the first ⌘S on the new timeline
     * overwrote the previous project's file on the server. A new project is
     * not a blank object; it is a new identity. */
    const { newProject } = await import("./projects.js");
    newProject();
    Object.values(PAGES).forEach(p => { p.drawn = false; });
    showPage("create");
  },
};

boot().catch((err) => {
  console.error("[cut] boot failed", err);
  document.body.innerHTML = `<div style="padding:40px;font-family:system-ui;color:#ccc">
    <h2>Motionstill Cut failed to start</h2><pre style="color:#e07060">${err.message}</pre></div>`;
});
