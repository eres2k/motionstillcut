/* MOTIONSTILL CUT — the things that outlive a session, client-side.
 *
 *   library   every render, with the prompt that made it and what you thought
 *   rulebook  what YOU have learned on YOUR hardware, fed back into the
 *             checker and the rewriter's system prompt
 *   cast      recurring subjects and reusable phrase blocks
 *
 * The Cut server kept these as JSON files under data/. The public release has
 * no server, so they live in IndexedDB — one object store per kind, one
 * record per row, and the whole kind held in memory once read, so list and
 * filter stay synchronous the way the server's were. localStorage is not an
 * option here: a library of a few thousand renders is megabytes, and the
 * 5 MB quota would eat it silently.
 *
 * When IndexedDB is unavailable (private windows, some webviews) everything
 * still works for the session in memory, and says so once.
 */

const DB_NAME = "mscut-data";
const DB_VERSION = 1;
export const KINDS = ["library", "rulebook", "cast", "projects"];

/* A render record is a few KB of text; the video itself stays in ComfyUI's
 * output folder and the record only points at it. Past the cap the oldest
 * unrated ones go first — a record you never judged is the one you will miss
 * least. */
const LIMITS = { library: 4000, rulebook: 500, cast: 500 };

let dbPromise = null;
let warned = false;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch { return resolve(null); }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const kind of KINDS) {
        if (!db.objectStoreNames.contains(kind)) db.createObjectStore(kind);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}

async function tx(kind, mode, fn) {
  const db = await openDB();
  if (!db) {
    if (!warned) { warned = true; console.warn("[store] IndexedDB unavailable — the library, rulebook, cast and projects hold for this session only."); }
    return null;
  }
  return new Promise((resolve, reject) => {
    const t = db.transaction(kind, mode);
    const req = fn(t.objectStore(kind));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Every row of a kind, straight from the object store. */
export async function readAll(kind) {
  try { return (await tx(kind, "readonly", (s) => s.getAll())) || []; }
  catch { return []; }
}

export async function idbPut(kind, id, row) {
  try { await tx(kind, "readwrite", (s) => s.put(row, id)); } catch { /* memory is enough */ }
}

export async function idbDelete(kind, id) {
  try { await tx(kind, "readwrite", (s) => s.delete(id)); } catch { /* nothing to do */ }
}

export async function idbClear(kind) {
  try { await tx(kind, "readwrite", (s) => s.clear()); } catch { /* nothing to do */ }
}

/* ── The in-memory view the routes work on ─────────────────────
 * Loaded once per kind, then kept current on every write. The arrays sort
 * newest-first like the server's did. */

const cache = {};        // kind → rows[]
const loading = {};      // kind → Promise

function load(kind) {
  if (cache[kind]) return Promise.resolve(cache[kind]);
  if (!loading[kind]) {
    loading[kind] = readAll(kind).then((rows) => {
      cache[kind] = rows.sort((a, b) => (b.at || 0) - (a.at || 0));
      return cache[kind];
    });
  }
  return loading[kind];
}

/** Await before the first synchronous read of a kind. */
export const ready = (kind) => load(kind);

const uuid = () =>
  (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

function trim(kind, rows) {
  const limit = LIMITS[kind] || 1000;
  if (rows.length <= limit) return rows;
  const keep = rows.filter(r => r.verdict?.rating || r.pinned);
  const rest = rows.filter(r => !(r.verdict?.rating || r.pinned));
  const kept = [...keep, ...rest].slice(0, limit);
  const gone = new Set(rows.filter(r => !kept.includes(r)).map(r => r.id));
  for (const id of gone) void idbDelete(kind, id);
  return kept;
}

export function list(kind, { limit = 500, offset = 0, query = "", filter = {} } = {}) {
  let rows = [...(cache[kind] || [])];
  const q = String(query || "").trim().toLowerCase();
  if (q) rows = rows.filter(r => JSON.stringify(r).toLowerCase().includes(q));
  for (const [key, value] of Object.entries(filter || {})) {
    if (value === undefined || value === null || value === "") continue;
    rows = rows.filter(r => {
      const at = key.split(".").reduce((o, k) => (o == null ? o : o[k]), r);
      if (Array.isArray(at)) return at.includes(value);
      if (key === "minRating") return (r.verdict?.rating || 0) >= Number(value);
      return String(at ?? "") === String(value);
    });
  }
  rows.sort((a, b) => (b.at || 0) - (a.at || 0));
  return { total: rows.length, rows: rows.slice(offset, offset + limit) };
}

export function get(kind, id) {
  return (cache[kind] || []).find(r => r.id === id) || null;
}

export function put(kind, row) {
  const rows = cache[kind] || (cache[kind] = []);
  const entry = { ...row, id: row.id || uuid(), at: row.at || Date.now() };
  const i = rows.findIndex(r => r.id === entry.id);
  let saved;
  if (i >= 0) { rows[i] = { ...rows[i], ...entry, updatedAt: Date.now() }; saved = rows[i]; }
  else { rows.unshift(entry); saved = entry; }
  cache[kind] = trim(kind, rows);
  void idbPut(kind, saved.id, saved);
  return { ok: true, entry: saved };
}

export function patch(kind, id, changes) {
  const rows = cache[kind] || [];
  const i = rows.findIndex(r => r.id === id);
  if (i < 0) return { ok: false, error: "no such entry" };
  rows[i] = { ...rows[i], ...changes, updatedAt: Date.now() };
  void idbPut(kind, id, rows[i]);
  return { ok: true, entry: rows[i] };
}

export function remove(kind, id) {
  cache[kind] = (cache[kind] || []).filter(r => r.id !== id);
  void idbDelete(kind, id);
  return { ok: true };
}

/** Replace a whole kind — the restore half of a backup. */
export async function replaceAll(kind, rows) {
  const clean = (Array.isArray(rows) ? rows : []).filter(r => r && typeof r === "object")
    .map(r => ({ ...r, id: r.id || uuid() }));
  await idbClear(kind);
  for (const r of clean) await idbPut(kind, r.id, r);
  cache[kind] = clean.sort((a, b) => (b.at || 0) - (a.at || 0));
  return clean.length;
}

export function stats() {
  const rows = cache.library || [];
  const tags = {};
  let rated = 0, sum = 0;
  for (const r of rows) {
    if (r.verdict?.rating) { rated++; sum += r.verdict.rating; }
    for (const t of r.verdict?.tags || []) tags[t] = (tags[t] || 0) + 1;
  }
  return {
    total: rows.length,
    rated,
    averageRating: rated ? +(sum / rated).toFixed(2) : null,
    topTags: Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([tag, n]) => ({ tag, n })),
    experiments: [...new Set(rows.map(r => r.experimentId).filter(Boolean))].length,
  };
}

/** The user's own rules, as a block for the rewriter's system prompt. */
export function rulebookPrompt(mode = "") {
  const rules = (cache.rulebook || []).filter(r => r.active !== false && (!r.mode || r.mode === "all" || r.mode === mode));
  if (!rules.length) return "";
  return "House rules, learned on this machine — they override general advice where they conflict:\n"
    + rules.map(r => `- ${r.text}`).join("\n");
}
