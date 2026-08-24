/* MOTIONSTILL CUT — projects, client-side.
 *
 * On the server a project was one JSON file under data/projects, and its media
 * travelled into data/media so the project could be opened elsewhere. Here
 * there is no elsewhere: projects live in IndexedDB next to the library, and
 * the media bytes are already in the pool's own store (media.js) — so the
 * "media sync" half of a save collapses into "already here".
 *
 * Portability is what the project export (a downloadable JSON, media inlined)
 * and the whole-app backup on Setup are for.
 */

import * as store from "./store.js";
import { getBlob, putBlob } from "../media.js";

const MAX = 500;

/* An id used to become a filename on the server; the shape is kept so ids stay
 * interchangeable between the hosted and the local version. */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const safe = (id) => (SAFE.test(String(id || "")) ? String(id) : null);

const uuid = () =>
  (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

function summarise(project) {
  return {
    id: project.id,
    name: (project.name || "Untitled Timeline").trim(),
    mode: project.mode || "t2v",
    duration: project.render?.duration || 0,
    resolution: project.render?.resolution || "",
    shots: (project.shots || []).length,
    references: (project.refs?.images?.length || 0) + (project.refs?.videos?.length || 0)
      + (project.refs?.audios?.length || 0) + (project.frames?.first ? 1 : 0),
    renders: (project.jobs || []).length,
    template: project.template || null,
    createdAt: project.createdAt || Date.now(),
    updatedAt: project.updatedAt || project.createdAt || Date.now(),
  };
}

export function list() {
  const rows = store.list("projects", { limit: MAX + 1 }).rows.map(summarise);
  rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { ok: true, rows };
}

export function get(id) {
  const key = safe(id);
  return key ? store.get("projects", key) : null;
}

export function save(project) {
  const key = safe(project?.id) || uuid();
  const now = Date.now();
  const body = { ...project, id: key, createdAt: project.createdAt || now, updatedAt: now };
  const isNew = !store.get("projects", key);
  if (isNew && store.list("projects", { limit: MAX + 1 }).total >= MAX) {
    return { ok: false, error: `That would be more than ${MAX} projects. Delete some first.` };
  }
  // `at` drives the store's newest-first ordering; projects sort on updatedAt
  // in list() above, but keeping `at` in step costs nothing and confuses less.
  const r = store.put("projects", { ...body, at: now });
  return r.ok ? { ok: true, id: key, project: r.entry } : r;
}

export function remove(id) {
  const key = safe(id);
  if (!key) return { ok: false, error: "bad id" };
  return store.remove("projects", key);
  // No media sweep here: the pool's bytes are shared with the open editor and
  // the library thumbnails, and IndexedDB space is the browser's to reclaim.
}

export function duplicate(id, name) {
  const src = get(id);
  if (!src) return { ok: false, error: "no such project" };
  const copy = { ...src, id: undefined, name: name || `${src.name} copy`, createdAt: Date.now(), jobs: [] };
  return save(copy);
}

/* ── Media ────────────────────────────────────────────────────
 * The same contract the server offered, answered from the pool's own
 * IndexedDB: nothing to upload, everything already "there". */

export async function haveMedia(ids = []) {
  const have = [];
  for (const id of ids) {
    const key = safe(id);
    if (key && (await getBlob(key))) have.push(key);
  }
  return have;
}

export async function putMedia(id, dataUrl) {
  const key = safe(id);
  if (!key) return { ok: false, error: "bad id" };
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return { ok: false, error: "not a data url" };
  await putBlob(key, dataUrl);
  return { ok: true, id: key };
}

export async function getMedia(id) {
  const key = safe(id);
  if (!key) return null;
  return (await getBlob(key)) || null;
}
