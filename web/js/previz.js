/* MOTIONSTILL CUT — previsualisation.
 *
 * The gap this closes: between writing a prompt and seeing a render there is
 * nothing, and an H3 clip costs minutes of GPU time to find out that the cut
 * lands too early or that four beats were packed into three seconds. Previz
 * plays the timeline back in real time — the cuts where they actually fall,
 * each shot's framing, the camera move animated at its own amplitude and
 * speed, the beats appearing when they would happen, the dialogue as captions.
 *
 * It is a simulation of the PROMPT, not a prediction of the model. It shows
 * timing, framing and structure — the three things a prompt can get wrong that
 * you can know about for free.
 *
 * Three of the four questions it is asked used to need something outside the
 * gate to answer, so each of them is answered inside it now:
 *
 *   WHERE AM I, AND WHEN DOES IT CUT?  A strip along the bottom: one block per
 *     shot at its real length, the beats ticked inside it, the playhead
 *     sweeping, and the seconds to the next cut said out loud. The timecode
 *     was never that question, and Create and the read-through have no
 *     timeline underneath to ask instead.
 *
 *   WHERE IS THE MOVE GOING?  The destination is drawn — a faint box where the
 *     move leaves the subject, and the line it travels — so an amplitude is a
 *     distance you can see rather than a word you have to picture. Speed is
 *     how much of the SHOT the move occupies, so when a fast one finishes
 *     early the camera line says the frame holds from here, instead of a held
 *     second reading as previz having stopped.
 *
 *   HOW IS IT LIT?  The frame is lit: the key where the lighting line puts it,
 *     as hard as the words ask, the shadow it leaves, and the grade's tint over
 *     the lot. The Light dial writes exactly those two fields, and until previz
 *     drew them the only evidence that dial did anything was a line of text.
 */

import { h, clear, timecode, shotTime } from "./util.js";
import { orderedShots, dimensions } from "./state.js";
import { GRADES } from "./vocab.js";
import { beatsProse } from "./prompt.js";

/* The colourist's shelf by its short name — a line on the frame has room for
 * "Low key" and not for the sentence the model reads. */
const GRADE_LABEL = Object.fromEntries(GRADES.map(([value, label]) => [value, label]));

/* Camera moves as transforms. Amplitude scales the distance, speed scales how
 * much of the shot the move occupies — a "slow" move runs the whole shot, a
 * "fast" one is over in half of it. */
const AMP = { small: 0.07, medium: 0.16, large: 0.30 };
const SPEED_SPAN = { slow: 1.0, normal: 0.8, fast: 0.5 };

/* A telephoto frame is a crop of the same subject; a wide one sees more of the
 * room. Baseline scale per lens keeps that difference visible in previz. */
export const LENS_SCALE = {
  "fisheye 8mm": 1.0, "ultra-wide 16mm": 1.0, "wide 24mm": 1.04, "35mm": 1.1,
  "50mm": 1.18, "85mm": 1.3, "telephoto 135mm": 1.45, "macro": 1.6, "": 1.1,
};

const SHOT_SCALE = {
  "extreme wide": 1.0, wide: 1.06, "medium wide": 1.14,
  medium: 1.24, "medium close-up": 1.4, "close-up": 1.62, "extreme close-up": 1.95,
};

const FRAMING_ORIGIN = {
  centered: [50, 50], "left third": [34, 50], "right third": [66, 50],
  "low in frame": [50, 64], "high in frame": [50, 36],
  "over-shoulder foreground": [60, 55], "": [50, 50],
};

/** Where the subject sits, as coordinates, whatever set it: a preset picks the
 *  pair, dragging the box writes it directly. One source of truth either way. */
export function framingOrigin(camera = {}) {
  if (camera.framing && camera.framing !== "custom") return FRAMING_ORIGIN[camera.framing] || [50, 50];
  return [Number.isFinite(camera.fx) ? camera.fx : 50, Number.isFinite(camera.fy) ? camera.fy : 50];
}

/** How much of the frame height the subject fills at a given shot size. This is
 *  the number the framing box draws and the number a resize reads back. */
export const subjectHeightPct = (shotType) => Math.min(88, (SHOT_SCALE[shotType] ?? 1.24) * 35.2);

/** …and the inverse: the shot type whose subject box is closest to a height. */
export function shotTypeForHeight(pct) {
  const target = pct / 35.2;
  let best = "medium", diff = Infinity;
  for (const [name, scale] of Object.entries(SHOT_SCALE)) {
    const d = Math.abs(scale - target);
    if (d < diff) { diff = d; best = name; }
  }
  return best;
}

/** Where the subject box ends up once the move has finished — the same
 *  transform the playback applies, read at progress 1. Dragging this box is
 *  what defines the move. */
export function endFramingFor(camera = {}, shotType = "") {
  const [x, y] = framingOrigin(camera);
  const cam = cameraAt(camera, 1);
  const h0 = subjectHeightPct(shotType);
  return {
    // The plate moves, so the subject appears to move the other way — except
    // for scale, which the subject shares with the plate.
    x: x + (cam.x / 6),
    y: y + (cam.y / 6),
    height: h0 * cam.scale,
  };
}

const AMP_FOR = (v) => (v < 0.11 ? "small" : v < 0.24 ? "medium" : "large");

/**
 * Read a dragged end-box back into the camera vocabulary: the dominant axis
 * becomes the move, a significant second axis becomes the simultaneous one, and
 * a size change becomes a push or a pull. This is the direct-manipulation half
 * of the camera controls — the dropdowns and the box always say the same thing
 * because both write the same three fields.
 */
export function moveFromEndBox(start, end) {
  const dx = (end.x - start.x) / 100;         // fraction of frame width
  const dy = (end.y - start.y) / 100;
  const ds = end.height / start.height - 1;   // relative subject growth

  const mag = { scale: Math.abs(ds), x: Math.abs(dx) * 1.6, y: Math.abs(dy) * 1.6 };
  const dominant = Object.entries(mag).sort((a, b) => b[1] - a[1])[0];
  if (!dominant || dominant[1] < 0.03) return { type: "static", amplitude: "medium", secondary: "none" };

  const axisMove = {
    // The subject drifting right means the camera went left, and vice versa.
    x: dx > 0 ? "truck left" : "truck right",
    y: dy > 0 ? "pedestal down" : "pedestal up",
    scale: ds > 0 ? "push in" : "pull out",
  };
  const secondaryMove = { x: dx > 0 ? "pan left" : "pan right", y: dy > 0 ? "tilt down" : "tilt up", scale: ds > 0 ? "push in" : "pull out" };

  const [primaryAxis, primaryMag] = dominant;
  const second = Object.entries(mag)
    .filter(([axis, v]) => axis !== primaryAxis && v > primaryMag * 0.45 && v > 0.04)
    .sort((a, b) => b[1] - a[1])[0];

  return {
    type: axisMove[primaryAxis],
    amplitude: AMP_FOR(primaryAxis === "scale" ? primaryMag : primaryMag / 1.6),
    secondary: second ? secondaryMove[second[0]] : "none",
  };
}

/** Where the camera is at time t within a shot (0…1 of its own length). */
function cameraAt(camera, progress) {
  const move = (type, p) => {
    const a = AMP[camera.amplitude || "medium"] ?? AMP.medium;
    switch (type) {
      case "push in":       return { scale: 1 + a * p };
      case "zoom in":       return { scale: 1 + a * 1.2 * p };
      case "pull out":      return { scale: 1 + a - a * p };
      case "zoom out":      return { scale: 1 + a * 1.2 * (1 - p) };
      case "pan left":      return { x: a * 90 * p };
      case "pan right":     return { x: -a * 90 * p };
      case "truck left":    return { x: a * 120 * p };
      case "truck right":   return { x: -a * 120 * p };
      case "tilt up":       return { y: a * 80 * p };
      case "tilt down":     return { y: -a * 80 * p };
      case "pedestal up":   return { y: a * 100 * p };
      case "pedestal down": return { y: -a * 100 * p };
      case "arc left":      return { x: a * 70 * p, rot: -a * 6 * p, scale: 1 + a * 0.3 * p };
      case "arc right":     return { x: -a * 70 * p, rot: a * 6 * p, scale: 1 + a * 0.3 * p };
      case "tracking":      return { x: -a * 150 * p };
      case "roll clockwise":        return { rot: a * 25 * p };
      case "roll counterclockwise": return { rot: -a * 25 * p };
      case "handheld":      return { x: Math.sin(p * 22) * a * 9, y: Math.cos(p * 17) * a * 7, rot: Math.sin(p * 13) * a * 2 };
      case "slight shake":  return { x: Math.sin(p * 70) * a * 6, y: Math.cos(p * 61) * a * 5 };
      case "strong shake":  return { x: Math.sin(p * 80) * a * 18, y: Math.cos(p * 73) * a * 15, rot: Math.sin(p * 90) * a * 3 };
      default:              return {};
    }
  };

  const span = SPEED_SPAN[camera.speed || "normal"] ?? 0.8;
  const p = Math.min(1, progress / span);
  const primary = move(camera.type || "static", p);
  const secondary = camera.secondary && camera.secondary !== "none" ? move(camera.secondary, p) : {};
  return {
    x: (primary.x || 0) + (secondary.x || 0),
    y: (primary.y || 0) + (secondary.y || 0),
    rot: (primary.rot || 0) + (secondary.rot || 0),
    scale: ((primary.scale || 1) * (secondary.scale || 1)),
  };
}

/** Which shot is on screen at time t, and how far into it we are. */
export function shotAt(project, t) {
  const shots = orderedShots(project);
  const duration = project.render.duration;
  for (let i = shots.length - 1; i >= 0; i--) {
    if (t >= (shots[i].at || 0) - 1e-6) {
      const end = i + 1 < shots.length ? shots[i + 1].at : duration;
      const len = Math.max(0.001, end - shots[i].at);
      return { shot: shots[i], index: i, start: shots[i].at, end, len, progress: Math.min(1, (t - shots[i].at) / len) };
    }
  }
  return shots.length ? { shot: shots[0], index: 0, start: 0, end: duration, len: duration, progress: 0 } : null;
}

/** Beats are spread evenly across their shot — the same assumption the model
 *  makes when it is told "one beat per 2–3 seconds" and nothing else. */
export function beatAt(frame, t) {
  const beats = (frame.shot.beats || []).filter(b => (b.text || "").trim());
  if (!beats.length) return { beat: null, index: -1, count: 0 };
  const slot = frame.len / beats.length;
  const index = Math.min(beats.length - 1, Math.floor((t - frame.start) / slot));
  return { beat: beats[index], index, count: beats.length, slotStart: frame.start + index * slot, slotLen: slot };
}

/* ── Light, read out of the words ──────────────────────────────
 *
 * Previz drew everything the prompt says about a frame except how it is lit —
 * which is the half you can judge at a glance, and the half the Light dial
 * writes. So the frame stayed the same grey-blue whichever way that dial went,
 * and a dial whose effect you cannot see is indistinguishable from a dial that
 * does nothing.
 *
 * The lighting field is free text — a preset off the dropdown, a line the LLM
 * wrote, something you typed — so this reads it for the three things that
 * actually change what a frame looks like: where the key is, how hard it is,
 * what colour it is. The grade decides how far the shadows fall and what the
 * whole frame is tinted. Nothing recognised means nothing drawn: a shot with
 * no lighting line looks exactly like the plate, as it should.
 *
 * Like the rest of previz this reads the PROMPT. It does not predict what H3
 * will render; it shows what the words are asking for.
 */

/* Where the key sits, in frame percentages. First match wins, so the rows run
 * most specific first — "behind" beats "left" in "backlit from the left",
 * because behind is the fact that changes the picture. */
const KEY_AT = [
  [/backlit|back light|back-light|rim|silhouett|from behind/i, [50, 56]],
  [/underlit|from below|up-?light|floor lamp|firelight|candle/i, [38, 84]],
  [/overhead|from above|top light|ceiling|fluorescent|midday|noon/i, [50, 3]],
  [/window|moonlight|skylight/i, [14, 20]],
  [/screen glow|monitor|phone screen|television|\btv\b|laptop/i, [50, 64]],
  [/\bleft\b|camera left/i, [7, 30]],
  [/\bright\b|camera right/i, [93, 30]],
  [/practical|lamp|bulb|lantern|neon|sign|sconce/i, [22, 24]],
];
const KEY_DEFAULT = [26, 22];

/* How hard the source is: how fast it falls off, how sharp the shadow edge
 * would be. Soft is a big source close by, hard is a small one far away, and
 * the words for both are the ones people already use. */
const HARDNESS = [
  [/soft|diffus|overcast|bounce|shade|cloudy|gentle|scrim|fluorescent|screen glow/i, 0.14],
  [/harsh|hard|direct|midday|noon|spot|bare bulb|point source/i, 0.9],
  [/rim|backlit|neon|sun\b|sunlight/i, 0.68],
  [/practical|lamp|firelight|candle|moon|street/i, 0.5],
];

/* How much fill there is — how open the shadow side stays. Mostly the grade's
 * business, which is why the Light dial writes both: a source and a grade that
 * disagree about where the blacks sit is a frame arriving in two pieces. */
const SHADOW = [
  [/high-?key|lifted blacks|low-?contrast|overcast|diffused daylight|pastel|soft contrast/i, 0.85],
  [/low-?key|most of the frame in shadow|the rest.{0,14}dark|moonlight|\bnight\b/i, 0.1],
  [/bleach|crushed blacks|hard contrast|harsh|hard key/i, 0.22],
  [/dense blacks|deep shadow|2383|print emulation|halation/i, 0.38],
];

/* The colour of the key. */
const WARMTH = [
  [/tungsten|practical|lamp|bulb|firelight|candle|golden|amber|sunset|sodium|warm|incandescen/i, "255,206,142"],
  [/neon|magenta/i, "255,150,214"],
  [/moon|fluorescent|screen glow|monitor|blue|night|cool|overcast|shade/i, "168,204,246"],
  [/midday|noon|sun\b|daylight|harsh/i, "255,248,228"],
];
const KEY_WHITE = "246,246,242";

/* The grade as a wash over the frame, plus what it does to saturation and
 * contrast. The patterns match vocab's own GRADES, so a grade picked by hand in
 * the inspector draws exactly like one the dial wrote. */
const GRADE_LOOK = [
  [/teal.and.orange/i,               { wash: "rgba(96,168,180,.16)",  sat: 1.14, con: 1.06 }],
  [/golden.hour|amber highlights/i,  { wash: "rgba(255,178,84,.17)",  sat: 1.1,  con: 1.02 }],
  [/cool blue night/i,               { wash: "rgba(84,132,214,.2)",   sat: 0.9,  con: 1.08 }],
  [/bleach.?bypass/i,                { wash: "rgba(196,200,198,.1)",  sat: 0.42, con: 1.3 }],
  [/2383|print emulation/i,          { wash: "rgba(255,196,150,.09)", sat: 1.06, con: 1.12 }],
  [/high-?key/i,                     { wash: "rgba(255,255,255,.13)", sat: 0.95, con: 0.84 }],
  [/low-?key/i,                      { wash: "rgba(0,0,0,.14)",       sat: 0.92, con: 1.22 }],
  [/pastel/i,                        { wash: "rgba(232,214,224,.15)", sat: 0.72, con: 0.9 }],
  [/grain|halation/i,                { wash: "rgba(255,232,204,.08)", sat: 1,    con: 1.06 }],
  [/rec.?709|true blacks|neutral/i,  { wash: "",                      sat: 1,    con: 1.04 }],
];

const firstMatch = (table, text, fallback) => (table.find(([re]) => re.test(text)) || [null, fallback])[1];

/**
 * What a shot's light looks like, as numbers something can draw.
 *
 * @param {string} lighting  the shot's lighting line, in whatever words it is in
 * @param {string} grade     the clip's grade
 * @param {string} look      the clip's look — a monochrome one drains the colour
 * @returns {{key:[number,number], hard:number, fill:number, rgb:string,
 *            wash:string, filter:string, hasKey:boolean, lit:boolean}}
 */
export function lightingLook(lighting = "", grade = "", look = "") {
  const lit = String(lighting || "").trim();
  const graded = String(grade || "").trim();
  const g = firstMatch(GRADE_LOOK, graded, null);

  const mono = /black.and.white|monochrome|gr[ae]yscale/i.test(String(look || ""));
  const sat = mono ? 0 : (g?.sat ?? 1);
  const con = g?.con ?? 1;

  return {
    key: lit ? firstMatch(KEY_AT, lit, KEY_DEFAULT) : KEY_DEFAULT,
    hard: lit ? firstMatch(HARDNESS, lit, 0.45) : 0,
    // With nothing said about either, the frame is evenly lit — which is what
    // "nothing said" means, and is also the plate untouched.
    fill: firstMatch(SHADOW, `${lit} ${graded}`, lit || graded ? 0.5 : 1),
    rgb: lit ? firstMatch(WARMTH, lit, KEY_WHITE) : KEY_WHITE,
    wash: g?.wash || "",
    filter: sat === 1 && con === 1 ? "" : `saturate(${sat.toFixed(2)}) contrast(${con.toFixed(2)})`,
    hasKey: !!lit,
    lit: !!lit || !!g || mono,
  };
}

/** The two gradients that draw that reading. Split out from the reading itself
 *  so the reading can be checked without a browser.
 *
 *  Fill gets its own flat layer rather than being folded into the falloff,
 *  because that is what fill light physically is: an even lift over the whole
 *  frame that decides how much of it stays legible. Without it "soft and flat"
 *  drew a soft pool on a dark frame, which is not flat, it is just soft. */
export function lightingLayers(look) {
  const [kx, ky] = look.key;
  // A hard source is a tight bright core falling off fast; a soft one is a
  // broad wash that barely falls off at all.
  const spread = 32 + (1 - look.hard) * 76;
  const core = 0.3 + look.hard * 0.42;
  const ambient = look.fill * 0.2;
  const dark = (1 - look.fill) * 0.62;
  const beam = look.hasKey
    ? `radial-gradient(${(spread * 1.25).toFixed(0)}% ${spread.toFixed(0)}% at ${kx}% ${ky}%,`
      + ` rgba(${look.rgb},${core.toFixed(2)}) 0%,`
      + ` rgba(${look.rgb},${(core * 0.36).toFixed(2)}) ${(36 + look.hard * 10).toFixed(0)}%,`
      + ` rgba(${look.rgb},0) 78%)`
    : "";
  // Fill is fill OF a key. With nothing lighting the shot there is nothing to
  // open up, and a flat white layer over an unlit frame is not a neutral one.
  const lift = !look.hasKey || ambient < 0.02 ? ""
    : `linear-gradient(rgba(${look.rgb},${ambient.toFixed(2)}), rgba(${look.rgb},${ambient.toFixed(2)}))`;
  return {
    key: [beam, lift].filter(Boolean).join(", "),
    shadow: dark < 0.02 ? ""
      : `radial-gradient(134% 120% at ${kx}% ${ky}%, rgba(0,0,0,0) 12%,`
        + ` rgba(0,0,0,${(dark * 0.38).toFixed(2)}) 48%, rgba(0,0,0,${dark.toFixed(2)}) 100%)`,
  };
}

/** The light in one line, for the readout on the frame: what lights it, and
 *  the grade it is finished with. The grade used to change without previz or
 *  the dial readout ever mentioning it. */
export function lightSentence(lighting = "", grade = "", look = "") {
  const graded = String(grade || "").trim();
  const parts = [String(lighting || "").trim(), graded ? GRADE_LABEL[graded] || "" : ""];
  if (/black.and.white|monochrome/i.test(String(look || ""))) parts.push("black-and-white");
  return parts.filter(Boolean).join("  ·  ");
}

/**
 * Build the previz player.
 *
 * With `editable`, the paused frame becomes a framing editor: an orange box
 * where the subject starts and a blue one where the move leaves it. Drag either
 * body to move it, either corner to resize it. The boxes are not a separate
 * model — they read and write the same camera fields the dropdowns do, so a
 * drag says "truck left, medium amplitude, while tilting up" in the inspector
 * and in the prompt a moment later.
 *
 * @returns {{el, gate, play, pause, toggle, seek, destroy, isPlaying, time}}
 */
export function createPreviz(project, {
  backgroundFor = () => null, onTime = () => {}, startAt = 0,
  editable = false, onFraming = () => {},
} = {}) {
  const { width, height } = dimensions(project);
  const aspect = width / height;

  const plate = h("div", {
    // Order matters: the `background` shorthand resets size/position/repeat, so
    // those three come after it or a plate image tiles instead of covering.
    style: {
      position: "absolute", inset: "0",
      background: "radial-gradient(120% 90% at 50% 38%, #3a4a5f 0%, #232c3a 45%, #141a22 100%)",
      backgroundSize: "cover", backgroundPosition: "50% 50%", backgroundRepeat: "no-repeat",
      willChange: "transform",
    },
  });
  // A grid that makes a camera move legible even with no image behind it.
  const grid = h("div", {
    style: {
      position: "absolute", inset: "-20%", opacity: ".22", pointerEvents: "none",
      backgroundImage: "linear-gradient(#7fb2e5 1px, transparent 1px), linear-gradient(90deg, #7fb2e5 1px, transparent 1px)",
      backgroundSize: "56px 56px",
    },
  });
  plate.appendChild(grid);

  /* The light, drawn. Three layers over the plate and under everything that
   * writes on the frame: the key, the shadow it leaves, and the grade's wash.
   *
   * They are fixed to the gate rather than riding the plate transform, because
   * what previz is showing is the light on the SUBJECT, and the subject stays
   * where the framing put it. A key that panned away with the walls would be a
   * more literal simulation and a less useful picture. */
  const keyLight = h("div.pv-key", {
    style: { position: "absolute", inset: "0", pointerEvents: "none", mixBlendMode: "screen" },
  });
  const shadowSide = h("div.pv-shadow", {
    style: { position: "absolute", inset: "0", pointerEvents: "none" },
  });
  /* The grade tints flat rather than in overlay: overlay reads as punch on a
   * bright photo and as nothing at all on the dark plate an unreferenced clip
   * shows, which is exactly the case where the tint is the only evidence the
   * grade changed. */
  const gradeWash = h("div.pv-grade", {
    style: { position: "absolute", inset: "0", pointerEvents: "none" },
  });

  const thirds = h("div", {
    style: {
      position: "absolute", inset: "0", pointerEvents: "none", opacity: ".33",
      backgroundImage: "linear-gradient(90deg, transparent 33.33%, #fff 33.33%, #fff calc(33.33% + 1px), transparent calc(33.33% + 1px), transparent 66.66%, #fff 66.66%, #fff calc(66.66% + 1px), transparent calc(66.66% + 1px)), linear-gradient(180deg, transparent 33.33%, #fff 33.33%, #fff calc(33.33% + 1px), transparent calc(33.33% + 1px), transparent 66.66%, #fff 66.66%, #fff calc(66.66% + 1px), transparent calc(66.66% + 1px))",
      mixBlendMode: "overlay",
    },
  });

  /* The box that tracks the subject during playback. */
  const subjectMark = h("div", {
    style: {
      position: "absolute", width: "14%", aspectRatio: "2/3", border: "1px dashed rgba(224,161,58,.85)",
      borderRadius: "3px", transform: "translate(-50%,-50%)", pointerEvents: "none",
      boxShadow: "0 0 0 1px rgba(0,0,0,.4)",
    },
  });

  /* Where the move is going to leave it. During playback the subject drifts and
   * you can see THAT it is moving; you cannot see how far it has left to go,
   * which is the only question "amplitude: medium" was ever standing in for.
   * So the destination is drawn, faintly, and the marker walks into it. */
  const moveGhost = h("div.pv-ghost", {
    style: {
      position: "absolute", border: "1px dashed rgba(122,178,229,.8)",
      borderRadius: "3px", transform: "translate(-50%,-50%)", pointerEvents: "none",
      display: "none", background: "rgba(122,178,229,.07)", boxShadow: "0 0 0 1px rgba(0,0,0,.4)",
    },
  });

  /* …and the two you can grab when it is paused. */
  const makeBox = (kind, color) => {
    // START labels top-left, END top-right: with no move yet the two boxes sit
    // exactly on top of each other, and two labels in the same corner is an
    // unreadable smudge.
    const label = h("div", {
      style: {
        position: "absolute", top: "-16px", fontSize: "9px", letterSpacing: ".1em",
        ...(kind === "start" ? { left: "0" } : { right: "0" }),
        textTransform: "uppercase", color, textShadow: "0 1px 3px #000", whiteSpace: "nowrap",
      },
    }, kind);
    const handle = h("div", {
      class: "pv-handle",
      style: {
        position: "absolute", right: "-5px", bottom: "-5px", width: "11px", height: "11px",
        background: color, border: "1px solid rgba(0,0,0,.6)", borderRadius: "2px", cursor: "nwse-resize",
      },
    });
    const box = h("div", {
      class: `pv-box pv-${kind}`,
      style: {
        position: "absolute", border: `1px dashed ${color}`, borderRadius: "3px",
        transform: "translate(-50%,-50%)", cursor: "move", display: "none",
        boxShadow: "0 0 0 1px rgba(0,0,0,.45)", background: "rgba(255,255,255,.03)",
        // The start box sits on top: with no move yet the two are coincident,
        // and the one you reach for first is where the subject starts.
        zIndex: kind === "start" ? "3" : "2",
      },
    }, label, handle);
    return { box, handle };
  };
  const startBox = makeBox("start", "rgba(224,161,58,.95)");
  const endBox = makeBox("end", "rgba(122,178,229,.95)");

  /* The end box's handle when there is no move yet: a chip parked just outside
   * the frame box, so it is never buried under the start box. Dragging it is
   * how a move gets created in the first place. */
  const moveChip = h("div", {
    class: "pv-move-chip",
    title: "Drag to set where the move leaves the subject",
    style: {
      position: "absolute", width: "20px", height: "20px", borderRadius: "50%",
      background: "rgba(122,178,229,.95)", color: "#08121c", display: "none",
      alignItems: "center", justifyContent: "center", cursor: "grab",
      fontSize: "11px", fontWeight: "700", transform: "translate(-50%,-50%)",
      boxShadow: "0 1px 5px rgba(0,0,0,.6)", zIndex: "4", userSelect: "none",
    },
  }, "↔");
  const linkLine = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  linkLine.setAttribute("style", "position:absolute;inset:0;pointer-events:none;display:none");
  const linkPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  linkPath.setAttribute("stroke", "rgba(160,190,220,.6)");
  linkPath.setAttribute("stroke-width", "1");
  linkPath.setAttribute("stroke-dasharray", "4 3");
  linkPath.setAttribute("fill", "none");
  const tracePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  tracePath.setAttribute("stroke", "rgba(224,161,58,.5)");
  tracePath.setAttribute("stroke-width", "1");
  tracePath.setAttribute("stroke-dasharray", "3 4");
  tracePath.setAttribute("fill", "none");
  linkLine.append(tracePath, linkPath);

  const editHint = h("div.pv-hint", {
    style: {
      position: "absolute", left: "10px", bottom: "11px", maxWidth: "52%", color: "rgba(255,255,255,.5)",
      fontSize: "10px", pointerEvents: "none", textShadow: "0 1px 3px #000", display: "none",
    },
  }, "drag the boxes · corner resizes · the move follows");

  const slate = h("div.pv-slate", {
    style: {
      position: "absolute", top: "10px", left: "10px", display: "flex", gap: "6px",
      alignItems: "center", pointerEvents: "none", textShadow: "0 1px 3px #000",
    },
  });
  /* The corner carries one line per decision, each in its own colour: the slate
   * is the shot, green is the camera, warm amber is the light. Three answers,
   * not one paragraph — and the light one is new, because until previz drew the
   * light there was nothing to caption. */
  const camLine = h("div.pv-cam", {
    style: {
      position: "absolute", top: "34px", left: "10px", right: "10px", color: "#8fd3a8",
      fontFamily: "var(--mono)", fontSize: "var(--fs-sm)", pointerEvents: "none", textShadow: "0 1px 3px #000",
    },
  });
  const lightLine = h("div.pv-light", {
    style: {
      position: "absolute", top: "50px", left: "10px", right: "10px", color: "#e6c68a",
      fontFamily: "var(--mono)", fontSize: "var(--fs-sm)", pointerEvents: "none", textShadow: "0 1px 3px #000",
    },
  });
  const beatLine = h("div.pv-beat", {
    style: {
      position: "absolute", left: "0", right: "0", bottom: "56px", textAlign: "center",
      color: "#eaeaea", fontSize: "15px", lineHeight: "1.5", padding: "0 12%",
      pointerEvents: "none", textShadow: "0 2px 6px #000",
    },
  });
  const dlgLine = h("div.pv-dlg", {
    style: {
      position: "absolute", left: "0", right: "0", bottom: "26px", textAlign: "center",
      color: "#f0d0e4", fontSize: "13px", pointerEvents: "none", textShadow: "0 2px 6px #000",
    },
  });
  const audioLine = h("div.pv-audio", {
    style: {
      position: "absolute", top: "10px", right: "10px", textAlign: "right",
      color: "#a8e0c0", fontFamily: "var(--mono)", fontSize: "var(--fs-sm)",
      pointerEvents: "none", textShadow: "0 1px 3px #000", maxWidth: "42%",
    },
  });

  /* ── The strip ────────────────────────────────────────────
   * The one thing previz could not answer while it was playing: where am I,
   * and when does it cut? The timecode says how many seconds have passed, which
   * is not the same question — "four beats in three seconds" and "the cut lands
   * too early" are both structure, and structure was the thing you had to look
   * away from the picture to see.
   *
   * So the clip is drawn along the bottom of the frame: one block per shot at
   * its real length, the beats ticked inside the block they fall in, the
   * playhead sweeping across, and the seconds left before the next cut said out
   * loud. It is the same clip as the timeline below the viewer, except that it
   * is inside the gate, it shows beats, and it is there in Create and in the
   * read-through where no timeline exists. */
  const stripShots = h("div", { style: { position: "absolute", inset: "0" } });
  const stripHead = h("div", {
    style: {
      position: "absolute", top: "-3px", bottom: "0", width: "2px", left: "0", marginLeft: "-1px",
      background: "#fff", boxShadow: "0 0 5px rgba(0,0,0,.9)",
    },
  });
  const stripSay = h("div.pv-strip-say", {
    style: {
      position: "absolute", right: "10px", bottom: "11px", color: "rgba(226,226,226,.72)",
      fontFamily: "var(--mono)", fontSize: "9px", letterSpacing: ".06em",
      pointerEvents: "none", textShadow: "0 1px 3px #000",
    },
  });
  const strip = h("div.pv-strip", {
    style: {
      position: "absolute", left: "0", right: "0", bottom: "0", height: "8px",
      pointerEvents: "none",
    },
  }, stripShots, stripHead);
  const stripScrim = h("div", {
    style: {
      position: "absolute", left: "0", right: "0", bottom: "0", height: "34px",
      background: "linear-gradient(rgba(0,0,0,0), rgba(0,0,0,.55))", pointerEvents: "none",
    },
  });

  // A watermark that says what the plate is, so an empty previz never reads as
  // a broken one.
  const watermark = h("div", {
    style: {
      position: "absolute", inset: "0", display: "flex", alignItems: "center", justifyContent: "center",
      color: "rgba(255,255,255,.10)", fontSize: "clamp(18px, 4vw, 42px)", letterSpacing: ".18em",
      textTransform: "uppercase", pointerEvents: "none", fontWeight: "700",
    },
  }, "previz");

  const gate = h("div", {
    style: {
      position: "relative", aspectRatio: String(aspect), width: "auto", height: "100%",
      maxWidth: "100%", maxHeight: "100%", overflow: "hidden", background: "#000",
      border: "1px solid #000", boxShadow: "0 0 0 1px #2a2a2a",
    },
  },
    // Order is depth: the plate, the light on it, then everything that writes
    // about it, then the strip that says where in the clip we are.
    plate, shadowSide, keyLight, gradeWash,
    watermark, thirds, moveGhost, subjectMark, linkLine,
    startBox.box, endBox.box, moveChip, stripScrim,
    editHint, slate, camLine, lightLine, beatLine, dlgLine, audioLine,
    stripSay, strip);

  const el = h("div", {
    style: { position: "absolute", inset: "0", display: "flex", alignItems: "center", justifyContent: "center", padding: "10px" },
  }, gate);

  let raf = 0, playing = false, t = startAt, last = 0, lastShotIndex = -1;
  let dragging = null;      // while a box is being dragged, paint() leaves it alone

  const gateRect = () => gate.getBoundingClientRect();
  const aspectOf = () => {
    const r = gateRect();
    return r.width && r.height ? r.width / r.height : aspect;
  };

  /* A box is positioned in frame percentages: centre x/y, and a height the
   * shot size decides. Width follows from a standing figure's proportions, so
   * the box reads as a subject rather than as a crop rectangle. */
  function placeBox(el, cx, cy, heightPct) {
    el.style.left = `${cx}%`;
    el.style.top = `${cy}%`;
    el.style.height = `${heightPct}%`;
    el.style.width = `${(heightPct * 0.55) / aspectOf()}%`;
    el.style.display = "block";
  }

  function paintBoxes(frame) {
    const showEdit = editable && !playing && frame;
    startBox.box.style.display = showEdit ? "block" : "none";
    endBox.box.style.display = showEdit ? "block" : "none";
    moveChip.style.display = showEdit ? "flex" : "none";
    editHint.style.display = showEdit ? "block" : "none";
    subjectMark.style.display = showEdit ? "none" : "block";
    // One SVG, two paths: the tie-line you drag against, and the line the move
    // travels while it plays. Only ever one of them is meant.
    linkPath.setAttribute("opacity", showEdit ? "1" : "0");
    tracePath.setAttribute("opacity", showEdit ? "0" : "1");
    if (!frame) { linkLine.style.display = "none"; moveGhost.style.display = "none"; return; }
    linkLine.style.display = "block";

    const cam = frame.shot.camera || {};
    const [sx, sy] = framingOrigin(cam);
    const sh = subjectHeightPct(frame.shot.shotType);
    const end = endFramingFor(cam, frame.shot.shotType);
    const r = gateRect();
    const px = (x, y) => [(x / 100) * r.width, (y / 100) * r.height];
    linkLine.setAttribute("viewBox", `0 0 ${r.width} ${r.height}`);

    if (!showEdit) {
      // A move worth drawing is one that ends up somewhere else. A shake ends
      // where it started, so nothing is drawn for it — correctly.
      const moved = Math.abs(end.x - sx) > 1.5 || Math.abs(end.y - sy) > 1.5 || Math.abs(end.height - sh) > 2;
      moveGhost.style.display = moved ? "block" : "none";
      if (moved) {
        placeBox(moveGhost, end.x, end.y, end.height);
        const [ax, ay] = px(sx, sy);
        const [bx, by] = px(end.x, end.y);
        tracePath.setAttribute("d", `M ${ax} ${ay} L ${bx} ${by}`);
      } else {
        tracePath.setAttribute("d", "");
      }
      return;
    }

    moveGhost.style.display = "none";
    if (dragging !== "start") placeBox(startBox.box, sx, sy, sh);
    if (dragging !== "end") placeBox(endBox.box, end.x, end.y, end.height);
    const [x1, y1] = px(sx, sy);
    const [x2, y2] = px(end.x, end.y);
    linkPath.setAttribute("d", `M ${x1} ${y1} L ${x2} ${y2}`);
    if (dragging !== "end") parkChip();
  }

  /* ── The light on the frame ───────────────────────────────
   * Only changes at a cut, or when the lighting or grade is edited, so it is
   * rebuilt from the words rather than sixty times a second. */
  let lightSig = "";
  function paintLight(shot) {
    const lighting = shot?.lighting || "";
    const grade = project.style?.grade || "";
    const look = project.style?.look || "";
    const sig = `${lighting}|${grade}|${look}`;
    if (sig === lightSig) return;
    lightSig = sig;

    const read = lightingLook(lighting, grade, look);
    const layers = lightingLayers(read);
    keyLight.style.background = layers.key || "none";
    shadowSide.style.background = layers.shadow || "none";
    gradeWash.style.background = read.wash || "none";
    plate.style.filter = read.filter || "none";
    const said = lightSentence(lighting, grade, look);
    lightLine.textContent = said ? `☀  ${said}` : "";
  }

  /* ── The strip ────────────────────────────────────────────
   * Rebuilt when the structure changes; between those, only the playhead and
   * the countdown move. */
  let stripSig = "", stripLive = -1, stripSaid = "";
  function buildStrip(shots, duration) {
    clear(stripShots);
    stripLive = -1;
    shots.forEach((sh, i) => {
      const start = sh.at || 0;
      const end = i + 1 < shots.length ? shots[i + 1].at : duration;
      const seg = h("div", {
        style: {
          position: "absolute", top: "0", bottom: "0",
          left: `${(start / duration) * 100}%`,
          width: `calc(${(Math.max(0, end - start) / duration) * 100}% - 1px)`,
          background: "rgba(150,178,206,.28)", borderRadius: "1px",
        },
      });
      /* Beats divide their shot evenly — the same assumption playback makes, so
       * a tick is exactly where the words on the frame change. Seeing four of
       * them inside three seconds is the whole point of drawing them. */
      const beats = (sh.beats || []).filter(b => (b.text || "").trim());
      for (let k = 1; k < beats.length; k++) {
        seg.appendChild(h("div", {
          style: {
            position: "absolute", top: "0", bottom: "0", width: "1px",
            left: `${(k / beats.length) * 100}%`, background: "rgba(8,12,18,.8)",
          },
        }));
      }
      stripShots.appendChild(seg);
    });
  }

  function paintStrip(frame, duration) {
    const shots = orderedShots(project);
    const sig = shots.map(sh => `${sh.at}/${(sh.beats || []).filter(b => (b.text || "").trim()).length}`).join(",")
      + `@${duration}`;
    if (sig !== stripSig) { stripSig = sig; buildStrip(shots, duration); }

    stripHead.style.left = `${Math.min(100, Math.max(0, (t / duration) * 100))}%`;
    if (frame.index !== stripLive) {
      stripLive = frame.index;
      [...stripShots.children].forEach((seg, i) => {
        seg.style.background = i === frame.index ? "rgba(224,161,58,.82)" : "rgba(150,178,206,.28)";
      });
    }

    const left = Math.max(0, frame.end - t);
    const last = frame.index >= shots.length - 1;
    const said = shots.length > 1
      ? `shot ${frame.index + 1}/${shots.length}  ·  ${last ? "ends" : "cuts"} in ${left.toFixed(1)}s`
      : `${left.toFixed(1)}s to go`;
    if (said !== stripSaid) { stripSaid = said; stripSay.textContent = said; }
  }

  /* Small hosts — Create's side pane, the read-through plate — get the frame
   * and the strip and lose the two lines of settings, which at that size cover
   * the picture they are describing. Measuring is a forced layout, so it runs
   * when the gate changes size and not once per frame of playback. */
  function fitOverlays() {
    const r = gateRect();
    if (!r.width) return;
    gate.classList.toggle("pv-compact", r.width < 340 || r.height < 190);
  }

  /* ── Dragging ──────────────────────────────────────────
   * Boxes write the same three camera fields the dropdowns write; nothing here
   * keeps a second copy of the framing. `live` says whether this is a move in
   * progress (cheap update, no redraw) or the end of one (commit, redraw). */
  function beginDrag(which, ev, mode) {
    if (!editable || playing) return;
    ev.preventDefault();
    ev.stopPropagation();
    const frame = shotAt(project, t);
    if (!frame) return;
    dragging = which;
    const r = gateRect();
    const el = which === "start" ? startBox.box : endBox.box;
    const startPct = {
      x: parseFloat(el.style.left), y: parseFloat(el.style.top), h: parseFloat(el.style.height),
    };
    const from = { x: ev.clientX, y: ev.clientY };

    const emit = (live) => {
      const box = {
        x: parseFloat(el.style.left), y: parseFloat(el.style.top), height: parseFloat(el.style.height),
      };
      if (which === "start") {
        onFraming({
          shotId: frame.shot.id, live,
          framing: "custom", fx: round1(box.x), fy: round1(box.y),
          shotType: mode === "resize" ? shotTypeForHeight(box.height) : undefined,
        });
      } else {
        const [sx, sy] = framingOrigin(frame.shot.camera || {});
        const move = moveFromEndBox(
          { x: sx, y: sy, height: subjectHeightPct(frame.shot.shotType) },
          box,
        );
        onFraming({ shotId: frame.shot.id, live, move });
      }
    };

    const onMove = (e) => {
      const dx = ((e.clientX - from.x) / r.width) * 100;
      const dy = ((e.clientY - from.y) / r.height) * 100;
      if (mode === "resize") {
        el.style.height = `${clampPct(startPct.h + dy * 2, 6, 96)}%`;
        el.style.width = `${(parseFloat(el.style.height) * 0.55) / aspectOf()}%`;
      } else {
        el.style.left = `${clampPct(startPct.x + dx, 2, 98)}%`;
        el.style.top = `${clampPct(startPct.y + dy, 2, 98)}%`;
      }
      // Keep the tie-line honest while the box moves.
      const rr = gateRect();
      const s = which === "start"
        ? [parseFloat(el.style.left), parseFloat(el.style.top)]
        : [parseFloat(startBox.box.style.left), parseFloat(startBox.box.style.top)];
      const en = which === "end"
        ? [parseFloat(el.style.left), parseFloat(el.style.top)]
        : [parseFloat(endBox.box.style.left), parseFloat(endBox.box.style.top)];
      linkPath.setAttribute("d", `M ${(s[0] / 100) * rr.width} ${(s[1] / 100) * rr.height} L ${(en[0] / 100) * rr.width} ${(en[1] / 100) * rr.height}`);
      parkChip();
      emit(true);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      dragging = null;
      emit(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  /* The chip rides the end box's right edge, always outside it. */
  function parkChip() {
    const r = gateRect();
    if (!r.width) return;
    const cx = parseFloat(endBox.box.style.left) || 50;
    const cy = parseFloat(endBox.box.style.top) || 50;
    const halfW = (parseFloat(endBox.box.style.width) || 8) / 2;
    moveChip.style.left = `${Math.min(99, cx + halfW + (16 / r.width) * 100)}%`;
    moveChip.style.top = `${cy}%`;
  }

  const round1 = (v) => Math.round(v * 10) / 10;
  const clampPct = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  startBox.box.addEventListener("pointerdown", (e) => beginDrag("start", e, "move"));
  startBox.handle.addEventListener("pointerdown", (e) => beginDrag("start", e, "resize"));
  endBox.box.addEventListener("pointerdown", (e) => beginDrag("end", e, "move"));
  endBox.handle.addEventListener("pointerdown", (e) => beginDrag("end", e, "resize"));
  moveChip.addEventListener("pointerdown", (e) => beginDrag("end", e, "move"));

  function paint(now = 0) {
    const duration = project.render.duration;
    if (playing) {
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      t += dt;
      if (t >= duration) { t = duration; playing = false; }
    }
    const frame = shotAt(project, t);
    if (!frame) return;

    const cam = cameraAt(frame.shot.camera || {}, frame.progress);
    const lens = LENS_SCALE[frame.shot.camera?.lens || ""] ?? 1.1;
    const shotScale = SHOT_SCALE[frame.shot.shotType] ?? 1.24;
    const [ox, oy] = framingOrigin(frame.shot.camera || {});

    // Baseline 1.0 = the widest shot with an unstated lens, so the plate always
    // covers the gate and a closer shot or a longer lens reads as a crop into
    // it — which is what those two things actually are.
    const base = (lens / LENS_SCALE[""]) * shotScale;
    plate.style.transform = `translate(${cam.x}px, ${cam.y}px) rotate(${cam.rot}deg) scale(${(cam.scale * base).toFixed(4)})`;
    plate.style.transformOrigin = `${ox}% ${oy}%`;
    // During playback the marker rides the move, which is the clearest way to
    // read an amplitude: you can see how far the subject actually travels.
    subjectMark.style.left = `${ox + cam.x / 6}%`;
    subjectMark.style.top = `${oy + cam.y / 6}%`;
    subjectMark.style.height = `${Math.min(88, subjectHeightPct(frame.shot.shotType) * cam.scale)}%`;
    paintBoxes(frame);
    paintLight(frame.shot);
    paintStrip(frame, duration);

    // A cut should be visible as a cut.
    if (frame.index !== lastShotIndex) {
      lastShotIndex = frame.index;
      gate.animate([{ opacity: 0.25, filter: "brightness(1.6)" }, { opacity: 1, filter: "none" }], { duration: 130, easing: "ease-out" });
      const bg = backgroundFor(frame.shot, frame.index);
      plate.style.backgroundImage = bg ? `url("${bg}")` : "none";
      grid.style.display = bg ? "none" : "block";
      watermark.style.display = bg ? "none" : "flex";
    }

    clear(slate);
    slate.append(
      h("span.tag", `Shot ${frame.index + 1}`),
      h("span", { style: { color: "#dce8f4", fontSize: "var(--fs-sm)" } },
        `${frame.shot.shotType} · ${frame.shot.viewpoint}`),
      h("span.mono", { style: { color: "var(--clip-sel)", fontSize: "var(--fs-sm)" } }, timecode(t, project.render.fps)),
    );

    /* Speed is not how fast the move looks, it is how much of the SHOT the move
     * occupies: a fast one is over halfway through and the frame holds still
     * for the rest of it. That has always been what previz animated and never
     * what it said, so a held second read as previz having stopped. */
    const c = frame.shot.camera || {};
    const span = SPEED_SPAN[c.speed || "normal"] ?? 0.8;
    const moving = c.type && c.type !== "static";
    camLine.textContent = c.custom?.trim()
      ? c.custom.trim()
      : [
          c.type === "static" ? "static — the camera does not move" : `${c.type} · ${c.amplitude} · ${c.speed}`,
          c.secondary && c.secondary !== "none" ? `+ ${c.secondary}` : "",
          c.lens || "", c.height || "", c.depth ? "depth" : "",
          c.framing === "custom"
            ? `frame ${Math.round(c.fx ?? 50)},${Math.round(c.fy ?? 50)}`
            : (c.framing && c.framing !== "centered" ? c.framing : ""),
          moving && span < 1 && frame.progress >= span ? "move done, the frame holds" : "",
        ].filter(Boolean).join("  ·  ");

    const { beat, index: bi, count } = beatAt(frame, t);
    beatLine.textContent = beat ? beat.text : (frame.shot.subject || "");
    beatLine.style.opacity = beat ? "1" : ".55";
    if (beat && count > 1) {
      beatLine.textContent = `${beat.text}`;
      slate.appendChild(h("span.hint", { style: { color: "#9fc0dc" } }, `beat ${bi + 1}/${count}`));
    }

    const lines = (frame.shot.dialogue || []).filter(d => (d.text || "").trim());
    if (lines.length) {
      const slot = frame.len / lines.length;
      const li = Math.min(lines.length - 1, Math.floor((t - frame.start) / slot));
      const line = lines[li];
      dlgLine.textContent = `(${line.speaker}) “${line.text}”${line.voiceover ? "  (voiceover)" : ""}`;
    } else {
      dlgLine.textContent = "";
    }

    const sound = [];
    if (!project.sound.silent && project.sound.soundscape) sound.push("♪ soundscape");
    if (!project.sound.musicOff && project.sound.music) sound.push("♫ score");
    if (frame.shot.sfx) sound.push(`✳ ${frame.shot.sfx}`);
    audioLine.textContent = sound.join("   ");

    onTime(t, frame);
    if (playing) raf = requestAnimationFrame(paint);
  }

  paint();

  /* The gate has no size until it is in the page, and it changes again every
   * time the panel is dragged or the window resizes. Everything measured in
   * percentages of it — the boxes, the tie-line, how much text fits — was
   * being decided once, at construction, against a rect of zero. */
  let measuring = false;
  const ro = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => {
        if (measuring) return;
        measuring = true;
        fitOverlays();
        if (!playing) paint();               // playback is already repainting
        measuring = false;
      })
    : null;
  // Fires once on observe, which is also the first moment the gate has a size.
  ro?.observe(gate);
  // …and once here for anything without a ResizeObserver, where the worst case
  // is every overlay staying on rather than nothing being drawn.
  fitOverlays();

  return {
    el, gate,
    get time() { return t; },
    get isPlaying() { return playing; },
    play() { if (playing) return; if (t >= project.render.duration) t = 0; playing = true; last = 0; raf = requestAnimationFrame(paint); },
    pause() { playing = false; cancelAnimationFrame(raf); last = 0; },
    toggle() { playing ? this.pause() : this.play(); },
    seek(v) { t = Math.max(0, Math.min(project.render.duration, v)); lastShotIndex = -1; last = 0; paint(); },
    repaint() { paint(); },
    destroy() { playing = false; cancelAnimationFrame(raf); ro?.disconnect(); },
  };
}
