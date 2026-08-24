/**
 * MOTIONSTILL CUT — projects on disk.
 *
 * The editor used to hold exactly one project, in the browser's localStorage.
 * That is fine for a scratchpad and wrong for a tool: you cannot have two
 * clips on the go, you cannot come back to last week's, and clearing your
 * browser data throws the lot away.
 *
 * So projects live on the server, one JSON file each, the way the library and
 * the rulebook already do — readable, diffable, and recoverable with `cp`.
 * One file per project rather than one big array, because a project is tens of
 * kilobytes and rewriting every project on every autosave is the kind of thing
 * that is fine until it is not.
 *
 * MEDIA. The project object holds only metadata; the bytes live in the
 * browser's IndexedDB. A project saved here and opened on another machine
 * would therefore reference pictures that are not there — which is not
 * "saved" in any sense worth the word. So the bytes come too, into
 * data/media/, deduplicated by id: the same picture used by four projects is
 * stored once, and is only deleted when the last project referencing it is.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "./settings.js";

const DIR = join(DATA_DIR, "projects");
const MEDIA = join(DATA_DIR, "media");
const MAX = 500;

/* An id from the client is a filename here, so it is not allowed to be a path.
 * The app generates uuids, but the endpoint is reachable by anything. */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const safe = (id) => (SAFE.test(String(id || "")) ? String(id) : null);

const ensure = (dir) => { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); };

function atomicWrite(path, text) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/* The list is what the project manager shows, and it must not require parsing
 * every project on every keystroke. Parsed once, then only when the file's
 * mtime moves. */
const summaries = new Map();   // id → { mtimeMs, summary }

function summarise(id, project, stat) {
  return {
    id,
    name: (project.name || "Untitled Timeline").trim(),
    mode: project.mode || "t2v",
    duration: project.render?.duration || 0,
    resolution: project.render?.resolution || "",
    shots: (project.shots || []).length,
    references: (project.refs?.images?.length || 0) + (project.refs?.videos?.length || 0)
      + (project.refs?.audios?.length || 0) + (project.frames?.first ? 1 : 0),
    renders: (project.jobs || []).length,
    template: project.template || null,
    createdAt: project.createdAt || stat?.birthtimeMs || stat?.mtimeMs || Date.now(),
    updatedAt: stat?.mtimeMs || Date.now(),
  };
}

export function list() {
  ensure(DIR);
  const rows = [];
  for (const file of readdirSync(DIR)) {
    if (!file.endsWith(".json")) continue;
    const id = file.slice(0, -5);
    const path = join(DIR, file);
    let stat;
    try { stat = statSync(path); } catch { continue; }
    const cached = summaries.get(id);
    if (cached && cached.mtimeMs === stat.mtimeMs) { rows.push(cached.summary); continue; }
    try {
      const project = JSON.parse(readFileSync(path, "utf-8"));
      const summary = summarise(id, project, stat);
      summaries.set(id, { mtimeMs: stat.mtimeMs, summary });
      rows.push(summary);
    } catch {
      // A project that will not parse is still a file someone can recover; it
      // is listed as broken rather than hidden.
      rows.push({ id, name: `${id} (unreadable)`, broken: true, updatedAt: stat.mtimeMs });
    }
  }
  rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { ok: true, rows };
}

export function get(id) {
  const key = safe(id);
  if (!key) return null;
  const path = join(DIR, `${key}.json`);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

export function save(project) {
  ensure(DIR);
  const key = safe(project?.id) || randomUUID();
  const now = Date.now();
  const body = { ...project, id: key, createdAt: project.createdAt || now, updatedAt: now };
  if (!summaries.has(key) && list().rows.length >= MAX) {
    return { ok: false, error: `That would be more than ${MAX} projects. Delete some first.` };
  }
  try {
    atomicWrite(join(DIR, `${key}.json`), JSON.stringify(body, null, 1));
    summaries.delete(key);
    return { ok: true, id: key, project: body };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function remove(id) {
  const key = safe(id);
  if (!key) return { ok: false, error: "bad id" };
  try {
    unlinkSync(join(DIR, `${key}.json`));
    summaries.delete(key);
    sweepMedia();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function duplicate(id, name) {
  const src = get(id);
  if (!src) return { ok: false, error: "no such project" };
  const copy = { ...src, id: undefined, name: name || `${src.name} copy`, createdAt: Date.now(), jobs: [] };
  return save(copy);
}

/* ── Media ────────────────────────────────────────────────────
 * Deduplicated by the media id the client already generates. Stored as the
 * data URL the client uses, so what goes back is exactly what came in — no
 * re-encoding, and nothing to get wrong about a codec. */

export function putMedia(id, dataUrl) {
  const key = safe(id);
  if (!key) return { ok: false, error: "bad id" };
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return { ok: false, error: "not a data url" };
  ensure(MEDIA);
  const path = join(MEDIA, key);
  // Already here means already identical: ids are content-independent but a
  // given id is only ever one file.
  if (existsSync(path)) return { ok: true, id: key, existed: true };
  try {
    atomicWrite(path, dataUrl);
    return { ok: true, id: key };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function getMedia(id) {
  const key = safe(id);
  if (!key) return null;
  const path = join(MEDIA, key);
  if (!existsSync(path)) return null;
  try { return readFileSync(path, "utf-8"); } catch { return null; }
}

/** Which of these ids the server already holds, so the client only uploads the
 *  rest. A project with six references should not re-send six pictures every
 *  time somebody renames it. */
export function haveMedia(ids = []) {
  ensure(MEDIA);
  const have = [];
  for (const id of ids) {
    const key = safe(id);
    if (key && existsSync(join(MEDIA, key))) have.push(key);
  }
  return have;
}

/** Delete media no remaining project references. Called after a delete, which
 *  is the only moment it can become true. */
export function sweepMedia() {
  ensure(MEDIA);
  const used = new Set();
  for (const row of list().rows) {
    const p = get(row.id);
    if (!p) continue;
    for (const m of [p.frames?.first, ...(p.refs?.images || []), ...(p.refs?.videos || []), ...(p.refs?.audios || [])]) {
      if (m?.id) used.add(m.id);
    }
  }
  let freed = 0;
  for (const file of readdirSync(MEDIA)) {
    if (used.has(file)) continue;
    try { unlinkSync(join(MEDIA, file)); freed++; } catch { /* it will be swept next time */ }
  }
  return freed;
}

export { DIR as PROJECTS_DIR, MEDIA as MEDIA_DIR };
