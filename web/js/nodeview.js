/* MOTIONSTILL CUT — the node view.
 *
 * Resolve puts a node graph on the Fusion and Color pages because some
 * questions are about wiring, not about time. This app has exactly one of
 * those questions, and Ref2V makes it urgent: with nine reference images,
 * three clips and three audio files in play, "which reference is actually
 * doing something, and in which shot?" is invisible on a timeline and
 * invisible in a paragraph of prose.
 *
 * So: sources on the left, shots in the middle in cut order, the render on the
 * right. An edge exists where a shot's text actually cites that reference —
 * not where one was attached. A source with no edge is drawn as what it is: a
 * tag the model will silently ignore.
 */

import { TRANSITIONS, NO_CUT, transitionLabel } from "./vocab.js";
import { h, clear } from "./util.js";
import { orderedShots, referenceInventory, shotActionText } from "./state.js";
import { shotProse } from "./prompt.js";

const COL = { src: 14, shot: 226, out: 470 };
const NODE_W = { src: 168, shot: 190, out: 150 };
const ROW_H = 62;
const TOP = 14;

const KIND_COLOR = {
  picture: { bg: "#2b3f57", edge: "#7fb2e5", chip: "t-pic" },
  video:   { bg: "#45324f", edge: "#c79ae0", chip: "t-vid" },
  audio:   { bg: "#2c4a3b", edge: "#79c79b", chip: "t-aud" },
  frame:   { bg: "#4a3b28", edge: "#e0a13a", chip: "t-pic" },
};

/** Which tags a shot actually cites — read off the same prose the encoder
 *  will read, so the graph and the prompt can never disagree. */
function citedBy(shot, index, project) {
  const text = shotProse(shot, index, project);
  return new Set(text.match(/<(?:Subject|Picture|Video|Audio) \d+>/g) || []);
}

function nodeBox({ x, y, w, title, subtitle, color, className = "", onclick, title2 }) {
  return h("div", {
    class: `nv-node ${className}`,
    style: { left: `${x}px`, top: `${y}px`, width: `${w}px`, borderColor: color },
    title: title2 || "",
    onclick,
  },
    h("div.nv-hd", { style: { background: color } }, title),
    h("div.nv-bd", subtitle),
  );
}

/**
 * Build the graph.
 * @returns {HTMLElement} a scrollable strip
 */
export function renderNodeGraph(project, { selectedShotId = null, onSelectShot = () => {}, onSelectSource = () => {}, onCutChange = null } = {}) {
  const shots = orderedShots(project);
  const inv = referenceInventory(project);

  /* Sources: Ref2V's tag inventory, or I2V's fixed first frame. T2V has none,
   * and saying so is more useful than drawing an empty column. */
  const sources = project.mode === "r2v"
    ? inv.map(e => ({
        key: e.tag, tag: e.tag, kind: e.kind === "picture" ? "picture" : e.kind,
        label: e.ref?.label || e.ref?.name || e.kind,
        marker: (e.kind === "audio" && e.fromVideo ? e.ref?.audioRetention : e.ref?.retention)
          || (e.kind === "audio" ? (e.fromVideo ? "reference" : "fully_copy") : "fully_preserved"),
        ref: e.ref, fromVideo: !!e.fromVideo,
      }))
    : project.mode === "i2v" && project.frames.first
      ? [{ key: "frame", tag: "<Picture 1>", kind: "frame", label: project.frames.first.label || project.frames.first.name, marker: "keyframe at 0.00s", ref: project.frames.first }]
      : [];

  const rows = Math.max(sources.length, shots.length, 1);
  const height = TOP * 2 + rows * ROW_H;
  const width = COL.out + NODE_W.out + 20;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "nv-wires");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));

  const canvas = h("div.nv-canvas", { style: { width: `${width}px`, height: `${height}px` } });
  canvas.appendChild(svg);

  const wire = (x1, y1, x2, y2, color, opts = {}) => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const dx = Math.max(26, (x2 - x1) * 0.45);
    path.setAttribute("d", `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", opts.strong ? "2" : "1.2");
    path.setAttribute("opacity", opts.dim ? "0.25" : opts.strong ? "0.95" : "0.6");
    if (opts.dashed) path.setAttribute("stroke-dasharray", "3 3");
    if (opts.title) {
      const t = document.createElementNS("http://www.w3.org/2000/svg", "title");
      t.textContent = opts.title;
      path.appendChild(t);
    }
    svg.appendChild(path);
    return path;
  };

  // ── Source nodes ──
  const srcY = {};
  sources.forEach((s, i) => {
    const y = TOP + i * ROW_H;
    srcY[s.key] = y + 26;
    const color = KIND_COLOR[s.kind]?.bg || "#333";
    const used = project.mode !== "r2v" || shots.some((shot, si) => citedBy(shot, si, project).has(s.tag));
    canvas.appendChild(nodeBox({
      x: COL.src, y, w: NODE_W.src, color,
      className: `nv-src${used ? "" : " nv-unused"}`,
      title: `${s.tag}`,
      subtitle: `${(s.label || "").slice(0, 22)} · ${s.marker}`,
      title2: used ? `${s.label}\n${s.marker}` : `${s.label}\nAttached but never cited — the model ignores a tag with no mention.`,
      onclick: () => onSelectSource(s),
    }));
    if (!used) {
      canvas.appendChild(h("div.nv-flag", { style: { left: `${COL.src + NODE_W.src - 16}px`, top: `${y - 4}px` }, title: "Not cited in any shot" }, "!"));
    }
  });

  // ── Shot nodes ──
  const shotY = {};
  shots.forEach((shot, i) => {
    const y = TOP + i * ROW_H;
    shotY[shot.id] = y + 26;
    const beats = (shot.beats || []).filter(b => (b.text || "").trim()).length;
    const lines = (shot.dialogue || []).filter(d => (d.text || "").trim()).length;
    const cam = shot.camera?.type === "static" && (!shot.camera?.secondary || shot.camera.secondary === "none")
      ? "static" : shot.camera?.type;
    canvas.appendChild(nodeBox({
      x: COL.shot, y, w: NODE_W.shot,
      color: selectedShotId === shot.id ? "#8a6a22" : "#35506e",
      className: `nv-shot${selectedShotId === shot.id ? " sel" : ""}`,
      title: `Shot ${i + 1} · ${shot.shotType}`,
      subtitle: `${cam} · ${beats} beat${beats === 1 ? "" : "s"}${lines ? ` · ${lines} line${lines === 1 ? "" : "s"}` : ""}`,
      title2: `${shot.subject || ""}\n${shotActionText(shot) || ""}`,
      onclick: () => onSelectShot(shot.id),
    }));

    // The cut chain: shot N feeds shot N+1 in time, which is what a [Shot N]
    // marker actually is — and the wire carries what happens at the seam:
    // a cut verb, or no cut at all (the row continues the same take, and is
    // drawn as one solid line into the block above).
    if (i > 0) {
      const same = shot.cutVerb === NO_CUT;
      const x = COL.shot + NODE_W.shot / 2;
      const y1 = TOP + (i - 1) * ROW_H + 44, y2 = y + 6;
      wire(x, y1, x, y2, same ? "#7fb2e5" : "#5a6a7a", { dashed: !same, title: same ? "same take — no cut" : transitionLabel(shot.cutVerb) });
      const pick = h("select.nv-cut", {
        title: "What happens between these two shots",
        onclick: (e) => e.stopPropagation(),
        onchange: (e) => onCutChange?.(shot.id, e.target.value),
      }, ...TRANSITIONS.map(([v, label]) => h("option", { value: v, selected: v === (shot.cutVerb || "the camera cuts to") }, label.replace(/ \(ask first\)/, ""))));
      canvas.appendChild(h("div.nv-cutwrap", { class: `nv-cutwrap${same ? " same" : ""}`, style: { left: `${x}px`, top: `${(y1 + y2) / 2}px` } }, pick));
    }
  });

  // ── Reference → shot edges ──
  if (project.mode === "r2v") {
    shots.forEach((shot, i) => {
      const cited = citedBy(shot, i, project);
      for (const s of sources) {
        if (!cited.has(s.tag)) continue;
        const strong = selectedShotId === shot.id;
        wire(COL.src + NODE_W.src, srcY[s.key], COL.shot, shotY[shot.id],
          KIND_COLOR[s.kind]?.edge || "#888",
          { strong, dim: selectedShotId && !strong, title: `${s.tag} → Shot ${i + 1} (${s.marker})` });
      }
    });
  } else if (project.mode === "i2v" && sources.length && shots.length) {
    wire(COL.src + NODE_W.src, srcY.frame, COL.shot, shotY[shots[0].id], KIND_COLOR.frame.edge,
      { strong: true, title: "first frame, anchored at 0.00s" });
  }

  // ── Output ──
  const outY = TOP + Math.max(0, (rows - 1) / 2) * ROW_H;
  canvas.appendChild(nodeBox({
    x: COL.out, y: outY, w: NODE_W.out, color: "#2f5c46",
    className: "nv-out",
    title: "Render",
    subtitle: `${project.render.duration}s · ${project.render.resolution}`,
    title2: "MiniMaxH3 → sample → decode video + audio → mux",
  }));
  shots.forEach((shot) => {
    wire(COL.shot + NODE_W.shot, shotY[shot.id], COL.out, outY + 26, "#4b9b58",
      { dim: !!selectedShotId && selectedShotId !== shot.id, strong: selectedShotId === shot.id });
  });

  // Audio fields join at the output, because that is where they are mixed.
  const sound = [];
  if (!project.sound.silent && project.sound.soundscape) sound.push("soundscape");
  if (!project.sound.musicOff && project.sound.music) sound.push("score");
  if (sound.length) {
    canvas.appendChild(h("div.nv-note", { style: { left: `${COL.out}px`, top: `${outY + 58}px` } }, `+ ${sound.join(" + ")}`));
  }

  const strip = h("div.nv-strip", canvas);
  if (!sources.length && project.mode !== "t2v") {
    strip.appendChild(h("div.nv-empty", project.mode === "i2v"
      ? "No first frame yet — Media ▸ First Frame."
      : "No references yet — Media ▸ Reference bins."));
  }
  if (project.mode === "t2v") {
    strip.appendChild(h("div.nv-empty", "Text to Video conditions on the prompt alone — the graph is the cut chain."));
  }
  return strip;
}

export function nodeGraphLegend() {
  return h("div.nv-legend",
    h("span", h("i", { style: { background: "#7fb2e5" } }), "picture"),
    h("span", h("i", { style: { background: "#c79ae0" } }), "video"),
    h("span", h("i", { style: { background: "#79c79b" } }), "audio"),
    h("span", h("i", { style: { background: "#5a6a7a" } }), "cut"),
    h("span.nv-legend-warn", "! never cited"),
  );
}
