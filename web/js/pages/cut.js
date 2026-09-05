/* CUT — the page the work happens on.
 *
 * Left: the shot list. Centre: viewer over timeline, the way every NLE lays it
 * out. Right: the inspector for whatever is selected. The viewer switches
 * between the rendered clip, the compiled prompt and the validation report,
 * because on this app the prompt IS the footage until a render exists.
 */

import {
  h, mount, clear, toast, field, select, segmented, textarea, checkbox,
  timecode, shotTime, words, clamp, modal, closeModal, copyText, uid,
  group, more, row,
} from "../util.js";
import {
  getProject, update, orderedShots, selectedShot, selectShot, newShot, newBeat,
  duplicateShot, shotActionText, referenceInventory,
  dimensions, frameCount, DURATION_FRAMES, MODES, H3_DURATION, overLength, durationFrames,
 onProjectSwap, ltxGuideIdx, ltxGuideTime, setEngine, ENGINES, activeEngine } from "../state.js";
import { TEMPLATES } from "../templates.js";
import { SCENE_PRESETS, applyPreset, presetContext } from "../presets.js";
import { getBlob, ingest } from "../media.js";
import { compilePrompt, validate, wordBudget, cameraSentence, framingSentence } from "../prompt.js";
import { pickCharacter, castLine } from "../knowncast.js";
import {
  SHOT_TYPES, VIEWPOINTS, CAMERA_TYPES, AMPLITUDES, SPEEDS, CUT_VERBS, TRANSITIONS, NO_CUT, transitionLabel,
  LOOKS, GRADES, LIGHTING, LENSES, CAMERA_HEIGHTS, FRAMINGS, SECONDARY_MOVES, DEPTH_CUES,
} from "../vocab.js";
import { createPreviz, shotAt, framingOrigin, subjectHeightPct } from "../previz.js";
import { renderNodeGraph, nodeGraphLegend } from "../nodeview.js";
import { renderPrompt } from "../prompttext.js";
import { renderBoard } from "../board.js";
import { shotCitations } from "../state.js";
import { breakdown, polishShot } from "../llm.js";
import { assistBar, lastReading, setReading } from "../assist.js";
import { validateFix, describeFix, applyFix } from "../fixes.js";
import { beatEditor } from "../beats.js";
import { directorBody, directorBadge, director, runDirector } from "../director.js";
import { steerBody, steerBadge, shotTune, shotTuneBadge } from "../steerpanel.js";
import { api } from "../api.js";

let root = null;
let viewerMode = "previz";       // previz | preview | prompt | checks
let previz = null;               // the running player, when the previz tab is up
let previzBg = new Map();        // shot id → data URL, resolved from the media pool
let followedShot = -1;           // which shot the previz playhead is inside
let nodeViewOpen = (() => {
  try {
    const stored = localStorage.getItem("mscut.nodeview");
    // null means "never chosen" — the default below decides per mode.
    return stored === null ? null : stored === "1";
  } catch { return null; }
})();

/* Default: open wherever there is wiring to see. T2V conditions on the prompt
 * alone, so its graph is just the cut chain and the viewer is worth more. */
const nodeViewVisible = (p) => (nodeViewOpen === null ? p.mode !== "t2v" : nodeViewOpen);

function toggleNodeView(p) {
  nodeViewOpen = !nodeViewVisible(p);
  try { localStorage.setItem("mscut.nodeview", nodeViewOpen ? "1" : "0"); } catch { /* private mode */ }
  refresh();
}

/** How tall the node strip wants to be: the header, plus a row per node, up to
 *  a third of the window — past that the viewer suffers more than the graph
 *  gains, and the strip scrolls. */
function nodeStripHeight(p) {
  const sources = p.mode === "r2v"
    ? referenceInventory(p).length
    : (p.mode === "i2v" && p.frames.first ? 1 : 0);
  const rows = Math.max(sources, (p.shots || []).length, 1);
  return clamp(26 + 24 + rows * 62, 120, Math.round(window.innerHeight * 0.42));
}

/* ── The node graph panel ─────────────────────────────────── */
function nodePanel(p) {
  // Named, not counted: the resizer inserts a drag seam between panels, so
  // "the second child" is no longer this one.
  return h("div.panel.cut-nodes",
    h("div.hd",
      h("span.title", "Nodes"),
      h("div.vsep"),
      nodeGraphLegend(),
      h("span.spacer"),
      h("span.hint", p.mode === "r2v"
        ? "an edge exists where a shot actually cites the tag — not where a file was attached"
        : "sources → shots → render"),
      h("button.btn.ghost.sm", { title: "Hide the node view", onclick: () => toggleNodeView(p) }, "✕"),
    ),
    h("div.bd", { style: { overflow: "hidden", padding: "0" } },
      renderNodeGraph(p, {
        selectedShotId: selectedShot(p)?.id || null,
        onSelectShot: (id) => { selectShot(id); refresh(); },
        onSelectSource: () => { document.querySelector('.page-btn[data-page="media"]')?.click(); },
        onCutChange: (id, v) => { update(proj => { const sh = proj.shots.find(x => x.id === id); if (sh) sh.cutVerb = v; }, "shots"); refresh(); },
      }),
    ),
  );
}
let playhead = 0;                // seconds
let idea = "";
let busy = false;

export function setViewerMode(m) {
  if (previz && m !== "previz") { previz.destroy(); previz = null; }
  viewerMode = m;
  refresh();
}

/* The same six presets the dropdown offers, as coordinates. Both the dropdown
 * and the box write fx/fy, so there is one source of truth for where the
 * subject sits. */
const FRAMING_PRESET_XY = {
  centered: [50, 50], "left third": [34, 50], "right third": [66, 50],
  "low in frame": [50, 64], "high in frame": [50, 36], "over-shoulder foreground": [60, 55],
};

/**
 * A drag in the previz, written back into the camera the inspector shows.
 *
 * The boxes are a view of the same three fields the dropdowns edit, so this is
 * a plain assignment rather than a second model: framing coordinates from the
 * start box, shot size from its corner, and the move — type, amplitude and any
 * simultaneous second axis — derived from where the end box was dropped.
 *
 * A live drag writes with reason "text", which the shell deliberately does not
 * redraw on; the commit at the end writes "shots" and the inspector catches up.
 */
function applyFraming({ shotId, live, framing, fx, fy, shotType, move }) {
  update((proj) => {
    const shot = proj.shots.find(x => x.id === shotId);
    if (!shot) return;
    if (framing) shot.camera.framing = framing;
    if (Number.isFinite(fx)) shot.camera.fx = fx;
    if (Number.isFinite(fy)) shot.camera.fy = fy;
    if (shotType) shot.shotType = shotType;
    if (move) {
      shot.camera.type = move.type;
      shot.camera.amplitude = move.amplitude;
      shot.camera.secondary = move.secondary;
      // A hand-written line would silently win over what was just dragged.
      if ((shot.camera.custom || "").trim()) shot.camera.custom = "";
    }
  }, live ? "text" : "shots");
  if (!live) refresh();
}

/* The plate behind a previz shot: the fixed first frame for I2V, the first
 * reference image for Ref2V, and otherwise the grid — which is honest, since
 * T2V has no picture until it renders. */
function ensurePrevizBackgrounds(p) {
  /* Every picture a shot could cite, not just the first: a reel that walks
   * through six rooms previews as six rooms, not the first room six times. */
  const wanted = [p.mode === "i2v" ? p.frames?.first : null, ...(p.refs?.images || [])].filter(Boolean);
  if (!wanted.length) { previzBg = new Map(); return; }
  for (const m of wanted) {
    if (previzBg.has(m.id)) continue;
    previzBg.set(m.id, null);            // in flight — never fetched twice
    getBlob(m.id).then((data) => {
      if (!data) { previzBg.delete(m.id); return; }
      previzBg.set(m.id, data);
      if (viewerMode === "previz") refresh();
    });
  }
}

/** The plate a shot plays over: the first picture that shot cites, falling
 *  back to the project's lead image for a shot that cites nothing. */
function previzPlate(p, shot) {
  for (const e of shotCitations(p, shot)) {
    if (e.kind === "picture" && previzBg.get(e.ref?.id)) return previzBg.get(e.ref.id);
  }
  const lead = p.mode === "i2v" ? p.frames?.first : (p.refs?.images || [])[0];
  return lead ? previzBg.get(lead.id) || null : null;
}

/* ── Left: shot list + the idea box ───────────────────────── */
/** The pictures (and clips) a shot cites, as small stills next to its
 *  number — so a reel that walks through six rooms reads as six rooms, and a
 *  shot that cites nothing is visibly blank. Stills load from the media store
 *  after the row paints, exactly as the Canvas does. */
function citeStrip(p, shot) {
  const cites = shotCitations(p, shot).filter(e => e.kind !== "audio");
  if (!cites.length) return null;
  const shown = cites.slice(0, 4);
  return h("div.cites", ...shown.map((e) => {
    const still = h("div.cite-still", { title: `${e.tag} — ${e.ref?.label || e.ref?.name || ""}` }, e.kind === "video" ? "▶" : "");
    const paint = (src) => { if (src) { still.style.backgroundImage = `url("${src}")`; still.textContent = ""; } };
    if (e.kind === "video") paint(e.ref?.poster);
    else if (e.ref?.id) getBlob(e.ref.id).then(paint);
    return still;
  }), cites.length > shown.length ? h("div.cite-still.more", `+${cites.length - shown.length}`) : null);
}

function shotList(p) {
  const shots = orderedShots(p);
  const sel = selectedShot(p);
  const duration = p.render.duration;

  const rows = shots.map((s, i) => {
    const next = shots[i + 1];
    const len = (next ? next.at : duration) - s.at;
    const beats = (s.beats || []).filter(b => (b.text || "").trim()).length;
    const empty = !s.subject?.trim() && !beats;
    const dense = beats > Math.max(1, Math.ceil(len / 2));
    return h("div", {
      class: `shot-row${sel && sel.id === s.id ? " sel" : ""}`,
      title: empty ? "This shot has nothing in it yet" : dense ? "More beats than this shot has seconds for" : "",
      onclick: () => { selectShot(s.id); playhead = s.at; refresh(); },
    },
      h("div.idx", String(i + 1)),
      citeStrip(p, s),
      h("div.txt",
        h("div.line1", (s.subject || shotActionText(s) || "— empty shot —").slice(0, 60)),
        h("div.line2", `${i > 0 ? `${s.cutVerb === NO_CUT ? "⟶ same take" : `✂ ${transitionLabel(s.cutVerb).replace(/ \(ask first\)/, "")}`} · ` : ""}${shotTime(s.at)} · ${len.toFixed(1)}s · ${s.shotType}${beats ? ` · ${beats} beat${beats > 1 ? "s" : ""}` : ""}`),
      ),
      h("span", {
        title: empty ? "empty" : dense ? "too many beats" : "ok",
        style: {
          width: "6px", height: "6px", borderRadius: "50%", flex: "none", marginTop: "7px",
          background: empty ? "var(--fg-faint)" : dense ? "var(--amber)" : "var(--green)",
        },
      }),
    );
  });

  const ideaBox = textarea(idea, (v) => { idea = v; }, {
    rows: 3, placeholder: "One line about the video you want…\n\nExample: a barista finishes a pour-over as the morning rush starts",
  });

  return h("div.panel",
    h("div.hd", h("span.title", "Shots"), h("span.spacer"),
      h("button.btn.sm.ghost", { title: "Start from a shot structure", onclick: () => openTemplates() }, "Templates"),
      h("span.hint", `${shots.length}`)),
    h("div.bd",
      h("div.shot-list", ...rows),
      h("div", { style: { padding: "10px", borderTop: "1px solid var(--line)" } },
        h("h4.sec", "Idea → shot list"),
        ideaBox,
        h("div.btn-row", { style: { marginTop: "6px" } },
          h("button.btn.ai.sm.grow", {
            onclick: async (e) => {
              if (!idea.trim()) return toast("Nothing to break down", "Write a line about the video first.", "warn");
              const btn = e.currentTarget;
              btn.classList.add("disabled"); btn.textContent = "thinking…";
              try {
                const { shots: made, model } = await breakdown(idea, p);
                update((proj) => {
                  proj.shots = made.map((s, i) => ({
                    ...newShot(i === 0 ? 0 : clamp(Number(s.at) || i * 2, 0.5, proj.render.duration - 0.5)),
                    shotType: s.shotType || "medium",
                    viewpoint: s.viewpoint || "front-facing",
                    subject: s.subject || "",
                    beats: (Array.isArray(s.beats) && s.beats.length ? s.beats : [s.action || ""])
                      .map((b, bi) => newBeat(typeof b === "string" ? b : (b?.text || ""), bi === 0 ? "" : (b?.link || "then"))),
                    setting: s.setting || "",
                    lighting: s.lighting || "",
                    details: s.details || "",
                    camera: { type: s.camera?.type || "static", amplitude: s.camera?.amplitude || "medium", speed: s.camera?.speed || "normal", target: s.camera?.target || "" },
                  }));
                  proj.selectedShot = proj.shots[0]?.id || null;
                }, "shots");
                toast("Shot list written", `${made.length} shots · ${model}`, "ok");
                refresh();
              } catch (err) { toast("Breakdown failed", err.message, "err"); }
              finally { btn.classList.remove("disabled"); btn.textContent = "✨ Auto-shots"; }
            },
          }, "✨ Auto-shots"),
        ),
        h("div.hint", { style: { marginTop: "6px" } },
          "Past H3's ~15s training window a single take degrades — a shot list is what holds a long clip together."),
      ),
    ),
  );
}

/* ── Centre top: viewer / prompt / checks ─────────────────── */
function viewerPanel(p) {
  const { width, height } = dimensions(p);
  const job = (p.jobs || []).find(j => j.outputs?.length);
  const body = h("div.viewer");
  const surface = h("div.surface");

  if (viewerMode === "previz") {
    ensurePrevizBackgrounds(p);
    const wasPlaying = previz?.isPlaying;
    if (previz) previz.destroy();
    previz = createPreviz(p, {
      startAt: playhead,
      editable: true,
      backgroundFor: (shot) => previzPlate(p, shot),
      onFraming: applyFraming,
      onTime: (t, frame) => {
        playhead = t;
        const head = body.querySelector(".pv-time");
        if (head) head.textContent = timecode(t, p.render.fps);
        const ph = root.querySelector(".tl-playhead");
        if (ph) ph.style.left = `${clamp((t / p.render.duration) * 100, 0, 100)}%`;
        // Follow the tape: the clip and the list row under the playhead light
        // up as it passes, without rebuilding either.
        if (frame && frame.index !== followedShot) {
          followedShot = frame.index;
          root.querySelectorAll(".tl-track:not(.audio) .tl-clip").forEach((c, i) => c.classList.toggle("live", i === frame.index));
          root.querySelectorAll(".shot-row").forEach((r, i) => r.classList.toggle("live", i === frame.index));
        }
      },
    });
    surface.style.background = "#0b0b0b";
    surface.appendChild(previz.el);
    // An edit made mid-playback shouldn't stop the tape — that is the whole
    // point of a previz you can scrub while you write.
    if (wasPlaying) previz.play();
  } else if (viewerMode === "board") {
    surface.style.alignItems = "stretch";
    surface.style.background = "var(--bg-panel)";
    surface.appendChild(renderBoard(p, {
      selectedShotId: selectedShot(p)?.id || null,
      onSelectShot: (id) => { selectShot(id); refresh(); },
    }));
  } else if (viewerMode === "preview") {
    const running = job && ["queued", "running"].includes(job.status);
    if (running && job.preview) {
      // The sampler's own frames, live. Watching the image resolve is worth
      // more than watching a bar, and this tab is where you would look.
      surface.appendChild(h("img.live", { src: job.preview, alt: "render preview",
        style: { maxHeight: "100%", maxWidth: "100%" } }));
    } else if (job?.outputs?.length && !running) {
      const f = job.outputs[0];
      surface.appendChild(h("video", {
        src: api.viewUrl(f), controls: "", autoplay: "", loop: "", playsinline: "",
        style: { maxHeight: "100%", maxWidth: "100%" },
      }));
    } else if (p.mode === "i2v" && p.frames.first) {
      const img = h("img", { alt: "first frame" });
      getBlob(p.frames.first.id).then(d => { if (d) img.src = d; });
      surface.appendChild(img);
    } else {
      const shot = selectedShot(p);
      surface.appendChild(h("div.empty",
        h("div.big", "▣"),
        h("div", { style: { color: "var(--fg-dim)", maxWidth: "460px", lineHeight: "1.7" } },
          shot ? (shot.subject || shot.action
            ? h("span", h("b", { style: { color: "var(--fg-bright)" } }, `Shot ${orderedShots(p).findIndex(s => s.id === shot.id) + 1}. `), `${shot.subject} ${shot.action}`)
            : "This shot is empty — describe it in the inspector.")
            : "No shots yet."),
        h("div.hint", { style: { marginTop: "12px" } }, "No render yet. Deliver ▸ Render queues this timeline on ComfyUI."),
      ));
    }
  } else if (viewerMode === "prompt") {
    surface.style.alignItems = "stretch";
    surface.style.background = "var(--bg-panel)";
    surface.appendChild(promptView(p));
  } else {
    surface.style.alignItems = "stretch";
    surface.style.background = "var(--bg-panel)";
    surface.appendChild(checksView(p));
  }

  const transport = h("div.transport",
    viewerMode === "previz" ? h("button.btn.sm", {
      title: "Play the previz (Space)",
      onclick: (e) => { previz?.toggle(); e.currentTarget.textContent = previz?.isPlaying ? "❚❚" : "▶"; },
    }, previz?.isPlaying ? "❚❚" : "▶") : null,
    viewerMode === "previz" ? h("button.btn.sm.ghost", {
      title: "Back to the start",
      onclick: () => { previz?.pause(); previz?.seek(0); playhead = 0; refresh(); },
    }, "⏮") : null,
    h("span.pv-time", timecode(playhead, p.render.fps)),
    h("span.faint", "/"),
    h("span", timecode(p.render.duration, p.render.fps)),
    h("div.vsep"),
    h("span.faint.pv-spec", `${width}×${height} · ${p.render.fps} fps · ${frameCount(p)} frames`),
    h("span", { style: { flex: "1" } }),
    h("span.faint.pv-mode", MODES[p.mode].label),
  );

  body.append(surface, transport);

  return h("div.panel",
    h("div.hd",
      h("span.title", "Viewer"),
      h("span.spacer"),
      /* The three LLM assists, the same three in every viewer mode — they
       * used to be one each under Prompt and Checks and one in the node
       * view, so which you found depended on where you were standing. */
      assistBar(p, { refresh, onReading: () => setViewerMode("checks") }),
      h("span.vsep"),
      segmented([
        ["previz", "Previz", "Play the prompt back before spending GPU time on it"],
        ["board", "Board", "Every beat as a card, in render order"],
        ["preview", "Render", "The last clip ComfyUI sent back"],
        ["prompt", "Prompt", "Exactly what the encoder will read"],
        ["checks", "Checks", "Everything checkable before a render"],
      ], viewerMode, setViewerMode),
    ),
    body,
  );
}

/* The compiled prompt, coloured by what each part is — this is the "advanced
 * prompt" surface: you see exactly what the encoder will read. */
function promptView(p) {
  const compiled = compilePrompt(p);
  const budget = wordBudget(p);
  const count = words(compiled.description);
  const pct = clamp((count / budget.max) * 100, 0, 100);
  const meterClass = count < budget.min ? "warn" : count > budget.max * 1.15 ? "bad" : "good";

  /* Built as DOM rather than assembled as HTML: the reference chips have to
   * carry which media they name, and nothing here has to be escaped by hand. */
  const pre = h("pre.code", { style: { margin: "0", flex: "1", minHeight: "0" } });
  pre.appendChild(renderPrompt(compiled.text, p));

  return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: "0", padding: "10px", gap: "8px" } },
    h("div.budget",
      h("span.n", `${count} words`),
      h("div", { class: `meter ${meterClass}` }, h("i", { style: { width: `${pct}%` } })),
      h("span.n", `target ${budget.min}–${budget.max}`),
      h("button.btn.sm", { onclick: async () => { await copyText(compiled.text); toast("Prompt copied", "", "ok"); } }, "Copy"),
    ),
    pre,
    p.prompt.manual
      ? h("div.note.warn", h("b", "Manual override is on"), " — the timeline no longer drives the description. Turn it off in the inspector to go back to the shot list.")
      : null,
  );
}


function checksView(p) {
  const { checks, errors, warnings, wordCount, pristine } = validate(p);
  const rows = checks.map(c => h(`div.check.${c.level}`,
    h("span.ico", c.level === "err" ? "✕" : c.level === "warn" ? "!" : "✓"),
    h("span.msg", { html: c.msg.replace(/"([^"]+)"/g, "<b>$1</b>") },
      /* A check that names a fix the app can make itself offers it here,
       * where the problem is read — not on another page. */
      c.action?.kind === "engine" ? h("button.btn.sm", {
        style: { marginLeft: "8px", verticalAlign: "middle" },
        onclick: () => { setEngine(c.action.engine); toast("Engine switched", ENGINES[c.action.engine]?.label || c.action.engine, "ok"); refresh(); },
      }, c.action.label) : null),
  ));
  return h("div", { style: { height: "100%", overflow: "auto" } },
    h("div", { style: { padding: "10px 12px", borderBottom: "1px solid var(--line)" } },
      h("div.flex",
        h("span", { class: `badge ${pristine ? "" : errors ? "bad" : "ok"}` }, h("span.dot"),
          pristine ? "empty timeline" : `${errors} error${errors === 1 ? "" : "s"}`),
        pristine ? null : h("span", { class: `badge ${warnings ? "busy" : "ok"}` }, h("span.dot"), `${warnings} warning${warnings === 1 ? "" : "s"}`),
        h("span.hint", `${wordCount} words`),
        h("span.grow"),
      ),
      h("div.hint", { style: { marginTop: "6px" } },
        "Everything checkable before a GPU second is spent. Nothing here blocks a render — most bad clips are bad prompts, and this is the cheapest place to notice."),
    ),
    h("div.checks", ...rows),
    lastReading() ? dryRunView(lastReading()) : null,
  );
}

/* The second half of "see how it plays out": previz shows what the timeline
 * says, this shows what the PROMPT says — read back by a model that has never
 * seen what you meant. Ambiguity is invisible from the inside. */
function dryRunView(r) {
  const tone = { low: "ok", medium: "warn", high: "err" };
  return h("div", { style: { borderTop: "1px solid var(--line)", padding: "10px 12px" } },
    h("h4.sec", `Read back by ${r.model || "the LLM"}`),
    ...(r.shots || []).map(s => h("div", { style: { marginBottom: "9px" } },
      h("div.flex", { style: { marginBottom: "2px" } },
        h("span.tag", `Shot ${s.n}`),
        h("span", { class: `badge ${s.risk === "high" ? "bad" : s.risk === "medium" ? "busy" : "ok"}` }, h("span.dot"), `${s.risk || "low"} risk`),
      ),
      h("div.hint", s.renders || ""),
      s.ambiguity ? h("div.note.warn", { style: { margin: "4px 0 0" } }, h("b", "Reads two ways: "), s.ambiguity) : null,
    )),
    r.overall ? h("div.note.info", h("b", "Overall — "), r.overall) : null,
    r.biggestRisk ? h("div.note.bad", h("b", "Biggest risk — "), r.biggestRisk) : null,
    fixList(r),
    h("div.hint", { style: { marginTop: "6px" } },
      "One reader's reading, not the model's. It is useful for the same reason a table read is: it finds the sentences that only make sense to the person who wrote them."),
  );
}

/* The suggestions, as buttons. A reading that cannot be acted on is a lecture —
 * but nothing lands without passing the whitelist in fixes.js, because a model
 * writing straight into the project is exactly what goes wrong quietly. */
function fixList(r) {
  const p = getProject();
  const checked = (r.fixes || []).map(fix => ({ fix, check: validateFix(p, fix) }));
  const usable = checked.filter(c => c.check.ok);
  if (!checked.length) return null;

  return h("div", { style: { marginTop: "10px" } },
    h("div.flex", { style: { marginBottom: "5px" } },
      h("h4.sec", { style: { margin: "0", flex: "1", borderBottom: "0" } }, "Suggested edits"),
      usable.length > 1 ? h("button.btn.sm.primary", {
        onclick: () => {
          let done = 0;
          update((draft) => { for (const { fix } of usable) { if (applyFix(draft, fix).ok) done++; } }, "shots");
          toast(`${done} edit${done === 1 ? "" : "s"} applied`, "⌘Z puts it all back.", "ok");
          setReading({ ...r, fixes: [] });
          refresh();
        },
      }, `Use all ${usable.length}`) : null,
    ),
    ...checked.map(({ fix, check }) => h("div.fix-row",
      h("div.grow",
        h("div.fix-what", describeFix(p, fix)),
        fix.why ? h("div.hint", fix.why) : null,
        check.ok ? null : h("div.hint.warn", `Not applied — ${check.error}.`),
      ),
      check.ok ? h("button.btn.sm", {
        onclick: () => {
          let ok = false;
          update((draft) => { ok = applyFix(draft, fix).ok; }, "shots");
          toast(ok ? "Applied" : "Could not apply", ok ? describeFix(p, fix) : "", ok ? "ok" : "err");
          setReading({ ...r, fixes: (r.fixes || []).filter(f => f !== fix) });
          refresh();
        },
      }, "Use") : null,
    )),
  );
}


/* ── Centre bottom: the timeline ──────────────────────────── */
/* Laid out the way an NLE lays it out: a fixed gutter of track headers on the
 * left, lanes on the right, one playhead across all of them. */
function timeline(p) {
  const duration = p.render.duration;
  const shots = orderedShots(p);
  const sel = selectedShot(p);
  const pctOf = (t) => `${clamp((t / duration) * 100, 0, 100)}%`;

  /* Ruler — tick density follows the clip length, so a 30s timeline doesn't
   * turn into a picket fence. */
  const step = duration <= 10 ? 1 : duration <= 20 ? 2 : 5;
  const majorEvery = duration <= 10 ? 1 : 5;
  const ruler = h("div.tl-ruler", {
    onclick: (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      playhead = clamp(((e.clientX - r.left) / r.width) * duration, 0, duration);
      if (previz && viewerMode === "previz") { previz.seek(playhead); e.currentTarget.closest(".tl-lanes").querySelector(".tl-playhead").style.left = `${(playhead / duration) * 100}%`; }
      else refresh();
    },
  });
  for (let t = 0; t <= duration; t += step) {
    const major = t % majorEvery === 0;
    ruler.appendChild(h(`div.tick${major ? ".major" : ""}`, { style: { left: pctOf(t) } },
      major ? h("span", timecode(t, p.render.fps).slice(3, 8)) : null));
  }

  const videoTrack = h("div.tl-track");
  shots.forEach((s, i) => {
    const next = shots[i + 1];
    const end = next ? next.at : duration;
    const clip = h("div", {
      class: `tl-clip${sel && sel.id === s.id ? " sel" : ""}`,
      style: { left: pctOf(s.at), width: `calc(${pctOf(end - s.at)} - 2px)` },
      onmousedown: () => { selectShot(s.id); },
      title: `${s.subject || "shot"} — ${s.action || ""}`,
    },
      h("div.n", `${i + 1}. ${s.shotType}`),
      h("div.t", `${shotTime(s.at)} → ${shotTime(end)}`),
      h("div.d", s.subject || s.action || "—"),
    );
    // Only a cut can be dragged; shot 1 is pinned at zero by the format.
    if (i > 0) {
      clip.appendChild(h("div.grip.l", {
        title: "Drag the cut",
        onmousedown: (e) => startDrag(e, s.id, shots[i - 1].at + 0.5, end - 0.5, duration),
      }));
      if (s.cutVerb === NO_CUT) clip.classList.add("same-take");
    }
    videoTrack.appendChild(clip);

    /* The seam itself: what happens between this shot and the one before,
     * on the timeline where the cut is — the same field the Inspector row,
     * the node view and the Canvas set. A select, because a cut has eight
     * answers and a click should not cycle through them. */
    if (i > 0) {
      const same = s.cutVerb === NO_CUT;
      const label = same ? "⟶ same take" : `✂ ${transitionLabel(s.cutVerb).replace(/ \(ask first\)/, "")}`;
      const pick = select(TRANSITIONS, s.cutVerb || "the camera cuts to", (v) => { update(proj => { const sh = proj.shots.find(x => x.id === s.id); if (sh) sh.cutVerb = v; }, "shots"); refresh(); },
        { class: "tl-cut-sel", title: "What happens between these two shots" });
      videoTrack.appendChild(h("div", {
        class: `tl-cut${same ? " same" : ""}`,
        style: { left: pctOf(s.at) },
        onmousedown: (e) => e.stopPropagation(),
        onclick: (e) => e.stopPropagation(),
      }, h("span.tl-cut-lbl", label), pick));
    }
  });

  const audioTrack = h("div.tl-track.audio");
  shots.forEach((s, i) => {
    const next = shots[i + 1];
    const end = next ? next.at : duration;
    const lines = (s.dialogue || []).filter(d => (d.text || "").trim());
    if (!lines.length && !(s.sfx || "").trim()) return;
    audioTrack.appendChild(h("div.tl-clip.audio", {
      style: { left: pctOf(s.at), width: `calc(${pctOf(end - s.at)} - 2px)` },
      onclick: () => { selectShot(s.id); refresh(); },
      title: lines.map(d => `(${d.speaker}) ${d.text}`).join("\n"),
    },
      h("div.n", lines.length ? `${lines.length} line${lines.length > 1 ? "s" : ""}` : "sfx"),
      h("div.d", lines[0]?.text || s.sfx),
    ));
  });

  const head = h("div.hd",
    h("span.title", "Timeline"),
    h("div.vsep"),
    h("button.btn.sm", { title: "Cut the current shot at the playhead (S)", onclick: () => splitAtPlayhead() }, "✂ Split"),
    h("button.btn.sm", { title: "Add a shot at the playhead", onclick: () => addShotAt(playhead) }, "＋ Shot"),
    h("button.btn.sm.ghost", { title: "Delete the selected shot (⌫)", onclick: () => deleteSelected() }, "✕ Delete"),
    h("div.vsep"),
    h("button.btn.sm.ghost", {
      title: "Show how references and shots are wired (N)",
      onclick: () => toggleNodeView(p),
    }, nodeViewVisible(p) ? "◱ Nodes" : "◰ Nodes"),
    h("span.spacer"),
    h("span.hint", "Duration"),
    select(Object.keys(durationFrames(p)).map(d => [d,
        `${d}s · ${durationFrames(p)[d]}f${overLength(d, p) ? " ⚠" : ""}`,
        overLength(d, p) ? `Past H3's ${H3_DURATION.max}s ceiling — the clip repeats` : ""]),
      String(p.render.duration),
      (v) => { update(proj => { proj.render.duration = Number(v); }, "render"); refresh(); },
      { style: { width: "116px" }, title: overLength(p.render.duration, p) ? `Past H3's ${H3_DURATION.max}s ceiling — the clip repeats` : "" }),
  );

  const lanes = h("div.tl-lanes", ruler, videoTrack, audioTrack,
    h("div.tl-playhead", { style: { left: pctOf(playhead) } }));

  const gutters = h("div.tl-gutters",
    h("div.g.ruler", timecode(playhead, p.render.fps).slice(0, 8)),
    h("div.g", h("b", "V1"), h("span.faint", "shots")),
    h("div.g", h("b", "A1"), h("span.faint", "sound")),
  );

  return h("div.panel", head, h("div.bd", { style: { overflow: "hidden" } }, h("div.tl", gutters, lanes)));
}

function startDrag(e, shotId, min, max, duration) {
  e.preventDefault();
  e.stopPropagation();
  const track = e.currentTarget.closest(".tl-track");
  const rect = track.getBoundingClientRect();
  const move = (ev) => {
    const t = clamp(((ev.clientX - rect.left) / rect.width) * duration, min, max);
    update((p) => {
      const s = p.shots.find(x => x.id === shotId);
      if (s) s.at = Math.round(t * 100) / 100;
    }, "text");
    const shots = orderedShots(getProject());
    const i = shots.findIndex(s => s.id === shotId);
    const clip = track.querySelectorAll(".tl-clip")[i];
    if (clip) clip.style.left = `${(t / duration) * 100}%`;
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    refresh();
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

export function addShotAt(at) {
  const p = getProject();
  const t = clamp(at, 0.5, p.render.duration - 0.5);
  if (p.shots.some(s => Math.abs((s.at || 0) - t) < 0.4)) return toast("Too close", "There is already a cut within half a second.", "warn");
  const shot = newShot(Math.round(t * 100) / 100);
  update((proj) => { proj.shots.push(shot); proj.selectedShot = shot.id; }, "shots");
  refresh();
}

function splitAtPlayhead() {
  const p = getProject();
  const shots = orderedShots(p);
  const current = [...shots].reverse().find(s => s.at <= playhead) || shots[0];
  if (!current) return;
  const copy = { ...newShot(Math.round(clamp(playhead, 0.5, p.render.duration - 0.5) * 100) / 100) };
  // A split inherits the look of what it was cut out of — that is what a razor
  // does in every NLE, and it saves retyping the setting for a reverse angle.
  Object.assign(copy, {
    shotType: current.shotType, viewpoint: current.viewpoint,
    subject: current.subject, setting: current.setting, lighting: current.lighting,
    camera: { ...current.camera },
  });
  copy.id = uid();
  copy.action = "";
  update((proj) => { proj.shots.push(copy); proj.selectedShot = copy.id; }, "shots");
  refresh();
}

function deleteSelected() {
  const p = getProject();
  if ((p.shots || []).length <= 1) return toast("Cannot delete", "A timeline needs at least one shot.", "warn");
  const sel = selectedShot(p);
  if (!sel) return;
  update((proj) => {
    proj.shots = proj.shots.filter(s => s.id !== sel.id);
    if (proj.shots[0]) proj.shots[0].at = 0;
    proj.selectedShot = proj.shots[0]?.id || null;
  }, "shots");
  refresh();
}

/* ── Right: the inspector ─────────────────────────────────── */
/* The prompt-based timeline in miniature: a shot is a list of timed beats, and
 * H3 renders roughly one of them per 2–3 seconds. Making them a list rather
 * than a paragraph is what lets the editor count them against the shot's own
 * length and draw them on the clip. */
/* Ref2V: the tag inventory as clickable chips. Clicking one drops the tag into
 * whichever text field was last focused — a tag with no media behind it is
 * silently ignored, so typing them by hand is the easiest way to lose a
 * reference without noticing. */
let lastFocusedField = null;

/* Everything above that belongs to ONE project, forgotten when a different one
 * is opened. `idea` is a logline the user typed and it lives only here, so a
 * new project used to land on Cut with the last one's idea still in the box;
 * the second opinion (assist.js) is the LLM's reading of the PREVIOUS shot list, whose
 * fixes apply by shot INDEX, so one click wrote project A's text into project
 * B. The transport position is only cosmetic, and is reset for the same
 * reason a fresh timeline starts at zero. */
onProjectSwap(() => {
  idea = "";
  setReading(null);
  playhead = 0;
  followedShot = -1;
  viewerMode = "previz";
  lastFocusedField = null;
  previzBg.clear();
});
document.addEventListener("focusin", (e) => {
  if (/^(TEXTAREA|INPUT)$/.test(e.target.tagName) && e.target.type !== "checkbox") lastFocusedField = e.target;
});

function referenceChips(p) {
  const inv = referenceInventory(p);
  if (!inv.length) {
    return h("div.hint", "No references attached yet — add them on the Media page.");
  }
  return h("div.flex.wrap",
    ...inv.map(e => h("span", {
      class: `chip`,
      title: `${e.ref?.label || e.ref?.name || ""} — click to insert at the cursor`,
      onclick: () => {
        const field = lastFocusedField;
        if (!field) return toast("Put the cursor somewhere first", "Click into a text field, then click a tag.", "warn");
        const start = field.selectionStart ?? field.value.length;
        const endPos = field.selectionEnd ?? start;
        field.value = `${field.value.slice(0, start)}${e.tag}${field.value.slice(endPos)}`;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.focus();
        field.setSelectionRange(start + e.tag.length, start + e.tag.length);
      },
    }, e.tag)),
  );
}

export function openTemplates() {
  const p = getProject();
  const ctx = presetContext(p);
  const body = h("div",
    h("div.note.info", { style: { marginTop: 0 } },
      "A template replaces the shot list and sets the clip length. Everything you have typed into the current shots is lost — export the project first if you want it back."),
    h("div.hint", { style: { margin: "8px 0 4px", color: "var(--fg-bright)" } }, "Scene presets — one shot per attached picture, each citing its own; the guidance rides on every rewrite"),
    ...SCENE_PRESETS.map(t => {
      const n = t.build(ctx).length;
      return h("div", {
        style: { padding: "8px 10px", border: "1px solid var(--line-hair)", borderRadius: "3px", marginBottom: "6px", cursor: "pointer" },
        onclick: () => {
          update((proj) => { applyPreset(proj, t.key); }, "shots");
          closeModal(null);
          toast(`${t.name} applied`, `${n} shot${n === 1 ? "" : "s"} over ${getProject().render.duration}s.`, "ok");
          refresh();
        },
      },
        h("div.flex", h("b", { style: { color: "var(--fg-bright)" } }, t.name), h("span.hint", `${n} shot${n === 1 ? "" : "s"} · ${ctx.picCount} picture${ctx.picCount === 1 ? "" : "s"}`), h("span.tag", MODES[ctx.mode].short)),
        h("div.hint", { style: { marginTop: "3px" } }, t.blurb),
      );
    }),
    h("div.hint", { style: { margin: "10px 0 4px", color: "var(--fg-bright)" } }, "Shot structures"),
    ...TEMPLATES.map(t => h("div", {
      style: { border: "1px solid var(--line-hair)", borderRadius: "2px", padding: "9px 11px", marginBottom: "7px", cursor: "pointer" },
      onmouseenter: (e) => { e.currentTarget.style.borderColor = "var(--accent)"; },
      onmouseleave: (e) => { e.currentTarget.style.borderColor = "var(--line-hair)"; },
      onclick: () => applyTemplate(t),
    },
      h("div.flex",
        h("b", { style: { color: "var(--fg-bright)" } }, t.name),
        h("span.hint", `${t.duration}s · ${t.build().length} shot${t.build().length > 1 ? "s" : ""}`),
        t.mode ? h("span.tag", t.mode.toUpperCase()) : null,
      ),
      h("div.hint", { style: { marginTop: "3px" } }, t.blurb),
    )),
  );
  return modal({ title: "Shot structures", wide: true, body, actions: [{ label: "Cancel", onClick: (done) => done(null) }] });
}

export function applyTemplate(t) {
  update((proj) => {
    proj.shots = t.build();
    proj.render.duration = t.duration;
    proj.selectedShot = proj.shots[0]?.id || null;
    if (t.mode) proj.mode = t.mode;
  }, "shots");
  closeModal(null);
  toast(`${t.name} applied`, `${t.build().length} shots over ${t.duration}s.`, "ok");
  refresh();
}

/* ── Right: the inspector ─────────────────────────────────────
 * Three rules, because an inspector earns its keep by being scannable: one
 * group open at a time, the advanced controls behind a "more", and the
 * explanations behind a "?" rather than permanently between you and the field
 * you came for. */
function inspector(p) {
  const shot = selectedShot(p);
  const shots = orderedShots(p);
  const index = shot ? shots.findIndex(s => s.id === shot.id) : -1;
  const set = (patch, reason = "text") => update((proj) => {
    const s = proj.shots.find(x => x.id === shot.id);
    if (s) Object.assign(s, patch);
  }, reason);
  const setCam = (patch) => update((proj) => {
    const s = proj.shots.find(x => x.id === shot.id);
    if (s) s.camera = { ...s.camera, ...patch };
  }, "text");

  const body = h("div.insp");

  /* The two clip-level tools. They used to exist only on the canvas, which
   * meant the same project opened in Studio quietly lost its director and its
   * dials. Same modules, same state, same plan — the canvas points them at a
   * shot with a wire, Studio with a numbered chip. */
  const clipGroups = [
    group("Director", {
      id: "director", icon: "\u2726", badge: directorBadge(),
      help: h("div",
        h("b", "It edits the project, it does not hand you text. "),
        "Ask in your own words and it comes back with a list of concrete changes \u2014 each one a sentence you can read and a box you can clear. Nothing lands until you press Apply, and everything that lands lands in one undo step.",
      ),
    }, directorBody(p, { refresh, chips: true })),

    group("Steering", {
      id: "steering", icon: "\u25ce", badge: steerBadge(p),
      help: h("div",
        h("b", "Six dials that rewrite the prompt, for the whole clip. "),
        "One shot can differ where it honestly can \u2014 distance, energy and light describe a frame \u2014 and that lives on the shot, under Fine-tune, not here. Pace decides how many shots there are, sound is one continuous track, and faithfulness is a marker per reference: none of those were ever per-shot.",
      ),
    }, steerBody(p, { refresh })),
  ];

  if (!shot) {
    clipGroups.forEach(g => body.appendChild(g));
    body.appendChild(h("div", { style: { padding: "14px 12px" } },
      h("div.hint", "No shot selected \u2014 pick one in the list on the left or on the timeline below, and its own controls appear here.")));
    return h("div.panel",
      h("div.hd", h("span.title", "Inspector"), h("span.spacer"), h("span.hint", MODES[p.mode].short)),
      h("div.bd", body));
  }

  const cam = shot.camera || {};
  const moving = cam.type !== "static" || (cam.secondary && cam.secondary !== "none");
  const lines = (shot.dialogue || []).filter(d => (d.text || "").trim()).length;
  const inv = p.mode === "r2v" ? referenceInventory(p) : [];

  const groups = [
    ...clipGroups,
    group(`Shot ${index + 1}`, {
      id: "shot", icon: "▣", defaultOpen: true,
      badge: `${shotTime(shot.at)}`,
      help: h("div",
        h("b", "One shot, one idea. "),
        index === 0
          ? "Shot 1 opens the clip at 0.000 and carries the overall style — the model anchors on its first sentence."
          : "A cut should introduce new information. If only the distance or the angle needs to change, prefer a camera move.",
      ),
    },
      index > 0 ? row("Cuts at", h("div.flex",
        h("input", {
          type: "number", step: "0.1", min: "0.5", max: String(p.render.duration - 0.5), class: "num",
          value: String(shot.at),
          onchange: (e) => { set({ at: clamp(Number(e.target.value) || 0, 0.5, p.render.duration - 0.5) }, "shots"); refresh(); },
        }),
        h("span.hint", "seconds"),
      )) : null,
      row("Shot type", select(SHOT_TYPES, shot.shotType, (v) => { set({ shotType: v }, "shots"); refresh(); })),
      row("Subject", (() => {
        const input = h("input", {
          type: "text", value: shot.subject || "", placeholder: "a barista in a grey apron",
          oninput: (e) => set({ subject: e.target.value }),
        });
        /* The second way to cast someone: not describing a face but naming
         * one the model already has. The picker only ever appends, because
         * "Walter White" and "in a stained lab coat" are both true and the
         * one you typed is not the one to throw away. */
        return h("div.flex", { style: { gap: "5px" } }, input,
          h("button.btn.sm.ghost", {
            title: "Characters H3 renders from the name alone",
            onclick: async () => {
              const entry = await pickCharacter({ verb: "Cast" });
              if (!entry) return;
              const line = castLine(entry);
              const now = (input.value || "").trim();
              input.value = now ? `${now}, ${line}` : line;
              set({ subject: input.value }, "shots");
              refresh();
            },
          }, "🎭"));
      })()),
      /* Only from shot 2 on: shot 1 has nothing to have changed from. This is
       * the answer to "she is wearing the blazer she just took off" — the head
       * repeats the subject line at every cut, and this is what corrects it. */
      index > 0 ? row("Changed since", h("input", {
        type: "text", value: shot.continuity || "",
        placeholder: "jacket off, hair loose, gun now in her hand",
        title: "What is different about the subject NOW. The prompt repeats the subject line at every cut, so anything the earlier shots changed is described as it was unless this says otherwise.",
        oninput: (e) => set({ continuity: e.target.value }),
      }), "H3 has no memory across a cut — this is what carries the change over.") : null,
      beatEditor(p, shot, index, shots, { refresh }),
      h("div.btn-row", { style: { marginTop: "9px" } },
        h("button.btn.ai.sm.grow", {
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.classList.add("disabled"); btn.textContent = "polishing…";
            try {
              const r = await polishShot(shot, index, p);
              const beats = Array.isArray(r.beats) && r.beats.length
                ? r.beats.map((b, bi) => newBeat(typeof b === "string" ? b : (b?.text || ""), bi === 0 ? "" : (b?.link || "then")))
                : shot.beats;
              set({
                subject: r.subject || shot.subject,
                beats,
                setting: r.setting || shot.setting,
                lighting: r.lighting || shot.lighting,
                details: r.details || shot.details,
              }, "shots");
              if (r.camera) setCam(r.camera);
              toast("Shot polished", r.model || "", "ok");
              refresh();
            } catch (err) { toast("Polish failed", err.message, "err"); }
            finally { btn.classList.remove("disabled"); btn.textContent = "✨ Polish this shot"; }
          },
        }, "✨ Polish this shot"),
      ),
      more("Setting, viewpoint and detail",
        index > 0 ? row("Cut", select(TRANSITIONS, shot.cutVerb || "the camera cuts to", (v) => set({ cutVerb: v })),
          shot.cutVerb === NO_CUT
            ? "No cut: this row continues the previous take — its reframe and beats are written into the same [Shot N] block, with no new marker. Use it to give one long shot several moments."
            : activeEngine(p) === "ltx25"
              ? "How the clip gets from the previous shot to this one. On LTX-2.5 every plain cut is written the way Lightricks' guide names one — \"a hard cut transitions to …\"; a dissolve or fade keeps its name."
              : "How the clip gets from the previous shot to this one. The first five are MiniMax's approved cut verbs; dissolve and fade exist but the guide asks for them only on explicit request.") : null,
        row("Viewpoint", select(VIEWPOINTS, shot.viewpoint, (v) => set({ viewpoint: v }))),
        row("Setting", h("input", {
          type: "text", value: shot.setting || "", placeholder: "a narrow café counter by a rain-streaked window",
          oninput: (e) => set({ setting: e.target.value }),
        })),
        row("Lighting", select(LIGHTING.map(l => [l, l || "— none —"]), shot.lighting, (v) => set({ lighting: v }))),
        row("Extra detail", textarea(shot.details, (v) => set({ details: v }), {
          rows: 2, placeholder: "steam curls off the cup; the tag of the filter sways",
        })),
        /* Diegetic sound — what the people in the shot can hear. The guide
         * sends it to the description, not to either sound field: "Singing,
         * instruments, radio, television, or phone music audible to the
         * characters are diegetic events and should appear in the multimodal
         * description." This field compiled into the description all along and
         * had no input anywhere in the app. */
        row("Sound in shot", textarea(shot.sfx, (v) => set({ sfx: v }), {
          rows: 2, placeholder: "the grinder starts and cuts out; a radio plays faintly behind the counter",
        }), "What the characters can hear. Ambience goes on the Sound page; this is tied to the shot."),
        /* Timeline pinning — LTX-2.5 engine only. H3 has no per-frame guide
         * input (its one image input is the I2V first frame), so on the
         * MiniMax engine this attachment rides along unused and the checks
         * say so. On LTX the image is conditioned into the clip at this
         * shot's cut time (LTXVAddGuide): it pins what the frame looks like
         * when the shot lands. It does not force a hard cut. */
        row("Pin (LTX)", shot.keyframe
          ? h("div.flex", { style: { gap: "5px" } },
              h("span.hint.mono.grow", { title: shot.keyframe.name }, shot.keyframe.name),
              h("span.hint.mono", {
                title: "LTXVAddGuide anchors on the video VAE's 8-frame stride (⅓ s at 24 fps). This is where the pin actually lands.",
              }, `→ f${ltxGuideIdx(shot.at, p)} · ${shotTime(ltxGuideTime(shot.at, p))}`),
              h("button.btn.sm.ghost", {
                title: "Remove the pin (the image stays in the media pool)",
                onclick: () => { set({ keyframe: null }, "shots"); refresh(); },
              }, "✕"))
          : (() => {
              const file = h("input", {
                type: "file", accept: "image/*", style: { display: "none" },
                onchange: async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  try {
                    const item = await ingest(f);
                    if (item.kind !== "image") return toast("Not an image", "A timeline pin is a picture.", "warn");
                    set({ keyframe: item }, "shots");
                    toast("Timeline pinned", `${item.name} at ${shotTime(shot.at)}`, "ok");
                    refresh();
                  } catch (err) { toast("Could not read the file", err.message, "err"); }
                },
              });
              return h("div.flex", { style: { gap: "5px" } }, file,
                h("button.btn.sm", { onclick: () => file.click() }, "＋ Pin an image at this cut"));
            })(),
          "LTX-2.5 engine only: the image is anchored at this shot's cut time with LTXVAddGuide — it pins the timeline, it does not force a hard cut. The MiniMax graph ignores it."),
        shot.keyframe ? row("Pin strength", h("div.flex",
          h("input", {
            type: "number", step: "0.05", min: "0.1", max: "1", class: "num",
            value: String(shot.keyframeStrength ?? 1),
            onchange: (e) => { set({ keyframeStrength: Math.min(1, Math.max(0.1, Number(e.target.value) || 1)) }, "shots"); refresh(); },
          }),
          h("span.hint", "0.1 – 1.0"),
        ), "1.0 holds the pinned frame hard; lower lets the model drift toward it. The strength is the knob worth sweeping.") : null,
      ),
      /* Fine-tuning belongs to the shot, not to a global panel aimed at it.
       * Three dials, because three is how many of the six honestly describe a
       * frame; the other three describe the clip and stay on the Steering
       * group where they mean something. */
      more(`Fine-tune this shot · ${shotTuneBadge(shot)}`, shotTune(p, shot, { refresh })),
    ),

    group("Camera", {
      id: "camera", icon: "◎",
      badge: moving ? cam.type : "static",
      help: h("div",
        h("b", "Motion is always stated. "),
        "If the camera does not move, the prompt says so — leaving it out is what makes the model invent one. ",
        h("b", "Medium amplitude"), " and ", h("b", "normal speed"),
        " are the unmarked cases and are left out of the prose. Framing is true for the whole shot; the move is what changes during it.",
      ),
    },
      row("Motion", select(CAMERA_TYPES.map(c => [c[0], c[1]]), cam.type, (v) => { setCam({ type: v }); refresh(); })),
      moving ? row("Amplitude", segmented(AMPLITUDES, cam.amplitude || "medium", (v) => { setCam({ amplitude: v }); refresh(); })) : null,
      moving ? row("Speed", segmented(SPEEDS, cam.speed || "normal", (v) => { setCam({ speed: v }); refresh(); })) : null,
      cam.type !== "static" ? row("Toward", h("input", {
        type: "text", value: cam.target || "", placeholder: "the cup",
        oninput: (e) => setCam({ target: e.target.value }),
      })) : null,
      h("div.cam-readout", cameraSentence(cam)),
      h("div.hint", { style: { marginTop: "5px" } }, "Or drag the boxes in Previz — the move follows."),
      more("Lens, framing and depth",
        row("Lens", select(LENSES, cam.lens || "", (v) => { setCam({ lens: v }); refresh(); })),
        row("Height", select(CAMERA_HEIGHTS, cam.height || "", (v) => { setCam({ height: v }); refresh(); })),
        row("Subject in frame", select(
          cam.framing === "custom" ? [...FRAMINGS, ["custom", "Custom — dragged"]] : FRAMINGS,
          cam.framing || "centered",
          (v) => {
            const [px, py] = FRAMING_PRESET_XY[v] || [50, 50];
            setCam({ framing: v, fx: px, fy: py });
            refresh();
          }),
          cam.framing === "custom" ? `x ${Math.round(cam.fx ?? 50)}% · y ${Math.round(cam.fy ?? 50)}%` : null),
        row("Depth", select(DEPTH_CUES, cam.depth || "", (v) => { setCam({ depth: v }); refresh(); })),
        row("And also", select(SECONDARY_MOVES, cam.secondary || "none", (v) => { setCam({ secondary: v }); refresh(); })),
        row("Write the move yourself", textarea(cam.custom || "", (v) => setCam({ custom: v }), {
          rows: 2, placeholder: "The camera swings around the counter and settles behind her shoulder",
        }), "Replaces the generated line outright."),
        framingSentence(cam, shot.shotType) ? h("div.cam-readout", framingSentence(cam, shot.shotType)) : null,
      ),
    ),

    group("Dialogue", {
      id: "dialogue", icon: "❝", badge: lines ? String(lines) : null,
      help: h("div",
        "Words go in verbatim inside ", h("code", "<d>[Language] … </d>"),
        " and are never translated. Speaker ids are stable across shots. ",
        h("b", "Mentioning speech without quoted words makes the model invent dialogue."),
      ),
    },
      ...(shot.dialogue || []).map((line) => h("div", { style: { marginBottom: "8px" } },
        h("div.flex", { style: { marginBottom: "3px" } },
          h("span.tag", `(${line.speaker})`),
          h("span.hint.grow", line.voiceover ? "off-screen voiceover" : line.language),
          h("button.btn.ghost.sm", {
            title: "Delete this line",
            onclick: () => {
              update((proj) => {
                const s = proj.shots.find(x => x.id === shot.id);
                s.dialogue = s.dialogue.filter(d => d.id !== line.id);
              }, "shots");
              refresh();
            },
          }, "✕"),
        ),
        textarea(line.text, (v) => update((proj) => {
          const s = proj.shots.find(x => x.id === shot.id);
          const d = s.dialogue.find(x => x.id === line.id);
          if (d) d.text = v;
        }, "text"), { rows: 2, placeholder: "the exact words, verbatim" }),
      )),
      h("button.btn.sm.wide", {
        onclick: () => document.querySelector('.page-btn[data-page="sound"]')?.click(),
      }, lines ? "Edit on the Sound page" : "＋ Add a line on the Sound page"),
    ),

    p.mode === "r2v" ? group("References", {
      id: "refs", icon: "⧉", badge: inv.length ? String(inv.length) : null,
      help: "Cite every attached reference for what it actually shows. A tag with no media behind it is silently ignored, and a reference nobody mentions does nothing. Click a tag to drop it where the cursor is.",
    },
      referenceChips(p),
    ) : null,

    group("Style", {
      id: "style", icon: "✦", badge: p.style.look.split(" ")[0],
      help: "Shot 1 has to establish the overall style and the initial composition — this is what it opens with. A grade is a real, describable visual fact, which steers the model far better than \"cinematic\".",
    },
      row("Look", select(LOOKS.map(l => [l, l]), p.style.look, (v) => { update(proj => { proj.style.look = v; }, "style"); refresh(); })),
      row("Grade", select(GRADES, p.style.grade, (v) => { update(proj => { proj.style.grade = v; }, "style"); refresh(); })),
      more("Anything else about the whole clip",
        textarea(p.style.extra, (v) => update(proj => { proj.style.extra = v; }, "text"), {
          rows: 2, placeholder: "shot on a 35mm lens, shallow depth of field",
        }),
      ),
    ),

    group("Prompt source", {
      id: "prompt", icon: "≡", badge: p.prompt.manual ? "manual" : "auto",
      help: "With the override off, the description is compiled from the shot list every time — nothing to keep in sync. Turn it on to edit the paragraph by hand, or after a rewrite.",
    },
      /* Loud when it is on. This is the one setting that makes every other edit
       * look broken — the shots, the camera and the dials stop being compiled,
       * so changing them changes nothing the model reads, and the only symptom
       * is "my edits do not apply". */
      p.prompt.manual ? h("div.note.warn", { style: { marginTop: "0" } },
        h("b", "Your shots are not being compiled."),
        " This text is sent to the model instead, so edits to the subject, beats, camera or dials will not reach it.",
        h("div.btn-row", { style: { marginTop: "7px" } },
          h("button.btn.sm", {
            onclick: () => {
              update(proj => { proj.prompt.manual = false; }, "prompt");
              toast("Back to the built prompt", "Your shots drive the description again", "ok");
              refresh();
            },
          }, "Use my shots again"),
        ),
      ) : null,
      checkbox("Edit the description by hand", !!p.prompt.manual,
        (v) => { update(proj => { proj.prompt.manual = v; if (v && !proj.prompt.description) proj.prompt.description = compilePrompt(proj).description; }, "prompt"); refresh(); }),
      p.prompt.manual ? textarea(p.prompt.description, (v) => update(proj => { proj.prompt.description = v; }, "text"), { rows: 8, style: { marginTop: "8px" } }) : null,
      p.mode === "i2v" ? h("div", { style: { marginTop: "8px" } },
        checkbox("Emit the keyframe-alignment line", !!p.prompt.alignKeyframe,
          (v) => { update(proj => { proj.prompt.alignKeyframe = v; }, "prompt"); refresh(); },
          "The guide's own first line for I2VA: it anchors <Picture 1> at 0.00 seconds")) : null,
    ),
  ];
  groups.filter(Boolean).forEach(g => body.appendChild(g));

  return h("div.panel",
    h("div.hd", h("span.title", "Inspector"), h("span.spacer"), h("span.hint", MODES[p.mode].short)),
    h("div.bd", body),
  );
}


function draw() {
  const p = getProject();
  playhead = clamp(playhead, 0, p.render.duration);
  mount(root,
    h("div.cols",
      shotList(p),
      nodeViewVisible(p)
        // The strip grows with the graph — a Ref2V project with a full pool has
        // five source rows, and a fixed 168px strip hides half of them behind a
        // scrollbar nobody notices.
        // On a phone the stylesheet stacks this into two rows and hides the
        // node strip, so an inline three-row template would only be something
        // it had to fight — and something a dragged size would have to fight
        // as well.
        ? h("div.cut-center.with-nodes", {
            style: window.innerWidth > 880
              ? { gridTemplateRows: `minmax(140px, 1fr) ${nodeStripHeight(p)}px 214px` }
              : {},
          }, viewerPanel(p), nodePanel(p), timeline(p))
        : h("div.cut-center", viewerPanel(p), timeline(p)),
      inspector(p),
    ),
  );
}

/**
 * Open the Director here, optionally with a request already asked.
 *
 * The canvas has the same entry point. Whichever view you are in when you
 * press \u2318J is the one that answers \u2014 the assistant is not a reason to be
 * thrown into a different layout.
 */
export function askDirector(request = "", runner = null) {
  director.request = request;
  refresh();
  requestAnimationFrame(() => {
    // The inspector is an accordion; opening the group is what makes it
    // visible, and it is stored, so it stays open across the next redraw.
    const g = root?.querySelector('.insp-group[data-group="director"]');
    if (g?.classList.contains("closed")) g.querySelector(".gh")?.click();
    root?.querySelector(".dr-ask")?.focus();
    if (request || runner) runDirector(request || "review this", runner);
  });
}

export function render(el) { root = el; draw(); }
export function refresh() { if (root) draw(); }
function nudge(delta) {
  const p = getProject();
  playhead = clamp(playhead + delta, 0, p.render.duration);
  if (previz && viewerMode === "previz") previz.seek(playhead);
  refresh();
}

export const shortcuts = {
  " ": () => {
    if (viewerMode !== "previz") { setViewerMode("previz"); return; }
    previz?.toggle();
    // Repaint the transport button without rebuilding the player.
    const btn = root?.querySelector(".viewer .transport .btn");
    if (btn) btn.textContent = previz?.isPlaying ? "❚❚" : "▶";
  },
  s: splitAtPlayhead,
  b: () => setViewerMode(viewerMode === "board" ? "previz" : "board"),
  n: () => toggleNodeView(getProject()),
  d: () => { const sel = selectedShot(getProject()); if (sel) { duplicateShot(sel.id); refresh(); } },
  ArrowLeft:  () => nudge(-0.25),
  ArrowRight: () => nudge(0.25),
  Home: () => { playhead = 0; previz?.seek(0); refresh(); },
  End:  () => { playhead = getProject().render.duration; previz?.seek(playhead); refresh(); },
  Delete: deleteSelected,
  Backspace: deleteSelected,
};
