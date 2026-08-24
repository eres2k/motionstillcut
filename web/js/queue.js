/* THE RENDER QUEUE.
 *
 * A render takes minutes and the GPU does one at a time. The app already knew
 * that — it refuses to start a second — but the only thing you could do about
 * it was wait at the Deliver page with the clip you wanted to render second
 * still in your head.
 *
 * So: put it in the queue and keep working. Create can drop a clip in as soon
 * as it has built one, the canvas has a button next to Render, and Deliver is
 * where the queue is run, reordered and emptied.
 *
 * Two decisions worth stating:
 *
 *   A queued item is a SNAPSHOT, not a pointer. You queue what the project
 *   looks like now and then carry on editing it; what comes out of the queue is
 *   what you queued. Anything else makes "queue it and keep working" a lie.
 *
 *   The queue lives outside the project, in its own storage key. The whole
 *   point is to line up several DIFFERENT clips — a queue that belonged to one
 *   project could only ever hold seed variations of it, which the batch button
 *   already does.
 *
 * What a snapshot does NOT carry is the media itself. Pictures live in
 * IndexedDB by id and the snapshot references them, so deleting a picture from
 * the pool while its render is still queued leaves that item unable to run. It
 * fails with the file's name, the rest of the queue carries on, and the UI says
 * so up front.
 */

import { getProject, replaceProject } from "./state.js";
import { compilePrompt } from "./prompt.js";
import { renderNow } from "./render.js";
import { uid } from "./util.js";

const KEY = "mscut.queue.v1";
const MAX = 24;

const watchers = new Set();
export const onQueueChange = (fn) => { watchers.add(fn); return () => watchers.delete(fn); };
const emit = () => { for (const fn of watchers) { try { fn(read()); } catch (e) { console.error(e); } } };

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function write(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch { /* private mode, or full */ }
  emit();
}

export const listQueue = () => read();
export const queueLength = () => read().filter(i => i.status !== "done").length;

/* ── Running ──────────────────────────────────────────────── */
let running = false;
let currentId = null;
export const isQueueRunning = () => running;
export const runningId = () => currentId;

/** What the list shows about an item without opening it. */
function summarise(project) {
  let prompt = "";
  try { prompt = compilePrompt(project).description; } catch { /* a broken draft still queues */ }
  const shots = (project.shots || []).length;
  const [w, h] = String(project.render?.resolution || "").split("x");
  return {
    name: (project.name || "Untitled Timeline").trim(),
    mode: project.mode,
    shots,
    duration: project.render?.duration || 0,
    resolution: w && h ? `${w}×${h}` : "",
    variant: project.render?.variant || "",
    line: prompt.replace(/^\[Shot 1\]\s*/, "").slice(0, 120),
    media: (project.refs?.images?.length || 0) + (project.refs?.videos?.length || 0)
      + (project.refs?.audios?.length || 0) + (project.frames?.first ? 1 : 0),
  };
}

/**
 * Put the current project (or a given one) on the queue.
 * Returns the item, or null if the project has nothing to render.
 */
export function enqueue(project = getProject(), { label = "" } = {}) {
  const snapshot = JSON.parse(JSON.stringify(project));
  // The render history and the selection are not part of what to render, and
  // carrying them would grow every snapshot by everything that came before it.
  delete snapshot.jobs;
  delete snapshot.selectedShot;

  const item = {
    id: uid(),
    at: Date.now(),
    label: label.trim(),
    status: "waiting",          // waiting | running | done | error
    error: null,
    jobId: null,
    summary: summarise(snapshot),
    project: snapshot,
  };
  const list = read();
  if (list.length >= MAX) return null;
  write([...list, item]);
  return item;
}

export function removeFromQueue(id) {
  write(read().filter(i => i.id !== id));
}

export function clearQueue({ doneOnly = false } = {}) {
  write(doneOnly ? read().filter(i => i.status !== "done" && i.status !== "error") : []);
}

/** Move an item one place up (-1) or down (+1). */
export function moveInQueue(id, delta) {
  const list = read();
  const i = list.findIndex(x => x.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  write(list);
}

/** Put a queued snapshot back on the editor — for looking at, or fixing. */
export function openQueued(id) {
  const item = read().find(x => x.id === id);
  if (!item) return false;
  replaceProject(JSON.parse(JSON.stringify(item.project)), "load");
  return true;
}

function patch(id, fields) {
  const list = read();
  const item = list.find(x => x.id === id);
  if (!item) return;
  Object.assign(item, fields);
  write(list);
}

/**
 * Run everything still waiting, in order, one at a time.
 *
 * An item that fails does not stop the queue — a missing file or a ComfyUI
 * error on clip 2 is no reason not to render clips 3 and 4, and the failure is
 * kept on the item so it can be read afterwards.
 */
export async function runQueue({ onStep = () => {} } = {}) {
  if (running) throw new Error("The queue is already running.");
  running = true;
  emit();
  const results = { done: 0, failed: 0 };
  try {
    for (;;) {
      const list = read();
      const item = list.find(i => i.status === "waiting");
      if (!item) break;
      currentId = item.id;
      patch(item.id, { status: "running", error: null });
      const at = list.findIndex(i => i.id === item.id) + 1;
      onStep(`${at}/${list.length} — ${item.summary.name}`);
      try {
        const job = await renderNow({
          onStep: (m) => onStep(`${at}/${list.length} — ${item.summary.name}: ${m}`),
          project: item.project,
          // Uploaded filenames are written back into the SNAPSHOT, so running
          // the same item twice does not re-upload everything it references.
          commit: (fn) => { fn(item.project); patch(item.id, { project: item.project }); },
        });
        patch(item.id, { status: job?.status === "error" ? "error" : "done", jobId: job?.id || null, error: job?.error || null });
        if (job?.status === "error") results.failed++; else results.done++;
      } catch (err) {
        patch(item.id, { status: "error", error: err.message });
        results.failed++;
      }
      currentId = null;
    }
  } finally {
    running = false;
    currentId = null;
    emit();
  }
  return results;
}

/** Put a failed or finished item back in the line. */
export function requeue(id) {
  patch(id, { status: "waiting", error: null, jobId: null });
}
