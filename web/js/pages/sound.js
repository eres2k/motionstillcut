/* SOUND — H3 generates its own 32 kHz audio, and it takes three separate
 * instructions to do it: the dialogue (exact words, per speaker, in the shot
 * they belong to), the soundscape (everything else that is IN the world) and
 * the score (which is not). The guide is strict that they never overlap, so
 * they get three separate surfaces. */

import { h, mount, toast, select, checkbox, textarea, shotTime } from "../util.js";
import {
  getProject, update, orderedShots, newDialogue, orderedDialogue, lastSpeaker, nextUnusedSpeaker,
} from "../state.js";
import { LANGUAGES, SPEAKERS } from "../vocab.js";
import { compilePrompt, dialogueSentence } from "../prompt.js";
import { soundFor } from "../llm.js";

let root = null;

/* ── Dialogue, grouped by shot ────────────────────────────── */
function dialoguePanel(p) {
  const shots = orderedShots(p);
  const body = h("div");

  shots.forEach((shot, i) => {
    const lines = shot.dialogue || [];
    body.appendChild(h("div", { style: { borderBottom: "1px solid var(--line)" } },
      h("div.flex", { style: { padding: "6px 9px", background: "#232323" } },
        h("span.tag", `Shot ${i + 1}`),
        h("span.hint.grow", `${shotTime(shot.at)} · ${(shot.subject || shot.action || "—").slice(0, 46)}`),
        /* Two buttons, because there are two different intentions and guessing
         * between them was the bug. This used to index SPEAKERS by THAT SHOT's
         * line count, so every shot's first line came back as (S1) — two
         * different characters in two different shots compiled to one voice,
         * and H3 duly gave them one. The only symptom was the render. */
        h("button.btn.sm", {
          title: "Another line from whoever spoke last",
          onclick: () => {
            update((proj) => {
              const s = proj.shots.find(x => x.id === shot.id);
              s.dialogue = [...(s.dialogue || []), newDialogue(lastSpeaker(proj))];
            }, "shots");
            refresh();
          },
        }, "＋ Line"),
        h("button.btn.sm", {
          title: nextUnusedSpeaker(p) ? `A new speaking part — ${nextUnusedSpeaker(p)}` : "All four speaker ids are in use",
          class: `btn sm${nextUnusedSpeaker(p) ? "" : " disabled"}`,
          onclick: () => {
            const next = nextUnusedSpeaker(getProject());
            if (!next) return;
            update((proj) => {
              const s = proj.shots.find(x => x.id === shot.id);
              s.dialogue = [...(s.dialogue || []), newDialogue(next)];
            }, "shots");
            refresh();
          },
        }, "＋ Voice"),
      ),
      ...lines.map(line => dialogueRow(p, shot, line, i === shots.length - 1)),
      !lines.length ? h("div.hint", { style: { padding: "8px 10px" } }, "No dialogue in this shot.") : null,
    ));
  });

  return h("div.panel",
    h("div.hd", h("span.title", "Dialogue"), h("span.spacer"),
      h("span.hint", "(S1) says, <d>[Language] …</d>")),
    h("div.bd", body),
  );
}

/** This speaker's first line in the clip — where their identity is written. */
function firstLineOf(p, speaker) {
  return orderedDialogue(p).find(({ line }) => line.speaker === speaker)?.line || null;
}

function dialogueRow(p, shot, line, last = false) {
  const patch = (fields, reason = "text") => update((proj) => {
    const s = proj.shots.find(x => x.id === shot.id);
    const d = s?.dialogue?.find(x => x.id === line.id);
    if (d) Object.assign(d, fields);
  }, reason);

  /* Whether this is where the speaker is introduced. The identity phrase is
   * written once, at a speaker's first line — which is what the guide scopes
   * it to, and what the compiler emits. Showing the box on every line would
   * invite four copies of the same sentence. */
  const first = firstLineOf(p, line.speaker)?.id === line.id;

  return h("div.dlg-row",
    select(SPEAKERS.map(s => [s, s]), line.speaker, (v) => { patch({ speaker: v }, "shots"); refresh(); }, { class: "spk" }),
    select(LANGUAGES.map(l => [l, l]), line.language, (v) => { patch({ language: v }, "shots"); refresh(); }),
    h("div",
      first ? h("input", {
        type: "text", class: "dlg-identity", value: line.identity || "",
        placeholder: `who is (${line.speaker}), and how do they sound?`,
        title: "H3 builds the voice from this. Character type, age, whether they are on screen, pitch, timbre, pace, accent — \"a young woman with a quiet, breathy voice\". Written once, at this speaker's first line.",
        onchange: (e) => { patch({ identity: e.target.value.trim() }, "shots"); refresh(); },
      }) : h("div.hint", { style: { marginBottom: "3px" } },
        `(${line.speaker})${firstLineOf(p, line.speaker)?.identity ? ` — ${firstLineOf(p, line.speaker).identity}` : ""}`),
      textarea(line.text, (v) => patch({ text: v }), { rows: 2, placeholder: "the exact words — never translated, never paraphrased" }),
      h("div.flex", { style: { marginTop: "4px" } },
        h("input", {
          type: "text", class: "dlg-delivery", value: line.delivery || "",
          placeholder: "says",
          title: "The verb and its manner — says, shouts, replies quietly, exclaims with light annoyance. Goes between the speaker id and the words.",
          onchange: (e) => { patch({ delivery: e.target.value.trim() }, "shots"); refresh(); },
        }),
        checkbox("off-screen voiceover", !!line.voiceover, (v) => { patch({ voiceover: v }, "shots"); refresh(); },
          "Uses the guide's exact phrase and states that the lips stay closed"),
        last
          ? checkbox("cut off by the end", !!line.cutoff, (v) => { patch({ cutoff: v, continues: false }, "shots"); refresh(); },
              "Writes <cutoff> — the clip ends before the line does")
          : checkbox("carries over the cut", !!line.continues, (v) => { patch({ continues: v, cutoff: false }, "shots"); refresh(); },
              "Writes <scenetrans> at both sides of the cut and says the line carries over"),
      ),
      (line.text || "").trim() ? h("div.hint.mono", { style: { marginTop: "4px" } }, dialogueSentence(line, { first })) : null,
    ),
    h("button.btn.ghost.sm", {
      title: "Delete this line",
      onclick: () => {
        update((proj) => {
          const s = proj.shots.find(x => x.id === shot.id);
          s.dialogue = (s.dialogue || []).filter(d => d.id !== line.id);
        }, "shots");
        refresh();
      },
    }, "✕"),
  );
}

/* ── Soundscape + score ───────────────────────────────────── */
function mixPanel(p) {
  const compiled = compilePrompt(p);

  return h("div.panel",
    h("div.hd", h("span.title", "Soundscape & Score"), h("span.spacer"),
      h("button.btn.ai.sm", {
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.classList.add("disabled"); btn.textContent = "listening…";
          try {
            const r = await soundFor(p);
            update((proj) => {
              proj.sound.soundscape = r.soundscape === "N/A" ? "" : r.soundscape;
              proj.sound.silent = r.soundscape === "N/A";
              proj.sound.music = r.music === "N/A" ? "" : r.music;
              proj.sound.musicOff = r.music === "N/A";
            }, "sound");
            toast("Sound written", r.model || "", "ok");
            refresh();
          } catch (err) { toast("Could not write the sound", err.message, "err"); }
          finally { btn.classList.remove("disabled"); btn.textContent = "✨ Write both"; }
        },
      }, "✨ Write both")),
    h("div.bd.pad",
      h("h4.sec", "overall_soundscape"),
      h("div.hint", "1–4 sentences: ambience, physical sounds, non-verbal vocals, in the order they happen. Dialogue and music must NOT be repeated here."),
      textarea(p.sound.soundscape, (v) => update(proj => { proj.sound.soundscape = v; }, "text"),
        { rows: 5, style: { marginTop: "6px" }, placeholder: "Rain taps the window in an uneven rhythm. The espresso grinder rises and cuts out. A chair scrapes across tile." }),
      h("div", { style: { marginTop: "6px" } },
        checkbox("Deliberate silence — export N/A", !!p.sound.silent,
          (v) => { update(proj => { proj.sound.silent = v; }, "sound"); refresh(); },
          "The field's own way of asking for no ambience at all")),

      h("div.sep"),

      h("h4.sec", "non_diegetic_music"),
      h("div.hint", "1–3 sentences: instrumentation, tempo, rhythm, dynamics. No mood words — \"a slow upright bass under brushed drums\", not \"emotional\"."),
      textarea(p.sound.music, (v) => update(proj => { proj.sound.music = v; }, "text"),
        { rows: 4, style: { marginTop: "6px" }, placeholder: "A slow upright bass walks under brushed drums at about 70 bpm, thinning to a single sustained note as the shot ends." }),
      h("div", { style: { marginTop: "6px" } },
        checkbox("No score — export N/A", !!p.sound.musicOff,
          (v) => { update(proj => { proj.sound.musicOff = v; }, "sound"); refresh(); })),

      h("div.sep"),
      h("h4.sec", "As exported"),
      h("pre.code", `overall_soundscape: ${compiled.soundscape}\n\nnon_diegetic_music: ${compiled.music}`),
    ),
  );
}

/* ── Right: the speaking parts, and the rules ─────────────── */
function castPanel(p) {
  const shots = orderedShots(p);
  const bySpeaker = new Map();
  shots.forEach((s, i) => (s.dialogue || []).forEach((d) => {
    if (!(d.text || "").trim()) return;
    if (!bySpeaker.has(d.speaker)) bySpeaker.set(d.speaker, []);
    bySpeaker.get(d.speaker).push({ shot: i + 1, line: d });
  }));

  return h("div.panel",
    h("div.hd", h("span.title", "Cast & rules")),
    h("div.bd.pad",
      h("h4.sec", "Speakers"),
      bySpeaker.size
        ? h("div.stack-6", ...[...bySpeaker.entries()].map(([spk, lines]) => h("div",
            h("div.flex", h("span.tag", `(${spk})`), h("span.hint", `${lines.length} line${lines.length > 1 ? "s" : ""}`)),
            ...lines.map(({ shot, line }) => h("div.hint", { style: { paddingLeft: "8px" } },
              h("span.faint", `Shot ${shot}: `), `"${line.text.slice(0, 60)}"`)),
          )))
        : h("div.hint", "No speaking parts yet. A clip with no dialogue is fine — just don't mention talking in the description."),

      h("div.sep"),
      h("h4.sec", "What the model expects"),
      h("div.note.info",
        h("b", "Speaker ids are stable"), " — (S1) in shot 1 and (S1) in shot 4 are the same person, and the model keeps the voice."),
      h("div.note.info",
        h("b", "Words are verbatim"), " — inside ", h("code", "<d>[Language] … </d>"),
        ". Eleven languages are supported and the prompt layer never translates them."),
      h("div.note.warn",
        h("b", "Never mention talking without words"), " — \"they chat quietly\" makes the model invent dialogue, and it will not be in your language."),
      h("div.note.info",
        h("b", "Voiceover has an exact phrase"), " — \"says in an off-screen voiceover\", followed by a statement that the lips stay closed. Anything else and the mouth moves."),
      h("div.note.warn",
        h("b", "Three fields, no overlap"), " — dialogue in the description, ambience in overall_soundscape, score in non_diegetic_music. Saying music twice is the most common way to get two competing tracks."),
    ),
  );
}

function draw() {
  const p = getProject();
  mount(root, h("div.cols", dialoguePanel(p), mixPanel(p), castPanel(p)));
}

export function render(el) { root = el; draw(); }
export function refresh() { if (root) draw(); }
