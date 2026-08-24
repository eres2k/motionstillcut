/* MOTIONSTILL CUT — the readthrough.
 *
 * You cannot see a prompt. You can read it, and you can render it forty
 * minutes later and find out you were wrong, and in between there is nothing —
 * which is why prompt engineering for video feels like guesswork even when you
 * know the grammar.
 *
 * The readthrough closes that gap by playing the prompt back. Not a preview of
 * the video: a preview of the INSTRUCTIONS, in time, so you can watch what the
 * model will be told at every moment of the clip and catch the mistakes that
 * only exist in time — six beats crammed into five seconds, a camera move that
 * never ends, dialogue with no room to be said, a reference cited in a shot it
 * cannot help, silence you never asked for.
 *
 * Three views of the same instant, locked together:
 *
 *   THE PLATE     where the frame is and where the camera is taking it.
 *   THE SCORE     every channel of the prompt as a lane on one timeline —
 *                 shots, action, camera, speech, sound, music, references —
 *                 so density and emptiness are visible as shapes rather than
 *                 discovered by counting words.
 *   THE TEXT      the compiled description with the clause that is in effect
 *                 RIGHT NOW lit up, scrolling itself as the playhead moves.
 *
 * The text view is the point. Every other tool shows you a prompt as a block
 * you scroll; this one shows you which sentence the model is acting on at
 * 00:03.2, which is the only way to see that your second beat and your camera
 * move and your one line of dialogue are all fighting for the same second.
 */

import { h, clamp, timecode } from "./util.js";
import { orderedShots, shotActionText, dimensions } from "./state.js";
import {
  framingSentence, cameraSentence, dialogueSentence, beatsProse,
  compilePrompt, compileSoundscape, compileMusic, expandTokens,
} from "./prompt.js";
import { referenceInventory } from "./state.js";
import { createPreviz } from "./previz.js";
import { renderPrompt } from "./prompttext.js";

/* ── Channels ─────────────────────────────────────────────────
 * What a lane is, what colour it reads as, and — the part that matters — what
 * kind of mistake it exists to expose. */
export const CHANNELS = [
  { id: "shot",   label: "Shots",      colour: "#7fb2e5" },
  { id: "action", label: "Action",     colour: "#e0a13a" },
  { id: "camera", label: "Camera",     colour: "#c79ae0" },
  { id: "speech", label: "Speech",     colour: "#e58f8f" },
  { id: "sound",  label: "Sound",      colour: "#79c79b" },
  { id: "music",  label: "Music",      colour: "#5fae86" },
  { id: "refs",   label: "References", colour: "#9aa8bb" },
];

const AMP = { small: 0.34, medium: 0.62, large: 1 };
const SPD = { slow: 0.4, normal: 0.7, fast: 1 };

/** How hard the camera is working, 0–1. Two dials the guide always pairs. */
export const cameraLoad = (camera = {}) =>
  !camera.type || camera.type === "static"
    ? 0
    : clamp((AMP[camera.amplitude] ?? 0.62) * (SPD[camera.speed] ?? 0.7) * 1.35, 0.08, 1)
      + (camera.secondary && camera.secondary !== "none" ? 0.15 : 0);

/**
 * The score: every clause of the compiled prompt, with the window of time it
 * is in effect.
 *
 * The timing model is the one the model itself is working from — MiniMax say a
 * beat lands every 2–3 seconds and give no other alignment — so beats divide
 * their shot evenly, the establishing clauses (what the shot IS) hold over its
 * opening, and the camera holds across the whole of it. Stating that plainly
 * is the honest thing to do: this is a reading of the prompt, not a prediction
 * of the render.
 */
export function buildScore(project) {
  const duration = project.render?.duration || 5;
  const shots = orderedShots(project);
  const inv = referenceInventory(project);
  const clauses = [];
  const add = (c) => { if (c.text && String(c.text).trim()) clauses.push(c); };

  shots.forEach((shot, i) => {
    const start = shot.at || 0;
    const end = i + 1 < shots.length ? shots[i + 1].at : duration;
    const len = Math.max(0.001, end - start);
    // The establishing clauses hold over the shot's opening — long enough to
    // read, never past the shot itself.
    const estEnd = Math.min(end, start + Math.max(0.8, len * 0.34));
    const est = { from: start, to: estEnd, shot: i };

    const shotType = shot.shotType || "medium";
    const subject = expandTokens((shot.subject || "").trim());
    add({ ...est, channel: "shot", role: "framing",
      text: i === 0
        ? `${project.style?.look || "live-action cinematic"} ${shotType} shot, ${shot.viewpoint || "front-facing"}${subject ? `: ${subject}` : ""}`
        : `${shot.cutVerb || "the camera cuts to"} a ${shotType} shot, ${shot.viewpoint || "front-facing"}${subject ? ` of ${subject}` : ""}` });
    add({ ...est, channel: "shot", role: "composition", text: framingSentence(shot.camera, shotType) });
    add({ ...est, channel: "shot", role: "setting", text: expandTokens((shot.setting || "").trim()) });
    add({ ...est, channel: "shot", role: "light", text: shot.lighting });
    if (i === 0) {
      add({ ...est, channel: "shot", role: "grade", text: project.style?.grade });
      add({ ...est, channel: "shot", role: "style", text: expandTokens(project.style?.extra) });
    }
    add({ ...est, channel: "shot", role: "detail", text: expandTokens(shot.details) });

    // Beats divide the shot evenly — the same assumption the previz makes and
    // the same one the model is given.
    const beats = (shot.beats || []).map(b => ({ ...b, text: expandTokens((b.text || "").trim()) })).filter(b => b.text);
    const slot = len / Math.max(1, beats.length);
    beats.forEach((b, bi) => add({
      channel: "action", role: "beat", shot: i, beat: bi,
      from: start + bi * slot, to: start + (bi + 1) * slot, text: b.text,
    }));

    add({ channel: "camera", role: "camera", shot: i, from: start, to: end,
      text: cameraSentence(shot.camera), load: cameraLoad(shot.camera) });

    const lines = shot.dialogue || [];
    const dslot = len / Math.max(1, lines.length);
    lines.forEach((line, li) => add({
      channel: "speech", role: "dialogue", shot: i,
      from: start + li * dslot, to: start + (li + 1) * dslot,
      text: dialogueSentence(line), words: line.text, speaker: line.speaker,
    }));

    add({ channel: "sound", role: "sfx", shot: i, from: start, to: end, text: shot.sfx });

    // A reference is "in play" in a shot that actually cites its tag.
    const cited = [shot.subject, shotActionText(shot), shot.details, shot.setting].join(" ");
    for (const entry of inv) {
      if (!entry.tag || !cited.includes(entry.tag)) continue;
      add({ channel: "refs", role: "reference", shot: i, from: start, to: end,
        text: `${entry.tag} — ${entry.ref?.label || entry.ref?.name || entry.kind}${entry.ref?.retention ? `, kept ${entry.ref.retention}` : ""}`,
        tag: entry.tag });
    }
  });

  // Sound and music run the length of the clip: H3 generates one continuous
  // 32 kHz track, not a track per shot.
  const soundscape = compileSoundscape(project);
  const music = compileMusic(project);
  add({ channel: "sound", role: "soundscape", from: 0, to: duration,
    text: soundscape === "N/A" ? "deliberate silence" : soundscape, silent: soundscape === "N/A" });
  add({ channel: "music", role: "music", from: 0, to: duration,
    text: music === "N/A" ? "no score" : music, silent: music === "N/A" });

  return { duration, shots, clauses, inv };
}

/** Everything in effect at time t, newest-shot-first within each channel. */
export const clausesAt = (score, t) =>
  score.clauses.filter(c => t >= c.from - 1e-6 && t < c.to - 1e-6);

/**
 * How busy each second is, as a count of things starting in it. This is what
 * makes "too much crammed into three seconds" visible as a shape.
 */
export function densityCurve(score, samples = 120) {
  const out = new Array(samples).fill(0);
  const step = score.duration / samples;
  for (const c of score.clauses) {
    if (c.channel === "sound" || c.channel === "music" || c.channel === "refs") continue;
    const i = clamp(Math.floor(c.from / step), 0, samples - 1);
    out[i] += c.channel === "action" ? 1 : c.channel === "speech" ? 1.2 : 0.5;
  }
  // Smooth it, so one crowded sample reads as a hill rather than a spike.
  return out.map((_, i) => {
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - 4); j <= Math.min(samples - 1, i + 4); j++) { sum += out[j]; n++; }
    return sum / n;
  });
}

/* ── The player ───────────────────────────────────────────────
 * One clock drives all three views. The previz owns it, because it already
 * animates the plate at frame rate; everything else is repainted from its
 * onTime, which keeps the lanes and the text exactly in step with the picture
 * rather than approximately in step with it.
 */
export function createReadthrough(project, { backgroundFor = () => null, startAt = 0, onTime = null } = {}) {
  const score = buildScore(project);
  const { duration } = score;
  const fps = project.render?.fps || 24;

  /* ── The text, once, as elements we can light up ─────────── */
  const clauseEls = new Map();
  const textEl = h("div.rt-text");
  const bySho = new Map();
  for (const c of score.clauses) {
    if (c.channel === "sound" || c.channel === "music") continue;
    const key = c.shot ?? 0;
    if (!bySho.has(key)) bySho.set(key, []);
    bySho.get(key).push(c);
  }
  [...bySho.keys()].sort((a, b) => a - b).forEach((si) => {
    const group = h("div.rt-para", h("span.rt-shotmark", `[Shot ${si + 1}]`));
    // Read in the order the compiled prompt reads: what it is, then what
    // happens, then how it is shot, then what is said.
    const order = { framing: 0, composition: 1, beat: 2, setting: 3, light: 4, grade: 5, style: 6, camera: 7, detail: 8, dialogue: 9, reference: 10, sfx: 11 };
    const items = bySho.get(si).slice().sort((a, b) => (order[a.role] ?? 99) - (order[b.role] ?? 99) || a.from - b.from);
    for (const c of items) {
      // Reference tags become chips here too, so you can see WHICH picture a
      // clause is citing at the moment it lights up.
      const el = h("span", { class: `rt-clause rt-${c.channel}`, dataset: { role: c.role } });
      el.appendChild(renderPrompt(`${c.text} `, project));
      clauseEls.set(c, el);
      group.appendChild(el);
    }
    textEl.appendChild(group);
  });
  // Sound and music are one continuous track over the whole clip, so they read
  // as their own block at the end — which is exactly where they sit in the
  // compiled prompt's own fields.
  const soundC = score.clauses.find(c => c.role === "soundscape");
  const musicC = score.clauses.find(c => c.role === "music");
  for (const [c, label] of [[soundC, "overall_soundscape"], [musicC, "non_diegetic_music"]]) {
    if (!c) continue;
    const el = h("span", { class: `rt-clause rt-${c.channel}${c.silent ? " rt-silent" : ""}` }, c.text);
    clauseEls.set(c, el);
    textEl.appendChild(h("div.rt-para.rt-field", h("span.rt-fieldname", label), el));
  }

  /* ── The lanes ───────────────────────────────────────────── */
  const pct = (t) => `${clamp((t / duration) * 100, 0, 100)}%`;
  const laneEls = new Map();
  const lanesEl = h("div.rt-lanes");

  for (const ch of CHANNELS) {
    const items = score.clauses.filter(c =>
      c.channel === ch.id && c.text
      // Every establishing clause of a shot shares one window, so a lane
      // showing all of them prints six labels on top of each other. The lane
      // carries the shot itself; the rest is what the text panel is for.
      && (ch.id !== "shot" || c.role === "framing")
      && (ch.id !== "sound" || c.role === "soundscape"));
    const track = h("div.rt-track");
    for (const c of items) {
      const block = h("div", {
        class: `rt-block${c.silent ? " silent" : ""}`,
        style: {
          left: pct(c.from), width: `calc(${pct(c.to - c.from)} - 2px)`,
          background: c.silent ? "transparent" : ch.colour,
          borderColor: ch.colour,
          // The camera lane says how hard the move is by how tall it is: a
          // slow small push and a fast large orbit are not the same request.
          // Effort as height, with a floor: a static camera is still a block
          // you can read, not a hairline.
          ...(c.channel === "camera" ? { height: `${44 + (c.load || 0) * 40}%`, top: `${28 - (c.load || 0) * 20}%`, bottom: "auto" } : {}),
        },
        title: c.text,
      }, h("span", c.channel === "camera" ? (c.load ? c.text : "static") : c.text));
      laneEls.set(c, block);
      track.appendChild(block);
    }
    if (!items.length) track.appendChild(h("div.rt-none", ch.id === "speech" ? "nobody speaks" : ch.id === "refs" ? "no references cited" : "—"));
    lanesEl.appendChild(h("div", { class: `rt-lane rt-lane-${ch.id}` },
      h("div.rt-lane-lb", h("i", { style: { background: ch.colour } }), ch.label),
      track,
    ));
  }

  /* Density: where the clip is crowded, as a hill. */
  const curve = densityCurve(score);
  const peak = Math.max(0.001, ...curve);
  const spark = h("div.rt-density", ...curve.map(v => h("i", { style: { height: `${(v / peak) * 100}%` } })));
  lanesEl.appendChild(h("div.rt-lane.rt-lane-density",
    h("div.rt-lane-lb", h("i", { style: { background: "#5a6a7a" } }), "Density"),
    h("div.rt-track", spark),
  ));

  const playhead = h("div.rt-playhead");
  const ruler = h("div.rt-ruler");
  for (let s = 0; s <= duration; s += duration > 15 ? 5 : duration > 8 ? 2 : 1) {
    ruler.appendChild(h("i", { style: { left: pct(s) } }, `${s}s`));
  }
  const scroller = h("div.rt-scroll", ruler, lanesEl, playhead);

  /* ── The now-readout ─────────────────────────────────────── */
  const nowEl = h("div.rt-now");
  const timeEl = h("span.rt-time.mono", timecode(startAt, fps));

  /* ── The plate ───────────────────────────────────────────── */
  let live = [];
  // `let`, not `const`: createPreviz calls onTime once while it is still
  // constructing, and paint() reads the player back to decide whether to
  // auto-scroll. A const would be in its temporal dead zone at that moment.
  let previz;
  previz = createPreviz(project, {
    startAt, backgroundFor,
    onTime: (t) => paint(t),
  });

  function paint(t) {
    timeEl.textContent = timecode(t, fps);
    playhead.style.left = pct(t);

    const on = clausesAt(score, t);
    // Only touch what changed: this runs at frame rate.
    for (const c of live) if (!on.includes(c)) {
      clauseEls.get(c)?.classList.remove("live");
      laneEls.get(c)?.classList.remove("live");
    }
    for (const c of on) if (!live.includes(c)) {
      clauseEls.get(c)?.classList.add("live");
      laneEls.get(c)?.classList.add("live");
    }
    live = on;

    // Keep the lit clause in view without fighting a person who is scrolling.
    const lead = on.find(c => c.channel === "action") || on.find(c => c.channel === "shot");
    const el = lead && clauseEls.get(lead);
    if (el && previz?.isPlaying) {
      const box = textEl.getBoundingClientRect(), r = el.getBoundingClientRect();
      if (r.top < box.top + 6 || r.bottom > box.bottom - 6) {
        textEl.scrollTop += r.top - box.top - box.height * 0.34;
      }
    }

    const shotC = on.find(c => c.role === "framing");
    const beatC = on.find(c => c.channel === "action");
    const camC = on.find(c => c.channel === "camera");
    const sayC = on.find(c => c.channel === "speech");
    const refs = on.filter(c => c.channel === "refs");
    const beats = beatC ? score.clauses.filter(c => c.channel === "action" && c.shot === beatC.shot) : [];

    nowEl.replaceChildren(...[
      h("div.rt-row", h("b", `Shot ${(shotC?.shot ?? beatC?.shot ?? 0) + 1}`),
        h("span.rt-dim", `of ${score.shots.length}`),
        camC?.load ? h("span.rt-pill", { style: { borderColor: "#c79ae0", color: "#c79ae0" } }, camC.text.replace(/^The camera /, "")) 
                   : h("span.rt-pill.rt-quiet", "camera static")),
      beats.length ? h("div.rt-row",
        h("span.rt-dim", "Action"),
        h("span.rt-beats", ...beats.map(b => h("i", { class: b === beatC ? "on" : "" }, b.text))),
      ) : h("div.rt-row", h("span.rt-dim", "Action"), h("span.rt-warn", "nothing happens in this shot")),
      sayC ? h("div.rt-row", h("span.rt-dim", `(${sayC.speaker})`), h("span.rt-say", `“${sayC.words}”`)) : null,
      refs.length ? h("div.rt-row", h("span.rt-dim", "In play"),
        h("span", ...refs.map(r => h("span.rt-pill", { style: { borderColor: "#9aa8bb" } }, r.tag)))) : null,
      // replaceChildren renders a null as the literal text "null".
    ].filter(Boolean));
    onTime?.(t);
  }

  const bar = h("div.rt-bar",
    h("button.rt-play", { onclick: () => api.toggle() }, "▶"),
    timeEl,
    h("span.rt-dim", `/ ${duration}s · ${score.shots.length} shot${score.shots.length === 1 ? "" : "s"}`),
    h("span.grow"),
    h("span.rt-dim", "click the lanes to scrub"),
  );

  scroller.addEventListener("pointerdown", (e) => {
    const track = e.target.closest(".rt-track") || e.target.closest(".rt-scroll");
    if (!track) return;
    const seekTo = (ev) => {
      const r = (track.classList.contains("rt-track") ? track : scroller).getBoundingClientRect();
      previz.seek(clamp((ev.clientX - r.left) / r.width, 0, 1) * duration);
    };
    seekTo(e);
    const move = (ev) => seekTo(ev);
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  const el = h("div.rt",
    h("div.rt-top", h("div.rt-plate", previz.el), h("div.rt-side", nowEl, textEl)),
    bar,
    scroller,
  );

  paint(startAt);
  const play = () => { previz.play(); const b = el.querySelector(".rt-play"); if (b) b.textContent = "❚❚"; };
  const pause = () => { previz.pause(); const b = el.querySelector(".rt-play"); if (b) b.textContent = "▶"; };
  const api = {
    el, score,
    play, pause,
    toggle: () => (previz.isPlaying ? pause() : play()),
    seek: (t) => previz.seek(t),
    time: () => previz.time,
    isPlaying: () => previz.isPlaying,
    destroy: () => previz.destroy(),
  };
  return api;
}
