/* MOTIONSTILL CUT — the canvas.
 *
 * The whole app as one graph: drop a file, type a line, press render. It is a
 * VIEW, not a second app — nodes are the project's own pieces (media pool
 * items, shots, the steering dials, the sound fields, the render) and wiring
 * one to another edits the same fields the studio edits. The generation mode
 * isn't even a choice here: it follows from what is connected, because "a
 * picture wired into a shot" and "image to video" are the same statement.
 *
 * Everything below the node bodies is about one thing: making the graph
 * obvious. A node canvas is only intuitive if you never have to guess.
 *
 *   Nothing is hidden behind a 13px dot. You start a connection by dragging
 *   from ANYWHERE on a node's body, or by clicking Link and then clicking a
 *   target — because trackpads, touchscreens and shaky hands all exist.
 *
 *   The canvas tells you what is legal before you commit. While you drag,
 *   valid targets light up, invalid ones dim, and a label under the cursor
 *   says what the drop will actually do in plain words.
 *
 *   It arranges itself. Nodes flow left to right — material, shots, sound,
 *   render — and are stacked by their measured height, so wires never cross
 *   and nothing ever lands on top of anything. Drag a node and it stays where
 *   you put it; Tidy gives the arrangement back.
 *
 *   You can get around. Pan by dragging the background, zoom on the wheel,
 *   Fit to see all of it. Standard for a graph, and absent from the first cut
 *   of this view.
 */

import {
  h, mount, clear, toast, uid, clamp, timecode, download, copyText, modal, select,
} from "../util.js";
import {
  getProject, update, orderedShots, newShot, newBeat, newDialogue, nextUnusedSpeaker,
  referenceInventory, removeReference,
  normaliseMedia,
  shotActionText, dimensions, frameCount, DURATION_FRAMES, MODES, H3_DURATION, overLength,
 onProjectSwap} from "../state.js";
import { ingest, getBlob, delBlob, posterFor } from "../media.js";
import { compilePrompt, validate, cameraSentence, compileSubjectDefs, taskTypeFor } from "../prompt.js";
import { SPEEDS, SPEAKERS, LANGUAGES, LOOKS, GRADES, REF_TASK_TYPES, TRANSITIONS, NO_CUT } from "../vocab.js";
import { estimateSeconds, humanTime } from "../workflow.js";
import { renderNow, currentJob, onRenderChange, cancelRender, applyLive } from "../render.js";
import { enhance, breakdown, polishShot } from "../llm.js";
import { api } from "../api.js";
import { getHealth, getSettings } from "../config.js";
import { DEFAULT_DIALS, applySteering, hasOwnDials } from "../steer.js";
import { steerBody, steerBadge, shotTune, shotTuneBadge } from "../steerpanel.js";
import {
  director, focusedShot, setFocus, directorBody, directorBadge, runDirector,
} from "../director.js";
import { createReadthrough } from "../readthrough.js";
import { beatEditor } from "../beats.js";
import { queueLength } from "../queue.js";

let root = null;
let unsub = null;
let dragWire = null;      // { fromId, payload, x, y } while a wire is being pulled
let linking = null;       // { fromId, payload } while in click-to-link mode
let busy = false;

const NODE_W = 236;
const GAP_X = 96;         // breathing room between columns
const GAP_Y = 22;

/* ── The viewport ─────────────────────────────────────────────
 * Pan and zoom live here rather than in the project: moving the camera is not
 * an edit, and it has no business on the undo stack. */
const view = { x: 28, y: 20, z: 1, touched: false };

/* A fresh project gets a fresh viewport. `touched` records that the user has
 * panned or zoomed and permanently disables auto-reframe; carrying it over
 * meant a new project opened at the previous one's pan and never framed
 * itself. */
onProjectSwap(() => { Object.assign(view, { x: 28, y: 20, z: 1, touched: false }); });
const ZOOM_MIN = 0.35, ZOOM_MAX = 1.7;
const geom = new Map();   // id → { x, y, w, h } in world coordinates

/** Screen point → canvas coordinates, whatever the pan and zoom are. */
function toWorld(clientX, clientY) {
  const canvas = root?.querySelector(".sn-canvas");
  if (!canvas) return { x: 0, y: 0 };
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left - view.x) / view.z,
    y: (clientY - rect.top - view.y) / view.z,
  };
}

function applyView() {
  const world = root?.querySelector(".sn-world");
  if (world) world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
  const pct = root?.querySelector(".sn-zoom-pct");
  if (pct) pct.textContent = `${Math.round(view.z * 100)}%`;
}

function zoomAt(clientX, clientY, factor) {
  const before = toWorld(clientX, clientY);
  view.z = clamp(view.z * factor, ZOOM_MIN, ZOOM_MAX);
  const canvas = root.querySelector(".sn-canvas");
  const rect = canvas.getBoundingClientRect();
  // Keep the point under the cursor pinned while the scale changes.
  view.x = clientX - rect.left - before.x * view.z;
  view.y = clientY - rect.top - before.y * view.z;
  applyView();
}

/** Frame every node with a margin, so "where did my graph go" never happens. */
function fitView() {
  const canvas = root?.querySelector(".sn-canvas");
  if (!canvas || !geom.size) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const g of geom.values()) {
    minX = Math.min(minX, g.x); minY = Math.min(minY, g.y);
    maxX = Math.max(maxX, g.x + g.w); maxY = Math.max(maxY, g.y + g.h);
  }
  const pad = 40;
  const w = maxX - minX + pad * 2, hgt = maxY - minY + pad * 2;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  view.z = clamp(Math.min(rect.width / w, rect.height / hgt), ZOOM_MIN, 1);
  view.x = (rect.width - w * view.z) / 2 - (minX - pad) * view.z;
  view.y = (rect.height - hgt * view.z) / 2 - (minY - pad) * view.z;
  // Framing everything hands the view back to the app: from here it may keep
  // things in shot again until the creator moves it themselves.
  view.touched = false;
  applyView();
  drawWires(getProject());
}

/* ── Layout ───────────────────────────────────────────────────
 * Positions live in the project so a canvas someone arranged stays arranged.
 * Anything without a position gets one from a tidy default grid. */
function positions(p) {
  p.simple = p.simple || { pos: {} };
  p.simple.pos = p.simple.pos || {};
  return p.simple.pos;
}

function setPos(id, x, y) {
  update((draft) => { positions(draft)[id] = { x: Math.round(x), y: Math.round(y) }; }, "text");
}

/** Every media item in the pool, whatever bin it sits in. */
function poolItems(p) {
  return [
    ...(p.frames?.first ? [{ ...p.frames.first, bin: "first" }] : []),
    ...(p.refs?.images || []).map(m => ({ ...m, bin: "images" })),
    ...(p.refs?.videos || []).map(m => ({ ...m, bin: "videos" })),
    ...(p.refs?.audios || []).map(m => ({ ...m, bin: "audios" })),
  ];
}

/* ── The mode follows the wiring ──────────────────────────────
 * One image wired in is image-to-video. Several, or a clip, or a sound file, is
 * reference-to-video. Nothing is text-to-video. Saying that out loud in a
 * dropdown was always a restatement of what the canvas already shows. */
/* One rule, in state.js, shared by every entry point — the canvas used to
 * carry its own slightly different version, so dropping a file here and
 * dropping one on the Media page could reach different conclusions. */
function syncMode(draft) { normaliseMedia(draft); }

/* ── Adding media ─────────────────────────────────────────── */
async function addFiles(fileList, dropAt) {
  const files = [...fileList];
  if (!files.length) return;
  const added = [];
  for (const file of files) {
    try {
      const item = await ingest(file);
      if (item.kind === "video") item.poster = await posterFor(await getBlob(item.id));
      added.push(item);
    } catch (err) { toast("Could not read the file", `${file.name}: ${err.message}`, "err"); }
  }
  if (!added.length) return;

  update((p) => {
    for (const [i, item] of added.entries()) {
      if (item.kind === "audio") { if ((p.refs.audios || []).length < 3) p.refs.audios.push(item); }
      else if (item.kind === "video") { if ((p.refs.videos || []).length < 3) p.refs.videos.push(item); }
      else if (!p.frames.first) p.frames.first = item;
      else if ((p.refs.images || []).length < 9) p.refs.images.push(item);
      if (dropAt) positions(p)[item.id] = { x: dropAt.x, y: dropAt.y + i * 232 };
    }
    syncMode(p);
    // A single image wired into a shot is a first frame; a second one means the
    // pool is a cast, and the first frame moves into it.
    if (p.mode === "r2v" && p.frames.first) {
      const first = p.frames.first;
      p.frames.first = null;
      if ((p.refs.images || []).length < 9) p.refs.images.unshift(first);
    }
  }, "media");
  refresh();
}

function removeMedia(item) {
  let result = { dropped: [], renamed: [] };
  update((p) => {
    // removeReference resolves the tags BEFORE it mutates, strips the removed
    // one from every shot, and renumbers what the survivors are cited as —
    // because a tag is a position, and deleting one silently re-points every
    // later citation at a different picture.
    result = removeReference(p, item.id);
    syncMode(p);
  }, "media");
  delBlob(item.id);
  if (result.renamed.length) {
    toast("Renumbered",
      result.renamed.map(([from, to]) => `${from} → ${to}`).join(", ")
      + " — your shots were updated to match.", "");
  }
  refresh();
}

const tagFor = (p, item) => {
  // The first frame answers to <Picture 1> only when nothing in the reference
  // pool already holds that number — otherwise two different pictures would
  // both claim it and a citation would be ambiguous.
  if (p.frames?.first?.id === item.id) return (p.refs?.images || []).length ? null : "<Picture 1>";
  return referenceInventory(p).find(e => e.ref?.id === item.id && e.kind !== "audio")?.tag
    || referenceInventory(p).find(e => e.ref?.id === item.id)?.tag
    || null;
};

/* ── Wiring: a tag in the shot's text IS the connection ────── */
/**
 * The shot a piece of media belongs to when no shot cites it in words.
 *
 * I2V's first frame is the one case: it anchors the opening frame and is
 * referenced by the keyframe-alignment line rather than by any shot's prose,
 * so nothing "cites" it and it was landing in the uncited inbox — connected to
 * nothing, which is exactly what it is not. It belongs above shot 1.
 */
function anchorsShot(p, item) {
  if (p.mode !== "i2v" || p.frames?.first?.id !== item.id) return null;
  return orderedShots(p)[0] || null;
}

/* The same fields the compiled description draws from. This used to omit
 * `setting` and `lighting`, so a tag cited there counted for the checker and
 * not for the node — one saying the reference was used and the other saying it
 * was not, about the same project. */
function shotCites(shot, tag) {
  if (!tag) return false;
  return [shot.subject, shotActionText(shot), shot.details, shot.setting, shot.lighting, shot.sfx]
    .join(" ").includes(tag);
}

function stripTag(shot, tag) {
  const clean = (v) => String(v || "")
    .split(tag).join("")
    // Removing "<Picture 1>" from "a grey coat with <Picture 1>" must take the
    // "with" too, or reconnecting builds "a grey coat with with <Picture 1>".
    .replace(/\s+(with|and)\s*$/i, "")
    .replace(/\s+(with|and)\s+(?=(with|and)\b)/gi, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;])/g, "$1")
    .trim();
  shot.subject = clean(shot.subject);
  shot.details = clean(shot.details);
  (shot.beats || []).forEach(b => { b.text = clean(b.text); });
}

function connect(shotId, tag) {
  update((p) => {
    const shot = p.shots.find(s => s.id === shotId);
    if (!shot || shotCites(shot, tag)) return;
    // The tag goes where the model reads the cast: the subject if it is empty,
    // otherwise appended to it.
    shot.subject = shot.subject?.trim() ? `${shot.subject.trim()} with ${tag}` : tag;
  }, "shots");
  refresh();
}

/* ── Speaking parts ───────────────────────────────────────────
 * A line belongs to a shot (that is where the model reads it) but a VOICE
 * belongs to the clip: (S1) in shot 1 and (S1) in shot 4 are the same person
 * and H3 keeps the voice between them. So the canvas draws the voice once and
 * wires it to every shot it speaks in, rather than burying the lines inside
 * each shot where the through-line is invisible. */
function addLine(shotId, speaker) {
  update((p) => {
    const shot = p.shots.find(s => s.id === shotId);
    if (!shot) return;
    shot.dialogue = [...(shot.dialogue || []), { ...newDialogue(speaker), language: lastLanguage(p, speaker) }];
  }, "shots");
  refresh();
}

/** Whatever language this speaker last spoke, so a second line does not come
 *  back in English when the first was not. */
function lastLanguage(p, speaker) {
  for (const shot of [...(p.shots || [])].reverse()) {
    const line = [...(shot.dialogue || [])].reverse().find(d => d.speaker === speaker);
    if (line?.language) return line.language;
  }
  return "English";
}

/** Every speaking part in the clip, with where each one speaks. */
function voices(p) {
  const byId = new Map();
  orderedShots(p).forEach((shot, i) => {
    for (const line of shot.dialogue || []) {
      const spk = line.speaker || "S1";
      if (!byId.has(spk)) byId.set(spk, { speaker: spk, lines: [] });
      byId.get(spk).lines.push({ shot, index: i, line });
    }
  });
  return [...byId.values()].sort((a, b) => a.speaker.localeCompare(b.speaker));
}

/**
 * Give every attached reference a shot that names it.
 *
 * Shared by the Idea button and Create's hand-off. The first shot takes
 * anything nothing else claimed: it establishes the clip, so a citation there
 * carries. Returns how many had to be rescued, so the caller can say what it
 * did rather than quietly editing the creator's words.
 */
export function citeLooseReferences(draft) {
  const shots = orderedShots(draft);
  if (!shots.length) return 0;
  const cited = (tag) => shots.some(sh => shotCites(sh, tag));
  const loose = referenceInventory(draft).filter(e => e.tag && e.kind !== "audio" && !cited(e.tag));
  if (!loose.length) return 0;
  const first = draft.shots.find(sh => sh.id === shots[0].id);
  const tags = loose.map(e => e.tag).join(" and ");
  const subject = (first.subject || "").trim();
  first.subject = subject ? `${subject} — ${tags}` : tags;
  return loose.length;
}

function disconnect(shotId, tag) {
  update((p) => {
    const shot = p.shots.find(s => s.id === shotId);
    if (shot) stripTag(shot, tag);
  }, "shots");
  refresh();
}

/* ── Nodes ────────────────────────────────────────────────── */
const ICON = {
  image: "▣", video: "▶", audio: "♪", shot: "⬛", sound: "♬", render: "⏻", steer: "◎",
  director: "✦", add: "＋", voice: "❝", look: "◐", cast: "⧉",
};


/* What a connection from this node will actually DO, said in the creator's
 * words. Shown under the cursor mid-drag and on the Link button, because
 * "port" and "edge" are not words anyone arrives already knowing. */
function dropVerb(kind) {
  return kind === "audio" ? "use this sound as the reference"
    : kind === "video" ? "match this clip's motion"
    : kind === "image" ? "put this picture in the shot"
    : kind === "director" ? "work on this shot only"
    : kind === "voice" ? "give this voice a line here"
    : "connect";
}

/** Grow a node's textarea to its content: a node that hides half its own text
 * makes you click into it to find out what it says. */
function autoGrow(node) {
  node.querySelectorAll("textarea").forEach((ta) => {
    const fit = () => {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(220, ta.scrollHeight)}px`;
    };
    ta.addEventListener("input", fit);
    requestAnimationFrame(fit);
  });
}

function nodeEl(p, { id, x, y, kind, title, badge, body, ports = {}, onRemove, accent, hint, className = "", dragPayload = null, action = null }) {
  const node = h("div", {
    class: `sn-node sn-${kind}${className ? ` ${className}` : ""}`,
    style: { left: `${x}px`, top: `${y}px`, width: `${NODE_W}px`, ...(accent ? { borderColor: accent } : {}) },
    dataset: { node: id, kind },
  },
    h("div.sn-hd", { style: accent ? { background: accent } : {} },
      h("span.sn-ico", ICON[kind] || "▪"),
      h("span.sn-title", title),
      badge ? h("span.sn-badge", badge) : null,
      /* Kept away from ✕ by a spacer: one of these rewrites the shot with a
       * model and the other deletes it, and they should not be neighbours. */
      action ? h("button.sn-act", {
        title: action.title,
        onclick: (e) => { e.stopPropagation(); action.run(e.currentTarget); },
      }, h("span", action.label)) : null,
      action && onRemove ? h("span.sn-hd-gap") : null,
      onRemove ? h("button.sn-x", { title: "Remove", onclick: (e) => { e.stopPropagation(); onRemove(); } }, "✕") : null,
    ),
    h("div.sn-bd", body),
  );

  moveOnDrag(node, id);
  autoGrow(node);

  if (ports.out) {
    /* The dot stays — people who know node editors reach for it — but it is no
     * longer the only way in. The body drags, and Link works by clicking. */
    const port = h("div.sn-port.out", { title: `Drag to a shot to ${dropVerb(kind)}`, dataset: { port: id } });
    port.addEventListener("pointerdown", (e) => startWire(e, id, ports.out, kind));
    node.appendChild(port);
  }
  // What a drag from this node carries. A node can be draggable without
  // showing a port — the director is, because its wire is optional.
  const payload = dragPayload || (ports.out?.tag || ports.out?.focus ? ports.out : null);
  if (payload) {
    wireOnDrag(node, id, payload, kind);
    node.appendChild(h("button.sn-link", {
      title: `Click, then click a shot — same as dragging`,
      onclick: (e) => { e.stopPropagation(); beginLink(id, payload, kind); },
    }, "↗ Link"));
  }
  if (ports.in) node.appendChild(h("div.sn-port.in", { dataset: { portIn: id } }));
  if (hint) node.appendChild(h("div.sn-hint", hint));
  return node;
}

/* ── Moving a node ────────────────────────────────────────────
 * The header is the handle. Dragging it pins the node: auto-layout stops
 * touching it, because you have said where it goes. */
function moveOnDrag(node, id) {
  node.querySelector(".sn-hd").addEventListener("pointerdown", (e) => {
    if (e.target.closest(".sn-x") || e.button !== 0) return;
    // No preventDefault: it would swallow the click, and a shot's header must
    // stay clickable as a link target. user-select: none already stops the
    // drag from selecting the title text.
    e.stopPropagation();
    // Read where the node is NOW: auto-layout will have moved it since it was
    // built, and a stale origin makes the node jump on the first pixel.
    const x = parseFloat(node.style.left) || 0;
    const y = parseFloat(node.style.top) || 0;
    const start = toWorld(e.clientX, e.clientY);
    const offX = start.x - x, offY = start.y - y;
    let moved = false;
    node.classList.add("dragging");
    const move = (ev) => {
      const w = toWorld(ev.clientX, ev.clientY);
      const nx = Math.round(w.x - offX), ny = Math.round(w.y - offY);
      if (nx !== x || ny !== y) moved = true;
      node.style.left = `${nx}px`;
      node.style.top = `${ny}px`;
      const g = geom.get(id);
      if (g) { g.x = nx; g.y = ny; }
      drawWires(getProject());
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      node.classList.remove("dragging");
      // Only a real move is a move. Writing the position on every press would
      // pin the node on a plain click, put a no-op on the undo stack, and —
      // because writing state redraws the canvas — destroy the node under the
      // cursor before its click event could reach the canvas, so clicking a
      // header to complete a link silently did nothing.
      if (moved) setPos(id, parseFloat(node.style.left), parseFloat(node.style.top));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}

/* ── Starting a wire from the body ────────────────────────────
 * Anywhere that is not a control. This is the change that makes the canvas
 * feel direct: you grab the picture and pull it onto the shot, which is what
 * you were already trying to do the first time. */
function wireOnDrag(node, id, payload, kind) {
  node.querySelector(".sn-bd").addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest("button, textarea, input, select, video, a")) return;
    startWire(e, id, payload, kind);
  });
}

/* ── Click to link ───────────────────────────────────────────
 * The same connection without holding the mouse down. Escape or a click on
 * the background cancels; the whole canvas stays in a visible armed state so
 * you are never in a mode you can't see. */
function beginLink(fromId, payload, kind) {
  linking = { fromId, payload, kind };
  const canvas = root.querySelector(".sn-canvas");
  canvas.classList.add("linking");
  markTargets(true);
  cursorLabel(`Click a shot to ${dropVerb(kind)}`);
  const onKey = (ev) => { if (ev.key === "Escape") endLink(); };
  const onMove = (ev) => cursorLabel(null, ev);
  canvas._linkCleanup = () => {
    window.removeEventListener("keydown", onKey);
    canvas.removeEventListener("pointermove", onMove);
  };
  window.addEventListener("keydown", onKey);
  canvas.addEventListener("pointermove", onMove);
}

function endLink() {
  const canvas = root?.querySelector(".sn-canvas");
  linking = null;
  if (canvas) {
    canvas.classList.remove("linking");
    canvas._linkCleanup?.();
    canvas._linkCleanup = null;
  }
  markTargets(false);
  cursorLabel(null);
  drawWires(getProject());
}

/** Light up what a drop is allowed to land on; dim everything else. */
function markTargets(on) {
  const canvas = root?.querySelector(".sn-canvas");
  if (!canvas) return;
  canvas.querySelectorAll(".sn-node").forEach((n) => {
    n.classList.toggle("valid", on && n.dataset.kind === "shot");
    n.classList.toggle("invalid", on && n.dataset.kind !== "shot");
    if (!on) n.classList.remove("target");
  });
}

/** A plain-words label that follows the cursor while a connection is in flight. */
function cursorLabel(text, ev) {
  const canvas = root?.querySelector(".sn-canvas");
  if (!canvas) return;
  let el = canvas.querySelector(".sn-cursor-label");
  if (text === null && !ev) { el?.remove(); return; }
  if (!el) {
    el = h("div.sn-cursor-label");
    canvas.appendChild(el);
  }
  if (text) el.textContent = text;
  if (ev) {
    const rect = canvas.getBoundingClientRect();
    el.style.left = `${ev.clientX - rect.left + 16}px`;
    el.style.top = `${ev.clientY - rect.top + 18}px`;
  }
}

function startWire(e, fromId, payload, kind) {
  e.preventDefault();
  e.stopPropagation();
  endLink();
  const canvas = root.querySelector(".sn-canvas");
  const w = toWorld(e.clientX, e.clientY);
  dragWire = { fromId, payload, kind, x: w.x, y: w.y };
  canvas.classList.add("linking");
  markTargets(true);
  cursorLabel(`Drop on a shot to ${dropVerb(kind)}`, e);

  const move = (ev) => {
    const pt = toWorld(ev.clientX, ev.clientY);
    dragWire.x = pt.x; dragWire.y = pt.y;
    drawWires(getProject());
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".sn-shot");
    canvas.querySelectorAll(".sn-shot").forEach(n => n.classList.toggle("target", n === over));
    const title = over?.querySelector(".sn-title")?.textContent;
    cursorLabel(over ? `${dropVerb(kind)} → ${title}` : `Drop on a shot to ${dropVerb(kind)}`, ev);
  };
  const up = (ev) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".sn-shot");
    const shotId = target?.dataset.node;
    dragWire = null;
    endLink();
    if (shotId && payload?.tag) connect(shotId, payload.tag);
    else if (shotId && payload?.focus) setFocus(shotId);
    else if (shotId && payload?.speaker) addLine(shotId, payload.speaker);
    else drawWires(getProject());
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/* ── Wires ────────────────────────────────────────────────────
 * Drawn from the measured geometry rather than from CSS strings, so they stay
 * attached to the right edge of a node whatever height its contents ended up.
 * Every wire a person made by hand carries a ✕ at its midpoint: the old canvas
 * expected you to guess that clicking the line removed it. */
/**
 * Where a wire leaves and lands.
 *
 * With shots laid out in time and their material stacked above them, a fixed
 * right-edge-to-left-edge rule sends a picture's wire on a long hook around
 * its own shot. So the edge is chosen from the geometry: a node above another
 * drops out of its bottom into the target's top, a node beside one goes edge
 * to edge, and the curve is bent along the same axis.
 *
 * @returns {{x, y, dir: "h"|"v"}}
 */
function wirePorts(id, side, otherId = null) {
  const g = geom.get(id);
  if (!g) return null;
  const o = otherId ? geom.get(otherId) : null;
  if (o) {
    const from = side === "out" ? g : o;
    const to = side === "out" ? o : g;
    // Vertical when one sits above the other and they overlap horizontally —
    // which is exactly the material-above-its-shot case.
    const overlap = Math.min(from.x + from.w, to.x + to.w) - Math.max(from.x, to.x);
    if (from.y + from.h <= to.y + 4 && overlap > Math.min(from.w, to.w) * 0.35) {
      return side === "out"
        ? { x: g.x + g.w / 2, y: g.y + g.h, dir: "v" }
        : { x: g.x + g.w / 2, y: g.y, dir: "v" };
    }
    // …and when one sits BELOW the other (the steering shelf reaching up).
    if (from.y >= to.y + to.h - 4 && overlap > Math.min(from.w, to.w) * 0.35) {
      return side === "out"
        ? { x: g.x + g.w / 2, y: g.y, dir: "v" }
        : { x: g.x + g.w / 2, y: g.y + g.h, dir: "v" };
    }
  }
  return { x: side === "out" ? g.x + g.w : g.x, y: g.y + 18, dir: "h" };
}


function drawWires(p) {
  const canvas = root?.querySelector(".sn-canvas");
  const world = root?.querySelector(".sn-world");
  const svg = root?.querySelector(".sn-wires");
  if (!canvas || !svg || !world) return;
  clear(svg);
  world.querySelectorAll(".sn-cut").forEach(n => n.remove());

  let extentX = 1200, extentY = 700;
  for (const g of geom.values()) {
    extentX = Math.max(extentX, g.x + g.w + 200);
    extentY = Math.max(extentY, g.y + g.h + 200);
  }
  svg.setAttribute("width", String(extentX));
  svg.setAttribute("height", String(extentY));
  svg.setAttribute("viewBox", `0 0 ${extentX} ${extentY}`);
  world.style.width = `${extentX}px`;
  world.style.height = `${extentY}px`;

  const wire = (a, b, color, opts = {}) => {
    if (!a || !b) return;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    // Bend along the axis the wire actually travels: a drop from a picture to
    // the shot below it curves vertically, a step from shot to shot curves
    // horizontally. A horizontal bend on a vertical wire draws an S nobody
    // can follow.
    const vertical = a.dir === "v" && b.dir === "v";
    const d = vertical
      ? (() => {
          const dy = Math.max(30, Math.abs(b.y - a.y) * 0.55);
          return `M ${a.x} ${a.y} C ${a.x} ${a.y + dy}, ${b.x} ${b.y - dy}, ${b.x} ${b.y}`;
        })()
      : (() => {
          const dx = Math.max(46, Math.abs(b.x - a.x) * 0.5);
          return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
        })();
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", opts.width || "2.5");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("opacity", opts.opacity || "0.85");
    if (opts.dashed) path.setAttribute("stroke-dasharray", "5 5");
    svg.appendChild(path);

    if (!opts.onRemove) return;
    /* A hit area far wider than the visible line, plus a real button — the
     * two ways anyone actually tries to delete a connection. */
    const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
    hit.setAttribute("d", path.getAttribute("d"));
    hit.setAttribute("fill", "none");
    hit.setAttribute("stroke", "transparent");
    hit.setAttribute("stroke-width", "16");
    hit.setAttribute("class", "sn-wire-hit");
    const t = document.createElementNS("http://www.w3.org/2000/svg", "title");
    t.textContent = opts.title || "Click to disconnect";
    hit.appendChild(t);
    hit.addEventListener("click", opts.onRemove);
    svg.appendChild(hit);

    /* The ✕ goes on the CURVE, not on the straight line between the ports:
     * a wire that arcs around a column has a straight-line midpoint sitting
     * inside some other node, which is where the button was landing. */
    let mid;
    try {
      const at = path.getPointAtLength(path.getTotalLength() / 2);
      mid = { x: at.x, y: at.y };
    } catch { mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
    const cut = h("button.sn-cut", {
      style: { left: `${mid.x}px`, top: `${mid.y}px` },
      title: opts.title || "Disconnect",
      onclick: (ev) => { ev.stopPropagation(); opts.onRemove(); },
    }, "✕");
    const hot = (on) => {
      cut.classList.toggle("hot", on);
      path.setAttribute("stroke-width", on ? "4" : (opts.width || "2.5"));
    };
    hit.addEventListener("mouseenter", () => hot(true));
    hit.addEventListener("mouseleave", () => hot(false));
    cut.addEventListener("mouseenter", () => hot(true));
    cut.addEventListener("mouseleave", () => hot(false));
    world.appendChild(cut);
  };

  const shots = orderedShots(p);
  // media → shot, wherever the shot actually cites the tag
  for (const item of poolItems(p)) {
    const tag = tagFor(p, item);
    if (!tag) continue;
    for (const shot of shots) {
      if (!shotCites(shot, tag)) continue;
      wire(wirePorts(item.id, "out", shot.id), wirePorts(shot.id, "in", item.id),
        item.kind === "video" ? "#c79ae0" : item.kind === "audio" ? "#79c79b" : "#7fb2e5",
        { onRemove: () => disconnect(shot.id, tag), title: `${tag} — click to disconnect` });
    }
  }
  /* I2V's first frame anchors the opening. It has no citation to hang a wire
   * on, but it is emphatically connected — so the wire is drawn from what it
   * anchors, solid, with no ✕: removing it is what the node's own ✕ is for. */
  if (p.mode === "i2v" && p.frames?.first && shots[0]) {
    wire(wirePorts(p.frames.first.id, "out", shots[0].id),
      wirePorts(shots[0].id, "in", p.frames.first.id),
      "#7fb2e5", { title: "anchors the first frame" });
  }

  // The director's wire, when it has one. This IS hand-made, so it carries a ✕.
  if (director.focus && geom.has("director")) {
    const target = shots.find(sh => sh.id === director.focus);
    if (target) {
      wire(wirePorts("director", "out", target.id), wirePorts(target.id, "in", "director"), "#a98fd6",
        { onRemove: () => setFocus(director.focus), title: "Working on this shot only — click to read the whole clip again" });
    }
  }
  /* The steering node governs the clip, so it is drawn to every shot — the
   * same weight to each, because it applies to each. A shot that has been
   * fine-tuned says so on the shot; it is not a different kind of connection,
   * and drawing it as one was the old panel's confusion in wire form. These
   * are not hand-made connections and deliberately have no ✕. */
  if (geom.has("steer")) {
    for (const shot of shots) {
      wire(wirePorts("steer", "out", shot.id), wirePorts(shot.id, "in", "steer"),
        "#c9a24d", { dashed: true, width: 1.5, opacity: "0.45" });
    }
  }
  /* A voice reaches every shot it speaks in. This is the only wire in the
   * graph that answers "who is in this scene" at a glance, which is exactly
   * what a speaker id is for: (S1) in shot 1 and (S1) in shot 4 are one
   * person and H3 keeps the voice between them. */
  for (const v of voices(p)) {
    const id = `voice:${v.speaker}`;
    if (!geom.has(id)) continue;
    const seen = new Set();
    for (const { shot, line } of v.lines) {
      if (seen.has(shot.id)) continue;
      seen.add(shot.id);
      const words = (line.text || "").trim();
      wire(wirePorts(id, "out", shot.id), wirePorts(shot.id, "in", id), "#d59ac0", {
        width: words ? 1.5 : 1,
        opacity: words ? "0.75" : "0.3",
        title: words ? `(${v.speaker}) speaks here` : `(${v.speaker}) has an empty line here — the model will render silence`,
      });
    }
  }
  /* The look anchors the opening: H3 reads the overall style from the first
   * sentence of [Shot 1] and carries it, so that is the one shot it reaches. */
  if (geom.has("look") && shots[0]) {
    wire(wirePorts("look", "out", shots[0].id), wirePorts(shots[0].id, "in", "look"), "#6fa8cc",
      { dashed: true, width: 1.5, opacity: "0.45", title: "the style opens shot 1 and carries" });
  }

  // shot → shot (the cut chain), and the last one into the render node
  shots.forEach((shot, i) => {
    if (i > 0) wire(wirePorts(shots[i - 1].id, "out", shot.id), wirePorts(shot.id, "in", shots[i - 1].id), "#5a6a7a", { dashed: true, width: 1.5, opacity: "0.5" });
  });
  if (shots.length) wire(wirePorts(shots[shots.length - 1].id, "out", "render"), wirePorts("render", "in", shots[shots.length - 1].id), "#4b9b58", { width: 3 });
  wire(wirePorts("sound", "out", "render"), wirePorts("render", "in", "sound"), "#79c79b", { dashed: true, width: 1.5, opacity: "0.5" });
  /* The cast sheet is prompt, not picture: it is the first three fields of
   * what gets encoded, so it reaches the render the way the sound does. */
  if (geom.has("ref2v")) {
    wire(wirePorts("ref2v", "out", "render"), wirePorts("render", "in", "ref2v"), "#c9a878",
      { dashed: true, width: 1.5, opacity: "0.45", title: "subject_definitions, summary and retention_analysis" });
  }

  if (dragWire) {
    wire(wirePorts(dragWire.fromId, "out"), { x: dragWire.x, y: dragWire.y, dir: "h" }, "#e0a13a", { width: 3 });
  }
  if (linking) {
    const from = wirePorts(linking.fromId, "out");
    if (from) {
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", String(from.x)); dot.setAttribute("cy", String(from.y));
      dot.setAttribute("r", "6"); dot.setAttribute("fill", "#e0a13a");
      svg.appendChild(dot);
    }
  }
}

/* ── Auto-layout ──────────────────────────────────────────────
 * Left to right, the order the work happens in: what you brought, what happens
 * in it, how it sounds, the render. Within a column, nodes stack by their real
 * measured height so two of them can never overlap — which is the failure that
 * makes a node canvas feel broken.
 *
 * A node the creator has dragged is pinned and skipped. Tidy unpins everything.
 */
/* Steering gets a lane of its own rather than stacking under the material: it
 * is a tall node, and hanging it off the bottom of the media column made the
 * whole graph twice as tall as it needed to be — which Fit then answered by
 * shrinking everything to 77%. */
/* ── Layout ───────────────────────────────────────────────────
 * Shots are a SEQUENCE IN TIME, so they run left to right — the way a timeline
 * reads and the way every editor in the world lays a cut out. Stacking them
 * vertically made a four-shot clip a column you had to scroll, and put the
 * cut chain at right angles to the flow it belongs to.
 *
 * Around that, each thing sits where its relationship puts it:
 *
 *        [ the pictures ]        above the shot that cites them, so the
 *              │                 wire is a short drop rather than a long
 *              ▼                 reach across the graph
 *   [Shot 1]→[Shot 2]→[Shot 3]→[Render]      time, and the render at the end
 *              ▲
 *        [ steering ] [ sound ] [ director ]  what governs the whole clip,
 *                                             on one shelf underneath
 *
 * Material nothing cites yet waits in an inbox at the far left of the top row,
 * which is also where the amber "no shot uses this" flag lives — so an unused
 * picture is literally off to one side of the work.
 */
const ROW_GAP = 46;

function layoutNodes(canvasEl, p) {
  const nodes = [...canvasEl.querySelectorAll(".sn-node")];
  const byId = new Map(nodes.map(n => [n.dataset.node, n]));
  const pinned = p.simple?.pos || {};
  const shots = orderedShots(p);
  const wid = (n) => n?.offsetWidth || NODE_W;
  const hgt = (n) => n?.offsetHeight || 180;

  geom.clear();
  const place = (node, x, y) => {
    if (!node) return null;
    const id = node.dataset.node;
    const pin = pinned[id];
    const px = pin && Number.isFinite(pin.x) ? pin.x : Math.round(x);
    const py = pin && Number.isFinite(pin.y) ? pin.y : Math.round(y);
    node.style.left = `${px}px`;
    node.style.top = `${py}px`;
    const g = { x: px, y: py, w: wid(node), h: hgt(node) };
    geom.set(id, g);
    return g;
  };

  /* Which pictures each shot cites — that is what decides where they sit. */
  const media = poolItems(p);
  const feedsOf = new Map(shots.map(sh => [sh.id, []]));
  const orphans = [];
  for (const item of media) {
    const node = byId.get(item.id);
    if (!node) continue;
    const tag = tagFor(p, item);
    const owner = (tag ? shots.find(sh => shotCites(sh, tag)) : null) || anchorsShot(p, item);
    if (owner && feedsOf.has(owner.id)) feedsOf.get(owner.id).push(node);
    else orphans.push(node);
  }

  // Row heights, so the shot row starts below the tallest thing above it.
  const feedH = (list) => list.reduce((n, el) => n + hgt(el) + GAP_Y, 0);
  const topH = Math.max(
    orphans.length ? feedH(orphans) : 0,
    ...shots.map(sh => feedH(feedsOf.get(sh.id) || [])),
    0,
  );
  const rowShotsY = 24 + topH;

  // The inbox: anything nothing cites, at the far left of the top row.
  let x = 40;
  if (orphans.length) {
    let oy = 24;
    for (const node of orphans) { place(node, x, oy); oy += hgt(node) + GAP_Y; }
    x += Math.max(...orphans.map(wid)) + GAP_X;
  }

  /* The cut, left to right, with each shot's pictures stacked directly above
   * it and bottom-aligned to the shot, so the drop is as short as possible. */
  const colX = new Map();          // shot id → where its column landed
  for (const shot of shots) {
    const node = byId.get(shot.id);
    if (!node) continue;
    const feeds = feedsOf.get(shot.id) || [];
    const colW = Math.max(wid(node), ...feeds.map(wid), NODE_W);
    let fy = rowShotsY - GAP_Y - feedH(feeds) + GAP_Y;
    for (const f of feeds) {
      place(f, x + (colW - wid(f)) / 2, fy);
      fy += hgt(f) + GAP_Y;
    }
    const sx0 = x + (colW - wid(node)) / 2;
    colX.set(shot.id, sx0);
    place(node, sx0, rowShotsY);
    x += colW + GAP_X;
  }

  // The render is the destination: at the end of the cut, on the same line.
  const render = byId.get("render");
  const shotH = Math.max(...shots.map(sh => hgt(byId.get(sh.id))), 180);
  if (render) {
    place(render, x, rowShotsY + Math.max(0, (shotH - hgt(render)) / 2));
    x += wid(render) + GAP_X;
  }

  /* Voices get a row of their own directly under the cut, each one under the
   * first shot it speaks in — the mirror image of the pictures above, and for
   * the same reason: a wire that drops one row is readable, and one that
   * crosses the whole graph is decoration. Two voices that open in the same
   * shot are pushed right rather than stacked, so the row stays a row. */
  const voiceRowY = rowShotsY + shotH + ROW_GAP;
  const voiceList = voices(p);
  let vx = 40, voiceH = 0;
  for (const v of voiceList) {
    const node = byId.get(`voice:${v.speaker}`);
    if (!node) continue;
    const under = colX.get(v.lines[0]?.shot.id);
    const at = Math.max(vx, Number.isFinite(under) ? under : vx);
    place(node, at, voiceRowY);
    vx = at + wid(node) + GAP_X;
    voiceH = Math.max(voiceH, hgt(node));
  }

  /* The shelf: what governs the whole clip, underneath all of it. */
  let sx = 40;
  const shelfY = voiceRowY + (voiceH ? voiceH + ROW_GAP : 0);
  for (const id of ["steer", "look", "ref2v", "sound", "director"]) {
    const node = byId.get(id);
    if (!node) continue;
    place(node, sx, shelfY);
    sx += wid(node) + GAP_X;
  }

  // Anything unaccounted for (a kind added later) goes on the end of the shelf
  // rather than on top of the origin.
  for (const node of nodes) {
    if (geom.has(node.dataset.node)) continue;
    place(node, sx, shelfY);
    sx += wid(node) + GAP_X;
  }
}

/* ── The canvas ───────────────────────────────────────────── */
function mediaNode(p, item, index) {
  const tag = tagFor(p, item);
  const thumb = h("div.sn-thumb", ICON[item.kind] || "▣");
  if (item.kind === "image" || item.poster) {
    getBlob(item.id).then((data) => {
      const src = item.kind === "image" ? data : item.poster;
      if (src) { thumb.style.backgroundImage = `url("${src}")`; thumb.textContent = ""; }
    });
  }
  /* Whether any shot actually names this. H3 ignores a reference the prompt
   * does not cite, so an unwired picture is not merely untidy — it does
   * nothing, and until now the only sign was a warning on another page. */
  const isFirstFrame = p.frames?.first?.id === item.id;
  const used = isFirstFrame || (tag && orderedShots(p).some(sh => shotCites(sh, tag)));
  const shots = orderedShots(p);

  return nodeEl(p, {
    id: item.id, x: 0, y: 0, kind: item.kind === "audio" ? "audio" : item.kind === "video" ? "video" : "image",
    title: (item.label || item.name || "media").slice(0, 20),
    badge: tag || (isFirstFrame ? "first frame" : null),
    onRemove: () => removeMedia(item),
    ports: { out: { tag } },
    hint: isFirstFrame || used ? null : "drag me onto a shot",
    className: used ? "" : "unused",
    body: h("div", thumb,
      isFirstFrame
        ? h("div.sn-note", "anchors the first frame — it is already in the shot")
        : used
          ? h("div.sn-note", citedIn(p, tag))
          : h("div.sn-unused",
              h("div.sn-unused-hd", "No shot uses this"),
              h("div", `${tag || "It"} is attached, but nothing in the prompt names it — the model will ignore it completely.`),
              shots.length ? h("div.sn-row", { style: { marginTop: "6px" } },
                ...shots.map((sh, i) => h("button.dr-mini", {
                  title: `Cite ${tag} in shot ${i + 1}`,
                  onclick: () => connect(sh.id, tag),
                }, shots.length === 1 ? "Use it" : `Shot ${i + 1}`)),
              ) : null,
            ),
    ),
  });
}

/* ── The camera pad ───────────────────────────────────────────
 * H3's camera grammar is three things — a move, an amplitude and a speed —
 * and the move vocabulary is really one axis of choice repeated: something
 * happens left/right, something happens up/down, something happens nearer or
 * further. Twenty radio buttons hide that; a pad shows it.
 *
 * Drag the puck: the ANGLE picks the move, the DISTANCE from centre picks the
 * amplitude, and the centre is "the camera remains static" — which the guide
 * insists you say out loud rather than leave unstated. What the horizontal and
 * vertical axes MEAN is one segmented control above the pad, because "left"
 * has three legitimate readings and the model wants to be told which:
 *
 *   Turn   the camera pivots where it stands   pan / tilt
 *   Move   the camera travels                  truck / pedestal
 *   Orbit  the camera goes around the subject  arc / pedestal
 *
 * Depth is its own slider beside the pad, because a push is not a direction on
 * the same plane — and "push in" (the body moves) and "zoom in" (the lens
 * moves) are different shots, which is the one distinction the slider's ends
 * make you state.
 *
 * Everything else — a second simultaneous move, lens, height, framing box,
 * rack focus — stays in the studio. This is the low-level control that fits on
 * a node; that is the detailed one.
 */
const PAD_AXES = {
  turn:  { x: ["pan left", "pan right"], y: ["tilt up", "tilt down"], label: "Turn", hint: "the camera pivots where it stands" },
  move:  { x: ["truck left", "truck right"], y: ["pedestal up", "pedestal down"], label: "Move", hint: "the camera travels" },
  orbit: { x: ["arc left", "arc right"], y: ["pedestal up", "pedestal down"], label: "Orbit", hint: "the camera goes around the subject" },
};
const DEPTH = { in: ["push in", "zoom in"], out: ["pull out", "zoom out"] };
/* The moves that are a QUALITY of the shot rather than a direction. They ride
 * in `camera.secondary`, which is exactly the field the compiler turns into
 * "…, while holding a handheld frame". */
const FEEL = [
  ["none", "—", "no added quality"],
  ["tracking", "Track", "the camera tracks with the subject"],
  ["handheld", "Hand", "a handheld frame"],
  ["slight shake", "Shake", "the camera shakes slightly"],
  ["roll clockwise", "Roll cw", "the camera rolls clockwise"],
  ["roll counterclockwise", "Roll ccw", "the camera rolls counterclockwise"],
];

/** Which pad mode a camera type belongs to, so the pad opens where you left it. */
function padModeOf(type) {
  for (const [mode, axes] of Object.entries(PAD_AXES)) {
    if (axes.x.includes(type) || axes.y.includes(type)) return mode;
  }
  return null;
}

/** camera → puck position, as -1..1 on each axis. */
function puckFor(camera = {}, mode) {
  const type = camera.type || "static";
  const axes = PAD_AXES[mode] || PAD_AXES.turn;
  const amp = camera.amplitude === "small" ? 0.42 : camera.amplitude === "large" ? 1 : 0.72;
  if (axes.x[0] === type) return { x: -amp, y: 0 };
  if (axes.x[1] === type) return { x: amp, y: 0 };
  if (axes.y[0] === type) return { x: 0, y: -amp };
  if (axes.y[1] === type) return { x: 0, y: amp };
  return { x: 0, y: 0 };
}

/** puck position → the move and amplitude it means. */
function moveFor(x, y, mode) {
  const axes = PAD_AXES[mode] || PAD_AXES.turn;
  const r = Math.hypot(x, y);
  if (r < 0.18) return { type: "static", amplitude: "medium" };
  const amplitude = r < 0.55 ? "small" : r < 0.85 ? "medium" : "large";
  // The dominant axis wins outright: a camera that pans AND tilts is a
  // compound move, and the guide wants those stated as one primary plus one
  // secondary rather than as a diagonal nobody can picture.
  const type = Math.abs(x) >= Math.abs(y)
    ? (x < 0 ? axes.x[0] : axes.x[1])
    : (y < 0 ? axes.y[0] : axes.y[1]);
  return { type, amplitude };
}

function cameraPad(p, shot) {
  const cam = shot.camera || {};
  const mode = padModeOf(cam.type) || shot._padMode || "turn";
  const puck = puckFor(cam, mode);
  const depthNow = DEPTH.in.includes(cam.type) ? "in" : DEPTH.out.includes(cam.type) ? "out" : "";
  const lensMove = cam.type === "zoom in" || cam.type === "zoom out";

  const write = (patch) => {
    update((draft) => {
      const s2 = draft.shots.find(x => x.id === shot.id);
      if (!s2) return;
      // `custom` is a hand-written override from the studio; touching the pad
      // is an explicit statement that the generated sentence is wanted back.
      // `byHand` stops the Energy dial overwriting what was just set here.
      s2.camera = { ...s2.camera, ...patch, custom: "", byHand: true };
    }, "shots");
    refresh();
  };

  const pad = h("div.cam-pad", { title: PAD_AXES[mode].hint },
    h("div.cam-ring.small"), h("div.cam-ring.mid"), h("div.cam-ring.large"),
    h("div.cam-cross"),
    h("div.cam-puck", { style: { left: `${50 + puck.x * 44}%`, top: `${50 + puck.y * 44}%` } }),
    h("div.cam-static", cam.type === "static" ? "static" : ""),
  );

  const grab = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();   // the canvas must not pan while the puck is moving
    const rect = pad.getBoundingClientRect();
    const at = (ev) => {
      const x = clamp(((ev.clientX - rect.left) / rect.width - 0.5) * 2.2, -1, 1);
      const y = clamp(((ev.clientY - rect.top) / rect.height - 0.5) * 2.2, -1, 1);
      const m = moveFor(x, y, mode);
      pad.querySelector(".cam-puck").style.left = `${50 + (m.type === "static" ? 0 : x) * 44}%`;
      pad.querySelector(".cam-puck").style.top = `${50 + (m.type === "static" ? 0 : y) * 44}%`;
      return m;
    };
    let last = at(e);
    const move = (ev) => { last = at(ev); };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      write(last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  pad.addEventListener("pointerdown", grab);

  const depthBtn = (dir, glyph, title) => h("button", {
    class: `cam-depth-b${depthNow === dir ? " on" : ""}`,
    title,
    onclick: () => write(depthNow === dir
      ? { type: "static", amplitude: "medium" }
      : { type: DEPTH[dir][lensMove ? 1 : 0], amplitude: cam.amplitude || "medium" }),
  }, glyph);

  return h("div.cam",
    h("div.sn-pick-lb", "Camera"),
    h("div.cam-modes",
      ...Object.entries(PAD_AXES).map(([id, a]) => h("button", {
        class: `sn-chip${mode === id ? " on" : ""}`,
        title: a.hint,
        onclick: () => {
          // Re-express the current move in the new reading, so switching from
          // Turn to Move keeps "left" pointing left.
          const cur = moveFor(puck.x, puck.y, id);
          shot._padMode = id;
          write(cam.type === "static" ? {} : cur);
        },
      }, a.label)),
    ),
    h("div.cam-body",
      pad,
      h("div.cam-depth",
        depthBtn("in", "▲", lensMove ? "zoom in (the lens moves)" : "push in (the camera moves)"),
        h("button", {
          class: `cam-lens${lensMove ? " on" : ""}`,
          title: lensMove
            ? "Zoom: the lens moves, the perspective does not change. Click for a push."
            : "Push: the camera moves, the perspective changes. Click for a zoom.",
          onclick: () => {
            if (!depthNow) return;
            write({ type: DEPTH[depthNow][lensMove ? 0 : 1] });
          },
        }, lensMove ? "lens" : "body"),
        depthBtn("out", "▼", lensMove ? "zoom out (the lens moves)" : "pull out (the camera moves)"),
      ),
    ),
    h("div.cam-row",
      ...SPEEDS.map(([id, label]) => h("button", {
        class: `sn-chip${(cam.speed || "normal") === id ? " on" : ""}`,
        title: `${label.toLowerCase()} speed`,
        onclick: () => write({ speed: id }),
      }, label)),
    ),
    h("div.cam-row",
      ...FEEL.map(([id, label, title]) => h("button", {
        class: `sn-chip${(cam.secondary || "none") === id ? " on" : ""}`,
        title,
        onclick: () => write({ secondary: id }),
      }, label)),
    ),
    /* The sentence the model will actually read. This is the whole point of
     * the pad: a gesture, and then the words it produced, so the vocabulary is
     * learned by using it rather than by reading a dropdown. */
    h("div.cam-say", cameraSentence({ ...cam, custom: "" })),
    cam.byHand ? h("div.cam-held",
      h("span.grow", "set by hand — the Energy dial leaves this shot alone"),
      h("button.dr-mini", {
        title: "Let the Energy dial drive this shot's camera again",
        onclick: () => {
          update((draft) => {
            const s2 = draft.shots.find(x => x.id === shot.id);
            if (s2) s2.camera = { ...s2.camera, byHand: false };
            applySteering(draft);
          }, "shots");
          refresh();
        },
      }, "release"),
    ) : null,
  );
}

/** Which shots name this reference, in words. */
function citedIn(p, tag) {
  const where = orderedShots(p)
    .map((sh, i) => (shotCites(sh, tag) ? i + 1 : 0))
    .filter(Boolean);
  if (!where.length) return "Drag me onto a shot — or press Link, then click one.";
  return where.length === 1
    ? `Used in shot ${where[0]}. Drag me onto another to use it there too.`
    : `Used in shots ${where.join(", ")}.`;
}

function shotNode(p, shot, index, shots) {
  const end = index + 1 < shots.length ? shots[index + 1].at : p.render.duration;

  return nodeEl(p, {
    id: shot.id, x: 0, y: 0, kind: "shot",
    title: `Shot ${index + 1}`,
    /* "2.5s · tuned" is long enough to push "Shot 1" into an ellipsis. The
     * glyph is the Steering node's own icon, so it reads as "this one has its
     * own dials" without spelling it out twice — the fold below says it in
     * words, and so does the Steering node. */
    badge: hasOwnDials(shot) ? `${(end - shot.at).toFixed(1)}s ◎` : `${(end - shot.at).toFixed(1)}s`,
    // One shot at a time, from the shot itself — the whole-clip Improve is
    // rarely what you want once a draft is close.
    action: {
      label: "✎",
      title: "Rewrite just this shot — concrete, observable, in H3's grammar",
      run: (btn) => improveShots(btn, shot.id),
    },
    onRemove: shots.length > 1 ? () => {
      update((draft) => {
        draft.shots = draft.shots.filter(s => s.id !== shot.id);
        if (draft.shots[0]) draft.shots[0].at = 0;
      }, "shots");
      refresh();
    } : null,
    ports: { in: true, out: {} },
    body: h("div",
      /* The subject and the beats, as the fields they actually are.
       *
       * This was one textarea holding "subject — beat; beat; beat", parsed back
       * on blur — and the parse destroyed the connective on every beat, split a
       * beat containing a semicolon in two, and cut a subject at its first em
       * dash. Focusing the box and clicking away was enough to do it, so simply
       * looking at a shot on the canvas rewrote it, and the studio then showed
       * something different from what you had typed.
       *
       * beats.js is the same editor the studio draws. Not a matching one — the
       * same one. */
      h("input", {
        type: "text", spellcheck: "false", class: "sn-subject",
        placeholder: index === 0 ? "Who or what? a barista in a grey apron" : "and now?",
        value: shot.subject || "",
        onchange: (e) => {
          update((draft) => {
            const s2 = draft.shots.find(x => x.id === shot.id);
            if (s2) s2.subject = e.target.value.trim();
          }, "shots");
          refresh();
        },
      }),
      index > 0 ? h("input", {
        type: "text", spellcheck: "false", class: "sn-continuity",
        placeholder: "changed since? jacket off, gun now drawn",
        title: "What is different about the subject NOW. The prompt repeats the subject line at every cut, so anything an earlier shot changed comes back unless this says otherwise.",
        value: shot.continuity || "",
        onchange: (e) => {
          update((draft) => {
            const s2 = draft.shots.find(x => x.id === shot.id);
            if (s2) s2.continuity = e.target.value.trim();
          }, "shots");
          refresh();
        },
      }) : null,
      /* What happens between the previous shot and this one. The same field
       * the studio's Cut row and the node view's wire selector set. */
      index > 0 ? h("div.sn-cut",
        h("span.sn-cut-lbl", { title: "How the clip gets from the previous shot to this one" }, "✂ Cut"),
        select(TRANSITIONS, shot.cutVerb || "the camera cuts to", (v) => {
          update((draft) => { const s2 = draft.shots.find(x => x.id === shot.id); if (s2) s2.cutVerb = v; }, "shots");
          refresh();
        }, { class: "sn-cut-sel", title: shot.cutVerb === NO_CUT ? "Continues the previous take — no new [Shot N] marker" : "" }),
      ) : null,
      beatEditor(p, shot, index, shots, { refresh, compact: true }),
      /* Where and how it is lit. The director and Improve both write these, and
       * with nowhere to show them their changes were invisible — which is what
       * made applying a plan look like it had done nothing. */
      h("div.sn-where",
        h("input", {
          type: "text", spellcheck: "false", placeholder: "Where? a rain-streaked cafe window at night",
          value: shot.setting || "",
          onchange: (e) => {
            update((draft) => { const s2 = draft.shots.find(x => x.id === shot.id); if (s2) s2.setting = e.target.value.trim(); }, "shots");
            refresh();
          },
        }),
        h("input", {
          type: "text", spellcheck: "false", placeholder: "Light? single practical lamp in frame",
          value: shot.lighting || "",
          onchange: (e) => {
            update((draft) => { const s2 = draft.shots.find(x => x.id === shot.id); if (s2) s2.lighting = e.target.value.trim(); }, "shots");
            refresh();
          },
        }),
        (shot.details || "").trim() ? h("div.sn-note", shot.details) : null,
      ),
      /* Words, not glyphs. "▭ ▣ ◉ • ⤢ → ⇢" was a legend you had to hover
       * seven times to read, on the one node that decides the whole shot. */
      h("div.sn-pick",
        h("span.sn-pick-lb", "Framing"),
        h("div.sn-pick-row",
          ...[["wide", "Wide"], ["medium", "Medium"], ["close-up", "Close"]].map(([type, label]) =>
            h("button", {
              class: `sn-chip${shot.shotType === type ? " on" : ""}`,
              title: `${type} shot`,
              onclick: () => { update((draft) => { const s = draft.shots.find(x => x.id === shot.id); if (s) s.shotType = type; }, "shots"); refresh(); },
            }, label)),
        ),
      ),
      cameraPad(p, shot),
      /* Fine-tuning, on the shot rather than on a global panel aimed at it.
       * Folded away until asked for: most shots follow the clip, and three
       * more sliders on every node would bury the writing. */
      shotFold(shot, `Fine-tune this shot`, shotTuneBadge(shot),
        () => shotTune(p, shot, { refresh })),
    ),
  });
}

/* A fold inside a node. Which ones are open is remembered in the module rather
 * than the project: an opened drawer is not an edit. */
const folds = new Set();
function shotFold(shot, label, badge, build) {
  const key = `${shot.id}:${label}`;
  const open = folds.has(key);
  return h("div", { class: `sn-fold${open ? " open" : ""}` },
    h("button.sn-fold-hd", {
      onclick: () => { open ? folds.delete(key) : folds.add(key); refresh(); },
    },
      h("span.sn-fold-caret", "▸"),
      h("span.grow", label),
      badge ? h("span.st-tag", badge) : null,
    ),
    open ? h("div.sn-fold-bd", build()) : null,
  );
}

/* ── Steering ─────────────────────────────────────────────────
 * The six dials, on the canvas, wired into every shot — because they were a
 * separate page and a separate page is a separate app. Here you can see the
 * thing you are steering while you steer it.
 */
/* Which shot the steering node is pointed at. Clip-wide unless you pick one;
 * kept in the module because a scope is a place you are looking, not an edit. */

function steerNode(p) {
  return nodeEl(p, {
    id: "steer", x: 0, y: 0, kind: "steer", title: "Steering",
    badge: steerBadge(p),
    accent: "#5d4a20",
    ports: { out: {} },
    body: steerBody(p, { refresh }),
  });
}

/* ── The director ─────────────────────────────────────────────
 * The LLM as a node, not a button. It reads the whole graph — every shot, the
 * references (as pictures, not captions), the compiled prompt, the checker's
 * complaints and how past renders were rated — and answers with a PLAN: a list
 * of concrete edits, each one a sentence you can read and a checkbox you can
 * clear. Nothing lands until you say so, and everything that lands lands in
 * one undo step.
 *
 * The body itself lives in director.js, because Studio draws the same one.
 */
function directorNode(p) {
  const fi = focusedShot(p);
  return nodeEl(p, {
    id: "director", x: 0, y: 0, kind: "director", title: "Director",
    badge: directorBadge(),
    accent: "#3f2f5c",
    /* No port until there is a wire. A dot connected to nothing invites the
     * question "what do I attach this to?", and the honest answer is nothing —
     * the director reads the whole graph. Dragging the node still arms a
     * focus; the port only appears once one exists, to mark where the wire
     * leaves from. */
    ports: fi >= 0 ? { out: { focus: true } } : {},
    dragPayload: { focus: true },
    hint: fi >= 0 ? null : "drag me onto a shot to work on just that one",
    body: directorBody(p, { refresh }),
  });
}

/* ── A voice ──────────────────────────────────────────────────
 * One node per speaking part, wired to every shot it speaks in. The lines
 * themselves still live on their shots — that is where H3 reads them — but a
 * speaker is a person, not a property of a shot, and drawing them per shot hid
 * the one thing you actually want to see: who says what, in what order,
 * through the cut.
 *
 * The words are verbatim inside <d>[Language] … </d>. Nothing here paraphrases
 * or translates them, and the language is per line because a clip can be
 * bilingual.
 */
function voiceNode(p, voice, shots) {
  const spoken = voice.lines.filter(l => (l.line.text || "").trim()).length;
  const patch = (shotId, lineId, fields) => update((draft) => {
    const s = draft.shots.find(x => x.id === shotId);
    const d = s?.dialogue?.find(x => x.id === lineId);
    if (d) Object.assign(d, fields);
  }, "shots");

  return nodeEl(p, {
    id: `voice:${voice.speaker}`, x: 0, y: 0, kind: "voice",
    title: `(${voice.speaker})`,
    badge: spoken ? `${spoken} line${spoken === 1 ? "" : "s"}` : "no words yet",
    accent: "#5c2f4a",
    ports: { out: {} },
    dragPayload: { speaker: voice.speaker },
    hint: "drag me onto a shot to give this voice a line there",
    onRemove: () => {
      update((draft) => {
        for (const s of draft.shots) {
          s.dialogue = (s.dialogue || []).filter(d => d.speaker !== voice.speaker);
        }
      }, "shots");
      refresh();
    },
    body: h("div",
      /* Who this voice IS. Written once, on the node that represents the
       * person — which is exactly the right place for it, and the reason the
       * voice node earns its keep over a per-shot list. §4.4: "provide enough
       * information … to establish a stable identity, such as character type,
       * age, gender, whether the person is on-screen, pitch, timbre, speaking
       * rate, or accent." Without it H3 picks a voice. */
      h("input.vc-identity", {
        type: "text", spellcheck: "false",
        placeholder: `who is (${voice.speaker}), and how do they sound?`,
        title: "H3 builds the voice from this — a young woman with a quiet, breathy voice; a middle-aged man with a calm, slightly raspy voice. It is written into the prompt at this speaker's first line.",
        value: voice.lines[0]?.line.identity || "",
        onchange: (e) => {
          const v = e.target.value.trim();
          update((draft) => {
            // The identity belongs to the speaker, so it is kept on every one
            // of their lines; the compiler only emits it at the first.
            for (const s of draft.shots) {
              for (const d of s.dialogue || []) if (d.speaker === voice.speaker) d.identity = v;
            }
          }, "shots");
          refresh();
        },
      }),
      ...voice.lines.map(({ shot, index, line }) => h("div.vc-line",
        h("div.vc-hd",
          h("span.vc-where", `Shot ${index + 1}`),
          h("span.grow"),
          h("select.vc-lang", {
            title: "The model never translates these words — this says which language they are in",
            onchange: (e) => { patch(shot.id, line.id, { language: e.target.value }); refresh(); },
          }, ...LANGUAGES.map(l => h("option", { value: l, selected: l === line.language }, l))),
          h("button.vc-x", {
            title: "Delete this line",
            onclick: () => {
              update((draft) => {
                const s = draft.shots.find(x => x.id === shot.id);
                if (s) s.dialogue = (s.dialogue || []).filter(d => d.id !== line.id);
              }, "shots");
              refresh();
            },
          }, "✕"),
        ),
        h("textarea", {
          rows: 2, spellcheck: "false",
          placeholder: "the exact words — never translated, never paraphrased",
          value: line.text || "",
          onchange: (e) => patch(shot.id, line.id, { text: e.target.value }),
        }),
        h("input.vc-delivery", {
          type: "text", spellcheck: "false", placeholder: "says",
          title: "The verb and its manner — says, shouts, replies quietly, exclaims with light annoyance. It goes between the speaker id and the words.",
          value: line.delivery || "",
          onchange: (e) => patch(shot.id, line.id, { delivery: e.target.value.trim() }),
        }),
        /* The off-screen form is an exact phrase in H3's grammar, ending in a
         * statement that the lips stay closed. Anything else and the mouth
         * moves while the voice is meant to be elsewhere. */
        h("label.vc-vo", { title: 'Writes "says in an off-screen voiceover … their lips remain completely closed"' },
          h("input", {
            type: "checkbox", checked: !!line.voiceover,
            onchange: (e) => { patch(shot.id, line.id, { voiceover: e.target.checked }); refresh(); },
          }),
          "off screen",
        ),
        /* A line the cut lands in the middle of, and a line the end of the clip
         * truncates. Each has its own tag in H3's grammar, and each is only
         * offered where it could be true — there is no shot after the last one
         * to carry into. */
        index + 1 < shots.length ? h("label.vc-vo", {
          title: "Writes <scenetrans> at both sides of the cut and says the line carries over — H3's grammar for a line that does not stop where the shot does",
        },
          h("input", {
            type: "checkbox", checked: !!line.continues,
            onchange: (e) => { patch(shot.id, line.id, { continues: e.target.checked, cutoff: false }); refresh(); },
          }),
          "carries over the cut",
        ) : h("label.vc-vo", { title: "Writes <cutoff> — the clip ends before the line does" },
          h("input", {
            type: "checkbox", checked: !!line.cutoff,
            onchange: (e) => { patch(shot.id, line.id, { cutoff: e.target.checked, continues: false }); refresh(); },
          }),
          "cut off by the end",
        ),
      )),
      /* Adding a line without dragging: the shot picker is the same list the
       * wire would have pointed at. */
      shots.length ? h("div.vc-add",
        h("span.sn-pick-lb", "＋ line in"),
        h("div.vc-add-row",
          ...shots.map((sh, i) => h("button.sn-chip", {
            title: `Give (${voice.speaker}) a line in shot ${i + 1}`,
            onclick: () => addLine(sh.id, voice.speaker),
          }, String(i + 1))),
        ),
      ) : null,
    ),
  });
}

/* ── The look ─────────────────────────────────────────────────
 * The style of the whole clip, which the canvas had no way to set at all —
 * it was Studio-only, and it is the first thing in the compiled prompt.
 *
 * H3 reads the overall style from the opening of [Shot 1], which is why this
 * wires there and not to every shot: the model anchors on that first sentence
 * and carries it. */
function lookNode(p, shots) {
  const set = (fields) => { update((draft) => Object.assign(draft.style, fields), "text"); refresh(); };
  const grade = GRADES.find(g => g[0] === (p.style.grade || ""));

  return nodeEl(p, {
    id: "look", x: 0, y: 0, kind: "look", title: "Look",
    badge: p.style.look ? p.style.look.split(" ")[0] : "unset",
    accent: "#2f4a5c",
    ports: shots.length ? { out: {} } : {},
    body: h("div",
      h("select", {
        title: "The medium and treatment — the first thing the model reads",
        onchange: (e) => set({ look: e.target.value }),
      }, ...LOOKS.map(l => h("option", { value: l, selected: l === p.style.look }, l))),
      h("select", {
        style: { marginTop: "5px" },
        title: "A named grade beats any adjective — this is written out in full in the prompt",
        onchange: (e) => set({ grade: e.target.value }),
      }, ...GRADES.map(g => h("option", { value: g[0], selected: g[0] === (p.style.grade || "") }, g[1]))),
      h("textarea", {
        rows: 2, spellcheck: "false", style: { marginTop: "5px" },
        placeholder: "Anything else about the whole clip — shot on a long lens throughout, heavy film grain…",
        value: p.style.extra || "",
        onchange: (e) => set({ extra: e.target.value.trim() }),
      }),
      h("div.sn-note", grade?.[0] ? grade[0] : "No grade stated — the model picks one."),
    ),
  });
}

/* ── The cast sheet ───────────────────────────────────────────
 * Reference-to-video only. Ref2VA's rewriter emits an intermediate
 * representation before the description — subject_definitions naming each tag,
 * a task type, and a summary — and the model conditions on it. The app writes
 * a usable default for all three, which is why nothing broke without this
 * node; but they were editable only in Studio, so on the canvas the first
 * three fields of the prompt were invisible.
 */
function castNode(p) {
  const auto = compileSubjectDefs(p);
  const set = (fields) => { update((draft) => Object.assign(draft.ref2v, fields), "text"); refresh(); };

  return nodeEl(p, {
    id: "ref2v", x: 0, y: 0, kind: "cast", title: "Cast sheet",
    badge: p.ref2v.useFullIR ? (p.ref2v.subjectDefs || "").trim() ? "written" : "auto" : "off",
    accent: "#4a3a2a",
    ports: { out: {} },
    body: h("div",
      h("select", {
        title: "What the references are FOR. It opens the summary field the model reads first, and H3 only knows these six names. Left on auto, the app derives it from what you have attached.",
        onchange: (e) => set({ taskType: e.target.value }),
      },
        h("option", { value: "", selected: !p.ref2v.taskType }, `auto — ${taskTypeFor(p)}`),
        ...REF_TASK_TYPES.map(([v, why]) => h("option", { value: v, selected: v === p.ref2v.taskType, title: why }, v)),
      ),
      h("textarea", {
        rows: 2, spellcheck: "false", style: { marginTop: "5px" },
        placeholder: auto ? `auto: ${auto.split("\n")[0]}  —  say who they are: "<Subject 1> is the woman in <Picture 1>, long dark hair, a blue cardigan"` : "who and what each tag is",
        value: p.ref2v.subjectDefs || "",
        onchange: (e) => set({ subjectDefs: e.target.value.trim() }),
      }),
      h("textarea", {
        rows: 2, spellcheck: "false", style: { marginTop: "5px" },
        placeholder: "One line of what happens — leave it and the description's opening is used",
        value: p.ref2v.summary || "",
        onchange: (e) => set({ summary: e.target.value.trim() }),
      }),
      h("label.vc-vo", { title: "Off sends detailed_description alone, without the IR fields" },
        h("input", {
          type: "checkbox", checked: !!p.ref2v.useFullIR,
          onchange: (e) => set({ useFullIR: e.target.checked }),
        }),
        "write the full IR block",
      ),
    ),
  });
}

function soundNode(p) {
  const has = (p.sound.soundscape || "").trim() || (p.sound.music || "").trim();
  return nodeEl(p, {
    id: "sound", x: 0, y: 0, kind: "sound", title: "Sound",
    badge: has ? "written" : "auto",
    ports: { out: {} },
    body: h("div",
      h("textarea", {
        rows: 2, spellcheck: "false", placeholder: "What can you hear? Rain on the window, a grinder…",
        value: p.sound.soundscape || "",
        onchange: (e) => update((draft) => { draft.sound.soundscape = e.target.value; draft.sound.silent = false; }, "sound"),
      }),
      h("textarea", {
        rows: 2, spellcheck: "false", style: { marginTop: "5px" }, placeholder: "Music? A slow upright bass under brushed drums…",
        value: p.sound.music || "",
        onchange: (e) => update((draft) => { draft.sound.music = e.target.value; draft.sound.musicOff = false; }, "sound"),
      }),
    ),
  });
}

/**
 * What a render is actually doing, while it does it.
 *
 * ComfyUI reports per-step progress on its socket, and the app was already
 * receiving it — it just never drew it here. When the socket cannot be reached
 * (a tunnel, a locked-down box) there are no steps to report, so the bar says
 * so by running indeterminate rather than sitting at zero and looking stuck.
 */
function renderProgress(job) {
  const pct = Math.round((job.progress || 0) * 100);
  const known = job.steps > 0 && job.step > 0;
  const elapsed = Math.max(0, Math.round((Date.now() - job.at) / 1000));
  // A per-step rate is the only honest estimate: the queue wait before the
  // first step tells us nothing about the sampler's speed.
  const eta = known && job.step > 1
    ? Math.round((elapsed / job.step) * (job.steps - job.step))
    : null;

  return h("div.rn-prog",
    h("div", { class: `progress${known ? "" : " indet"}` },
      h("i", { style: { width: known ? `${pct}%` : "" } })),
    h("div.rn-prog-row",
      h("span.mono", { "data-live": "steps" }, known ? `${job.step}/${job.steps}` : job.status === "queued" ? "queued" : "starting"),
      h("span.grow", { class: "hint", "data-live": "node" }, job.node ? `node ${job.node}` : ""),
      h("span.mono.hint", eta != null ? `${humanTime(eta)} left` : humanTime(elapsed)),
    ),
  );
}

function renderNode(p) {
  const job = currentJob();
  const running = job && ["queued", "running"].includes(job.status);
  const report = validate(p);
  const { width, height } = dimensions(p);
  const health = getHealth();

  return nodeEl(p, {
    id: "render", x: 0, y: 0, kind: "render", title: "Render",
    badge: `${p.render.duration}s`,
    accent: "#2f5c46",
    ports: { in: true },
    body: h("div",
      /* Three states, and the middle one used to be the word "rendering…"
       * and nothing else — no bar, no step count, no sign of life for the
       * minutes a clip takes. It now shows the sampler's own preview frames
       * when ComfyUI is emitting them, and a real bar either way. */
      job?.outputs?.length && !running
        ? h("video", { src: api.viewUrl(job.outputs[0]), controls: "", loop: "", playsinline: "", style: { width: "100%", borderRadius: "2px", background: "#000" } })
        : running && job.preview
          ? h("div.sn-shotplate", h("img", { src: job.preview, alt: "render preview" }))
          : h("div.sn-preview",
              running
                ? (job.step
                    // A render that is sampling but sending no frames is a
                    // ComfyUI started without a preview method — worth saying,
                    // because the alternative is an empty box and a guess.
                    ? (getSettings()?.comfy?.previews === false
                        ? "sampling…"
                        : h("span", { style: { textAlign: "center", lineHeight: "1.4" } },
                            "sampling…",
                            h("div.hint", { style: { marginTop: "4px" } },
                              "no preview frames — start ComfyUI with --preview-method auto")))
                    : "queued…")
                : "no clip yet"),
      running ? renderProgress(job) : null,
      /* A hand-written description stops the prompt being built from the shots
       * at all — so the camera pad, the beats and the dials go nowhere. That
       * used to be invisible from here. */
      p.prompt?.manual && (p.prompt.description || "").trim()
        ? h("div.sn-unused", { style: { marginTop: "7px" } },
            h("div.sn-unused-hd", "Using a hand-written description"),
            h("div", "The shots, the camera and the dials are not being compiled — this text is sent instead."),
            h("div.sn-row", { style: { marginTop: "6px" } },
              h("button.dr-mini", {
                title: "Go back to the prompt built from your shots",
                onclick: () => {
                  update((draft) => { draft.prompt.manual = false; }, "prompt");
                  toast("Back to the built prompt", "Your shots drive the prompt again", "ok");
                  refresh();
                },
              }, "Use my shots again"),
            ))
        : null,
      h("div.sn-row", { style: { marginTop: "7px" } },
        h("select", {
          onchange: (e) => { update((draft) => { draft.render.duration = Number(e.target.value); }, "render"); refresh(); },
        }, ...Object.keys(DURATION_FRAMES).map(d => h("option", {
          value: d, selected: String(p.render.duration) === d,
          title: overLength(d) ? `Past H3's ${H3_DURATION.max}s ceiling — the clip repeats` : "",
        }, `${d}s${overLength(d) ? " ⚠" : ""}`))),
        h("span.hint.mono.grow", `${width}×${height}`),
      ),
      h("button.btn.sm.grow", {
        style: { marginTop: "7px", width: "100%" },
        title: "Play the prompt back before you spend a render on it",
        onclick: () => openReadthrough(),
      }, "▶ Read it through"),
      h("div.sn-row", { style: { marginTop: "7px" } },
        running
          ? h("button.btn.sm.grow", { onclick: async () => { await cancelRender(); refresh(); } }, "■ Stop")
          : h("button.btn.sm.record.grow", {
              onclick: async () => {
                try { await renderNow({ onStep: () => refresh() }); toast("Render finished", "", "ok"); }
                catch (err) { if (err.message !== "cancelled") toast("Render failed", err.message, "err"); }
                refresh();
              },
            }, "● Render"),
        /* The other ending: put it in the line and carry on. One GPU renders
         * one clip at a time, and until now the second one had to live in your
         * head until the first finished. */
        h("button.btn.sm", {
          title: "Put this clip on the render queue — run it from Studio ▸ Deliver",
          onclick: async () => {
            const { queueThis } = await import("./deliver.js");
            await queueThis(getProject());
            refresh();
          },
        }, `＋ Queue${queueLength() ? ` (${queueLength()})` : ""}`),
        h("button.btn.sm", {
          title: "Download the ComfyUI workflow",
          onclick: async () => {
            const { buildWorkflow } = await import("../workflow.js");
            const { getSettings } = await import("../config.js");
            const { prompt } = buildWorkflow(getProject(), getSettings() || { models: {} });
            download(`${(p.name || "timeline").replace(/[^\w-]+/g, "_")}.json`, JSON.stringify(prompt, null, 2));
            toast("Workflow downloaded", "", "ok");
          },
        }, "⬇"),
      ),
      h("div.hint", { style: { marginTop: "6px" } },
        report.pristine ? "Type something into a shot first."
          : report.errors ? `${report.errors} problem${report.errors === 1 ? "" : "s"} — check the Studio view.`
          : health.comfy?.ok ? `≈ ${humanTime(estimateSeconds(p))}` : "ComfyUI is not connected — the download still works."),
    ),
  });
}

/* ── The readthrough ──────────────────────────────────────────
 * Opened big, because it is a timeline: the plate, every channel of the prompt
 * as a lane, and the compiled text lighting up clause by clause as it plays.
 * This is the answer to "what will this actually do" that does not cost a
 * forty-minute render to get.
 */
export async function openReadthrough() {
  const p = getProject();
  if (validate(p).pristine) {
    toast("Nothing to read yet", "Type what happens into a shot first.", "");
    return;
  }
  // Reference stills stand in for the plate, so a shot that cites a picture
  // plays back over that picture.
  const plates = new Map();
  for (const item of poolItems(p)) {
    if (item.kind !== "image") continue;
    try { plates.set(item.id, await getBlob(item.id)); } catch { /* gone from the store */ }
  }
  const backgroundFor = (shot) => {
    for (const item of poolItems(p)) {
      const tag = tagFor(p, item);
      if (tag && shotCites(shot, tag) && plates.get(item.id)) return plates.get(item.id);
    }
    return p.frames?.first ? plates.get(p.frames.first.id) || null : null;
  };

  const rt = createReadthrough(p, { backgroundFor });
  const onKey = (e) => {
    if (e.key === " " && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) { e.preventDefault(); rt.toggle(); }
  };
  window.addEventListener("keydown", onKey);
  requestAnimationFrame(() => rt.play());
  await modal({ title: "Readthrough — how the prompt plays out", body: rt.el, full: true });
  window.removeEventListener("keydown", onKey);
  rt.destroy();
}

/* ── Toolbar ──────────────────────────────────────────────── */
function toolbar(p) {
  const pick = (accept, label) => {
    const input = h("input", { type: "file", accept, multiple: "", style: { display: "none" },
      onchange: (e) => { addFiles(e.target.files); e.target.value = ""; } });
    return h("button.sn-tool", { title: label, onclick: () => input.click() },
      h("span.sn-tool-ico", accept.startsWith("image") ? ICON.image : accept.startsWith("video") ? ICON.video : ICON.audio),
      h("span", label), input);
  };

  return h("div.sn-toolbar",
    pick("image/*", "Image"),
    pick("video/*", "Clip"),
    pick("audio/*", "Sound"),
    h("button.sn-tool", {
      title: "Add a shot",
      onclick: () => {
        const p2 = getProject();
        const at = clamp((orderedShots(p2).slice(-1)[0]?.at || 0) + 3, 0.5, p2.render.duration - 0.5);
        const shot = newShot(Math.round(at * 100) / 100);
        update((draft) => { draft.shots.push(shot); draft.selectedShot = shot.id; }, "shots");
        refresh();
      },
    }, h("span.sn-tool-ico", ICON.shot), h("span", "Shot")),
    h("button.sn-tool", {
      /* A speaking part, not a line: the node it makes is the person, and the
       * lines land on it. Empty on purpose — a voice with nothing to say is
       * how you start writing one. */
      title: "Add a speaking part",
      onclick: () => {
        const p2 = getProject();
        const next = nextUnusedSpeaker(p2);
        if (!next) return toast("Four voices is this app's limit", "H3 itself allows more — S1, S2, S3, S4 is where the picker stops.", "warn");
        const shot = orderedShots(p2)[0];
        if (!shot) return;
        addLine(shot.id, next);
      },
    }, h("span.sn-tool-ico", ICON.voice), h("span", "Voice")),
    h("button.sn-tool.ai", {
      title: "Turn one line into a shot list",
      onclick: (e) => askIdea(e.currentTarget),
    }, h("span.sn-tool-ico", "✨"), h("span", "Idea")),
    h("button.sn-tool.ai", {
      title: "Rewrite in the format the model wants — reads the attached images",
      onclick: (e) => improveShots(e.currentTarget),
    }, h("span.sn-tool-ico", "✎"), h("span", "Improve")),
    h("span.sn-sep"),
    h("button.sn-tool.ghost", {
      title: "Put every node back in its lane",
      onclick: () => {
        update((draft) => { draft.simple = { pos: {} }; }, "text");
        toast("Tidied", "Nodes are back in their columns", "ok");
        refresh();
      },
    }, h("span.sn-tool-ico", "⊞"), h("span", "Tidy")),
    h("button.sn-tool.ghost", {
      title: "Frame the whole graph",
      onclick: () => fitView(),
    }, h("span.sn-tool-ico", "⤢"), h("span", "Fit")),
    h("button.sn-tool", {
      title: "Play the prompt back — the plate, every channel, and the text lighting up as it goes",
      onclick: () => openReadthrough(),
    }, h("span.sn-tool-ico", "▶"), h("span", "Read through")),
    h("div.sn-zoom",
      h("button", { title: "Zoom out", onclick: () => zoomCentre(1 / 1.2) }, "−"),
      h("span.sn-zoom-pct", `${Math.round(view.z * 100)}%`),
      h("button", { title: "Zoom in", onclick: () => zoomCentre(1.2) }, "+"),
    ),
    h("span.grow"),
    h("span.badge", h("span.dot"), MODES[p.mode].label),
    h("span.hint.sn-mode-hint", "mode follows what you connect"),
  );
}

/** Zoom about the middle of the viewport, for the toolbar buttons. */
function zoomCentre(factor) {
  const canvas = root?.querySelector(".sn-canvas");
  if (!canvas) return;
  view.touched = true;
  const rect = canvas.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  drawWires(getProject());
}

async function askIdea(btn) {
  if (busy) return;
  const idea = window.prompt("One line about the video you want:");
  if (!idea?.trim()) return;
  busy = true;
  const label = btn.textContent;
  btn.classList.add("disabled");
  try {
    const p = getProject();
    const { shots, split } = await breakdown(idea, p);
    let wired = 0;
    update((draft) => {
      draft.shots = shots.map((s, i) => ({
        ...newShot(i === 0 ? 0 : clamp(Number(s.at) || i * 3, 0.5, draft.render.duration - 0.5)),
        shotType: s.shotType || "medium",
        viewpoint: s.viewpoint || "front-facing",
        subject: s.subject || "",
        beats: (Array.isArray(s.beats) && s.beats.length ? s.beats : [s.action || ""])
          .map((b, bi) => newBeat(typeof b === "string" ? b : (b?.text || ""), bi === 0 ? "" : "then")),
        setting: s.setting || "",
        lighting: s.lighting || "",
        details: s.details || "",
        ...(i > 0 && s.cutVerb ? { cutVerb: s.cutVerb } : {}),
        camera: { ...newShot(0).camera, ...(s.camera || {}) },
      }));
      // A fresh layout, because the old positions describe shots that are gone.
      draft.simple = { pos: {} };
      // The model is told the tags, but a shot list that cites none of the
      // attached pictures is useless — H3 ignores a reference nothing names.
      wired = citeLooseReferences(draft);
    }, "shots");
    toast("Shot list written",
      `${shots.length} shots${split ? ` · ${split} cut${split === 1 ? "" : "s"} the model wrote as beats made into shots` : ""}${wired ? ` · ${wired} picture${wired === 1 ? "" : "s"} wired into shot 1` : ""}`, "ok");
    refresh();
  } catch (err) { toast("Could not write the shots", err.message, "err"); }
  finally { busy = false; btn.classList.remove("disabled"); btn.textContent = label; }
}

/**
 * Improve the SHOTS, not the compiled paragraph.
 *
 * This used to call enhance(), which rewrites the whole prompt into one block
 * of prose and stores it as prompt.manual — an override. Two things went wrong
 * and neither was visible: the shot nodes still showed the old words, so
 * nothing looked improved; and every later edit — the camera pad, the beats,
 * the steering dials — was silently dropped, because a manual override stops
 * the prompt being compiled from the shots at all.
 *
 * polishShot returns structured fields instead, so the improvement lands where
 * you can see it and everything downstream keeps working.
 */
async function improveShots(btn, only = null) {
  if (busy) return;
  busy = true;
  btn?.classList.add("disabled");
  const label = btn?.querySelector("span:last-child");
  const was = label?.textContent;
  try {
    const p = getProject();
    const shots = orderedShots(p);
    const targets = only ? shots.filter(sh => sh.id === only) : shots;
    if (!targets.length) throw new Error("There is no shot to improve yet.");

    let done = 0, changed = 0;
    for (const shot of targets) {
      const index = shots.findIndex(sh => sh.id === shot.id);
      if (label) label.textContent = targets.length > 1 ? `${++done}/${targets.length}…` : "…";
      const r = await polishShot(shot, index, p);
      update((draft) => {
        const live = draft.shots.find(x => x.id === shot.id);
        if (!live) return;
        if (r.subject) live.subject = r.subject;
        if (Array.isArray(r.beats) && r.beats.length) {
          live.beats = r.beats.map((t, i) => newBeat(String(typeof t === "string" ? t : t?.text || "").trim(), i === 0 ? "" : "then"))
            .filter(b => b.text);
        }
        for (const k of ["setting", "lighting", "details"]) if (r[k]) live[k] = r[k];
        // A camera the creator set by hand on the pad stays theirs.
        if (r.camera && !live.camera?.byHand) live.camera = { ...live.camera, ...r.camera, custom: "" };
        changed++;
      }, "shots");
      refresh();
    }
    toast(targets.length > 1 ? "Shots improved" : "Shot improved",
      `${changed} shot${changed === 1 ? "" : "s"} rewritten — ⌘Z per shot to take one back`, "ok");
  } catch (err) {
    toast("Could not improve it", err.message, "err");
  } finally {
    busy = false;
    btn?.classList.remove("disabled");
    if (label && was) label.textContent = was;
    refresh();
  }
}

/* ── Panning ──────────────────────────────────────────────────
 * Drag the background. Middle-drag anywhere. Wheel zooms about the cursor.
 * A click on the background with no drag cancels an armed Link, which is the
 * escape hatch people reach for before they think of the Escape key. */
function installNavigation(canvas) {
  canvas.addEventListener("pointerdown", (e) => {
    const onBackground = !e.target.closest(".sn-node, .sn-cut");
    if (e.button !== 1 && !(e.button === 0 && onBackground)) return;
    // Only the middle button needs its default suppressed (autoscroll).
    // Calling preventDefault on a left-button pointerdown ALSO suppresses the
    // click that follows it — which is how a wire is cut and how an armed
    // link is completed. Selection is already handled by user-select: none.
    if (e.button === 1) e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const originX = view.x, originY = view.y;
    let moved = false;
    canvas.classList.add("panning");
    const move = (ev) => {
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 3) { moved = true; view.touched = true; }
      view.x = originX + (ev.clientX - startX);
      view.y = originY + (ev.clientY - startY);
      applyView();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      canvas.classList.remove("panning");
      if (!moved && linking) endLink();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    view.touched = true;
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1);
    drawWires(getProject());
  }, { passive: false });

  /* ── Pinch ────────────────────────────────────────────────────
   * The canvas sets `touch-action: none` — it has to, or a one-finger drag
   * scrolls the page instead of panning the graph — and that also switches off
   * the browser's own pinch-zoom over it. So the graph had a zoom that only a
   * mouse wheel could reach: on a phone you could pan a canvas you had no way
   * to zoom, which is most of the way to no canvas at all.
   *
   * Two fingers zoom around the point between them and pan with it, which is
   * one gesture rather than two and is what every map does. Tracked from raw
   * pointer events rather than gesturechange, which is WebKit-only. */
  const touches = new Map();
  let pinch = null;

  const spread = () => {
    const [a, b] = [...touches.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  };

  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) {
      const s = spread();
      pinch = { d0: s.d, z0: view.z, cx: s.cx, cy: s.cy, x0: view.x, y0: view.y };
      view.touched = true;
      // A pinch is not a drag: end anything the first finger started.
      canvas.classList.remove("panning");
    }
  }, { passive: true });

  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "touch" || !touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size !== 2 || !pinch) return;
    e.preventDefault();
    const s = spread();
    const z = clamp(pinch.z0 * (s.d / (pinch.d0 || 1)), 0.25, 2.5);
    /* Keep the world point that was under the midpoint at the start still
     * under the midpoint now — that is what makes a pinch feel attached to
     * the thing being pinched — and carry the midpoint's own movement, so the
     * same gesture pans. */
    const wx = (pinch.cx - pinch.x0) / pinch.z0;
    const wy = (pinch.cy - pinch.y0) / pinch.z0;
    view.z = z;
    view.x = s.cx - wx * z;
    view.y = s.cy - wy * z;
    applyView();
    drawWires(getProject());
  }, { passive: false });

  const endTouch = (e) => {
    if (e.pointerType !== "touch") return;
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
  };
  canvas.addEventListener("pointerup", endTouch, { passive: true });
  canvas.addEventListener("pointercancel", endTouch, { passive: true });

  // Click-to-link lands here: the target shot is whatever you clicked.
  canvas.addEventListener("click", (e) => {
    if (!linking) return;
    /* Belt and braces: while a link is armed the stylesheet makes everything
     * inside a node inert, so this click's target is the node itself. If that
     * rule ever fails to load, a control must still not be a link target —
     * clicking the shot's own ✎ mid-link should rewrite the shot, not rewrite
     * it AND connect something to it. */
    if (e.target.closest("button, input, textarea, select")) return;
    const target = e.target.closest(".sn-shot");
    const shotId = target?.dataset.node;
    const payload = linking.payload;
    endLink();
    if (shotId && payload?.tag) connect(shotId, payload.tag);
    else if (shotId && payload?.focus) setFocus(shotId);
    else if (shotId && payload?.speaker) addLine(shotId, payload.speaker);
  });
}

/* ── Draw ─────────────────────────────────────────────────── */
function draw() {
  const p = getProject();
  const shots = orderedShots(p);
  const media = poolItems(p);
  // A focus outlives its shot if the shot list is rewritten under it.
  if (director.focus && !shots.some(s => s.id === director.focus)) director.focus = null;
  const pristine = !media.length && shots.length === 1 && !shotActionText(shots[0]) && !shots[0].subject;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "sn-wires");

  const world = h("div.sn-world", svg);
  media.forEach((m, i) => world.appendChild(mediaNode(p, m, i)));
  if (!pristine) world.appendChild(steerNode(p));
  if (!pristine) world.appendChild(lookNode(p, shots));
  if (p.mode === "r2v") world.appendChild(castNode(p));
  world.appendChild(directorNode(p));
  shots.forEach((sh, i) => world.appendChild(shotNode(p, sh, i, shots)));
  world.appendChild(soundNode(p));
  for (const v of voices(p)) world.appendChild(voiceNode(p, v, shots));
  world.appendChild(renderNode(p));

  const canvas = h("div.sn-canvas", { ondragover: (e) => e.preventDefault() }, world);

  if (pristine) {
    /* An empty canvas should teach the one gesture the canvas is made of, not
     * apologise for being empty. */
    canvas.appendChild(h("div.sn-empty",
      h("div.sn-empty-ico", "⤓"),
      h("div.sn-empty-hd", "Drop an image, a clip or a sound anywhere here."),
      h("div.sn-empty-steps",
        h("div.sn-step", h("b", "1"), "Drop your material — it becomes a node on the left."),
        h("div.sn-step", h("b", "2"), "Drag that node onto a shot to put it in the picture."),
        h("div.sn-step", h("b", "3"), "Type what happens, then press Render."),
      ),
      h("div.hint", "Nothing else is required. The mode — text, image or reference to video — follows from what you connect."),
    ));
  }

  canvas.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    const at = toWorld(e.clientX, e.clientY);
    addFiles(e.dataTransfer.files, { x: at.x - NODE_W / 2, y: at.y - 20 });
  });

  installNavigation(canvas);
  mount(root, h("div.sn-wrap", toolbar(p), canvas));

  /* Measure, then place. Node heights depend on their contents (a shot with
   * three chips is not a steering node with six dials), so the only honest
   * layout is one that runs after the browser has laid the boxes out. */
  // Two frames: the first lets autoGrow size the textareas, the second measures
  // the nodes at their real height and places them.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    layoutNodes(canvas, p);
    applyView();
    drawWires(p);
    keepInFrame(canvas);
  }));
}

let lastIds = "";
let lastSizes = "";

/* Dropping a file must SHOW you the file. A node that arrives outside the
 * current view is the canvas losing the thing you just gave it, so when the
 * set of nodes changes and any of them is off screen, re-frame. A view you
 * arranged yourself is left alone as long as everything is still visible. */
function keepInFrame(canvas) {
  /* Two different questions, and conflating them was a bug: WHICH nodes exist,
   * and how big they are. Typing into a shot changes a node's height, and
   * treating that as "the graph changed" re-framed the canvas on every
   * keystroke — throwing away a zoom the creator had chosen.
   *
   * So: a new or removed node may re-frame, because you must be able to see
   * what you just dropped. A node merely growing may re-frame ONLY if the view
   * is still the one the app chose. Once you have panned or zoomed yourself,
   * that view is yours and nothing takes it back. */
  const ids = [...geom.keys()].sort().join(",");
  const sizes = [...geom.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([id, g]) => `${id}:${g.w}x${g.h}`).join(",");
  const idsChanged = ids !== lastIds;
  const sizesChanged = sizes !== lastSizes;
  lastIds = ids;
  lastSizes = sizes;
  if (!idsChanged && !(sizesChanged && !view.touched)) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  // Partly off the edge counts: a render node sliced down the middle is just as
  // lost as one that is nowhere on screen.
  const offscreen = [...canvas.querySelectorAll(".sn-node")].some((n) => {
    const r = n.getBoundingClientRect();
    return r.left < rect.left || r.right > rect.right || r.top < rect.top || r.bottom > rect.bottom;
  });
  if (offscreen) fitView();
}

/**
 * Open the canvas on the director, optionally with a request already asked.
 * The palette and the post-render verdict both come through here, so "ask the
 * assistant" means the same thing wherever you start it.
 */
export function askDirector(request = "", runner = null) {
  director.request = request;
  refresh();
  requestAnimationFrame(() => {
    root?.querySelector(".dr-ask")?.focus();
    if (request || runner) runDirector(request || "review this", runner);
  });
}

export function render(el) {
  root = el;
  if (!unsub) unsub = onRenderChange((job, kind) => { if (root && root.classList.contains("active")) applyLive(root, job, kind, draw); });
  draw();
}
export function refresh() { if (root) draw(); }
