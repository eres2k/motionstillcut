/* THE PROJECT MANAGER — where the app opens.
 *
 * Every NLE does this and it is not ceremony: it is the difference between a
 * tool that holds your work and a scratchpad that holds the last thing you
 * did. Before this, the app had exactly one project, in this browser's
 * localStorage, and "start something new" meant "overwrite what you had".
 *
 * The two things this page has to be honest about are on it, in words:
 * projects live on the server, and their media goes with them.
 */

import { h, mount, toast, modal, closeModal, timecode } from "../util.js";
import { getProject, MODES } from "../state.js";
import {
  listProjects, openProject, saveProject, newProject, deleteProject,
  duplicateProject, openProjectId,
} from "../projects.js";
import { STARTERS } from "../starters.js";
import { SERVER_BACKED } from "../api.js";
import { validate } from "../prompt.js";

let root = null;
let rows = null;            // null until the first load, so "empty" and "loading" differ
let error = "";
let busy = "";
let filter = "";

const when = (ms) => {
  if (!ms) return "";
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString();
};

async function reload() {
  try {
    const r = await listProjects();
    rows = r.rows || [];
    error = "";
  } catch (err) {
    rows = [];
    error = err.message;
  }
  draw();
}

/* ── Actions ──────────────────────────────────────────────── */

async function withBusy(label, fn) {
  busy = label;
  draw();
  try { await fn(); }
  catch (err) { toast("That did not work", err.message, "err"); }
  finally { busy = ""; draw(); }
}

/** Save what is open, if it is worth saving, before replacing it. */
async function guardUnsaved() {
  const p = getProject();
  if (validate(p).pristine) return true;
  const answer = await modal({
    title: "Save this project first?",
    body: h("div",
      h("div", `“${p.name || "Untitled Timeline"}” is open and has work in it.`),
      h("div.hint", { style: { marginTop: "8px" } },
        "Projects are saved on the server, media and all — so this is the copy you would come back to."),
    ),
    actions: [
      { label: "Cancel", onClick: (done) => done("cancel") },
      { label: "Don't save", onClick: (done) => done("skip") },
      { label: "Save", kind: "primary", onClick: (done) => done("save") },
    ],
  });
  if (answer === "cancel" || answer === null) return false;
  if (answer === "save") {
    await withBusy("Saving…", async () => {
      const r = await saveProject({ onStep: (m) => { busy = m; draw(); } });
      toast("Saved", r.missed ? `${r.missed} media file(s) could not be found in this browser.` : "On the server.", r.missed ? "warn" : "ok");
    });
  }
  return true;
}

function goEdit() {
  document.querySelector('.stepbtn[data-view="create"]')?.click();
}

async function doOpen(id) {
  if (!(await guardUnsaved())) return;
  await withBusy("Loading…", async () => {
    const r = await openProject(id, { onStep: (m) => { busy = m; draw(); } });
    if (r.missing.length) {
      toast("Opened, with media missing", `${r.missing.length} file(s) are not on the server: ${r.missing.slice(0, 3).join(", ")}`, "warn");
    } else {
      toast("Opened", r.project.name || "", "ok");
    }
    goEdit();
  });
}

async function doNew(starterKey) {
  if (!(await guardUnsaved())) return;
  const s = STARTERS.find(x => x.key === starterKey) || STARTERS[0];
  newProject(s.build().name, s.build());
  toast("New project", s.name, "ok");
  goEdit();
}

/* ── The page ─────────────────────────────────────────────── */

function starterCard(s) {
  return h("button.pm-starter", {
    title: s.blurb,
    onclick: () => doNew(s.key),
  },
    h("span.pm-starter-ico", s.icon),
    h("span.pm-starter-body",
      h("span.pm-starter-name", s.name),
      h("span.pm-starter-blurb", s.blurb),
    ),
  );
}

function projectRow(row) {
  const open = openProjectId() === row.id;
  if (row.broken) {
    return h("div.pm-row.broken",
      h("div.pm-main", h("div.pm-name", row.name), h("div.pm-meta", "This file will not parse. It is still on disk under data/projects.")),
    );
  }
  return h("div", { class: `pm-row${open ? " open" : ""}` },
    h("div.pm-main",
      h("div.pm-name", row.name, open ? h("span.badge.ok", { style: { marginLeft: "7px" } }, h("span.dot"), "open") : null),
      h("div.pm-meta",
        `${MODES[row.mode]?.short || row.mode} · ${row.duration}s · ${row.shots} shot${row.shots === 1 ? "" : "s"}`
        + `${row.references ? ` · ${row.references} reference${row.references === 1 ? "" : "s"}` : ""}`
        + `${row.renders ? ` · ${row.renders} render${row.renders === 1 ? "" : "s"}` : ""}`),
    ),
    h("div.pm-when", when(row.updatedAt)),
    h("div.pm-actions",
      h("button.btn.sm.primary", { onclick: () => doOpen(row.id) }, open ? "Reopen" : "Open"),
      h("button.btn.sm.ghost", {
        title: "Make a copy to experiment on",
        onclick: () => withBusy("Copying…", async () => { await duplicateProject(row.id); await reload(); toast("Copied", "", "ok"); }),
      }, "Copy"),
      h("button.btn.sm.ghost", {
        title: "Delete this project. The renders it made stay in the Library.",
        onclick: async () => {
          const yes = await modal({
            title: "Delete this project?",
            body: h("div",
              h("div", `“${row.name}” and everything in it.`),
              h("div.hint", { style: { marginTop: "8px" } },
                "The clips it rendered stay in the Library — this deletes the project, not the work it produced."),
            ),
            actions: [
              { label: "Cancel", onClick: (done) => done(false) },
              { label: "Delete", kind: "record", onClick: (done) => done(true) },
            ],
          });
          if (!yes) return;
          await withBusy("Deleting…", async () => { await deleteProject(row.id); await reload(); });
        },
      }, "✕"),
    ),
  );
}

function draw() {
  const p = getProject();
  const list = (rows || []).filter(r => !filter || (r.name || "").toLowerCase().includes(filter.toLowerCase()));

  mount(root, h("div.pm",
    h("div.pm-head",
      h("h1.pm-title", "Projects"),
      h("div.pm-sub", SERVER_BACKED
        ? "Saved on the local app, media and all — so a project is something you can come back to, and open somewhere else."
        : "Saved in this browser, media and all — so a project is something you can come back to. Setup has a one-click backup of everything."),
    ),

    h("div.pm-cols",
      h("div.pm-new",
        h("h4.sec", "Start something"),
        ...STARTERS.map(starterCard),
        h("div.hint", { style: { marginTop: "9px", lineHeight: "1.55" } },
          "The written ones render as they stand and pass the checker with no warnings. "
          + "Open one, change a line, and render it — reading a prompt already in H3's grammar teaches the format faster than the guide does."),
      ),

      h("div.pm-list",
        h("div.pm-listhead",
          h("h4.sec", { style: { margin: "0", flex: "1", border: "0", padding: "0" } },
            rows === null ? "Loading…" : `${list.length} project${list.length === 1 ? "" : "s"}`),
          h("input", {
            type: "search", placeholder: "Filter…", value: filter,
            oninput: (e) => { filter = e.target.value; draw(); },
          }),
          h("button.btn.sm", {
            title: "Save what is open now",
            class: `btn sm${busy ? " disabled" : ""}`,
            onclick: () => withBusy("Saving…", async () => {
              const r = await saveProject({ onStep: (m) => { busy = m; draw(); } });
              await reload();
              toast("Saved", r.missed ? `${r.missed} media file(s) could not be found in this browser.` : `“${getProject().name}” is on the server.`, r.missed ? "warn" : "ok");
            }),
          }, "Save open project"),
          h("button.btn.sm.ghost", { title: "Re-read the list", onclick: () => reload() }, "⟳"),
        ),
        busy ? h("div.note.info", busy) : null,
        error ? h("div.note.bad", `The server did not answer: ${error}`) : null,
        rows === null
          ? null
          : list.length
            ? h("div", ...list.map(projectRow))
            : h("div.hint", { style: { padding: "14px 2px" } },
                filter ? "Nothing matches that." : "No projects saved yet. Start one on the left, then Save."),
      ),
    ),

    h("div.pm-foot",
      h("span.hint",
        `Open: “${p.name || "Untitled Timeline"}”`,
        validate(p).pristine ? " — nothing written yet" : "",
      ),
      h("span.spacer", { style: { flex: "1" } }),
      h("button.btn.sm.ghost", { onclick: () => goEdit() }, "Back to the editor →"),
    ),
  ));
}

export function render(el) { root = el; draw(); reload(); }

/* Coming back to this page must re-read the server. The shell only calls
 * render() once and refresh() every time after, so a refresh that only redrew
 * showed yesterday's list: save a project, come back here, and it was not
 * there until you pressed the reload button. */
export function refresh() {
  if (!root) return;
  draw();
  if (root.classList.contains("active")) reload();
}
export { reload };
