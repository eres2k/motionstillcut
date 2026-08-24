/* MOTIONSTILL CUT — applying what the second opinion suggests.
 *
 * The dry run comes back with concrete edits, and a button that applies them is
 * the difference between advice and help. But a model writing straight into the
 * project is exactly the kind of thing that goes wrong quietly, so nothing
 * lands without passing this file: one field from a fixed list, one shot that
 * exists, and a value that is in the vocabulary the compiler already knows how
 * to write. Anything else is refused with a reason rather than coerced.
 */

import { newBeat, orderedShots } from "./state.js";
import {
  SHOT_TYPES, VIEWPOINTS, CAMERA_TYPES, AMPLITUDES, SPEEDS,
  LENSES, CAMERA_HEIGHTS, DEPTH_CUES,
} from "./vocab.js";

const values = (list) => list.map(v => (Array.isArray(v) ? v[0] : v));

/* field → { label, kind, enum? } */
const FIELDS = {
  subject:    { label: "subject", kind: "text" },
  beats:      { label: "action beats", kind: "beats" },
  setting:    { label: "setting", kind: "text" },
  lighting:   { label: "lighting", kind: "text" },
  details:    { label: "extra detail", kind: "text" },
  continuity: { label: "changed since the last shot", kind: "text" },
  shotType:   { label: "shot type", kind: "enum", options: values(SHOT_TYPES) },
  viewpoint:  { label: "viewpoint", kind: "enum", options: values(VIEWPOINTS) },
  at:         { label: "cut time", kind: "seconds" },
  "camera.type":      { label: "camera motion", kind: "enum", options: values(CAMERA_TYPES) },
  "camera.amplitude": { label: "amplitude", kind: "enum", options: values(AMPLITUDES) },
  "camera.speed":     { label: "speed", kind: "enum", options: values(SPEEDS) },
  "camera.target":    { label: "camera target", kind: "text" },
  "camera.lens":      { label: "lens", kind: "enum", options: values(LENSES) },
  "camera.height":    { label: "camera height", kind: "enum", options: values(CAMERA_HEIGHTS) },
  "camera.depth":     { label: "depth", kind: "enum", options: values(DEPTH_CUES) },
  soundscape: { label: "overall_soundscape", kind: "text", clipWide: true },
  music:      { label: "non_diegetic_music", kind: "text", clipWide: true },
};

const MAX_TEXT = 600;

/** Is this fix safe to apply, and what would it do? */
export function validateFix(project, fix) {
  if (!fix || typeof fix !== "object") return { ok: false, error: "not a fix" };
  const spec = FIELDS[fix.field];
  if (!spec) return { ok: false, error: `${fix.field} is not a field this can set` };

  const shots = orderedShots(project);
  const index = Number(fix.shot) - 1;
  if (!spec.clipWide) {
    if (!Number.isInteger(index) || index < 0 || index >= shots.length) {
      return { ok: false, error: `there is no shot ${fix.shot}` };
    }
  }

  switch (spec.kind) {
    case "enum": {
      const v = String(fix.value ?? "").trim();
      if (!spec.options.includes(v)) return { ok: false, error: `"${v}" is not one of the ${spec.label} options` };
      return { ok: true, spec, index, value: v };
    }
    case "beats": {
      const list = Array.isArray(fix.value) ? fix.value : [fix.value];
      const beats = list.map(b => String(typeof b === "string" ? b : b?.text || "").trim()).filter(Boolean);
      if (!beats.length) return { ok: false, error: "no beats given" };
      if (beats.length > 6) return { ok: false, error: "more beats than any shot has seconds for" };
      if (beats.some(b => b.length > MAX_TEXT)) return { ok: false, error: "a beat is far too long" };
      return { ok: true, spec, index, value: beats };
    }
    case "seconds": {
      const n = Number(fix.value);
      if (!Number.isFinite(n)) return { ok: false, error: "not a number of seconds" };
      if (index === 0) return { ok: false, error: "shot 1 is pinned at 0.000" };
      const lo = (shots[index - 1]?.at ?? 0) + 0.5;
      const hi = (index + 1 < shots.length ? shots[index + 1].at : project.render.duration) - 0.5;
      if (n < lo || n > hi) return { ok: false, error: `a cut there would not fit between the shots either side` };
      return { ok: true, spec, index, value: Math.round(n * 100) / 100 };
    }
    default: {
      const v = String(fix.value ?? "").trim();
      if (!v) return { ok: false, error: "empty value" };
      if (v.length > MAX_TEXT) return { ok: false, error: "far too long" };
      return { ok: true, spec, index, value: v };
    }
  }
}

/** One line describing what the fix would change, for the button's label. */
export function describeFix(project, fix) {
  const spec = FIELDS[fix?.field];
  if (!spec) return `${fix?.field ?? "?"} — not applicable`;
  const where = spec.clipWide ? "the clip" : `shot ${fix.shot}`;
  const value = Array.isArray(fix.value) ? fix.value.join(" · ") : String(fix.value ?? "");
  return `${where} · ${spec.label} → ${value.slice(0, 90)}${value.length > 90 ? "…" : ""}`;
}

/**
 * Apply a validated fix to a live project draft (call inside state.update).
 * Returns { ok, error }.
 */
export function applyFix(draft, fix) {
  const check = validateFix(draft, fix);
  if (!check.ok) return check;
  const { spec, index, value } = check;

  if (spec.clipWide) {
    if (fix.field === "soundscape") { draft.sound.soundscape = value; draft.sound.silent = false; }
    else { draft.sound.music = value; draft.sound.musicOff = false; }
    return { ok: true };
  }

  // orderedShots is a sorted copy, so the id is what identifies the shot.
  const id = orderedShots(draft)[index]?.id;
  const shot = (draft.shots || []).find(s => s.id === id);
  if (!shot) return { ok: false, error: "that shot has gone" };

  if (fix.field === "beats") {
    shot.beats = value.map((text, i) => newBeat(text, i === 0 ? "" : "then"));
  } else if (fix.field.startsWith("camera.")) {
    shot.camera = { ...shot.camera, [fix.field.slice(7)]: value };
    // A hand-written line would silently win over the change just applied.
    if (fix.field !== "camera.target" && (shot.camera.custom || "").trim()) shot.camera.custom = "";
  } else {
    shot[fix.field] = value;
  }
  return { ok: true };
}

export const FIX_FIELDS = Object.keys(FIELDS);
