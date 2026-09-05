/* SPOKEN LINES — write them, tighten them, say them, put them in the prompt.
 *
 * The usual order is backwards for dialogue: generate, then lay a voice-over
 * on top and hope the mouth roughly moves. This block turns it around, and it
 * lives where clips are SHAPED (Create) as well as where they are rendered
 * (Deliver ▸ Audio), reading the same project either way:
 *
 *   lines     — either the user's EXACT words (kept verbatim) or a rough
 *               DIRECTION the LLM writes from, together with the timeline.
 *   ⚡        — the optimizer: refit the draft to the clip's seconds without
 *               paraphrasing exact words away.
 *   ● record  — one mic take read off the box like a teleprompter; it becomes
 *               the LTX conditioning track, and the render lip-syncs to it.
 *               (LTX-2.5 only — MiniMax has no conditioning input.)
 *   →         — the lines land on their shots as dialogue, so the compiled
 *               prompt says the words are SPOKEN, in the engine's own dialect
 *               (H3's (S1) grammar, LTX's quoted prose). With a take this is
 *               what makes conditioning stick; without one the model simply
 *               speaks the lines itself — text alone is a complete path.
 *
 * The take is re-encoded to WAV in the browser (WebAudio decode → 16-bit
 * PCM): MediaRecorder hands back webm/opus, which ComfyUI's LoadAudio may or
 * may not read depending on its av build — WAV always loads. */

import { h, toast, segmented, textarea, select, uid, $ } from "./util.js";
import { update, newDialogue, activeEngine } from "./state.js";
import { putBlob } from "./media.js";
import { voiceoverScript } from "./llm.js";
import { VOICE_LANGS } from "./voice.js";

let lines = "";
let mode = "direction";   // "direction": intent the LLM writes from · "exact": these words, verbatim
let stamps = null;        // the last LLM result's [{at, text}] — lets → land lines on their shots
let lang = "de";
let rec = null, recSecs = 0, recTimer = null;
let busy = false;

const LANG_NAMES = { de: "German", en: "English", fr: "French", es: "Spanish", it: "Italian", pt: "Portuguese" };

async function dataUrlToWav(dataUrl) {
  const buf = await (await fetch(dataUrl)).arrayBuffer();
  const ctx = new AudioContext();
  let audio;
  try { audio = await ctx.decodeAudioData(buf); } finally { ctx.close(); }
  const n = audio.length, rate = audio.sampleRate, chs = audio.numberOfChannels;
  const mono = new Float32Array(n);
  for (let c = 0; c < chs; c++) { const d = audio.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / chs; }
  const out = new DataView(new ArrayBuffer(44 + n * 2));
  const tag = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  tag(0, "RIFF"); out.setUint32(4, 36 + n * 2, true); tag(8, "WAVEfmt ");
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  tag(36, "data"); out.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, mono[i])); out.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  const bytes = new Uint8Array(out.buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return "data:audio/wav;base64," + btoa(bin);
}

async function record(p, redraw) {
  if (rec) { rec.stop(); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { return toast("No microphone", e.message, "err"); }
  const chunks = [];
  const mr = new MediaRecorder(stream);
  mr.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  mr.onstop = async () => {
    clearInterval(recTimer); recTimer = null;
    stream.getTracks().forEach(t => t.stop());
    rec = null;
    try {
      const raw = await new Promise((res, rej) => {
        const rd = new FileReader(); rd.onload = () => res(rd.result); rd.onerror = () => rej(new Error("could not read the take"));
        rd.readAsDataURL(new Blob(chunks, { type: mr.mimeType || "audio/webm" }));
      });
      const wav = await dataUrlToWav(raw);
      const id = uid();
      await putBlob(id, wav);
      const name = `${(lines.trim().split(/\s+/).slice(0, 4).join(" ") || "spoken line").replace(/[^\w\s-]+/g, "").trim() || "spoken line"}.wav`;
      update((proj) => {
        proj.render.ltxAudio = { ...(proj.render.ltxAudio || {}), item: { id, name, kind: "audio", comfyName: "" }, startSec: 0 };
      }, "render");
      toast("Take is the track", `"${name}" now conditions the render — the model animates to it. Deliver ▸ Audio holds the knobs.`, "ok");
    } catch (e) { toast("Take lost", e.message, "err"); }
    redraw();
  };
  rec = mr; recSecs = 0;
  recTimer = setInterval(() => {
    recSecs++;
    const el = $("#lines-timer"); if (el) el.textContent = `■ Stop · ${recSecs}s`;
    // No point recording past what the clip can hold.
    if (recSecs >= ((p.render?.duration || 5) + 5)) mr.stop();
  }, 1000);
  mr.start();
  redraw();
}

async function write(p, redraw) {
  busy = true; redraw();
  try {
    const direction = mode === "direction" ? lines.trim() : "";
    const r = await voiceoverScript(p, {
      seconds: p.render.duration, language: lang,
      instruction: direction ? `The user's direction for the lines — follow it over everything the timeline suggests: ${direction}` : "",
    });
    lines = r.script;
    stamps = r.lines?.length ? r.lines : null;
    mode = "exact";   // what came back is now the text — the next edit is on words, not intent
  } catch (e) { toast("No lines", e.message, "err"); }
  busy = false; redraw();
}

async function tighten(p, redraw) {
  if (!lines.trim()) return toast("Nothing to tighten", "Write a draft first, or let ✎ write one.", "err");
  busy = true; redraw();
  try {
    const keep = mode === "exact"
      ? "These are the user's own words: do not paraphrase distinctive wording away — trim, reorder for breath, and cut filler, nothing more."
      : "Keep its intent and its voice.";
    const r = await voiceoverScript(p, {
      seconds: p.render.duration, language: lang,
      instruction: `Rework this draft instead of writing fresh. ${keep} Cut it until it fits the seconds comfortably, make every sentence speakable in one breath, end on the strongest line. The draft:\n${lines.trim()}`,
    });
    lines = r.script;
    stamps = r.lines?.length ? r.lines : null;
    mode = "exact";
  } catch (e) { toast("Optimizer failed", e.message, "err"); }
  busy = false; redraw();
}

function intoPrompt() {
  const text = lines.trim();
  if (!text) return toast("No lines yet", "Write them, or let ✎ write them.", "err");
  const langName = LANG_NAMES[lang] || "English";
  update((proj) => {
    const shots = [...(proj.shots || [])].sort((a, b) => (a.at || 0) - (b.at || 0));
    if (!shots.length) return;
    const use = stamps?.length ? stamps : [{ at: 0, text }];
    for (const ln of use) {
      let target = shots[0];
      for (const s of shots) if ((s.at || 0) <= (ln.at || 0)) target = s;
      const d = newDialogue("S1");
      d.text = ln.text; d.language = langName;
      target.dialogue = [...(target.dialogue || []), d];
    }
  }, "shots");
  toast("Lines are in the prompt", "They compile as spoken dialogue — edit speaker, delivery and language on the Sound page.", "ok");
}

/** The block both pages embed. Neutral markup; the page provides the frame
 *  (Deliver folds it into the Audio card, Create sets it under the grid). */
export function linesBlock(p, redraw) {
  const ltx = activeEngine(p) === "ltx25";
  return h("div.lines-block",
    h("div.flex", { style: { gap: "6px", alignItems: "center", flexWrap: "wrap" } },
      segmented([["direction", "A direction"], ["exact", "My exact words"]], mode, (v) => { mode = v; redraw(); }),
      h("span.spacer"),
      select(VOICE_LANGS, lang, (v) => { lang = v; }),
    ),
    h("div.hint", { style: { margin: "4px 0 0" } }, mode === "direction"
      ? "Type the intent — \"warm, du-form, sell the ending\" — and ✎ writes lines from it and the timeline."
      : "This text is the text: ⚡ only trims and re-breathes it, ● reads it, → puts it in the prompt verbatim."),
    textarea(lines, (v) => { lines = v; stamps = null; }, {
      rows: "3",
      placeholder: mode === "direction" ? "What should the voice say, roughly?" : "The words, exactly as they are to be spoken",
      style: "margin-top:6px",
    }),
    h("div.flex", { style: { gap: "5px", marginTop: "6px", flexWrap: "wrap" } },
      h("button.btn.sm", { type: "button", onclick: () => write(p, redraw), disabled: busy, title: "Write lines that fit the clip's seconds — from the timeline, and from the direction above if there is one" }, busy ? "…" : "✎ Write"),
      h("button.btn.sm", { type: "button", onclick: () => tighten(p, redraw), disabled: busy, title: "Rework the draft to fit the seconds — exact words are trimmed, never paraphrased away" }, "⚡ Tighten"),
      ltx ? h("button.btn.sm" + (rec ? ".record" : ""), { type: "button", onclick: () => record(p, redraw), title: "One mic take, read off this box — it becomes the conditioning track (Deliver ▸ Audio), and the render lip-syncs to it" },
        rec ? h("span", { id: "lines-timer" }, `■ Stop · ${recSecs}s`) : "● Record it") : null,
      h("button.btn.sm", { type: "button", onclick: intoPrompt, title: "Put the lines into the timeline as dialogue, so the compiled prompt says these words are SPOKEN — with a take that is what makes the conditioning stick; without one the model speaks them itself" }, "→ Into the prompt"),
    ),
  );
}
