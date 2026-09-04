/* MOTIONSTILL CUT — the storyboard.
 *
 * Previz answers "does this play the way I meant" in real time. A board answers
 * the same question at a glance, and answers a second one playback cannot: how
 * the beats are distributed. Six cards where three shots were intended is
 * visible here in a second and invisible in a paragraph.
 *
 * Each card is one beat: the frame it happens in (drawn from the same framing
 * geometry previz uses), when it happens, what the camera is doing, and the
 * words themselves.
 */

import { h, shotTime, timecode } from "./util.js";
import { orderedShots, shotCitations } from "./state.js";
import { getBlob } from "./media.js";
import { framingOrigin, subjectHeightPct, endFramingFor } from "./previz.js";
import { cameraSentence } from "./prompt.js";

/** A miniature of the frame: the subject box where it starts, a ghost where the
 *  move leaves it, and an arrow between them. Same numbers as the previz, drawn
 *  small enough to scan a whole clip at once. */
function frameThumb(shot, { width = 168 } = {}) {
  const height = Math.round(width * 9 / 16);
  const [sx, sy] = framingOrigin(shot.camera || {});
  const sh = subjectHeightPct(shot.shotType);
  const end = endFramingFor(shot.camera || {}, shot.shotType);
  const moved = Math.abs(end.x - sx) > 1.5 || Math.abs(end.y - sy) > 1.5 || Math.abs(end.height - sh) > 2;

  const box = (cx, cy, hPct, cls) => {
    const bh = (hPct / 100) * height;
    const bw = bh * 0.55;
    return `<rect x="${((cx / 100) * width - bw / 2).toFixed(1)}" y="${((cy / 100) * height - bh / 2).toFixed(1)}"
      width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" class="${cls}"/>`;
  };

  const arrow = moved
    ? `<line x1="${(sx / 100) * width}" y1="${(sy / 100) * height}"
             x2="${(end.x / 100) * width}" y2="${(end.y / 100) * height}"
             class="bd-arrow" marker-end="url(#bd-head)"/>`
    : "";

  return h("div.bd-thumb", {
    html: `<svg viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMidYMid meet">
      <defs><marker id="bd-head" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="5" markerHeight="5" orient="auto">
        <path d="M0,0 L8,4 L0,8 z" fill="#7fb2e5"/></marker></defs>
      <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" class="bd-gate"/>
      <line x1="${width / 3}" y1="0" x2="${width / 3}" y2="${height}" class="bd-third"/>
      <line x1="${(width / 3) * 2}" y1="0" x2="${(width / 3) * 2}" y2="${height}" class="bd-third"/>
      <line x1="0" y1="${height / 3}" x2="${width}" y2="${height / 3}" class="bd-third"/>
      <line x1="0" y1="${(height / 3) * 2}" x2="${width}" y2="${(height / 3) * 2}" class="bd-third"/>
      ${moved ? box(end.x, end.y, end.height, "bd-subject bd-ghost") : ""}
      ${box(sx, sy, sh, "bd-subject")}
      ${arrow}
    </svg>`,
  });
}

/** The references this shot cites, as a strip of stills under the framing
 *  diagram: the diagram says where the subject sits, the stills say who or
 *  what the subject is. */
function citedStills(project, shot) {
  const cites = shotCitations(project, shot).filter(e => e.kind !== "audio");
  if (!cites.length) return null;
  return h("div.bd-cites", ...cites.map((e) => {
    const still = h("div.cite-still", { title: `${e.tag} — ${e.ref?.label || e.ref?.name || ""}` }, e.kind === "video" ? "▶" : "");
    const paint = (src) => { if (src) { still.style.backgroundImage = `url("${src}")`; still.textContent = ""; } };
    if (e.kind === "video") paint(e.ref?.poster);
    else if (e.ref?.id) getBlob(e.ref.id).then(paint);
    return still;
  }));
}

/**
 * One card per beat, in order, across the whole clip.
 * @returns {HTMLElement}
 */
export function renderBoard(project, { onSelectShot = () => {}, selectedShotId = null } = {}) {
  const shots = orderedShots(project);
  const duration = project.render.duration;
  const cards = [];

  shots.forEach((shot, i) => {
    const end = i + 1 < shots.length ? shots[i + 1].at : duration;
    const len = Math.max(0.001, end - (shot.at || 0));
    const beats = (shot.beats || []).filter(b => (b.text || "").trim());
    const lines = (shot.dialogue || []).filter(d => (d.text || "").trim());
    const slots = beats.length || 1;
    const slot = len / slots;

    for (let bi = 0; bi < slots; bi++) {
      const at = (shot.at || 0) + bi * slot;
      const beat = beats[bi];
      const line = lines.length ? lines[Math.min(lines.length - 1, Math.floor((bi / slots) * lines.length))] : null;
      cards.push(h("div", {
        class: `bd-card${selectedShotId === shot.id ? " sel" : ""}`,
        onclick: () => onSelectShot(shot.id),
        title: `${shot.subject || ""}\n${beat?.text || ""}`,
      },
        frameThumb(shot),
        h("div.bd-meta",
          h("div.flex",
            h("span.tag", `${i + 1}${slots > 1 ? `.${bi + 1}` : ""}`),
            h("span.mono.faint", shotTime(at)),
            h("span.grow"),
            h("span.hint", `${slot.toFixed(1)}s`),
          ),
          bi === 0 ? citedStills(project, shot) : null,
          h("div.bd-shot", `${shot.shotType} · ${shot.viewpoint}${shot.camera?.lens && shot.camera.lens !== "none" ? ` · ${shot.camera.lens}` : ""}`),
          h("div.bd-beat", beat ? beat.text : (shot.subject || "— nothing written —")),
          bi === 0 ? h("div.bd-cam", cameraSentence(shot.camera)) : null,
          line && bi === 0 ? h("div.bd-dlg", `(${line.speaker}) “${line.text.slice(0, 48)}”`) : null,
        ),
      ));
    }
  });

  return h("div.bd-wrap",
    h("div.bd-strip", ...cards),
    h("div.bd-foot",
      h("span.hint", `${cards.length} beat${cards.length === 1 ? "" : "s"} across ${shots.length} shot${shots.length === 1 ? "" : "s"} · ${duration}s`),
      h("span.hint.faint", "one card per beat, in the order the model will render them"),
    ),
  );
}
