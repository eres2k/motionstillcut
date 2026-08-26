/* MOTIONSTILL CUT — the front of house.
 *
 * Not an editor. A creator arrives with a line of text, a photo, maybe a sound,
 * and an idea they cannot yet say precisely. Three moves:
 *
 *   MATERIAL   drop what you have; the app reads it and proposes a first pass
 *   STEER      answer a few questions, move seven dials in your own language
 *   TAKES      two renders, side by side, because one clip from H3 is a sample
 *
 * The timeline, the inspector and the compiler are all still here — underneath,
 * where they belong. Nothing on this page mentions amplitude, sigma shift or a
 * node graph, and everything on it writes them.
 */

import {
  h, mount, clear, toast, timecode, clamp, debounce, modal, copyText, download,
  segmented,
} from "../util.js";
import {
  getProject, update, orderedShots, shotActionText, newShot, newBeat,
  DURATION_FRAMES, dimensions, MODES, referenceInventory, normaliseMedia, H3_DURATION, overLength,
  clearShotWriting,
 onProjectSwap, activeEngine, setEngine, durationFrames, LTX25_DURATION } from "../state.js";
import { ingest, getBlob, delBlob, posterFor, kindOf } from "../media.js";
import { queueLength } from "../queue.js";
import { DIALS, DEFAULT_DIALS, applySteering, explainDials } from "../steer.js";
import { readMaterial, moreBeats, baseQuestions } from "../interview.js";
import { compilePrompt, validate } from "../prompt.js";
import { renderPrompt } from "../prompttext.js";
import { citeLooseReferences } from "./simple.js";
import { createPreviz } from "../previz.js";
import { estimateSeconds, humanTime } from "../workflow.js";
import { renderNow, currentJob, onRenderChange, cancelRender, applyLive } from "../render.js";
import { library } from "../library.js";
import { api } from "../api.js";
import { getHealth } from "../config.js";

let root = null;
let unsub = null;
let busy = false;
let previz = null;
let previzBg = null;
let takeState = { running: false, step: "", jobs: [] };

/* The pair of takes belongs to the project that rendered them. Create prefers
 * this over the project's own jobs when drawing the handoff stage, so a fresh
 * project showed the previous one's two videos as if it had made them. A run
 * still in flight is left alone — it finishes where it started. */
onProjectSwap(() => {
  if (takeState.running) return;
  takeState = { running: false, step: "", jobs: [] };
});

const creative = (p) => p.creative || {};
const stage = (p) => creative(p).stage || "material";

function setStage(next) {
  if (previz) { previz.destroy(); previz = null; }
  update((draft) => { draft.creative.stage = next; }, "creative");
  draw();
}

/* ── Stage 1 · Material ───────────────────────────────────── */
async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const added = [];
  for (const file of files) {
    try {
      const item = await ingest(file);
      if (item.kind === "video") item.poster = await posterFor(await getBlob(item.id));
      added.push(item);
    } catch (err) { toast("Could not read that", `${file.name}: ${err.message}`, "err"); }
  }
  update((p) => {
    for (const item of added) {
      if (item.kind === "audio") { if ((p.refs.audios || []).length < 3) p.refs.audios.push(item); }
      else if (item.kind === "video") { if ((p.refs.videos || []).length < 3) p.refs.videos.push(item); }
      else if (!p.frames.first) p.frames.first = item;
      else if ((p.refs.images || []).length < 9) p.refs.images.push(item);
    }
    // The mode is a consequence of what was dropped, never a question.
    const refs = (p.refs.images || []).length + (p.refs.videos || []).length + (p.refs.audios || []).length;
    normaliseMedia(p);
    if (p.mode === "r2v" && p.frames.first) {
      const first = p.frames.first;
      p.frames.first = null;
      if ((p.refs.images || []).length < 9) p.refs.images.unshift(first);
    }
  }, "media");
  draw();
}

function materialTiles(p) {
  const items = [
    ...(p.frames?.first ? [{ ...p.frames.first, role: "opening frame" }] : []),
    ...(p.refs?.images || []).map(m => ({ ...m, role: "reference" })),
    ...(p.refs?.videos || []).map(m => ({ ...m, role: "clip" })),
    ...(p.refs?.audios || []).map(m => ({ ...m, role: "sound" })),
  ];
  if (!items.length) return null;

  return h("div.cr-material",
    ...items.map((m) => {
      const tile = h("div.cr-chip-media", { title: m.name },
        h("div.cr-chip-thumb", m.kind === "audio" ? "♪" : m.kind === "video" ? "▶" : "▣"),
        h("div.grow", h("div.bright", (m.label || m.name).slice(0, 26)), h("div.hint", m.role)),
        h("button.btn.ghost.sm", {
          title: "Remove",
          onclick: () => {
            update((draft) => {
              if (draft.frames.first?.id === m.id) draft.frames.first = null;
              for (const bin of ["images", "videos", "audios"]) {
                draft.refs[bin] = (draft.refs[bin] || []).filter(x => x.id !== m.id);
              }
              const refs = (draft.refs.images || []).length + (draft.refs.videos || []).length + (draft.refs.audios || []).length;
              normaliseMedia(draft);
            }, "media");
            delBlob(m.id);
            draw();
          },
        }, "✕"),
      );
      if (m.kind === "image" || m.poster) {
        getBlob(m.id).then((data) => {
          const src = m.kind === "image" ? data : m.poster;
          const el = tile.querySelector(".cr-chip-thumb");
          if (src && el) { el.style.backgroundImage = `url("${src}")`; el.textContent = ""; }
        });
      }
      return tile;
    }),
  );
}

function materialStage(p) {
  const text = creative(p).material?.text || "";
  const health = getHealth();
  const canRead = health.llm?.ok;

  const input = h("input", { type: "file", multiple: "", style: { display: "none" },
    accept: "image/*,video/*,audio/*",
    onchange: (e) => { addFiles(e.target.files); e.target.value = ""; } });

  return h("div.cr-stage",
    h("div.cr-hero",
      h("h2.cr-h", "What are you making?"),
      h("p.cr-sub", "A line is enough. Drop a picture or a sound if you have one — they steer this model harder than words do."),
    ),

    h("textarea.cr-idea", {
      rows: 4, spellcheck: "false", value: text,
      placeholder: "she leaves the café without saying anything, and it's raining",
      oninput: (e) => update((draft) => { draft.creative.material.text = e.target.value; }, "text"),
    }),

    h("div.cr-drop", {
      onclick: () => input.click(),
      ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add("over"); },
      ondragleave: (e) => e.currentTarget.classList.remove("over"),
      ondrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove("over"); addFiles(e.dataTransfer.files); },
    },
      input,
      h("div.cr-drop-row",
        h("span.cr-drop-ico", "▣"), h("span", "a picture"),
        h("span.cr-drop-ico", "▶"), h("span", "a clip"),
        h("span.cr-drop-ico", "♪"), h("span", "a sound"),
      ),
      h("div.hint", "Drop them here, or click to browse. What you drop decides the mode."),
    ),

    materialTiles(p),

    /* The model is a real authoring choice now, not a render setting: the
     * two read different prompts — MiniMax its [Shot N] grammar, LTX-2.5 one
     * paragraph with the cuts in prose — and they disagree about how long a
     * clip may be. So it is asked here, before anything is written for it.
     * Ref2V is MiniMax-only and the row says so instead of pretending. */
    h("div.cr-row",
      h("span.cr-label", "Which model?"),
      p.mode === "r2v"
        ? h("span.hint", "Reference-to-video renders on MiniMax H3 — LTX-2.5 has no reference pipeline.")
        : segmented([
            ["minimax", "MiniMax H3", `Native engine · ${H3_DURATION.min}–${H3_DURATION.max} s · dialogue, [Shot N] cuts with timestamps`],
            ["ltx25", "LTX-2.5", `Experimental · ${LTX25_DURATION.min}–${LTX25_DURATION.max} s · cuts in prose, timeline pins, one render per cut`],
          ], activeEngine(p), (v) => { setEngine(v); draw(); }),
      h("span.hint", activeEngine(p) === "ltx25"
        ? "Up to 30 s, cuts written the way Lightricks' guide asks, keyframe pins on the timeline. Switchable later from the title bar."
        : "The native model: 4–15 s, the [Shot N] grammar its guide specifies, native dialogue. Switchable later from the title bar."),
    ),

    /* How many shots. Auto lets Pace decide, or the cuts the writer wrote;
     * a number is exact — the interview writes that many "Cut to" beats and
     * steering makes that many shots. Ref2V and I2V follow the same rule. */
    h("div.cr-row",
      h("span.cr-label", "How many shots?"),
      segmented([["0", "Auto", "Pace decides — or the cuts written into the beats"], ...[1, 2, 3, 4, 5, 6].map(n => [String(n), String(n), `Exactly ${n} shot${n === 1 ? "" : "s"}`])],
        String(Number(creative(p).shotCount) || 0),
        (v) => { update((draft) => { draft.creative.shotCount = Number(v) || 0; if ((draft.shots || []).some(s => (s.subject || "").trim())) applySteering(draft); }, "creative"); draw(); }),
      h("span.hint", (Number(creative(p).shotCount) || 0)
        ? `${creative(p).shotCount} shot${creative(p).shotCount === 1 ? "" : "s"}, each with its own Cut. Fewer than you already have keeps what you have — remove a shot with its own ✕.`
        : "Auto: the Pace dial picks a count — and a beat written as \"Cut to close-up, …\" always starts a new shot, whatever the dial says."),
    ),

    h("div.cr-row",
      h("span.cr-label", "How long?"),
      h("div.seg",
        ...Object.keys(durationFrames(p)).map(d => h("button", {
          class: `${String(p.render.duration) === d ? "on" : ""}${overLength(d) ? " over" : ""}`,
          title: overLength(d, p) ? `Past H3's ${H3_DURATION.max}s ceiling — the clip repeats` : "",
          onclick: () => { update((draft) => { draft.render.duration = Number(d); }, "render"); draw(); },
        }, `${d}s`)),
      ),
    ),
    /* This used to read "past about 15 seconds H3 holds together better with
     * cuts — the pace dial will add them", which is the front door telling a
     * first-time user to solve a model limit with prompt syntax. Cuts do not
     * extend the generation window. MiniMax's card gives the output duration
     * as 4–15 seconds and the node renders longer without complaining, so the
     * extra time comes back as a repeat. */
    overLength(p.render.duration)
      ? h("div.note.warn", { style: { marginTop: "-4px" } },
          h("b", `H3 renders up to ${H3_DURATION.max} seconds. `),
          `A ${p.render.duration}s clip is past that: the model has nothing trained beyond it and repeats itself to fill the last ${p.render.duration - H3_DURATION.max}s. Cuts do not help — a shot list is prompt syntax, not a longer window. For something longer, render it as separate clips and join them.`)
      : null,

    h("div.cr-actions",
      h("button.cr-go", {
        class: busy ? "disabled" : "",
        onclick: (e) => runRead(e.currentTarget, p),
      }, busy ? "reading…" : canRead ? "Read my material →" : "Start steering →"),
      canRead ? null : h("div.hint", { style: { marginTop: "8px" } },
        "No LLM connected, so this goes straight to the dials — Studio ▸ Setup connects one and it will read your material first."),
    ),
  );
}

async function runRead(btn, p) {
  if (busy) return;
  const health = getHealth();
  const material = creative(p).material?.text || "";
  const hasMedia = !!p.frames?.first || (p.refs?.images || []).length || (p.refs?.videos || []).length || (p.refs?.audios || []).length;

  if (!material.trim() && !hasMedia) {
    toast("Nothing to read yet", "Write a line, or drop a picture.", "warn");
    return;
  }

  if (!health.llm?.ok) {
    /* No LLM, so nothing was read — and a clear is only ever right when
     * something REPLACES what it wipes. Blanking the shots here and then
     * writing four empty answers back over them destroyed whatever was
     * already written, which on a starter is the entire starter. Without a
     * model this button only moves the user to the steering stage. */
    update((draft) => {
      draft.creative.answers = { subject: "", setting: "", beats: [], speech: "" };
      draft.creative.stage = "steer";
      applySteering(draft);
    }, "creative");
    draw();
    return;
  }

  busy = true; draw();
  try {
    const proposal = await readMaterial(p);
    update((draft) => {
      draft.creative.proposal = proposal;
      draft.creative.answers = {
        subject: proposal.subject,
        setting: proposal.setting,
        beats: proposal.beats,
        speech: proposal.speaks ? proposal.line : "",
        extra: {},
      };
      draft.creative.dials = { ...DEFAULT_DIALS, ...proposal.dials };
      draft.creative.pool = { beats: proposal.beats };
      draft.creative.stage = "steer";
      writeAnswers(draft, { fresh: true });
      applySteering(draft);
    }, "creative");
    toast("Read it — new shot list",
      `${proposal.model}${proposal.sawImages ? ` · looked at ${proposal.sawImages} image${proposal.sawImages === 1 ? "" : "s"}` : ""}`
      + ". Written from this material only; ⌘Z puts the previous one back.", "ok");
  } catch (err) {
    toast("Could not read the material", err.message, "err");
    update((draft) => { draft.creative.stage = "steer"; applySteering(draft); }, "creative");
  } finally {
    busy = false;
    draw();
  }
}

/** The interview's answers, written into the shot list the compiler reads. */
/**
 * The interview's answers, written into the shot list the compiler reads.
 *
 * `fresh` means the answers came from reading NEW material, in which case the
 * shot list is rebuilt rather than merged into. Everything in this app merges
 * with `||` — which is correct while one idea is being re-steered and wrong
 * the moment the idea itself is replaced, because every field the new answers
 * do not mention silently keeps the previous scene's words. That is how a
 * Spartan warrior ended up standing in a Soviet warehouse in somebody's shot
 * list. Reading material is the one gesture that means "this is a different
 * clip now", so it is the one place the writing is cleared.
 *
 * The clip's own settings, its media and the cast are untouched, and the whole
 * thing is one undo step.
 */
function writeAnswers(draft, { fresh = false } = {}) {
  const a = draft.creative.answers || {};
  if (fresh) for (const shot of (draft.shots || [])) clearShotWriting(shot);
  const shots = orderedShots(draft);
  const first = shots[0] || newShot(0);
  for (const shot of (draft.shots?.length ? draft.shots : [first])) {
    shot.subject = a.subject || shot.subject;
    shot.setting = a.setting || shot.setting;
  }
  if (!draft.shots?.length) draft.shots = [first];
  if (a.speech?.trim()) {
    const target = draft.shots[0];
    target.dialogue = [{
      id: (target.dialogue?.[0]?.id) || `d-${Math.random().toString(36).slice(2, 8)}`,
      speaker: "S1", language: "English", text: a.speech.trim(), voiceover: false, note: "",
    }];
  } else {
    for (const shot of draft.shots) shot.dialogue = [];
  }
}

/* ── Stage 2 · Steer ──────────────────────────────────────── */
function strength(p) {
  const a = creative(p).answers || {};
  const hasRefs = p.mode === "r2v" || !!p.frames?.first;
  const items = [
    { id: "subject", label: "who we're watching", ok: !!(a.subject || "").trim() },
    { id: "beats", label: "what happens", ok: (a.beats || []).some(b => (b || "").trim()) },
    { id: "setting", label: "where it is", ok: !!(a.setting || "").trim() },
    { id: "camera", label: "what the camera does", ok: true },
    { id: "light", label: "the light", ok: true },
    { id: "sound", label: "the sound", ok: true },
    ...(hasRefs ? [{ id: "refs", label: "what the pictures are for", ok: true }] : []),
  ];
  const done = items.filter(i => i.ok).length;
  return { items, done, total: items.length, pct: Math.round((done / items.length) * 100) };
}

function questionCards(p) {
  const a = creative(p).answers || {};
  const proposal = creative(p).proposal;
  const questions = baseQuestions(p, proposal);
  const cards = [];

  const setAnswer = (id, value, reason = "text") => {
    update((draft) => {
      draft.creative.answers = { ...(draft.creative.answers || {}), [id]: value };
      if (id === "beats") draft.creative.pool = { beats: value };
      writeAnswers(draft);
      applySteering(draft);
    }, reason);
  };

  for (const q of questions) {
    if (q.kind === "text") {
      cards.push(card(q, h("input", {
        type: "text", value: a[q.id] || "", placeholder: q.placeholder,
        oninput: (e) => setAnswer(q.id, e.target.value),
        onchange: () => draw(),
      })));
    } else if (q.kind === "beats") {
      const beats = a.beats || [];
      cards.push(card(q, h("div",
        ...beats.map((text, i) => h("div.cr-beat",
          h("span.cr-beat-n", String(i + 1)),
          h("input", {
            type: "text", value: text, placeholder: "and then…",
            oninput: (e) => { const next = [...beats]; next[i] = e.target.value; setAnswer("beats", next); },
            onchange: () => draw(),
          }),
          h("button.btn.ghost.sm", {
            title: "Remove", onclick: () => { setAnswer("beats", beats.filter((_, x) => x !== i)); draw(); },
          }, "✕"),
        )),
        h("div.btn-row", { style: { marginTop: "6px" } },
          h("button.btn.sm", { onclick: () => { setAnswer("beats", [...beats, ""]); draw(); } }, "＋ Beat"),
          getHealth().llm?.ok ? h("button.btn.sm.ai", {
            onclick: async (e) => {
              const btn = e.currentTarget;
              btn.classList.add("disabled"); btn.textContent = "thinking…";
              try {
                const next = await moreBeats(p, beats.filter(Boolean), beats.length + 2);
                setAnswer("beats", next);
                draw();
              } catch (err) { toast("Could not add beats", err.message, "err"); }
              finally { btn.classList.remove("disabled"); btn.textContent = "✨ Suggest more"; }
            },
          }, "✨ Suggest more") : null,
        ),
      )));
    } else if (q.kind === "speech") {
      const speaking = !!(a.speech || "").trim();
      cards.push(card(q, h("div",
        h("div.seg", { style: { marginBottom: speaking ? "8px" : "0" } },
          h("button", { class: speaking ? "" : "on", onclick: () => { setAnswer("speech", ""); draw(); } }, "No one speaks"),
          h("button", { class: speaking ? "on" : "", onclick: () => { setAnswer("speech", a.speech || proposal?.line || "…"); draw(); } }, "Someone does"),
        ),
        speaking ? h("input", {
          type: "text", value: a.speech, placeholder: "the exact words",
          oninput: (e) => setAnswer("speech", e.target.value),
          onchange: () => draw(),
        }) : null,
      )));
    }
  }

  // Anything the model thought was still undecided.
  for (const q of proposal?.questions || []) {
    const chosen = a.extra?.[q.id];
    cards.push(card({ ...q, why: "The model thought this was still open." }, h("div.flex.wrap",
      ...q.options.map(opt => h("span", {
        class: `chip${chosen === opt ? " on" : ""}`,
        onclick: () => {
          update((draft) => {
            const extra = { ...(draft.creative.answers.extra || {}) };
            extra[q.id] = chosen === opt ? "" : opt;
            draft.creative.answers = { ...draft.creative.answers, extra };
            // An answer to a free question becomes part of the first shot's detail.
            const detail = Object.values(extra).filter(Boolean).join("; ");
            const first = orderedShots(draft)[0];
            if (first) first.details = detail;
          }, "creative");
          draw();
        },
      }, opt)),
    )));
  }
  return cards;
}

function card(q, control) {
  const help = q.why ? h("div.cr-why", { style: { display: "none" } }, q.why) : null;
  return h("div.cr-card",
    h("div.cr-ask",
      h("span.grow", q.ask),
      q.why ? h("button.g-help-btn", {
        onclick: (e) => {
          const shown = help.style.display !== "none";
          help.style.display = shown ? "none" : "block";
          e.currentTarget.classList.toggle("on", !shown);
        },
      }, "?") : null,
    ),
    help,
    h("div.cr-ctl", control),
  );
}

function dialRail(p) {
  const dials = { ...DEFAULT_DIALS, ...(creative(p).dials || {}) };
  const hasRefs = p.mode === "r2v" || !!p.frames?.first;
  const explain = Object.fromEntries(explainDials(p).map(e => [e.id, e]));

  const setDial = debounce((id, value) => {
    update((draft) => {
      draft.creative.dials = { ...draft.creative.dials, [id]: value };
      applySteering(draft);
    }, "creative");
    draw();
  }, 80);

  return h("div.cr-dials",
    ...DIALS.filter(d => !d.needsRefs || hasRefs).map(d => h("div.cr-dial",
      h("div.cr-dial-hd",
        h("span.cr-dial-ico", d.icon),
        h("span.grow", d.label),
        h("span", { class: explain[d.id]?.warn ? "hint warn" : "hint" }, explain[d.id]?.text || ""),
      ),
      explain[d.id]?.suggestDuration ? h("button.btn.sm", {
        style: { marginBottom: "6px" },
        title: "Nothing is deleted — the clip just gets long enough for what you wrote",
        onclick: () => {
          update((draft) => { draft.render.duration = explain[d.id].suggestDuration; applySteering(draft); }, "render");
          draw();
        },
      }, `Make it ${explain[d.id].suggestDuration}s`) : null,
      h("input", {
        type: "range", min: "0", max: "100", value: String(dials[d.id]),
        oninput: (e) => setDial(d.id, Number(e.target.value)),
        title: d.hint,
      }),
      h("div.cr-dial-ends", h("span", d.low), h("span", d.high)),
    )),
  );
}

function previzPane(p) {
  const pane = h("div.cr-previz");
  const plate = p.mode === "i2v" ? p.frames?.first : (p.refs?.images || [])[0];
  if (plate && previzBg?.id !== plate.id) {
    getBlob(plate.id).then((data) => { if (data) { previzBg = { id: plate.id, data }; draw(); } });
  }
  if (previz) previz.destroy();
  previz = createPreviz(p, {
    startAt: 0,
    backgroundFor: () => (plate && previzBg?.id === plate.id ? previzBg.data : null),
  });
  pane.appendChild(previz.el);
  previz.play();
  return pane;
}

function steerStage(p) {
  const s = strength(p);
  const missing = s.items.find(i => !i.ok);
  const compiled = compilePrompt(p);

  return h("div.cr-steer",
    h("div.cr-col-main",
      h("div.cr-hero.small",
        h("h2.cr-h", "Let's get it specific"),
        h("p.cr-sub", "The model rewards concrete, observable detail. These are the few answers that change the result most."),
      ),
      ...questionCards(p),

      h("details.cr-brief",
        h("summary", "What the model will actually read"),
        h("pre.code", renderPrompt(compiled.text, p)),
        h("div.btn-row", { style: { marginTop: "8px" } },
          h("button.btn.sm", { onclick: async () => { await copyText(compiled.text); toast("Copied", "", "ok"); } }, "Copy"),
          h("button.btn.sm.ghost", {
            onclick: () => document.querySelector('#view-seg button[data-view="studio"]')?.click(),
          }, "Open it in the studio →"),
        ),
      ),

      h("div.cr-actions",
        /* Create's job is to hand you a canvas, not to render. Everything it
         * has worked out — the shots, the steering, the sound, the mode — is
         * already the project, so "build" is really "go and look at it". */
        h("button.cr-go", { onclick: () => buildCanvas() }, "Build the canvas →"),
        h("button.btn.ghost", {
          style: { marginLeft: "10px" },
          title: "Skip the canvas and render two takes now",
          onclick: () => startTakes(p),
        }, `or render two takes · ~${humanTime(estimateSeconds(p) * 2)}`),
        h("button.btn.ghost", { style: { marginLeft: "10px" }, onclick: () => setStage("material") }, "← material"),
      ),
    ),

    h("div.cr-col-side",
      previzPane(p),
      h("div.cr-strength",
        h("div.flex", h("span.grow", "How much the model has to go on"), h("span.mono", `${s.pct}%`)),
        h("div.meter", { class: `meter ${s.pct > 80 ? "good" : s.pct > 55 ? "warn" : "bad"}` }, h("i", { style: { width: `${s.pct}%` } })),
        missing ? h("div.hint", { style: { marginTop: "5px" } }, `Still missing: ${missing.label}.`)
          : h("div.hint", { style: { marginTop: "5px" } }, "Everything H3 needs is specified."),
      ),
      dialRail(p),
    ),
  );
}

/* ── Stage 3 · Takes ──────────────────────────────────────── */
/**
 * Hand the finished setup to the canvas.
 *
 * Nothing is copied or converted: Create has been writing the ordinary project
 * all along, so this lays the graph out fresh (any node positions from an
 * earlier session would describe shots that no longer exist) and switches
 * views. From here the canvas is where the work happens and the studio is
 * where the details are.
 */
function buildCanvas() {
  const p = getProject();
  const shots = orderedShots(p);
  let wired = 0;
  update((draft) => {
    draft.creative.stage = "canvas";
    // A fresh arrangement for a fresh shot list.
    draft.simple = { pos: {} };
    /* Never hand over a graph with a dead reference. H3 ignores a picture the
     * prompt does not cite, so an attached-but-unnamed one is not a loose end
     * to tidy later — it does nothing at all, silently. The model is asked to
     * cite the tags itself; this is the safety net for when it doesn't. */
    wired = citeLooseReferences(draft);
  }, "creative");
  document.querySelector('#view-seg button[data-view="simple"]')?.click();
  toast("On the canvas",
    `${shots.length} shot${shots.length === 1 ? "" : "s"} · ${MODES[getProject().mode].label} · ${p.render.duration}s`
    + (wired ? ` — ${wired} picture${wired === 1 ? "" : "s"} wired into shot 1 so the model actually uses ${wired === 1 ? "it" : "them"}.` : "."),
    "ok");
}



async function startTakes(p) {
  if (takeState.running) return;
  const health = getHealth();
  if (!health.comfy?.ok) {
    const go = await modal({
      title: "ComfyUI isn't connected",
      body: h("div",
        h("div.note.warn", { style: { marginTop: 0 } }, "Nothing can render without it — but the workflow is ready, and you can take it to a machine that has one."),
        h("div.hint", "Studio ▸ Setup connects a ComfyUI in about ten seconds if one is running."),
      ),
      actions: [
        { label: "Download the workflow", onClick: (d) => d("json") },
        { label: "Open Setup", kind: "primary", onClick: (d) => d("setup") },
      ],
    });
    if (go === "json") {
      const { buildWorkflow } = await import("../workflow.js");
      const { getSettings } = await import("../config.js");
      const { prompt } = buildWorkflow(getProject(), getSettings() || { models: {} });
      download(`${(p.name || "clip").replace(/[^\w-]+/g, "_")}.json`, JSON.stringify(prompt, null, 2));
    } else if (go === "setup") {
      document.querySelector('#view-seg button[data-view="studio"]')?.click();
      setTimeout(() => document.querySelector('.page-btn[data-page="setup"]')?.click(), 100);
    }
    return;
  }

  setStage("takes");
  takeState = { running: true, step: "starting", jobs: [] };
  draw();

  const experimentId = `takes-${Date.now().toString(36)}`;
  try {
    for (let i = 0; i < 2; i++) {
      // Two takes, two seeds. H3's seed-to-seed variance is wide enough that
      // one clip is a sample rather than a result, and learning that from the
      // app is better than learning it from a bad afternoon.
      update((draft) => { draft.render.seed = Math.floor(Math.random() * 0xffffffffff); }, "render");
      takeState.step = `take ${i + 1} of 2`;
      draw();
      const job = await renderNow({
        onStep: (m) => { takeState.step = `take ${i + 1} of 2 — ${m}`; draw(); },
        experimentId, variantLabel: `take ${i + 1}`,
      });
      takeState.jobs = [...takeState.jobs, { ...job }];
      draw();
    }
    toast("Two takes ready", "Keep the one that works — or change one thing and go again.", "ok");
  } catch (err) {
    if (err.message !== "cancelled") toast("Render failed", err.message, "err");
  } finally {
    takeState.running = false;
    draw();
  }
}

function takeCard(job, index) {
  const url = job?.outputs?.[0] ? api.viewUrl(job.outputs[0]) : null;
  return h("div.cr-take",
    h("div.cr-take-hd", h("span.tag", `take ${index + 1}`), h("span.hint.grow", job?.meta?.seed ? `seed ${job.meta.seed}` : ""),
      job?.error ? h("span.badge.bad", h("span.dot"), "failed") : null),
    url
      ? h("video", { src: url, controls: "", loop: "", playsinline: "", autoplay: "" })
      : h("div.cr-take-empty", job?.error ? job.error : "rendering…"),
    url ? h("div.btn-row", { style: { marginTop: "8px" } },
      h("button.btn.sm.primary", {
        title: "Rate it five and keep it in the library",
        onclick: async () => {
          try {
            if (job.libraryId) await library.patch(job.libraryId, { verdict: { rating: 5, tags: ["good-take"], note: "" } });
            toast("Kept", "It is in the library at five stars.", "ok");
          } catch (err) { toast("Could not save that", err.message, "err"); }
        },
      }, "★ Keep this one"),
      h("button.btn.sm", {
        title: "Same everything, another draw",
        onclick: () => startTakes(getProject()),
      }, "↻ Two more"),
      h("button.btn.sm.ghost", { onclick: () => window.open(url, "_blank") }, "Open ↗"),
    ) : null,
  );
}

function takesStage(p) {
  const jobs = takeState.jobs.length ? takeState.jobs : (p.jobs || []).slice(0, 2);
  return h("div.cr-stage",
    h("div.cr-hero.small",
      h("h2.cr-h", takeState.running ? "Rendering two takes" : "Two takes"),
      h("p.cr-sub", takeState.running
        ? takeState.step
        : "One clip from this model is a sample, not a result. Keep what works, then change one thing."),
    ),
    takeState.running ? h("div.progress.indet", h("i"), h("span", takeState.step)) : null,
    h("div.cr-takes", ...jobs.map(takeCard), ...(takeState.running && jobs.length < 2 ? [h("div.cr-take", h("div.cr-take-empty", "…"))] : [])),
    h("div.cr-actions",
      h("button.btn.lg", { onclick: () => setStage("steer") }, "← Steer it again"),
      takeState.running
        ? h("button.btn.lg", { style: { marginLeft: "10px" }, onclick: async () => { await cancelRender(); takeState.running = false; draw(); } }, "■ Stop")
        : h("button.btn.lg", {
            style: { marginLeft: "10px" },
            title: "Change one thing and render the set",
            onclick: () => {
              document.querySelector('#view-seg button[data-view="studio"]')?.click();
              setTimeout(() => document.querySelector('.page-btn[data-page="deliver"]')?.click(), 100);
            },
          }, "⇄ Change one thing"),
    ),
  );
}

/**
 * Step three: the setup is done and lives on the canvas.
 *
 * Coming BACK here should not look like a dead end, so this says plainly what
 * was built, where it went, and what each of the three views is now for.
 */
function handoffStage(p) {
  const shots = orderedShots(p);
  const beats = shots.reduce((n, s2) => n + (s2.beats || []).filter(b => (b.text || "").trim()).length, 0);
  const refs = referenceCount(p);
  const jobs = takeState.jobs.length ? takeState.jobs : (p.jobs || []).slice(0, 2);

  const line = (what, why) => h("div.cr-hand-row", h("b", what), h("span", why));

  return h("div.cr-stage",
    h("div.cr-hero.small",
      h("h2.cr-h", "It's on the canvas"),
      h("p.cr-sub", `${shots.length} shot${shots.length === 1 ? "" : "s"}, ${beats} beat${beats === 1 ? "" : "s"}, `
        + `${MODES[p.mode].label.toLowerCase()}, ${p.render.duration} seconds`
        + `${refs ? `, ${refs} reference${refs === 1 ? "" : "s"}` : ""}.`),
    ),
    h("div.cr-hand",
      line("Canvas", "where the work happens — drag your material onto a shot, set the camera, ask the director, render."),
      line("Studio", "where the details live — per-beat timing, dialogue, retention markers, the seed ladder."),
      line("Readthrough", "⇧Space at any time, to watch the prompt play before you spend a render on it."),
    ),
    jobs.length ? h("div.cr-takes", ...jobs.map(takeCard)) : null,
    h("div.cr-actions",
      h("button.cr-go", { onclick: () => buildCanvas() }, "Open the canvas →"),
      h("button.btn.ghost", { style: { marginLeft: "10px" }, onclick: () => setStage("steer") }, "← Steer it again"),
    ),
  );
}

const referenceCount = (p) =>
  (p.frames?.first ? 1 : 0) + (p.refs?.images || []).length + (p.refs?.videos || []).length + (p.refs?.audios || []).length;

/* ── Draw ─────────────────────────────────────────────────── */
function draw() {
  const p = getProject();
  const at = stage(p);
  mount(root,
    h("div.cr-wrap",
      h("div.cr-rail",
        ...[["material", "Material"], ["steer", "Steer"], ["canvas", "Canvas"]].map(([id, label], i) => h("button", {
          class: `cr-step${at === id ? " on" : ""}${["material", "steer", "canvas"].indexOf(at) > i ? " done" : ""}`,
          onclick: () => (id === "canvas" ? buildCanvas() : setStage(id)),
        }, h("span.cr-step-n", String(i + 1)), h("span", label))),
      ),
      at === "material" ? materialStage(p)
        : at === "steer" ? steerStage(p)
        : at === "canvas" ? handoffStage(p)
        : takesStage(p),
    ),
  );
}

export function render(el) {
  root = el;
  if (!unsub) unsub = onRenderChange((job, kind) => { if (root?.classList.contains("active")) applyLive(root, job, kind, draw); });
  draw();
}
export function refresh() { if (root) draw(); }
export function destroy() { if (previz) { previz.destroy(); previz = null; } }
