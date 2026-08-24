/**
 * MOTIONSTILL CUT — the things that outlive a session.
 *
 * A prompt-authoring tool needs none of this. A prompt-ENGINEERING tool needs
 * all of it, because the loop is idea → prompt → result → learn → better
 * prompt, and everything after "result" has to survive a browser refresh, a
 * different machine, and six weeks.
 *
 *   library   every render, with the prompt that made it and what you thought
 *   rulebook  what YOU have learned on YOUR hardware, fed back into the
 *             checker and the rewriter's system prompt
 *   cast      recurring subjects and reusable phrase blocks
 *
 * Plain JSON files under cut/data, written atomically, capped so they cannot
 * grow without bound. No database, because a database would be a dependency
 * and this project has none.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "./settings.js";

const FILES = {
  library:  join(DATA_DIR, "library.json"),
  rulebook: join(DATA_DIR, "rulebook.json"),
  cast:     join(DATA_DIR, "cast.json"),
};

/* A render record is a few KB of text; the video itself stays in ComfyUI's
 * output folder and the record only points at it. Ten thousand of those is
 * still a small file, and past that the oldest unrated ones go first — a
 * record you never judged is the one you will miss least. */
const LIMITS = { library: 4000, rulebook: 500, cast: 500 };

const cache = {};

function read(kind) {
  if (cache[kind]) return cache[kind];
  try {
    if (existsSync(FILES[kind])) {
      const parsed = JSON.parse(readFileSync(FILES[kind], "utf-8"));
      cache[kind] = Array.isArray(parsed) ? parsed : [];
    } else cache[kind] = [];
  } catch {
    // A corrupt file must not take the app down with it; it gets set aside so
    // the user still has it, and the app starts clean.
    try { renameSync(FILES[kind], `${FILES[kind]}.broken`); } catch { /* nothing to do */ }
    cache[kind] = [];
  }
  return cache[kind];
}

function write(kind, rows) {
  cache[kind] = rows;
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    // Atomic: a half-written library is worse than an old one.
    const tmp = `${FILES[kind]}.tmp`;
    writeFileSync(tmp, JSON.stringify(rows, null, 1));
    renameSync(tmp, FILES[kind]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function trim(kind, rows) {
  const limit = LIMITS[kind] || 1000;
  if (rows.length <= limit) return rows;
  const keep = rows.filter(r => r.verdict?.rating || r.pinned);
  const rest = rows.filter(r => !(r.verdict?.rating || r.pinned));
  return [...keep, ...rest].slice(0, limit);
}

export function list(kind, { limit = 500, offset = 0, query = "", filter = {} } = {}) {
  let rows = [...read(kind)];
  const q = String(query || "").trim().toLowerCase();
  if (q) {
    rows = rows.filter(r => JSON.stringify(r).toLowerCase().includes(q));
  }
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
  return read(kind).find(r => r.id === id) || null;
}

export function put(kind, row) {
  const rows = read(kind);
  const entry = { ...row, id: row.id || randomUUID(), at: row.at || Date.now() };
  const i = rows.findIndex(r => r.id === entry.id);
  if (i >= 0) rows[i] = { ...rows[i], ...entry, updatedAt: Date.now() };
  else rows.unshift(entry);
  const result = write(kind, trim(kind, rows));
  return { ...result, entry: i >= 0 ? rows[i] : entry };
}

export function patch(kind, id, changes) {
  const rows = read(kind);
  const i = rows.findIndex(r => r.id === id);
  if (i < 0) return { ok: false, error: "no such entry" };
  rows[i] = { ...rows[i], ...changes, updatedAt: Date.now() };
  const result = write(kind, rows);
  return { ...result, entry: rows[i] };
}

export function remove(kind, id) {
  const rows = read(kind).filter(r => r.id !== id);
  return write(kind, rows);
}

/** Everything the app knows about how renders have gone: how many, how they
 *  were rated, and which tags keep coming up. The Library header shows it, and
 *  it is the honest answer to "is this prompt style working". */
export function stats() {
  const rows = read("library");
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

/** The user's own rules, as a block for the rewriter's system prompt. This is
 *  the difference between a tool that knows MiniMax's guide and one that also
 *  knows what happened on this box last week. */
export function rulebookPrompt(mode = "") {
  const rules = read("rulebook").filter(r => r.active !== false && (!r.mode || r.mode === "all" || r.mode === mode));
  if (!rules.length) return "";
  return "House rules, learned on this machine — they override general advice where they conflict:\n"
    + rules.map(r => `- ${r.text}`).join("\n");
}

export { FILES };
