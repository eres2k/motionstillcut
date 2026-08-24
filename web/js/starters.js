/* STARTER PROJECTS.
 *
 * templates.js holds shot STRUCTURES — a cutting pattern with the camera
 * grammar filled in and nothing written. These are different: complete little
 * projects, written through, that render as they stand.
 *
 * They exist for the two hardest moments. The first is the blank page, where
 * "one continuous shot, three beats" is not actually a starting point because
 * you still have to invent everything that goes in it. The second is learning
 * what this model wants: reading a prompt that is already in H3's grammar —
 * beats as bare clauses, camera stated with amplitude and speed, a speaker
 * described before they talk, a soundscape that names sounds — teaches the
 * format faster than any amount of documentation, and you can render it,
 * change one thing, and render it again.
 *
 * Every one of these passes the checker with no errors. That is deliberate and
 * it is tested: a starter that warns the moment you open it teaches the wrong
 * thing.
 */

import { blankProject, newShot, newBeat, newDialogue } from "./state.js";
import { uid } from "./util.js";

function shot(at, spec) {
  const s = newShot(at);
  const { beats = [], camera = {}, dialogue = [], ...rest } = spec;
  Object.assign(s, rest);
  s.camera = { ...s.camera, ...camera };
  s.beats = beats.map((b, i) => newBeat(typeof b === "string" ? b : b.text, i === 0 ? "" : (b.link || "then")));
  s.dialogue = dialogue.map(d => ({ ...newDialogue(d.speaker || "S1"), ...d }));
  return s;
}

const make = (name, fields) => {
  const p = blankProject();
  Object.assign(p, fields);
  p.id = uid();
  p.name = name;
  p.createdAt = Date.now();
  p.jobs = [];
  p.selectedShot = p.shots?.[0]?.id || null;
  return p;
};

export const STARTERS = [
  {
    key: "blank",
    name: "Empty project",
    blurb: "Nothing written. Start from Create, or type straight into the canvas.",
    icon: "▢",
    build: () => make("Untitled Timeline", {}),
  },

  {
    key: "one-take",
    name: "One take, one person",
    blurb: "A single five-second shot with three beats and a stated camera move. The shape that survives H3's coherence window most reliably.",
    icon: "▣",
    build: () => make("One take", {
      mode: "t2v",
      render: { duration: 5, resolution: "832x480" },
      style: { look: "live-action cinematic", grade: "neutral Rec.709 grade with true blacks", extra: "" },
      shots: [shot(0, {
        shotType: "medium", viewpoint: "front-facing",
        subject: "a barista in a grey apron behind a wooden counter",
        setting: "a narrow café at closing time, chairs already on the tables",
        lighting: "one warm lamp over the bar, the rest of the room dark",
        camera: { type: "push in", amplitude: "small", speed: "slow", target: "the cup" },
        beats: [
          "pours the last of the water in a slow spiral",
          { text: "lifts the kettle away and sets it down", link: "then" },
          { text: "the steam bends toward the cold window", link: "as" },
        ],
        sfx: "the kettle clicks against the drip tray",
      })],
      sound: {
        soundscape: "Low room tone with the hum of a fridge underneath. Water pours steadily, then the kettle sets down on metal.",
        music: "", musicOff: true, silent: false,
      },
    }),
  },

  {
    key: "two-hander",
    name: "Two people talking",
    blurb: "Two shots, two described voices, one line each. Everything H3 needs to keep two voices apart — the thing it gets wrong when you leave it to guess.",
    icon: "❝",
    build: () => make("Two people talking", {
      mode: "t2v",
      render: { duration: 10, resolution: "832x480" },
      style: { look: "live-action cinematic", grade: "cool blue night grade with deep shadows and clean highlights", extra: "" },
      shots: [
        shot(0, {
          shotType: "medium wide", viewpoint: "side",
          subject: "a woman in a charcoal coat and a man across a small table",
          setting: "a rain-streaked café window at night",
          lighting: "a single practical lamp between them",
          camera: { type: "static" },
          beats: ["lowers her cup without letting go of it", { text: "looks up at him", link: "then" }],
          dialogue: [{
            speaker: "S1",
            identity: "The woman in the charcoal coat, with a low, tired voice",
            delivery: "says quietly",
            text: "You said you'd call.",
          }],
        }),
        shot(5, {
          shotType: "close-up", viewpoint: "over-the-shoulder",
          subject: "the man",
          camera: { type: "push in", amplitude: "small", speed: "slow" },
          beats: ["turns his glass a quarter turn on the table", { text: "keeps his eyes on it", link: "and" }],
          dialogue: [{
            speaker: "S2",
            identity: "The man opposite her, in a flat, unhurried voice",
            delivery: "says",
            text: "I did. You didn't pick up.",
          }],
        }),
      ],
      sound: {
        soundscape: "Rain ticks unevenly against the glass. Cups settle on saucers and a chair scrapes somewhere behind them.",
        music: "", musicOff: true, silent: false,
      },
    }),
  },

  {
    key: "establish",
    name: "Wide, medium, close",
    blurb: "The default documentary grammar in three shots — the place, the person, the thing they are doing — with a cut every five seconds.",
    icon: "⬛",
    build: () => make("Wide, medium, close", {
      mode: "t2v",
      render: { duration: 15, resolution: "1344x768" },
      style: { look: "documentary handheld", grade: "warm golden-hour grade, amber highlights and soft shadows", extra: "" },
      shots: [
        shot(0, {
          shotType: "wide", viewpoint: "front-facing",
          subject: "a wet market street just after dawn",
          setting: "stalls still going up, the road dark with rain",
          camera: { type: "pan right", amplitude: "large", speed: "slow" },
          beats: ["a shutter rolls up at the far end", { text: "a van pulls away from the kerb", link: "as" }],
        }),
        shot(5, {
          shotType: "medium", viewpoint: "side",
          subject: "a fishmonger in a rubber apron",
          camera: { type: "tracking", amplitude: "small", speed: "normal" },
          beats: ["tips a crate of ice across the slab", { text: "levels it with the flat of his hand", link: "then" }],
          sfx: "ice hitting steel, then the scrape of it being spread",
        }),
        shot(10, {
          shotType: "extreme close-up", viewpoint: "top-down",
          subject: "his hands",
          camera: { type: "static" },
          beats: ["set one fish on the ice", { text: "turn it until it faces the street", link: "then" }],
        }),
      ],
      sound: {
        soundscape: "Rain on canvas awnings and standing water underfoot. Crates knock together, ice scatters across metal, and a van pulls away in the distance.",
        music: "", musicOff: true, silent: false,
      },
    }),
  },

  {
    key: "voiceover",
    name: "Voiceover over a still scene",
    blurb: "The one form H3 gives an exact phrase to. A locked-off shot with a line spoken off screen, and the statement that the lips stay closed.",
    icon: "◐",
    build: () => make("Voiceover", {
      mode: "t2v",
      render: { duration: 10, resolution: "832x480" },
      style: { look: "35mm film", grade: "bleach-bypass look, desaturated with crushed blacks and hard contrast", extra: "" },
      shots: [shot(0, {
        shotType: "medium", viewpoint: "front-facing",
        subject: "a man at the wheel of a parked car",
        setting: "a lay-by above a road that runs out into fields",
        lighting: "flat overcast light through the windscreen",
        camera: { type: "static" },
        beats: ["watches the road without moving", { text: "his hands stay on the wheel", link: "while" }],
        dialogue: [{
          speaker: "S1",
          identity: "The man in the car, in a measured voice with a slight rasp",
          text: "I still remember that road.",
          voiceover: true,
        }],
      })],
      sound: {
        soundscape: "The engine ticks as it cools. Wind moves across the open window and the fields beyond.",
        music: "Sustained low strings at a slow tempo, entering late and holding at a low volume without a swell.",
        musicOff: false, silent: false,
      },
    }),
  },
];

export const starter = (key) => STARTERS.find(s => s.key === key) || null;
