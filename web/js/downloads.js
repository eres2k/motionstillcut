/* A FOLDER OF YOUR OWN — where finished renders land on this machine.
 *
 * A web page cannot write into the user's file system, with one exception:
 * the File System Access API (Chrome, Edge — over HTTPS or localhost) lets
 * the user pick a folder once and hands the page a handle it may keep. So:
 * choose a folder on Deliver, and from then on every clip that finishes is
 * fetched from ComfyUI and written there, named as ComfyUI named it. The
 * handle is kept in IndexedDB; the browser asks once per session before the
 * first write. Browsers without the API get the ordinary download instead
 * — and either way ComfyUI still keeps its own copy in its output folder.
 */

import { api } from "./api.js";

const DB_NAME = "mscut-downloads";
const STORE = "handles";
const KEY = "folder";

let dbPromise = null;
let handle = undefined;          // undefined = not loaded yet; null = none chosen
const listeners = new Set();

export const supported = () => typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
export function onFolderChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const emit = () => listeners.forEach(fn => { try { fn(); } catch {} });

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch { return resolve(null); }
    req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}
async function tx(mode, fn) {
  const db = await openDB();
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result ?? null);
    t.onerror = () => reject(t.error);
  });
}

/** The chosen folder's handle, or null. */
export async function folder() {
  if (handle !== undefined) return handle;
  try { handle = (await tx("readonly", s => s.get(KEY))) || null; } catch { handle = null; }
  return handle;
}
export async function folderName() { const h = await folder(); return h?.name || ""; }

/** Ask for the folder. Must run from a click. */
export async function chooseFolder() {
  if (!supported()) throw new Error("This browser cannot hand a page a folder. Chrome or Edge can; elsewhere renders download the ordinary way.");
  const h = await window.showDirectoryPicker({ mode: "readwrite", id: "mscut-renders", startIn: "videos" });
  handle = h;
  try { await tx("readwrite", s => s.put(h, KEY)); } catch { /* memory only */ }
  emit();
  return h;
}
export async function clearFolder() {
  handle = null;
  try { await tx("readwrite", s => s.delete(KEY)); } catch {}
  emit();
}

/** Do we hold write permission? `ask` may prompt (needs a user gesture). */
export async function hasPermission(ask = false) {
  const h = await folder();
  if (!h) return false;
  const opts = { mode: "readwrite" };
  try {
    if ((await h.queryPermission(opts)) === "granted") return true;
    if (!ask) return false;
    return (await h.requestPermission(opts)) === "granted";
  } catch { return false; }
}

/** Fetch one ComfyUI output and write it into the folder. Returns the name written. */
export async function saveOutput(out) {
  const h = await folder();
  if (!h) throw new Error("No download folder chosen.");
  if (!(await hasPermission(true))) throw new Error(`No permission to write into "${h.name}" — choose the folder again.`);
  const res = await fetch(api.viewUrl(out));
  if (!res.ok) throw new Error(`ComfyUI would not hand over ${out.filename} (${res.status}).`);
  const name = out.filename || "render.mp4";
  const file = await h.getFileHandle(name, { create: true });
  const w = await file.createWritable();
  await res.body.pipeTo(w);
  return name;
}

/**
 * Called when a job finishes with outputs. Writes every output into the
 * chosen folder; with no folder chosen it does nothing (ComfyUI has the
 * file). Never throws — a failed copy is reported on the job, not thrown
 * across a queue run. Returns { saved: [names], error } .
 */
export async function saveJobOutputs(job) {
  const h = await folder();
  if (!h || !job?.outputs?.length) return { saved: [], error: null };
  const saved = [];
  try {
    for (const out of job.outputs) saved.push(await saveOutput(out));
    return { saved, error: null };
  } catch (err) {
    return { saved, error: err.message };
  }
}

/** The ordinary download, for browsers without the API or as a one-off. */
export async function downloadOutput(out) {
  const res = await fetch(api.viewUrl(out));
  if (!res.ok) throw new Error(`ComfyUI would not hand over ${out.filename} (${res.status}).`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url; a.download = out.filename || "render.mp4";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
