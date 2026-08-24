/* THE DIRECTOR — the LLM as a collaborator, in whichever view you are in.
 *
 * This used to live inside the canvas, which meant Studio had no director at
 * all: the same project, edited on a different page, quietly lost its best
 * tool. So the whole thing moved here and BOTH views draw the same body. It is
 * one state, one plan, one apply — switch views mid-conversation and the plan
 * you have not accepted yet is still sitting there.
 *
 * The two views differ only in how you point it at a shot. On the canvas you
 * drag its node onto one, because that is what a graph is for. In Studio you
 * click a numbered chip, because that is what an inspector is for. Both write
 * the same `director.focus`.
 */

import { h, toast } from "./util.js";
import { getProject, orderedShots, normaliseMedia , onProjectSwap} from "./state.js";
import { direct, critique, nextTake, applyActions, describeAction } from "./agent.js";

/* Kept in the module rather than the project: a plan you have not accepted is
 * not part of your timeline, and it has no business on the undo stack or in a
 * saved file. */
export const director = {
  busy: false,
  request: "",
  reply: "",
  asks: [],
  plan: [],        // [{ name, args, why, spec, take: bool }]
  rejected: [],
  note: "",        // model + timing + what it looked at
  error: "",
  raw: "",         // what the model actually said, when it would not parse
  fix: "",
  // Which shot it has been narrowed to, if any. By default the director reads
  // the WHOLE clip.
  focus: null,     // shot id
};

/* The conversation belongs to the clip it was about.
 *
 * The whole object survived a project swap, including a `plan` of pre-ticked
 * actions — and those actions address shots by 1-based INDEX, not by id. So a
 * plan proposed for project A, left un-applied, sat there on project B with
 * its boxes already ticked, and Apply wrote A's subjects and beats into B's
 * shots by position. A busy request is left to finish; its reply lands on the
 * project it was asked about, which is why `focus` goes too. */
onProjectSwap(() => {
  if (director.busy) return;
  Object.assign(director, {
    request: "", reply: "", asks: [], plan: [], rejected: [],
    note: "", error: "", raw: "", fix: "", focus: null,
  });
});

/* Whoever drew the body last owns the repaint. Only one view is on screen at a
 * time, so a single slot is honest — and it means the module never has to know
 * whether it is inside a node or an inspector. */
let host = { refresh: () => {} };
const refresh = () => host.refresh();

export const focusedShot = (p) =>
  (director.focus ? orderedShots(p).findIndex(s => s.id === director.focus) : -1);

/** Narrow the director to one shot, or (with the same id, or null) let it read
 *  everything again. */
export function setFocus(shotId) {
  director.focus = director.focus === shotId ? null : shotId;
  refresh();
}

export async function runDirector(request, runner) {
  if (director.busy || !request?.trim()) return;
  director.busy = true;
  director.error = "";
  director.raw = "";
  director.fix = "";
  director.reply = "";
  director.plan = [];
  director.asks = [];
  director.rejected = [];
  refresh();
  try {
    const p = getProject();
    const fi = focusedShot(p);
    // A focus is a sentence in the request, not a different code path: the
    // model already reasons over the whole state, it just needs telling which
    // part of it the creator is pointing at.
    const scoped = fi >= 0
      ? `Work ONLY on shot ${fi + 1}. Leave every other shot exactly as it is.\n\n${request}`
      : request;
    const r = await (runner ? runner(p) : direct(scoped, { project: p }));
    director.reply = r.reply;
    director.asks = r.asks || [];
    director.rejected = r.rejected || [];
    // Everything the model proposed is ticked; clearing a box is how you
    // decline one part of a plan without declining the rest.
    director.plan = (r.actions || []).map(a => ({ ...a, take: true }));
    director.note = `${r.model}${r.sawImages ? ` · read ${r.sawImages} image${r.sawImages === 1 ? "" : "s"}` : ""} · ${(r.ms / 1000).toFixed(1)}s`;
    if (!r.actions?.length && !r.reply) director.error = "The model answered, but with nothing to do.";
  } catch (err) {
    director.error = err.message;
    // The reply itself, when there was one. Every diagnosis is a guess until
    // you can see what the model actually said.
    director.raw = err.raw || "";
    director.fix = err.fix || "";
  } finally {
    director.busy = false;
    refresh();
  }
}

export function applyPlan() {
  const take = director.plan.filter(a => a.take);
  if (!take.length) return;
  // The mode follows from what is attached, and it rides inside the plan's own
  // update — otherwise it lands as a second history entry and the first ⌘Z
  // takes back only the bookkeeping.
  applyActions(take, "director", (draft) => normaliseMedia(draft));
  toast("Applied", `${take.length} change${take.length === 1 ? "" : "s"} — ⌘Z takes all of it back`, "ok");
  director.plan = [];
  director.reply = "";
  refresh();
}

export const QUICK = [
  { label: "Check it", hint: "What will actually go wrong in this render", run: (p) => critique(p) },
  { label: "That didn't work", hint: "Diagnose the last render and change one thing", run: (p) => nextTake(p, p.jobs?.slice(-1)[0]?.verdict) },
  { label: "Make it stronger", hint: "Tighten the writing without changing the idea", run: null, ask: "Tighten this without changing what happens: sharper, more concrete beats, restrained wording, camera stated everywhere. Keep my subject and my setting." },
  { label: "Add the sound", hint: "Write the soundscape and score for what is on screen", run: null, ask: "Write the soundscape and the score for what is actually on screen. Do not repeat any dialogue in the soundscape." },
];

/** The badge a host puts on its header — how far along the conversation is. */
export function directorBadge() {
  if (director.busy) return "thinking…";
  if (!director.plan.length) return "ask";
  return `${director.plan.filter(a => a.take).length}/${director.plan.length}`;
}

function openSetup() {
  const seg = document.querySelector('#view-seg button[data-view="studio"]');
  if (seg && !seg.classList.contains("on")) {
    seg.click();
    setTimeout(() => document.querySelector('.page-btn[data-page="setup"]')?.click(), 60);
  } else {
    document.querySelector('.page-btn[data-page="setup"]')?.click();
  }
}

/**
 * The director, as a block of DOM.
 *
 * @param p        the project
 * @param opts.refresh   repaint the host
 * @param opts.chips     true to offer numbered scope chips (Studio); false to
 *                       say "drag this node onto a shot" (canvas)
 */
export function directorBody(p, opts = {}) {
  host = { refresh: opts.refresh || (() => {}) };
  const shots = orderedShots(p);
  // A focus whose shot has since been deleted is not a focus.
  if (director.focus && !shots.some(s => s.id === director.focus)) director.focus = null;

  const fi = focusedShot(p);
  const scope = fi >= 0 ? `Shot ${fi + 1}` : "the whole clip";

  const planRows = director.plan.map((a, i) => h("label.dr-act",
    h("input", {
      type: "checkbox", checked: a.take,
      onchange: (e) => { director.plan[i].take = e.target.checked; refresh(); },
    }),
    h("span.dr-act-body",
      h("span.dr-act-what", describeAction(a, p)),
      a.why ? h("span.dr-act-why", a.why) : null,
    ),
  ));
  const taking = director.plan.filter(a => a.take).length;

  return h("div.dr",
    /* The first question anyone asks of this is what it reads. Answer it up
     * front: nothing is required, and narrowing is optional. */
    opts.chips && shots.length > 1
      ? h("div.dr-pick",
          h("span.sn-pick-lb", "Reading"),
          h("div.dr-pick-row",
            h("button", {
              class: `sn-chip${fi >= 0 ? "" : " on"}`,
              title: "Read the whole clip",
              onclick: () => { director.focus = null; refresh(); },
            }, "All"),
            ...shots.slice(0, 8).map((sh, i) => h("button", {
              class: `sn-chip${director.focus === sh.id ? " on" : ""}`,
              title: `Work on shot ${i + 1} only`,
              onclick: () => { director.focus = director.focus === sh.id ? null : sh.id; refresh(); },
            }, String(i + 1))),
          ),
        )
      : h("div.dr-scope",
          h("span.dr-scope-lb", "Reading"),
          h("b", scope),
          fi >= 0
            ? h("button.dr-mini", { title: "Go back to reading everything", onclick: () => setFocus(director.focus) }, "all of it")
            : h("span.dr-scope-hint", "· drag this node onto a shot to narrow it"),
        ),

    h("textarea.dr-ask", {
      rows: 2, spellcheck: "false",
      placeholder: "Tell it what you want — “make her feel further away”, “why does it keep adding music?”, “give me a second shot on her hands”",
      value: director.request,
      oninput: (e) => { director.request = e.target.value; },
      onkeydown: (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runDirector(director.request); }
      },
    }),
    h("div.sn-row", { style: { marginTop: "6px" } },
      h("button.btn.sm.grow", {
        class: `btn sm grow${director.busy ? " disabled" : ""}`,
        onclick: () => runDirector(director.request),
      }, director.busy ? "thinking…" : "Ask ⌘⏎"),
    ),
    h("div.dr-quick",
      ...QUICK.map(q => h("button.dr-chip", {
        title: q.hint,
        class: `dr-chip${director.busy ? " disabled" : ""}`,
        onclick: () => runDirector(q.ask || q.label, q.run || null),
      }, q.label)),
    ),
    director.error ? h("div.dr-err",
      h("div", director.error),
      director.fix === "thinking" || director.fix === "maxTokens"
        ? h("button.dr-mini", { style: { marginTop: "6px" }, title: "Open the LLM settings", onclick: openSetup }, "Open Setup")
        : null,
      director.raw
        ? h("details", { style: { marginTop: "6px" } },
            h("summary", "what the model actually said"),
            h("pre.code", { style: { maxHeight: "160px", overflow: "auto", marginTop: "5px" } },
              director.raw.slice(0, 1200)))
        : null,
    ) : null,
    director.reply ? h("div.dr-reply", director.reply) : null,
    director.asks.length ? h("div.dr-asks",
      h("div.dr-asks-hd", "It needs to know:"),
      ...director.asks.map(q => h("div.dr-askrow",
        h("span.grow", q),
        h("button.dr-mini", {
          title: "Answer this one",
          onclick: () => {
            director.request = `${q}\n`;
            refresh();
            document.querySelector(".page.active .dr-ask, .sn-node .dr-ask")?.focus();
          },
        }, "answer"),
      )),
    ) : null,
    planRows.length ? h("div.dr-plan",
      h("div.dr-plan-hd", `It wants to make ${planRows.length} change${planRows.length === 1 ? "" : "s"} — clear anything you don't want:`),
      h("div.dr-plan-list", ...planRows),
      h("div.sn-row", { style: { marginTop: "7px" } },
        h("button.btn.sm.record.grow", {
          class: `btn sm record grow${taking ? "" : " disabled"}`,
          onclick: () => applyPlan(),
        }, taking ? `Apply ${taking}` : "Nothing ticked"),
        h("button.btn.sm", { onclick: () => { director.plan = []; refresh(); } }, "Discard"),
      ),
    ) : null,
    director.rejected.length ? h("details.dr-drop",
      h("summary", `${director.rejected.length} suggestion${director.rejected.length === 1 ? "" : "s"} dropped`),
      ...director.rejected.map(r => h("div.dr-droprow", h("b", r.name), ` — ${r.why}`)),
    ) : null,
    director.note && !director.busy ? h("div.dr-note", director.note) : null,
  );
}
