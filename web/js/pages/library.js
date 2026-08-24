/* LIBRARY — what was made, what made it, and what you thought.
 *
 * The half of prompt engineering that happens after the render. Every clip is
 * here with the exact text that produced it; rate it, say what went wrong in
 * words the app can count, and put two of them side by side to see the one
 * phrase that changed. Restoring a record puts its whole project back — six
 * weeks later, on another machine.
 */

import {
  h, mount, clear, toast, select, textarea, checkbox, timecode,
  copyText, download, modal, debounce, uid,
} from "../util.js";
import { api } from "../api.js";
import { getProject, replaceProject, forgetUploads } from "../state.js";
import { library, rulebook, cast, VERDICT_TAGS, tagLabel, tagIsGood, wordDiff, settingsDiff, summarise, tagRule} from "../library.js";
import { setCast, setHouseRules, castSlug } from "../prompt.js";
import { pickCharacter, castLine, loadKnownCast, knownCast, STATUS as KNOWN } from "../knowncast.js";
import { humanTime } from "../workflow.js";

let root = null;
let rows = [];
let stats = null;
let selectedId = null;
let compareIds = [];
let filters = { q: "", mode: "", minRating: "", tag: "", experimentId: "" };
let loading = false;
let view = "grid";      // grid | compare | rules

const clipUrl = (entry) => (entry.outputs?.[0] ? `${api.viewUrl(entry.outputs[0])}#t=0.1` : null);

async function load() {
  loading = true;
  try {
    const params = { limit: 400 };
    if (filters.q) params.q = filters.q;
    if (filters.mode) params.mode = filters.mode;
    if (filters.minRating) params.minRating = filters.minRating;
    if (filters.experimentId) params.experimentId = filters.experimentId;
    const r = await library.list(params);
    rows = r.rows || [];
    if (filters.tag) rows = rows.filter(e => (e.verdict?.tags || []).includes(filters.tag));
    stats = r.stats || null;
  } catch (err) {
    toast("Could not read the library", err.message, "err");
    rows = [];
  } finally {
    loading = false;
    draw();
  }
}

const search = debounce((v) => { filters.q = v; load(); }, 300);

async function setVerdict(entry, changes) {
  const verdict = { rating: null, tags: [], note: "", ...(entry.verdict || {}), ...changes };
  entry.verdict = verdict;
  draw();
  try { await library.patch(entry.id, { verdict }); }
  catch (err) { toast("Could not save the verdict", err.message, "err"); }
}

/* ── Left: filters and what the library knows ─────────────── */
function sidebar() {
  const tagCounts = new Map();
  for (const r of rows) for (const t of r.verdict?.tags || []) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);

  return h("div.panel",
    h("div.hd", h("span.title", "Library"), h("span.spacer"),
      h("button.btn.sm.ghost", { title: "Reload", onclick: () => load() }, "⟳")),
    h("div.bd.pad",
      h("input", {
        type: "text", placeholder: "Search prompts, tags, notes…", value: filters.q,
        oninput: (e) => search(e.target.value),
      }),
      h("div", { style: { height: "9px" } }),
      h("div.i-row", h("label.i-label", "Mode"),
        select([["", "any"], ["t2v", "T2V"], ["i2v", "I2V"], ["r2v", "Ref2V"]], filters.mode,
          (v) => { filters.mode = v; load(); })),
      h("div.i-row", h("label.i-label", "Rating"),
        select([["", "any"], ["5", "★★★★★"], ["4", "★★★★ and up"], ["3", "★★★ and up"], ["1", "rated at all"]],
          filters.minRating, (v) => { filters.minRating = v; load(); })),
      filters.experimentId ? h("div.flex", { style: { marginBottom: "8px" } },
        h("span.tag", "one experiment"),
        h("button.btn.sm.ghost", { onclick: () => { filters.experimentId = ""; load(); } }, "show all")) : null,

      h("h4.sec", { style: { marginTop: "12px" } }, "What went wrong"),
      h("div.flex.wrap",
        ...VERDICT_TAGS.filter(t => tagCounts.get(t.id)).map(t => h("span", {
          class: `chip${filters.tag === t.id ? " on" : ""}`,
          onclick: () => { filters.tag = filters.tag === t.id ? "" : t.id; load(); },
        }, `${t.label} ${tagCounts.get(t.id)}`)),
        !tagCounts.size ? h("span.hint", "Nothing tagged yet. Rate a clip and say what happened — the counts here are how you find a pattern.") : null,
      ),

      experimentList(),

      /* This whole column used to be three unrelated buttons under a heading
       * that said nothing — "This machine". It is one idea: the half of prompt
       * engineering that happens AFTER the render, and what it feeds. */
      h("div", { style: { marginTop: "14px" } },
        h("h4.sec", "What this box has learned"),
        h("div.note.info", { style: { marginTop: "0" } },
          stats?.rated
            ? h("div",
                h("b", `The director is reading ${stats.rated} rated render${stats.rated === 1 ? "" : "s"}.`),
                " It weighs what worked for you over general advice, every time you ask it anything.")
            : h("div",
                h("b", "Nothing is rated yet, so the director has nothing of yours to go on."),
                " Rate a clip ★ and say what happened — that is the only thing here that feeds back into what it suggests."),
        ),
        stats ? h("div.hint", { style: { marginTop: "6px" } },
          `${stats.total} render${stats.total === 1 ? "" : "s"} on the shelf · ${stats.rated} rated`
          + (stats.averageRating ? ` · ${stats.averageRating}★ average` : "")
          + (ruleRows.length ? ` · ${ruleRows.length} house rule${ruleRows.length === 1 ? "" : "s"}` : "")) : null,
        stats?.experiments ? h("div.hint", `${stats.experiments} experiment${stats.experiments === 1 ? "" : "s"}`) : null,
      ),

      h("div.sep"),
      h("button.btn.sm.wide", {
        title: "Read ComfyUI's own history and shelve every MiniMax H3 render it finds",
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.classList.add("disabled"); btn.textContent = "reading ComfyUI…";
          try {
            const r = await api.importHistory(100);
            toast(r.added ? `${r.added} imported` : "Nothing new",
              `${r.seen} in ComfyUI's history · ${r.skipped} skipped (already here, or not an H3 graph)`, "ok");
            load();
          } catch (err) { toast("Could not read ComfyUI's history", err.message, "err"); }
          finally { btn.classList.remove("disabled"); btn.textContent = "⇩ Import from ComfyUI"; }
        },
      }, "⇩ Import from ComfyUI"),
      h("div.hint", { style: { marginTop: "5px" } },
        "An H3 graph carries its own prompt, canvas, build and seed — so clips rendered before this editor existed still land on the shelf."),

      h("div.sep"),
      h("button.btn.sm.wide", { onclick: () => { view = view === "rules" ? "grid" : "rules"; draw(); } },
        view === "rules" ? "← Back to the library" : "📓 House rules"),
      h("div.hint", { style: { marginTop: "5px" } },
        "One sentence each, about what this model actually does. Every active rule is appended to the rewriter's system prompt, so a lesson learned once keeps working; give one a watch phrase and the checks flag it too. Tag a bad take and the app offers you the rule it implies."),
      h("button.btn.sm.wide", { style: { marginTop: "8px" },
        onclick: () => { view = view === "cast" ? "grid" : "cast"; draw(); } },
        view === "cast" ? "← Back to the library" : "🎭 Cast & phrases"),
      h("div.hint", { style: { marginTop: "5px" } },
        "Recurring subjects and phrases, written once. Type @name in any field and the same words describe them every time."),
    ),
  );
}

/* Experiments, grouped out of whatever is loaded. A sweep is the unit of
 * learning here, so it gets to be a thing you can click. */
function experimentList() {
  const groups = new Map();
  for (const r of rows) {
    if (!r.experimentId) continue;
    const g = groups.get(r.experimentId) || { id: r.experimentId, n: 0, at: 0, labels: [], best: 0 };
    g.n++;
    g.at = Math.max(g.at, r.at || 0);
    if (r.variantLabel) g.labels.push(r.variantLabel);
    g.best = Math.max(g.best, r.verdict?.rating || 0);
    groups.set(r.experimentId, g);
  }
  const list = [...groups.values()].sort((a, b) => b.at - a.at).slice(0, 8);
  if (!list.length) return null;

  return h("div", { style: { marginTop: "14px" } },
    h("h4.sec", "Experiments"),
    ...list.map(g => h("div", {
      class: `chip${filters.experimentId === g.id ? " on" : ""}`,
      style: { display: "flex", width: "100%", height: "auto", padding: "5px 8px", marginBottom: "4px", borderRadius: "3px" },
      onclick: () => { filters.experimentId = filters.experimentId === g.id ? "" : g.id; compareIds = []; load(); },
    },
      h("span.grow", { style: { textAlign: "left" } }, g.labels.slice(0, 3).join(" · ") || "sweep"),
      h("span.mono", { style: { opacity: ".7" } }, `${g.n}${g.best ? ` · ${g.best}★` : ""}`),
    )),
  );
}

/* ── Centre: the grid ─────────────────────────────────────── */
function card(entry) {
  const url = clipUrl(entry);
  const picked = compareIds.includes(entry.id);
  const rating = entry.verdict?.rating || 0;

  return h("div", {
    class: `lb-card${selectedId === entry.id ? " sel" : ""}${picked ? " picked" : ""}`,
    onclick: () => { selectedId = entry.id; draw(); },
  },
    h("div.lb-thumb",
      url
        ? h("video", { src: url, preload: "metadata", muted: "", playsinline: "",
            onmouseenter: (e) => { e.currentTarget.play().catch(() => {}); },
            onmouseleave: (e) => { e.currentTarget.pause(); e.currentTarget.currentTime = 0.1; } })
        : h("div.lb-nofile", entry.error ? "failed" : "no clip"),
      entry.variantLabel ? h("span.lb-variant", entry.variantLabel) : null,
      h("button", {
        class: `lb-pick${picked ? " on" : ""}`,
        title: "Pick for comparison",
        onclick: (e) => {
          e.stopPropagation();
          compareIds = picked ? compareIds.filter(id => id !== entry.id) : [...compareIds, entry.id].slice(-2);
          draw();
        },
      }, picked ? String(compareIds.indexOf(entry.id) + 1) : "⇄"),
    ),
    h("div.lb-meta",
      h("div.lb-stars", ...[1, 2, 3, 4, 5].map(n => h("span", {
        class: `lb-star${n <= rating ? " on" : ""}`,
        title: `${n} of 5`,
        onclick: (e) => { e.stopPropagation(); setVerdict(entry, { rating: rating === n ? null : n }); },
      }, "★"))),
      h("div.lb-sum", summarise(entry)),
      h("div.lb-prompt", (entry.description || entry.promptText || "").slice(0, 150)),
      (entry.verdict?.tags || []).length
        ? h("div.flex.wrap", { style: { marginTop: "5px" } },
            ...entry.verdict.tags.slice(0, 3).map(t => h("span", { class: `tag ${tagIsGood(t) ? "t-aud" : "t-vid"}` }, tagLabel(t))))
        : null,
    ),
  );
}

function grid() {
  const experiment = filters.experimentId
    ? rows.filter(r => r.experimentId === filters.experimentId)
    : null;

  return h("div.panel",
    h("div.hd",
      h("span.title", experiment ? "Experiment" : "Renders"),
      h("span.hint", experiment
        ? `${experiment.length} renders · everything held still except: ${[...new Set(experiment.map(r => r.variantLabel).filter(Boolean))].join(", ")}`
        : `${rows.length}`),
      h("span.spacer"),
      compareIds.length === 2
        ? h("button.btn.sm.primary", { onclick: () => { view = "compare"; draw(); } }, "Compare the two ⇄")
        : compareIds.length === 1 ? h("span.hint", "pick one more to compare") : null,
      h("button.btn.sm.ghost", { onclick: () => { compareIds = []; draw(); } }, compareIds.length ? "clear" : ""),
    ),
    h("div.bd",
      loading ? h("div", { style: { padding: "20px" } }, h("div.hint", "Reading…"))
        : rows.length ? h("div.lb-grid", ...rows.map(card))
        : h("div", { style: { padding: "26px", textAlign: "center" } },
            h("div", { style: { fontSize: "26px", opacity: ".25", marginBottom: "8px" } }, "▤"),
            h("div.hint", "Nothing recorded yet. Every render lands here with the prompt that made it."),
            h("div.hint", { style: { marginTop: "6px" } }, "Then rate it, and say what went wrong — that is what makes the next one better.")),
    ),
  );
}

/* ── Compare: the point of keeping any of this ────────────── */
function compare() {
  const [a, b] = compareIds.map(id => rows.find(r => r.id === id)).filter(Boolean);
  if (!a || !b) { view = "grid"; return grid(); }

  const diff = wordDiff(a.description || a.promptText, b.description || b.promptText);
  const sdiff = settingsDiff(a, b);
  const changed = diff.filter(d => d.type !== "same").length;

  const side = (entry, label) => h("div.cmp-side",
    h("div.flex", { style: { marginBottom: "6px" } },
      h("span.tag", label),
      h("span.hint.grow", summarise(entry)),
      h("span.lb-stars", ...[1, 2, 3, 4, 5].map(n => h("span", { class: `lb-star${n <= (entry.verdict?.rating || 0) ? " on" : ""}` }, "★"))),
    ),
    clipUrl(entry)
      ? h("video", { src: clipUrl(entry), controls: "", loop: "", playsinline: "", style: { width: "100%", background: "#000", borderRadius: "3px" } })
      : h("div.lb-nofile", { style: { aspectRatio: "16/9" } }, "no clip"),
    (entry.verdict?.tags || []).length
      ? h("div.flex.wrap", { style: { marginTop: "6px" } }, ...entry.verdict.tags.map(t => h("span", { class: `tag ${tagIsGood(t) ? "t-aud" : "t-vid"}` }, tagLabel(t))))
      : null,
  );

  const diffEl = h("div.cmp-diff");
  for (const part of diff) {
    diffEl.appendChild(h(part.type === "same" ? "span" : `span.d-${part.type}`, part.text));
  }

  return h("div.panel",
    h("div.hd",
      h("span.title", "Compare"),
      h("span.spacer"),
      h("span.hint", `${changed} change${changed === 1 ? "" : "s"} in the prompt · ${sdiff.length} in the settings`),
      h("button.btn.sm", { onclick: () => { view = "grid"; draw(); } }, "← Back"),
    ),
    h("div.bd.pad",
      h("div.cmp-pair", side(a, "A"), side(b, "B")),

      sdiff.length ? h("div", { style: { marginTop: "12px" } },
        h("h4.sec", "Settings that differ"),
        h("table.cmp-table",
          h("tr", h("th", ""), h("th", "A"), h("th", "B")),
          ...sdiff.map(r => h("tr", h("td", r.key), h("td", String(r.a ?? "—")), h("td", String(r.b ?? "—")))),
        ),
      ) : h("div.hint", { style: { marginTop: "12px" } }, "Identical settings — whatever differs, differs in the words."),

      h("h4.sec", { style: { marginTop: "14px" } }, "What changed in the prompt"),
      h("div.hint", { style: { marginBottom: "6px" } },
        h("span.d-del", "struck through"), " was only in A · ", h("span.d-add", "underlined"), " is only in B."),
      diffEl,

      h("div.btn-row", { style: { marginTop: "12px" } },
        h("button.btn.sm", { onclick: async () => { await copyText(diffSummary(a, b)); toast("Copied", "The A/B summary is on the clipboard.", "ok"); } }, "Copy the A/B summary"),
        h("button.btn.sm.ai", {
          title: "Turn what you just saw into a house rule",
          onclick: () => promptForRule(a, b),
        }, "＋ Make this a house rule"),
      ),
    ),
  );
}

function diffSummary(a, b) {
  const sdiff = settingsDiff(a, b);
  return [
    `A · ${summarise(a)} · ${a.verdict?.rating || "unrated"}★ ${(a.verdict?.tags || []).map(tagLabel).join(", ")}`,
    `B · ${summarise(b)} · ${b.verdict?.rating || "unrated"}★ ${(b.verdict?.tags || []).map(tagLabel).join(", ")}`,
    sdiff.length ? `Settings: ${sdiff.map(r => `${r.key} ${r.a} → ${r.b}`).join("; ")}` : "Settings identical.",
    "",
    "A:", a.description || a.promptText, "",
    "B:", b.description || b.promptText,
  ].join("\n");
}

async function promptForRule(a, b) {
  const sdiff = settingsDiff(a, b);
  const guess = sdiff.length
    ? `${sdiff[0].key} ${sdiff[0].a} → ${sdiff[0].b}: ${(b.verdict?.rating || 0) >= (a.verdict?.rating || 0) ? "better" : "worse"}`
    : "";
  const input = h("textarea", { rows: 3, value: guess, placeholder: "e.g. at 480p, arc left with large amplitude smears — keep it small" });
  const modeSel = select([["all", "every mode"], ["t2v", "T2V only"], ["i2v", "I2V only"], ["r2v", "Ref2V only"]], "all", () => {});
  const ok = await modal({
    title: "New house rule",
    body: h("div",
      h("div.note.info", { style: { marginTop: 0 } },
        "House rules ride along with every rewrite and are checked against every prompt. This is where what you just learned stops being something you have to remember."),
      input, h("div", { style: { height: "8px" } }), modeSel,
    ),
    actions: [
      { label: "Cancel", onClick: (done) => done(false) },
      { label: "Save the rule", kind: "primary", onClick: (done) => done(true) },
    ],
  });
  if (!ok || !input.value.trim()) return;
  try {
    await rulebook.save({ text: input.value.trim(), mode: modeSel.value, active: true, fromRenders: [a.id, b.id] });
    loadRules();
    toast("Rule saved", "It will ride along with the next rewrite.", "ok");
  } catch (err) { toast("Could not save the rule", err.message, "err"); }
}

/* ── Right: the record ────────────────────────────────────── */
function detail() {
  const entry = rows.find(r => r.id === selectedId) || rows[0];
  const body = h("div.insp");

  if (!entry) {
    body.appendChild(h("div", { style: { padding: "16px" } }, h("div.hint", "Select a render.")));
    return h("div.panel", h("div.hd", h("span.title", "Record")), h("div.bd", body));
  }

  const verdict = entry.verdict || {};
  body.append(
    h("div", { style: { padding: "11px" } },
      /* Rating is not a scoreboard: it is the only thing here that feeds back.
       * The director reads your rated renders and weighs them over generic
       * advice — so this line says what the star is FOR, at the star. */
      h("div.lb-stars.big", ...[1, 2, 3, 4, 5].map(n => h("span", {
        class: `lb-star${n <= (verdict.rating || 0) ? " on" : ""}`,
        title: n <= 2 ? "didn't work" : n >= 4 ? "worked" : "mixed",
        onclick: () => setVerdict(entry, { rating: verdict.rating === n ? null : n }),
      }, "★"))),
      h("div.hint", { style: { marginTop: "4px" } },
        verdict.rating
          ? `The director reads this${stats?.rated ? ` and ${stats.rated - 1 > 0 ? `${stats.rated - 1} other rated render${stats.rated - 1 === 1 ? "" : "s"}` : "nothing else yet"}` : ""} before it suggests anything.`
          : "Rate it and the director learns from it — it weighs your own results over general advice."),
      h("div.hint", { style: { marginTop: "4px" } },
        `${new Date(entry.at).toLocaleString()}${entry.tookMs ? ` · took ${humanTime(entry.tookMs / 1000)}` : ""}`),
      h("div.hint.mono", { style: { marginTop: "2px" } }, summarise(entry)),

      h("h4.sec", { style: { marginTop: "12px" } }, "What happened"),
      h("div.flex.wrap",
        ...VERDICT_TAGS.map(t => h("span", {
          class: `chip${(verdict.tags || []).includes(t.id) ? " on" : ""}`,
          onclick: () => {
            const tags = (verdict.tags || []).includes(t.id)
              ? verdict.tags.filter(x => x !== t.id)
              : [...(verdict.tags || []), t.id];
            setVerdict(entry, { tags });
          },
        }, t.label)),
      ),

      /* Noticing a problem and preventing it are different acts. This is the
       * one click between them: the tag already knows the rule it implies. */
      ...(verdict.tags || [])
        .filter(id => tagRule(id))
        .filter(id => !ruleRows.some(r => r.text === tagRule(id)))
        .map(id => h("div.lb-learn",
          h("div.lb-learn-hd", `Stop this happening again?`),
          h("div.lb-learn-rule", tagRule(id)),
          h("button.btn.sm", {
            title: "Add it to the house rules — every rewrite from now on carries it",
            onclick: () => addRule({ text: tagRule(id), mode: "all", fromTag: id }),
          }, "Make it a house rule"),
        )),
      h("div", { style: { marginTop: "9px" } },
        textarea(verdict.note || "", (v) => { entry.verdict = { ...verdict, note: v }; },
          { rows: 3, placeholder: "Anything worth remembering about this take…",
            onchange: () => setVerdict(entry, { note: entry.verdict.note }) })),

      h("h4.sec", { style: { marginTop: "12px" } }, "The prompt that made it"),
      h("pre.code", { style: { maxHeight: "28vh" } }, entry.promptText || ""),

      h("div.btn-row", { style: { marginTop: "10px" } },
        h("button.btn.sm", { onclick: async () => { await copyText(entry.promptText || ""); toast("Copied", "", "ok"); } }, "Copy"),
        entry.project ? h("button.btn.sm.primary", {
          title: "Put this whole project back — shots, sound, settings",
          onclick: async () => {
            const go = await modal({
              title: "Open this render's project?",
              body: h("div.note.warn", "The current timeline is replaced. Export it first if you want to keep it — media stays in the pool either way."),
              actions: [{ label: "Cancel", onClick: (d) => d(false) }, { label: "Open it", kind: "primary", onClick: (d) => d(true) }],
            });
            if (!go) return;
            /* A copy, not the original. The snapshot carries the id of the
             * project that made the render, so restoring it without a new one
             * meant the next save wrote over that project's file — and its
             * comfyNames claimed uploads that may be long gone. */
            replaceProject(forgetUploads({
              ...entry.project, id: uid(), jobs: getProject().jobs || [],
              name: `${entry.project?.name || "Untitled"} (from the library)`,
            }));
            toast("Project restored", entry.name || "", "ok");
            document.querySelector('.page-btn[data-page="cut"]')?.click();
          },
        }, entry.experimentId ? "Use this one" : "Open as project") : null,
      ),
      h("div.btn-row", { style: { marginTop: "7px" } },
        entry.experimentId ? h("button.btn.sm", {
          onclick: () => { filters.experimentId = entry.experimentId; compareIds = []; load(); },
        }, "Show its experiment") : null,
        entry.outputs?.[0] ? h("button.btn.sm.ghost", {
          onclick: () => window.open(api.viewUrl(entry.outputs[0]), "_blank"),
        }, "Open the clip ↗") : null,
        h("button.btn.sm.ghost", {
          onclick: async () => {
            await library.remove(entry.id);
            rows = rows.filter(r => r.id !== entry.id);
            selectedId = null;
            toast("Removed from the library", "", "ok");
            draw();
          },
        }, "Delete"),
      ),
      entry.error ? h("div.note.bad", entry.error) : null,
    ),
  );

  return h("div.panel",
    h("div.hd", h("span.title", "Record"), h("span.spacer"),
      h("span.hint", (entry.mode || "").toUpperCase())),
    h("div.bd", body),
  );
}

/* ── House rules ──────────────────────────────────────────── */
let ruleRows = [];

async function loadRules() {
  try { ruleRows = (await rulebook.list()).rows || []; setHouseRules(ruleRows); }
  catch (err) { toast("Could not read the rulebook", err.message, "err"); ruleRows = []; }
  draw();
}

function rulesView() {
  return h("div.panel",
    h("div.hd", h("span.title", "House rules"), h("span.spacer"),
      h("span.hint", `${ruleRows.length}`),
      h("button.btn.sm", { onclick: () => addRule() }, "＋ Rule"),
      h("button.btn.sm.ghost", { onclick: () => { view = "grid"; draw(); } }, "← Back")),
    h("div.bd.pad",
      h("div.note.info", { style: { marginTop: 0 } },
        h("b", "This is what the app knows that MiniMax's guide does not. "),
        "Every active rule is appended to the rewriter's system prompt and shown in the checks, so a lesson learned once keeps working."),
      ruleRows.length ? h("div", ...ruleRows.map(ruleRow))
        : h("div.hint", { style: { marginTop: "12px" } },
            "Nothing yet. Compare two renders and press “Make this a house rule”, or add one by hand."),
    ),
  );
}

function ruleRow(rule) {
  return h("div.rule-row",
    h("input", {
      type: "checkbox", checked: rule.active !== false,
      title: "Active rules ride along with every rewrite",
      onchange: async (e) => { rule.active = e.target.checked; await rulebook.patch(rule.id, { active: rule.active }); draw(); },
    }),
    h("div.grow",
      h("div", { class: rule.active === false ? "dim" : "" }, rule.text),
      h("div.hint",
        `${rule.mode && rule.mode !== "all" ? rule.mode.toUpperCase() : "every mode"}`
        + `${rule.pattern ? ` · watches for “${rule.pattern.replace(/\\(.)/g, "$1")}”` : " · carried by the rewriter"}`
        + `${rule.fromRenders ? " · from a comparison" : ""}`),
    ),
    h("button.btn.sm.ghost", { onclick: () => addRule(rule) }, "Edit"),
    h("button.btn.sm.ghost", {
      onclick: async () => { await rulebook.remove(rule.id); ruleRows = ruleRows.filter(r => r.id !== rule.id); setHouseRules(ruleRows); draw(); },
    }, "✕"),
  );
}

async function addRule(preset = {}) {
  const input = h("textarea", {
    rows: 3, value: preset.text || "",
    placeholder: "e.g. keep arc moves at small amplitude on this card — large smears at 480p",
  });
  const modeSel = select([["all", "every mode"], ["t2v", "T2V only"], ["i2v", "I2V only"], ["r2v", "Ref2V only"]],
    preset.mode || "all", () => {});
  const pattern = h("input", { type: "text", value: preset.pattern || "", placeholder: "large amplitude" });
  const ok = await modal({
    title: preset.id ? "Edit the rule" : "New house rule",
    body: h("div",
      h("label.i-label", "The rule, in your words"), input,
      h("div", { style: { height: "9px" } }),
      h("label.i-label", "Applies to"), modeSel,
      h("div", { style: { height: "9px" } }),
      h("label.i-label", "Flag prompts containing (optional)"), pattern,
      h("div.hint", { style: { marginTop: "4px" } },
        "Leave it empty and the rule is a reminder the rewriter carries. Fill it in and the checks also raise it whenever those words appear — a lesson that watches for itself."),
    ),
    actions: [{ label: "Cancel", onClick: (d) => d(false) }, { label: "Save", kind: "primary", onClick: (d) => d(true) }],
  });
  if (!ok || !input.value.trim()) return;
  const rule = {
    ...preset,
    text: input.value.trim(),
    mode: modeSel.value,
    // Plain words, escaped — a rulebook is not a place to debug a regex.
    pattern: pattern.value.trim() ? pattern.value.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "",
    active: preset.active !== false,
  };
  await rulebook.save(rule);
  loadRules();
}

/* ── Cast & phrases ───────────────────────────────────────── */
let castRows = [];

async function loadCast() {
  try { castRows = (await cast.list()).rows || []; setCast(castRows); }
  catch (err) { toast("Could not read the cast", err.message, "err"); castRows = []; }
  draw();
  // The counts under "Who H3 already knows" are the point of that section, so
  // they are fetched rather than guessed — and redrawn when they land.
  if (!knownCast().length) loadKnownCast().then(() => { if (view === "cast") draw(); });
}

function castView() {
  const subjects = castRows.filter(c => (c.kind || "subject") === "subject");
  const phrases = castRows.filter(c => c.kind === "phrase");

  return h("div.panel",
    h("div.hd", h("span.title", "Cast & phrases"), h("span.spacer"),
      h("span.hint", `${castRows.length}`),
      h("button.btn.sm", { onclick: () => editCast({ kind: "subject" }) }, "＋ Subject"),
      h("button.btn.sm", { onclick: () => editCast({ kind: "phrase" }) }, "＋ Phrase"),
      h("button.btn.sm.ghost", { onclick: () => { view = "grid"; draw(); } }, "← Back")),
    h("div.bd.pad",
      h("div.note.info", { style: { marginTop: 0 } },
        h("b", "Written once, used everywhere. "),
        "Type ", h("code", "@anna"), " in a subject, a beat, the setting or the soundscape and the compiler puts the full description there — the SAME words every time, which is most of what identity consistency is on a model with no character memory."),

      h("h4.sec", { style: { marginTop: "12px" } }, "Subjects"),
      subjects.length ? h("div", ...subjects.map(castRow))
        : h("div.hint", "Nobody yet. A subject is a person, a place or an object you keep coming back to."),

      h("h4.sec", { style: { marginTop: "14px" } }, "Phrases"),
      phrases.length ? h("div", ...phrases.map(castRow))
        : h("div.hint", "None yet. A phrase is a lighting recipe, a soundscape, a grade — anything you retype."),

      h("h4.sec", { style: { marginTop: "16px" } }, "Who H3 already knows"),
      knownSummary(),
    ),
  );
}

/* ── Casting from what the model already has ─────────────────
 *
 * The other way to keep a face consistent: not describing it, but naming
 * someone H3 was trained on. 1293 names were tested one clip at a time and
 * 405 of them came back recognisable — which is the whole value of the list,
 * because from the outside those 405 look exactly like the 835 that did not.
 */
function knownSummary() {
  const rows = knownCast();
  const n = (s) => rows.filter(e => e.status === s).length;
  return h("div",
    h("div.hint", { style: { marginBottom: "8px" } },
      rows.length
        ? `${n("g")} names H3 renders recognisably on their own, ${n("f")} it half-manages and ${n("b")} it does not — from ${rows.length} tested one clip at a time.`
        : "1293 characters were generated one clip at a time and sorted by whether the name alone was enough."),
    h("button.btn.sm", {
      onclick: async () => {
        const entry = await pickCharacter({ verb: "Add to cast" });
        if (!entry) return;
        await editCast({ kind: "subject", name: entry.name, text: castLine(entry), known: entry });
      },
    }, "🎭 Browse the character index"),
  );
}

function castRow(entry) {
  return h("div.rule-row",
    h("div.grow",
      h("div.flex",
        h("span.tag", `@${castSlug(entry.name)}`),
        h("span.bright", entry.name),
        h("span.hint.grow", `${(entry.text || "").split(/\s+/).filter(Boolean).length} words`),
      ),
      h("div.hint", { style: { marginTop: "3px" } }, (entry.text || "").slice(0, 180)),
    ),
    h("button.btn.sm.ghost", { onclick: () => editCast(entry) }, "Edit"),
    h("button.btn.sm.ghost", {
      onclick: async () => { await cast.remove(entry.id); loadCast(); },
    }, "✕"),
  );
}

async function editCast(entry) {
  const name = h("input", { type: "text", value: entry.name || "", placeholder: entry.kind === "phrase" ? "rain night" : "Anna" });
  const text = h("textarea", {
    rows: 5, value: entry.text || "",
    placeholder: entry.kind === "phrase"
      ? "rain beading on the window, the street lit only by a shop sign"
      : "a woman in her thirties with short dark hair and a grey wool coat, a small scar above her left eyebrow",
  });
  const slug = h("div.hint");
  const paintSlug = () => { slug.textContent = name.value.trim() ? `used as @${castSlug(name.value)}` : ""; };
  name.addEventListener("input", paintSlug);
  paintSlug();

  const ok = await modal({
    title: entry.id ? "Edit" : (entry.kind === "phrase" ? "New phrase" : "New subject"),
    body: h("div",
      h("label.i-label", "Name"), name, slug,
      h("div", { style: { height: "9px" } }),
      h("label.i-label", entry.kind === "phrase" ? "What it stands for" : "How they should always be described"),
      text,
      entry.known ? h("div.note.info", { style: { marginTop: "8px" } },
        h("b", `${KNOWN[entry.known.status].icon} ${KNOWN[entry.known.status].label}. `),
        KNOWN[entry.known.status].blurb,
        entry.known.status === "g"
          ? " Keep the wording short — the name is doing the work, and piling description on top of a face the model already has tends to fight it."
          : " Everything you add here is what the model will actually go on.")
        : null,
      h("div.hint", { style: { marginTop: "6px" } },
        entry.kind === "phrase"
          ? "Plain prose, no tags. It is pasted in exactly as written."
          : "Concrete, observable detail — the model has no memory between clips, so this text IS the character."),
    ),
    actions: [
      { label: "Cancel", onClick: (d) => d(false) },
      { label: "Save", kind: "primary", onClick: (d) => d(true) },
    ],
  });
  if (!ok || !name.value.trim() || !text.value.trim()) return;
  const { known, ...rest } = entry;   // the index hint is UI, not a stored field
  await cast.save({ ...rest, name: name.value.trim(), text: text.value.trim(), kind: entry.kind || "subject" });
  toast("Saved", `Use it as @${castSlug(name.value)}`, "ok");
  loadCast();
}

/* ── Draw ─────────────────────────────────────────────────── */
function draw() {
  mount(root, h("div.cols",
    sidebar(),
    view === "compare" ? compare() : view === "rules" ? rulesView() : view === "cast" ? castView() : grid(),
    view === "cast" ? h("div.panel", h("div.hd", h("span.title", "Why")), h("div.bd.pad",
      h("div.hint", "H3 has no memory between clips. Whatever describes a character in shot 1 has to describe her again in shot 4, and again next week."),
      h("div.sep"),
      h("div.hint", "A cast entry is those words, kept. @anna expands to them everywhere — in a subject, a beat, the setting, even the soundscape."),
      h("div.sep"),
      h("div.hint", "The checks flag an @name that stands for nobody, because the model would read it as a literal word."),
      h("div.sep"),
      h("div.hint", "Ref2V's <Picture N> tags are a different thing and still the stronger one: a picture pins a face, words pin a description. Use both."),
      h("div.sep"),
      h("div.hint", "And some faces the model already has. 405 of 1293 tested characters come back recognisable from the name alone — the index says which, and the checks say when you have named one of the others."),
    )) :
    view === "rules" ? h("div.panel", h("div.hd", h("span.title", "Why")), h("div.bd.pad",
      h("div.hint", "A house rule is one sentence about what this machine and this model actually do."),
      h("div.sep"),
      h("div.hint", "Good ones name a setting and an outcome: “ref_image_size max holds faces but doubles the time”, “the 4-step ref2v distill breaks audio past 15 s”."),
      h("div.sep"),
      h("div.hint", "They are appended to the rewriter's system prompt and shown with the checks, so the lesson keeps working after you have forgotten it."),
    )) : detail(),
  ));
}

export function render(el) {
  root = el;
  draw();
  load();
  loadRules();
  loadCast();
}
export function refresh() { if (root) draw(); }
export function openExperiment(id) { filters.experimentId = id; view = "grid"; load(); }
