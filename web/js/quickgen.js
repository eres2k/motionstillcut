/* ── Quick generate ────────────────────────────────────────────
 * An intro, a piece of B-roll, an outro: a five-second clip that needs a
 * line, not a project. This builds a throwaway snapshot of the current
 * project — same engine, canvas, look and mood — with one shot from one
 * line, on the fastest build the engine has, and hands it to renderNow the
 * way a film clip is rendered. The finished job lands in the live project's
 * history like any other render, so the editor can pick it up. */
import { getProject, update, newShot, newBeat, blankProject, activeEngine } from "./state.js";
import { renderNow } from "./render.js";
import { presetGuidance } from "./presets.js";

export const QUICK_ROLES = [
  ["intro", "Intro",  "An opening: the place or the subject arriving, room for a title."],
  ["broll", "B-roll", "A cutaway: texture, detail, atmosphere — nothing that has to match."],
  ["outro", "Outro",  "A closing: a pull-out, a settle, the light going, room for a card."],
];

const ROLE_BEATS = {
  intro: { camera: { type: "push in", amplitude: "small", speed: "slow" }, shotType: "wide", beat: "the scene establishes itself, light settling in" },
  broll: { camera: { type: "truck right", amplitude: "small", speed: "slow" }, shotType: "close-up", beat: "a slow drift across the detail" },
  outro: { camera: { type: "pull out", amplitude: "medium", speed: "slow" }, shotType: "wide", beat: "the camera eases back and the scene rests" },
};

/** The fastest build the engine has for a short clip. */
function fastVariant(engine) {
  return engine === "ltx25" ? "ltx_single" : "turbo";
}

/** A render-ready snapshot: one shot, one line, no history. */
export function quickProject(base, { prompt, seconds = 5, role = "broll", soundscape = "" } = {}) {
  const p = { ...blankProject(), ...structuredClone({ style: base.style, render: base.render, creative: base.creative }) };
  p.name = `${base.name || "Quick"} — ${role}`;
  p.mode = "t2v";
  p.frames = { first: null };
  p.refs = { images: [], videos: [], audios: [] };
  p.render = { ...p.render, engine: base.render?.engine === "ltx25" ? "ltx25" : "minimax", duration: seconds <= 5 ? 5 : 10, seed: -1, upscale: { engine: "off", target: "1080p" }, watermark: base.render?.watermark || "off" };
  p.render.variant = fastVariant(activeEngine(p));
  p.creative = { ...p.creative, preset: "", shotCount: 1 };
  const r = ROLE_BEATS[role] || ROLE_BEATS.broll;
  const s = newShot(0);
  s.subject = String(prompt || "").trim();
  s.shotType = r.shotType;
  s.viewpoint = "front-facing";
  s.camera = { ...s.camera, ...r.camera };
  s.beats = [newBeat(r.beat, "")];
  p.shots = [s];
  p.selectedShot = s.id;
  p.sound = { ...p.sound, soundscape: soundscape || base.sound?.soundscape || "quiet ambience of the place, no voices", musicOff: true };
  delete p.jobs; p.jobs = [];
  return p;
}

/** Render a quick clip into the live project's history. Resolves with the job. */
export async function quickRender({ prompt, seconds = 5, role = "broll", soundscape = "", onStep = () => {} } = {}) {
  const base = getProject();
  const snap = quickProject(base, { prompt, seconds, role, soundscape });
  return renderNow({
    project: snap,
    commit: (fn, reason = "jobs") => update(fn, reason),
    variantLabel: `Quick · ${QUICK_ROLES.find(r => r[0] === role)?.[1] || role}`,
    onStep,
  });
}

/** What the writer should know when drafting a quick line. */
export function quickBrief(base) {
  return [
    `The main project: ${base.name || "untitled"}, ${base.mode?.toUpperCase() || "T2V"}, style ${base.style?.look || "live-action cinematic"}${base.style?.grade ? `, ${base.style.grade}` : ""}.`,
    presetGuidance(base),
    base.shots?.[0]?.subject ? `Its first shot: ${base.shots[0].subject}` : "",
  ].filter(Boolean).join("\n");
}
