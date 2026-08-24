/* MOTIONSTILL CUT — starter structures.
 *
 * Not style presets: shot STRUCTURES. Each one is a cutting pattern with the
 * camera grammar already filled in — you bring the subject.
 *
 * Every one of them fits inside what H3 renders: MiniMax specifies 4–15
 * seconds of output, and a template is a shape for the clip, never a way to
 * buy more of it. This file used to ship a 20-second montage whose blurb
 * said, in as many words, that five cuts were what made 20 seconds work.
 * They are not. A cut is prompt syntax inside ONE generation — it tells the
 * model when to change shot, not how long to generate — so that template was
 * a one-click path to the exact clip that repeats in its tail, sold with the
 * belief that produced it.
 */

import { newShot, newBeat } from "./state.js";
import { uid } from "./util.js";

function shot(at, spec) {
  const s = newShot(at);
  const { beats = [], camera = {}, ...rest } = spec;
  Object.assign(s, rest);
  s.camera = { ...s.camera, ...camera };
  s.beats = (beats.length ? beats : [""]).map((b, i) => newBeat(typeof b === "string" ? b : b.text, i === 0 ? "" : (b.link || "then")));
  return s;
}

export const TEMPLATES = [
  {
    key: "single",
    name: "Single take",
    blurb: "One continuous shot, three beats. The safest structure under 10 seconds, and the only one FL2VA-style interpolation likes.",
    duration: 5,
    build: () => [
      shot(0, {
        shotType: "medium", viewpoint: "front-facing",
        camera: { type: "push in", amplitude: "small", speed: "slow" },
        beats: ["", { text: "" }, { text: "" }],
      }),
    ],
  },
  {
    key: "establish",
    name: "Establish → close",
    blurb: "Wide for the place, medium for the person, close for the thing they are doing. The default documentary grammar.",
    duration: 10,
    build: () => [
      shot(0,   { shotType: "wide", viewpoint: "front-facing", camera: { type: "static" } }),
      shot(3.5, { shotType: "medium", viewpoint: "three-quarter", camera: { type: "push in", amplitude: "small", speed: "slow" } }),
      shot(7,   { shotType: "close-up", viewpoint: "side", camera: { type: "static" } }),
    ],
  },
  {
    key: "interview",
    name: "Talking head",
    blurb: "One speaker, one cut for emphasis. Dialogue lives on the Sound page; the second shot exists so a line can land on a closer frame.",
    duration: 10,
    build: () => [
      shot(0, {
        shotType: "medium close-up", viewpoint: "front-facing", camera: { type: "static" },
        dialogue: [{ id: uid(), speaker: "S1", language: "English", text: "", voiceover: false, note: "" }],
      }),
      shot(5.5, { shotType: "close-up", viewpoint: "three-quarter", camera: { type: "push in", amplitude: "small", speed: "slow" } }),
    ],
  },
  {
    key: "product",
    name: "Product turn",
    blurb: "An arc around the object, a detail, then a hero frame. Camera does the work; the subject barely moves.",
    duration: 10,
    build: () => [
      shot(0,   { shotType: "medium", viewpoint: "three-quarter", camera: { type: "arc left", amplitude: "medium", speed: "slow" } }),
      shot(4,   { shotType: "extreme close-up", viewpoint: "side", camera: { type: "push in", amplitude: "small", speed: "slow" } }),
      shot(7.5, { shotType: "medium", viewpoint: "front-facing", camera: { type: "static" } }),
    ],
  },
  {
    key: "reveal",
    name: "Reveal",
    blurb: "Hold on the detail, then pull out to what it belongs to. One cut, and the cut is the point.",
    duration: 10,
    build: () => [
      shot(0, { shotType: "extreme close-up", viewpoint: "front-facing", camera: { type: "static" } }),
      shot(4, { shotType: "extreme wide", viewpoint: "high-angle", camera: { type: "pull out", amplitude: "large", speed: "slow" } }),
    ],
  },
  {
    key: "montage",
    name: "Long-form montage",
    blurb: "Five shots across 15 seconds — the most cutting H3 holds together in one clip. A long take degrades well before this; the cuts are what keep it legible, not what make it longer.",
    duration: 15,
    build: () => [
      shot(0,  { shotType: "wide", viewpoint: "front-facing", camera: { type: "static" } }),
      shot(3,  { shotType: "medium", viewpoint: "side", camera: { type: "truck right", amplitude: "medium", speed: "normal" } }),
      shot(6,  { shotType: "close-up", viewpoint: "front-facing", camera: { type: "static" } }),
      shot(9,  { shotType: "medium wide", viewpoint: "over-the-shoulder", camera: { type: "tracking", amplitude: "medium", speed: "normal" } }),
      shot(12, { shotType: "wide", viewpoint: "high-angle", camera: { type: "pedestal up", amplitude: "medium", speed: "slow" } }),
    ],
  },
  {
    key: "refswap",
    name: "Reference performance (Ref2V)",
    blurb: "One subject from <Picture 1>, moving the way <Video 1> moves, speaking <Audio 1>. The structure ref2va was built for.",
    duration: 10,
    mode: "r2v",
    build: () => [
      shot(0, {
        shotType: "medium", viewpoint: "front-facing", camera: { type: "static" },
        subject: "<Picture 1>",
        beats: ["walks into frame and settles", { text: "delivers the line in <Audio 1>", link: "then" }],
      }),
      shot(5, { shotType: "medium close-up", viewpoint: "three-quarter", camera: { type: "push in", amplitude: "small", speed: "slow" }, subject: "<Picture 1>" }),
    ],
  },
];

export const templateByKey = (key) => TEMPLATES.find(t => t.key === key) || null;
