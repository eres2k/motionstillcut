/* GOLDEN FIXTURES — the projects the compiler is frozen against.
 *
 * Every one of these is a real shape the app produces, and one of them
 * (`i2v-two-speakers`) is a reconstruction of a prompt a user actually pasted
 * back with the question "is this right?". The answer was no, in four separate
 * ways, and none of them were visible from inside the app.
 *
 * These are deliberately built through the app's own constructors rather than
 * written as literals: a fixture that bypasses `newShot`/`newDialogue` stops
 * being evidence about the app the moment the model changes.
 */

import { blankProject, newShot, newBeat, newDialogue } from "../web/js/state.js";

/* Determinism: uid() is random, and a golden file cannot contain random ids.
 * Nothing the compiler emits depends on an id, so they are simply normalised
 * away where they would otherwise leak into a snapshot. */

const shot = (at, fields = {}) => {
  const s = newShot(at);
  const { beats, camera, dialogue, ...rest } = fields;
  Object.assign(s, rest);
  if (beats) s.beats = beats.map((b, i) => (typeof b === "string" ? newBeat(b, i === 0 ? "" : "then") : newBeat(b.text, b.link)));
  if (camera) s.camera = { ...s.camera, ...camera };
  if (dialogue) s.dialogue = dialogue.map(d => ({ ...newDialogue(d.speaker || "S1"), ...d }));
  return s;
};

export const FIXTURES = [
  {
    name: "t2v-single-shot",
    why: "The commonest project in the app. Guide Cases 3 and 4 are single shots and both keep [Shot 1].",
    build() {
      const p = blankProject();
      p.mode = "t2v";
      p.render = { ...p.render, duration: 5, resolution: "832x480" };
      p.shots = [shot(0, {
        subject: "a barista in a grey apron",
        beats: ["pours the last of the water in a slow spiral"],
        setting: "a narrow cafe at closing time",
        lighting: "one warm lamp over the bar",
        camera: { type: "push in", amplitude: "small", speed: "slow", target: "the cup" },
      })];
      p.sound = { ...p.sound, soundscape: "Steam hisses from the wand and cups clink on the drainer.", music: "" };
      return p;
    },
  },

  {
    name: "t2v-two-shots",
    why: "Cut times, the cut verb, and style carried on shot 1 only.",
    build() {
      const p = blankProject();
      p.mode = "t2v";
      p.render = { ...p.render, duration: 10 };
      p.style = { look: "live-action cinematic", grade: "teal-and-orange grade with cool shadows and warm skin tones", extra: "" };
      p.shots = [
        shot(0, {
          subject: "a woman in a charcoal coat",
          beats: ["lowers her cup", { text: "looks up", link: "then" }],
          setting: "a rain-streaked cafe window at night",
          camera: { type: "static" },
        }),
        shot(4.5, {
          subject: "her hands",
          shotType: "close-up",
          beats: ["twist the portafilter free"],
          camera: { type: "tilt down", amplitude: "small", speed: "slow" },
        }),
      ];
      return p;
    },
  },

  {
    name: "i2v-two-speakers",
    why: "The prompt a user pasted back. Two speakers, an image anchor, an auto-written soundscape.",
    build() {
      const p = blankProject();
      p.mode = "i2v";
      p.render = { ...p.render, duration: 5 };
      p.frames = { first: { id: "pic1", name: "first.png", label: "first", kind: "image", size: 9, comfyName: "", caption: "", retention: "", note: "" } };
      p.style = { look: "live-action cinematic", grade: "warm golden-hour grade, amber highlights and soft shadows", extra: "" };
      p.shots = [shot(0, {
        shotType: "medium wide",
        viewpoint: "side",
        subject: "A woman with long dark hair in a light blue t-shirt and jeans kneeling on the ground, and a standing man in a camouflage uniform and cap holding a bloody bandage on his arm",
        // Written by an LLM as capitalised standalone sentences — which is
        // exactly what produced "then She looks up" in the pasted prompt.
        beats: [
          "The woman kneels on the broken pavement with her hands clasped tightly at her chest",
          { text: "She looks up at the standing soldier with a face contorted in grief", link: "then" },
          { text: "The soldier stands rigid, staring down at her while clutching his injured arm", link: "then" },
        ],
        setting: "A dilapidated outdoor area with cracked pavement and scattered rubble in the background",
        lighting: "Single practical lamp in frame",
        details: "The Spartan warrior stands with his back to the camera, his fur-lined armor and axe visible",
        camera: { type: "tilt up", amplitude: "small", speed: "fast", secondary: "pan right", lens: "35mm" },
        dialogue: [
          { speaker: "S1", language: "English", text: "Please help us" },
          { speaker: "S2", language: "English", text: "I am sorry" },
        ],
      })];
      return p;
    },
  },

  {
    name: "i2v-voiceover",
    why: "The one form the guide mandates an exact phrase for.",
    build() {
      const p = blankProject();
      p.mode = "i2v";
      p.frames = { first: { id: "pic1", name: "road.png", label: "road", kind: "image", size: 9, comfyName: "", caption: "", retention: "", note: "" } };
      p.shots = [shot(0, {
        subject: "a man at the wheel of a parked car",
        beats: ["watches the road ahead without moving"],
        camera: { type: "static" },
        dialogue: [{ speaker: "S1", language: "English", text: "I still remember that road.", voiceover: true }],
      })];
      p.sound = { ...p.sound, soundscape: "Rain ticks on the roof of the car and the engine ticks as it cools." };
      return p;
    },
  },

  {
    name: "r2v-three-references",
    why: "The full-reference IR block: definitions, task type, retention markers.",
    build() {
      const p = blankProject();
      p.mode = "r2v";
      p.render = { ...p.render, duration: 10 };
      const img = (id, label) => ({ id, name: `${id}.png`, label, kind: "image", size: 9, comfyName: "", caption: "", retention: "", note: "" });
      p.refs = {
        images: [img("kratos", "kratos"), img("soldier", "soldier")],
        videos: [{ id: "walk", name: "walk.mp4", label: "walk", kind: "video", size: 99, comfyName: "", useAudio: true, retention: "", audioRetention: "", note: "" }],
        audios: [],
      };
      p.ref2v = { taskType: "", subjectDefs: "", summary: "", useFullIR: true };   // "" = derive it
      p.shots = [shot(0, {
        subject: "a bearded man and a soldier — <Subject 1> and <Subject 2>",
        beats: ["square up in the rain"],
        setting: "a flooded courtyard",
        camera: { type: "static" },
      })];
      return p;
    },
  },

  {
    name: "t2v-line-across-a-cut",
    why: "A line the cut lands in the middle of, and a line the clip ends before finishing. Both have their own tag in H3's grammar and neither was expressible.",
    build() {
      const p = blankProject();
      p.mode = "t2v";
      p.render = { ...p.render, duration: 10 };
      p.shots = [
        shot(0, {
          subject: "a baker opening the shutters of a small street bakery",
          beats: ["places a fresh loaf on the wooden counter"],
          camera: { type: "push in", amplitude: "small", speed: "slow" },
          dialogue: [{
            speaker: "S1",
            identity: "The middle-aged baker with a calm, slightly raspy voice",
            text: "First batch of the morning.",
            continues: true,
          }],
        }),
        shot(5, {
          shotType: "close-up",
          subject: "steam rising from the sliced bread",
          beats: ["curls toward the cold window"],
          camera: { type: "static" },
          dialogue: [{ speaker: "S1", text: "And the last of the rye—", cutoff: true }],
        }),
      ];
      p.sound = { ...p.sound, soundscape: "Wooden shutters scrape open and trays clink softly inside the bakery." };
      return p;
    },
  },

  {
    name: "silent",
    why: "N/A is a positive instruction for a silent video, and must only appear when asked for.",
    build() {
      const p = blankProject();
      p.mode = "t2v";
      p.shots = [shot(0, { subject: "an empty corridor", beats: ["holds still as the lights tick off one bank at a time"], camera: { type: "static" } })];
      p.sound = { soundscape: "", music: "", silent: true, musicOff: true };
      return p;
    },
  },
];

export const byName = (name) => {
  const f = FIXTURES.find(x => x.name === name);
  if (!f) throw new Error(`no fixture named ${name}`);
  return f.build();
};
