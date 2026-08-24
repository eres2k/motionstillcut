/* MOTIONSTILL CUT — the client's view of the server's settings and of both
 * engines' health. One module so the badges in the title bar, the Setup page
 * and the graph builder all read the same values. */

import { api } from "./api.js";

let settings = null;
/* `ffmpeg` is undefined until the first health call answers, and undefined
 * means "not asked yet" rather than "missing" — an older Cut server has no
 * such probe, and hiding the join button on a machine that can join is worse
 * than offering it and reporting the 503. */
let health = { comfy: { ok: false }, llm: { ok: false }, nodes: null, vram: { saver: true, owner: null }, ffmpeg: undefined };
const listeners = new Set();

export const getSettings = () => settings;
export const getHealth = () => health;

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) { try { fn(settings, health); } catch (e) { console.error(e); } } }

export async function loadState() {
  const r = await api.state();
  settings = r.settings;
  health.vram = r.vram || health.vram;
  emit();
  return r;
}

export async function saveSettings(patch) {
  const r = await api.saveSettings(patch);
  settings = r.settings;
  emit();
  return settings;
}

export async function refreshHealth() {
  try {
    const r = await api.health();
    health = { comfy: r.comfy, llm: r.llm, nodes: r.nodes, vram: r.vram || health.vram, ffmpeg: r.ffmpeg };
  } catch (err) {
    health = { comfy: { ok: false, error: err.message }, llm: { ok: false, error: err.message }, nodes: null, vram: health.vram, ffmpeg: health.ffmpeg };
  }
  emit();
  return health;
}

export async function refreshVram() {
  try {
    health.vram = await api.vram();
    emit();
  } catch { /* the badge simply keeps its last value */ }
  return health.vram;
}
