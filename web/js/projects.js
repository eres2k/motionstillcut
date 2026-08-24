/* PROJECTS.
 *
 * The editor used to hold exactly one project, in localStorage. That is a
 * scratchpad, not a tool: you could not have two clips on the go, could not
 * come back to last week's, and clearing your browser data threw the lot away.
 *
 * Now it opens on a project manager, the way an NLE does. Projects live on the
 * server as one JSON file each, and their media goes with them — a project
 * whose pictures stayed behind in one browser's IndexedDB is not a project you
 * can open anywhere else, and calling that "saved" would be a lie.
 *
 * The autosave keeps working exactly as it did. What changed is what it saves
 * INTO: the open project's own file, rather than a single slot.
 */

import { api } from "./api.js";
import { getProject, replaceProject, blankProject } from "./state.js";
import { getBlob, putBlob } from "./media.js";
import { uid } from "./util.js";

const OPEN_KEY = "mscut.project.open";      // which project this browser has open

export const openProjectId = () => {
  try { return localStorage.getItem(OPEN_KEY) || null; } catch { return null; }
};
export const setOpenProjectId = (id) => {
  try { if (id) localStorage.setItem(OPEN_KEY, id); else localStorage.removeItem(OPEN_KEY); } catch { /* private mode */ }
};

/* Every media item a project references, whatever kind it is. */
function mediaOf(project) {
  return [
    project.frames?.first,
    ...(project.refs?.images || []),
    ...(project.refs?.videos || []),
    ...(project.refs?.audios || []),
  ].filter(m => m?.id);
}

export const listProjects = () => api.projects();

/**
 * Save the open project, media and all.
 *
 * Only the bytes the server does not already hold are sent — a project with
 * six references should not re-upload six pictures every time somebody renames
 * it. Media failures are reported but do not stop the project itself being
 * saved: a project whose thumbnails are missing is recoverable, a project that
 * did not save is not.
 */
export async function saveProject({ onStep = () => {} } = {}) {
  const project = getProject();
  const id = project.id || openProjectId() || uid();
  const items = mediaOf(project);
  let missed = 0;

  if (items.length) {
    onStep("Checking media…");
    let have = new Set();
    try {
      const r = await api.mediaHave(items.map(m => m.id));
      have = new Set(r.have || []);
    } catch { /* send everything rather than nothing */ }
    const pending = items.filter(m => !have.has(m.id));
    let n = 0;
    for (const m of pending) {
      onStep(`Saving ${m.name || "media"} (${++n}/${pending.length})…`);
      try {
        const data = await getBlob(m.id);
        if (!data) { missed++; continue; }
        await api.mediaPut(m.id, data);
      } catch { missed++; }
    }
  }

  onStep("Saving…");
  const r = await api.projectSave({ ...project, id });
  if (!r.ok) throw new Error(r.error || "The server would not save it.");
  setOpenProjectId(r.id);
  // The id belongs to the project from now on, so the next save updates the
  // same file rather than making another one.
  if (project.id !== r.id) replaceProject({ ...project, id: r.id }, "save");
  return { id: r.id, missed };
}

/**
 * Open a project by id, restoring any media this browser does not have.
 *
 * The restore is what makes a server-side project portable. Anything the
 * server has, the browser gets; anything it does not is reported by name
 * rather than silently rendering as a missing reference later.
 */
export async function openProject(id, { onStep = () => {} } = {}) {
  onStep("Loading…");
  const r = await api.projectGet(id);
  if (!r.ok || !r.project) throw new Error(r.error || "That project could not be read.");
  const project = r.project;

  const items = mediaOf(project);
  const missing = [];
  let n = 0;
  for (const m of items) {
    if (await getBlob(m.id)) continue;
    onStep(`Fetching ${m.name || "media"} (${++n}/${items.length})…`);
    try {
      const got = await api.mediaGet(m.id);
      if (got?.data) await putBlob(m.id, got.data);
      else missing.push(m.name || m.id);
    } catch { missing.push(m.name || m.id); }
  }

  replaceProject(project, "load");
  setOpenProjectId(id);
  return { project, missing };
}

/** Start a new one. Nothing is written until it is saved, which is why the
 *  manager offers to save the current project first. */
export function newProject(name = "Untitled Timeline", seed = null) {
  const p = { ...(seed ? JSON.parse(JSON.stringify(seed)) : blankProject()), id: uid(), name, createdAt: Date.now(), jobs: [] };
  replaceProject(p, "load");
  setOpenProjectId(p.id);
  return p;
}

export async function deleteProject(id) {
  const r = await api.projectDelete(id);
  if (!r.ok) throw new Error(r.error || "It would not delete.");
  if (openProjectId() === id) setOpenProjectId(null);
  return r;
}

export async function duplicateProject(id, name) {
  const r = await api.projectCopy(id, name);
  if (!r.ok) throw new Error(r.error || "It would not copy.");
  return r;
}
