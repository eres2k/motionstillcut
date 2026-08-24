/* MOTIONSTILL CUT — the media pool's storage.
 *
 * The project object holds only metadata; the bytes live in IndexedDB under
 * the media id. Two reasons: a base64 first frame would blow the localStorage
 * quota on the first drop, and an editor that loses its thumbnails on reload
 * is not an editor. When IndexedDB is unavailable (private windows, some
 * embedded webviews) everything still works for the session — the pool falls
 * back to an in-memory map and says so once.
 */

import { uid } from "./util.js";

const DB_NAME = "mscut";
const DB_VERSION = 1;
const STORE = "blobs";

const memory = new Map();
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
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await openDB();
  if (!db) {
    if (!warned) { warned = true; console.warn("[media] IndexedDB unavailable — media is kept in memory for this session only."); }
    return null;
  }
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putBlob(id, dataUrl) {
  memory.set(id, dataUrl);
  try { await tx("readwrite", (s) => s.put(dataUrl, id)); } catch { /* memory is enough */ }
  return id;
}

export async function getBlob(id) {
  if (memory.has(id)) return memory.get(id);
  try {
    const v = await tx("readonly", (s) => s.get(id));
    if (v) memory.set(id, v);
    return v || null;
  } catch { return null; }
}

export async function delBlob(id) {
  memory.delete(id);
  try { await tx("readwrite", (s) => s.delete(id)); } catch { /* nothing to do */ }
}

const IMAGE_RE = /\.(png|jpe?g|webp|bmp|gif|avif)$/i;
const VIDEO_RE = /\.(mp4|mov|webm|mkv|avi|m4v)$/i;
const AUDIO_RE = /\.(wav|mp3|flac|ogg|m4a|aac)$/i;

export function kindOf(file) {
  const name = file.name || "";
  if (file.type?.startsWith("image/") || IMAGE_RE.test(name)) return "image";
  if (file.type?.startsWith("video/") || VIDEO_RE.test(name)) return "video";
  if (file.type?.startsWith("audio/") || AUDIO_RE.test(name)) return "audio";
  return "other";
}

/** Read a dropped file into the pool and return the metadata the project
 *  stores. The bytes go to IndexedDB; `comfyName` stays empty until the file
 *  is uploaded (Deliver does that automatically before it queues). */
export async function ingest(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error("could not read the file"));
    fr.readAsDataURL(file);
  });
  const id = uid();
  await putBlob(id, dataUrl);
  return {
    id,
    name: file.name || `${id}.bin`,
    label: (file.name || "").replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim(),
    kind: kindOf(file),
    size: file.size || 0,
    comfyName: "",          // filled in once ComfyUI has a copy
    caption: "",
    retention: "",
    note: "",
    useAudio: false,        // reference videos: bring the clip's own soundtrack
    addedAt: Date.now(),
  };
}

/** A poster frame for a video, grabbed client-side so the pool shows real
 *  thumbnails instead of a placeholder icon. Best effort — a codec the browser
 *  can't decode just keeps the icon. */
export function posterFor(dataUrl) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.src = dataUrl;
    const bail = setTimeout(() => resolve(null), 4000);
    v.onloadeddata = () => {
      try {
        v.currentTime = Math.min(0.3, (v.duration || 1) / 3);
      } catch { clearTimeout(bail); resolve(null); }
    };
    v.onseeked = () => {
      try {
        const c = document.createElement("canvas");
        c.width = 320;
        c.height = Math.round(320 * (v.videoHeight / v.videoWidth || 0.5625));
        c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
        clearTimeout(bail);
        resolve(c.toDataURL("image/jpeg", 0.7));
      } catch { clearTimeout(bail); resolve(null); }
    };
    v.onerror = () => { clearTimeout(bail); resolve(null); };
  });
}
