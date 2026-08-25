/* MOTIONSTILL CUT — the prompt vocabulary.
 *
 * MiniMax H3's prompt guide is not a style guide, it is a grammar: the model
 * was trained on rewriter output with a fixed shape, and words outside that
 * shape are the ones that get diluted. So the editor offers the vocabulary as
 * controls rather than as advice — pick a camera move and the compiler writes
 * "The camera pushes in with small amplitude at slow speed", which is the
 * phrasing the encoder actually saw.
 *
 * Sources: MiniMaxAI/MiniMax-H3 docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md and
 * …_ref_en.md, plus Motionstill's own docs/PROMPT_ENGINEERING_RESEARCH.md.
 */

/* Exactly one shot type per shot must be woven into the prose. */
export const SHOT_TYPES = [
  ["extreme wide",   "Extreme wide"],
  ["wide",           "Wide"],
  ["medium wide",    "Medium wide"],
  ["medium",         "Medium"],
  ["medium close-up","Medium close-up"],
  ["close-up",       "Close-up"],
  ["extreme close-up","Extreme close-up"],
];

/* …and exactly one camera viewpoint. */
export const VIEWPOINTS = [
  ["front-facing",       "Front-facing"],
  ["side",               "Side / profile"],
  ["three-quarter",      "Three-quarter"],
  ["over-the-shoulder",  "Over-the-shoulder"],
  ["low-angle",          "Low angle"],
  ["high-angle",         "High angle"],
  ["top-down",           "Top-down"],
  ["POV",                "POV"],
];

/* Camera motion = type + amplitude + speed, written as prose. "medium
 * amplitude" and "normal speed" are the defaults and get omitted, which is
 * what the guide's own examples do. */
export const CAMERA_TYPES = [
  ["static",       "Static",        "The camera remains static"],
  ["push in",      "Push in",       "The camera pushes in"],
  ["pull out",     "Pull out",      "The camera pulls out"],
  ["zoom in",      "Zoom in",       "The camera zooms in"],
  ["zoom out",     "Zoom out",      "The camera zooms out"],
  ["pan left",     "Pan left",      "The camera pans left"],
  ["pan right",    "Pan right",     "The camera pans right"],
  ["truck left",   "Truck left",    "The camera trucks left"],
  ["truck right",  "Truck right",   "The camera trucks right"],
  ["tilt up",      "Tilt up",       "The camera tilts up"],
  ["tilt down",    "Tilt down",     "The camera tilts down"],
  ["pedestal up",  "Pedestal up",   "The camera pedestals up"],
  ["pedestal down","Pedestal down", "The camera pedestals down"],
  ["arc left",     "Arc left",      "The camera arcs left"],
  ["arc right",    "Arc right",     "The camera arcs right"],
  ["tracking",     "Tracking",      "The camera tracks with the subject"],
  /* "Handheld" is not in §4.3's table; "Shake Slightly" is, and it is the same
   * move. The id is kept because the Energy dial emits it and projects are
   * saved with it — only the words the encoder reads change. */
  ["handheld",     "Handheld",      "The camera shakes slightly"],
  ["slight shake", "Slight shake",  "The camera shakes slightly"],
  ["strong shake", "Strong shake",  "The camera shakes strongly"],
  /* §4.3 has "Roll Clockwise / Roll Counterclockwise" and no undirected roll.
   * Every other directional move in this table carries its direction, and the
   * previz has always drawn one rotation sign — so a bare "roll" agreed with
   * the preview about half the time and with the render never. The old id is
   * migrated to clockwise. */
  ["roll clockwise",        "Roll clockwise",        "The camera rolls clockwise"],
  ["roll counterclockwise", "Roll counterclockwise", "The camera rolls counterclockwise"],
];

/* The same moves as gerunds, for the second half of a compound move ("…,
 * while tilting up"). Spelled out rather than derived — "pan" → "paning" and
 * "push" → "pusheing" are exactly the kind of wrong word an LLM encoder
 * notices. */
export const CAMERA_GERUNDS = {
  "push in": "pushing in", "pull out": "pulling out",
  "zoom in": "zooming in", "zoom out": "zooming out",
  "pan left": "panning left", "pan right": "panning right",
  "truck left": "trucking left", "truck right": "trucking right",
  "tilt up": "tilting up", "tilt down": "tilting down",
  "pedestal up": "rising", "pedestal down": "lowering",
  "arc left": "arcing left", "arc right": "arcing right",
  "tracking": "tracking with the subject", "handheld": "shaking slightly",
  "slight shake": "shaking slightly", "strong shake": "shaking strongly",
  "roll clockwise": "rolling clockwise", "roll counterclockwise": "rolling counterclockwise",
  "static": "holding still",
};

export const AMPLITUDES = [["small", "Small"], ["medium", "Medium"], ["large", "Large"]];
export const SPEEDS     = [["slow", "Slow"], ["normal", "Normal"], ["fast", "Fast"]];

/* Lens, height and framing are the three things a shot type alone does not
 * say. They are separate controls because the model reads them as separate
 * facts: focal length sets the perspective ("compressed", "the background
 * falls away"), height sets who the viewer is, framing sets where the subject
 * sits in the rectangle. */
export const LENSES = [
  ["", "— unstated —"],
  ["fisheye 8mm",     "Fisheye 8mm — extreme curvature"],
  ["ultra-wide 16mm", "Ultra-wide 16mm — stretched, deep space"],
  ["wide 24mm",       "Wide 24mm — roomy, slight distortion"],
  ["35mm",            "35mm — natural reportage"],
  ["50mm",            "50mm — how the eye sees it"],
  ["85mm",            "85mm — portrait, soft background"],
  ["telephoto 135mm", "Telephoto 135mm — compressed, background falls away"],
  ["macro",           "Macro — surface detail, paper-thin focus"],
];

export const CAMERA_HEIGHTS = [
  ["", "— unstated —"],
  ["ground level",    "Ground level"],
  ["hip height",      "Hip height"],
  ["eye level",       "Eye level"],
  ["above eye level", "Above eye level"],
  ["overhead",        "Overhead"],
  ["drone height",    "Drone height"],
];

export const FRAMINGS = [
  ["centered",                 "Centred"],
  ["left third",               "Left third"],
  ["right third",              "Right third"],
  ["low in frame",             "Low in frame — headroom above"],
  ["high in frame",            "High in frame"],
  ["over-shoulder foreground", "Over-shoulder — foreground shoulder"],
];

/* Perspective and focus — what a lens does beyond how much it sees. These are
 * separate from the lens because they are separate facts to the model: focal
 * length sets the geometry, this sets what is sharp and what the geometry does
 * during the shot. */
export const DEPTH_CUES = [
  ["", "— unstated —"],
  ["shallow depth of field, the background thrown out of focus", "Shallow depth of field"],
  ["deep focus, foreground and background both sharp", "Deep focus"],
  ["the focus racks from the foreground to the background", "Rack focus → background"],
  ["the focus racks from the background to the subject", "Rack focus → subject"],
  ["a dolly zoom: the camera moves in while the lens widens, so the background stretches away behind the subject", "Dolly zoom (background stretches)"],
  ["a reverse dolly zoom: the camera pulls back while the lens narrows, so the background presses in behind the subject", "Reverse dolly zoom (background presses in)"],
  ["strong foreground bokeh in the near frame", "Foreground bokeh"],
  ["heavy lens flare across the frame from the key light", "Lens flare"],
];

/* A second, simultaneous move. Real camera work rarely does one thing at a
 * time, and H3 reads a compound move fine as long as both are named. */
export const SECONDARY_MOVES = [
  ["none", "— none —"],
  ["tilt up", "+ tilt up"], ["tilt down", "+ tilt down"],
  ["pan left", "+ pan left"], ["pan right", "+ pan right"],
  ["pedestal up", "+ pedestal up"], ["pedestal down", "+ pedestal down"],
  ["roll clockwise", "+ roll cw"], ["roll counterclockwise", "+ roll ccw"],
  ["push in", "+ push in"], ["pull out", "+ pull out"],
  ["slight shake", "+ slight shake"],
];

/* Approved cut verbs. Dissolves and fades exist but the guide asks for them
 * only on explicit request, so they are last and labelled. */
export const CUT_VERBS = [
  ["the camera cuts to",  "cuts to"],
  ["the shot cuts to",    "shot cuts to"],
  ["the shot transitions to", "transitions to"],
  ["the shot changes to", "changes to"],
  ["the shot switches to","switches to"],
  ["the shot dissolves to", "dissolves to (ask first)"],
  ["the shot fades to",   "fades to (ask first)"],
];

/* What happens between two shots. The verbs are the guide's; "none" is the
 * one thing the guide has no word for because it is not a cut: the next row
 * of the timeline continues the same take — a reframe, a move, a new beat —
 * and compiles INTO the previous [Shot N] block, with no new marker. That is
 * how a single-shot clip can still be authored as a list of moments. */
export const NO_CUT = "none";
export const TRANSITIONS = [
  ["the camera cuts to",       "Cut",                   "The guide's default: a straight cut. On LTX-2.5 it is written the way Lightricks' guide names a cut: \"a hard cut transitions to\""],
  ["the shot cuts to",         "Shot cut",              "Same as a hard cut, the guide's other wording"],
  ["the shot transitions to",  "Transition",            "An unspecified transition — the model decides"],
  ["the shot changes to",      "Change",                "Approved cut verb"],
  ["the shot switches to",     "Switch",                "Approved cut verb"],
  ["the shot dissolves to",    "Dissolve (ask first)",  "Exists, but the guide asks for it only on explicit request"],
  ["the shot fades to",        "Fade (ask first)",      "Exists, but the guide asks for it only on explicit request"],
  [NO_CUT,                     "No cut — same take",    "Continues the previous shot without a cut: no new [Shot N] marker, the reframe and beats are written into the same block"],
];
/* LTX-2.5 reads no [Shot N] dialect; Lightricks' 2.5 prompt guide names each
 * cut in prose — "A hard cut transitions to a close-up…". Every plain cut
 * verb becomes that phrase on the LTX engine; a dissolve or fade keeps its
 * own name, since those are different pictures. MiniMax keeps the guide's. */
export const LTX_HARD_CUT = "a hard cut transitions to";
export const cutVerbFor = (verb, engine) => {
  const v = verb || "the camera cuts to";
  if (engine !== "ltx25" || v === NO_CUT) return v;
  // docs.ltx.io, "Multi-shot prompts": name the transition in natural
  // language — "A hard cut transitions to…", "The view cuts to…",
  // "The image dissolves into…".
  if (/dissolve/i.test(v)) return "the image dissolves into";
  if (/fade/i.test(v)) return "the image fades into";
  if (/transitions/i.test(v)) return "the view cuts to";
  return LTX_HARD_CUT;
};
export const transitionLabel = (v) => (TRANSITIONS.find(t => t[0] === (v || "the camera cuts to")) || TRANSITIONS[0])[1];

/* Overall style — the first thing [Shot 1] has to establish. */
export const LOOKS = [
  "live-action cinematic",
  "documentary handheld",
  "35mm film",
  "16mm grainy film",
  "anamorphic widescreen",
  "vintage home video",
  "2D animation",
  "3D CG animation",
  "stop-motion",
  "black-and-white",
  "security-camera footage",
  "smartphone video",
];

/* A colourist's shelf. This is the one place the DaVinci lineage shows in the
 * prompt itself: a grade is a real, describable visual fact, and naming one
 * steers the model far better than "cinematic". */
export const GRADES = [
  ["", "— none —"],
  ["neutral Rec.709 grade with true blacks", "Rec.709 neutral"],
  ["warm golden-hour grade, amber highlights and soft shadows", "Golden hour"],
  ["teal-and-orange grade with cool shadows and warm skin tones", "Teal & orange"],
  ["bleach-bypass look, desaturated with crushed blacks and hard contrast", "Bleach bypass"],
  ["cool blue night grade with deep shadows and clean highlights", "Cool night"],
  ["Kodak 2383 print emulation, dense blacks and creamy highlight rolloff", "Print film 2383"],
  ["high-key grade, bright and low-contrast with lifted blacks", "High key"],
  ["low-key grade, most of the frame in shadow with a single bright source", "Low key"],
  ["muted pastel grade with soft contrast", "Muted pastel"],
  ["heavy film grain and halation around highlights", "Grain + halation"],
];

/* Ordered soft to hard, because that is the one thing about a light a creator
 * can feel without a light meter — and because the Light dial walks this list
 * rather than jumping around it. "Hard key light from the left" is here so a
 * dial asking for more contrast can harden the key it already has instead of
 * carrying it across to the other side of the face. */
export const LIGHTING = [
  "", "overcast diffused daylight", "soft key light from the left",
  "fluorescent overhead light", "single practical lamp in frame",
  "screen glow on the face", "moonlight through a window", "firelight flicker",
  "neon signage lighting the subject", "backlit with a bright rim",
  "harsh midday sun", "hard key light from the left", "hard key light from the right",
];

/* MiniMax H3 supports 11 dialogue languages; the words go in verbatim and are
 * never translated by the prompt layer. */
export const LANGUAGES = [
  "English", "Chinese", "Japanese", "Korean", "Spanish", "French",
  "German", "Italian", "Portuguese", "Russian", "Arabic",
];

export const SPEAKERS = ["S1", "S2", "S3", "S4"];

/* Ref2VA retention markers — the fixed vocabulary of the official rewriter's
 * retention_analysis section. Visual and audio have different sets. */
export const VISUAL_RETENTION = [
  ["fully_preserved",   "fully_preserved",   "Keep this subject exactly as shown — identity, clothing, everything"],
  ["partially_preserved","partially_preserved","Keep the identity, allow pose/framing/wardrobe to change"],
  ["attribute_transfer","attribute_transfer", "Take one attribute (a style, a texture, a colour) rather than the subject"],
  ["weak_reference",    "weak_reference",     "Loose inspiration only"],
];

export const AUDIO_RETENTION = [
  ["fully_copy",      "fully_copy",      "Use this audio as the finished soundtrack — lip-sync to it"],
  ["partially_copy",  "partially_copy",  "Reuse part of it, regenerate the rest"],
  ["reference",       "reference",       "Match its character, do not copy it"],
  ["weak_reference",  "weak_reference",  "Loose inspiration only"],
];

/* The task-type prefix that opens `summary` in full-reference mode. These six
 * are the guide's own table (ref §3) — they are a fixed vocabulary, and what
 * used to be here ("subject reference", "style reference", "scene reference",
 * "subject + scene reference", "audio-driven performance", "video motion
 * reference") intersected it in exactly zero places. A bracketed prefix the
 * rewriter never emitted is a phrase the encoder has never seen at the one
 * position it looks for a task type.
 *
 * The guide combines them with " + " when a task is more than one thing, which
 * is why the app derives the prefix from what is actually attached rather than
 * asking someone to pick one. */
export const REF_TASK_TYPES = [
  ["keyframe completion", "An image is a concrete frame of the target video — first, last or a keyframe"],
  ["reference generation", "An image, clip or audio guides a character, scene, style, action or camera — without being a frame or the source being edited"],
  ["video editing", "An existing source video is directly modified"],
  ["video continuation", "New content continues or extends an existing source video"],
  ["audio reuse", "The same audio signal is reused, in full or in part"],
  ["audio reference", "Only the style, timbre, words or rhythm of the audio is referenced — the signal is not copied"],
];

/* ── Render presets ───────────────────────────────────────── */

/* Turbo builds, transcribed from the lightx2v/ModelTC table. Steps and flow
 * shifts are properties of the distill, not preferences — upstream is explicit
 * that lora_name, steps, shift_video and shift_audio must be set together, and
 * the 768p build's shift_video of 6 is why none of this can be a constant. */
export const VARIANTS = {
  full: {
    key: "full", label: "Full (20-step)", family: "fl2va",
    lora: null, steps: 20, shiftVideo: 12, shiftAudio: 3,
    sampler: "res_multistep", scheduler: "simple",
    note: "The official Comfy-Org template settings. Slowest, best motion.",
  },
  turbo: {
    key: "turbo", label: "Turbo 8-step", family: "fl2va",
    lora: "turbo_lora_8", steps: 8, shiftVideo: 12, shiftAudio: 3,
    sampler: "euler", scheduler: "beta", trainedAt: "544p",
    note: "lightx2v v1.0 distill, trained at 544p. ~2.5× faster than the full pass.",
  },
  turbo4: {
    key: "turbo4", label: "Turbo 4-step (768p)", family: "fl2va",
    lora: "turbo_lora_4", steps: 4, shiftVideo: 6, shiftAudio: 3,
    sampler: "euler", scheduler: "beta", trainedAt: "768p (1344×768)",
    note: "v1.1 distill trained on the 1344×768 canvas — note shift_video 6, half of every other path.",
  },
  ref_full: {
    key: "ref_full", label: "Full (25-step)", family: "ref2va",
    lora: null, steps: 25, shiftVideo: 12, shiftAudio: 3,
    sampler: "res_multistep", scheduler: "beta",
    note: "25 rather than 20: ref2va AUDIO degrades before the video does, and 25 is the floor for a clean soundtrack.",
  },
  ref4: {
    key: "ref4", label: "Turbo 4-step (ref2v)", family: "ref2va",
    lora: "ref_turbo_lora", steps: 4, shiftVideo: 12, shiftAudio: 3,
    sampler: "euler", scheduler: "simple", trainedAt: "544p",
    note: "The ref2v v0.1 distill. Fast, but 4 steps is the worst case for the thing this mode fails at first — audio.",
  },

  /* The experimental second engine. These are Lightricks' own two distilled
   * workflows, not inventions: the step counts are manual sigma ladders baked
   * into the distill, so there is no steps or shift knob to turn — the build
   * IS the schedule. No LoRA either: the 2.5 transformer ships already distilled. */
  ltx_two: {
    key: "ltx_two", label: "Two-stage 8+3", family: "ltx25",
    lora: null, steps: 11, stages: 2,
    sampler: "euler_ancestral → euler", scheduler: "manual sigmas",
    note: "Lightricks' two-stage distilled workflow: 8 steps at half resolution, 2× latent upscale, then a 3-step refine — the official 768p-tier pipeline. Best quality of the two.",
  },
  ltx_single: {
    key: "ltx_single", label: "Single-stage 8-step", family: "ltx25",
    lora: null, steps: 8, stages: 1,
    sampler: "euler_ancestral", scheduler: "manual sigmas",
    note: "The official Single Stage Distilled workflow: the full 8-step schedule straight at target resolution. Roughly half the render time, and what upstream runs at the 480p tier — at 768p the two-stage build resolves more detail.",
  },
};

export const variantsFor = (mode, engine = "minimax") =>
  engine === "ltx25" && mode !== "r2v" ? [VARIANTS.ltx_two, VARIANTS.ltx_single]
    : mode === "r2v" ? [VARIANTS.ref_full, VARIANTS.ref4]
    : [VARIANTS.full, VARIANTS.turbo, VARIANTS.turbo4];

export function variantFor(mode, key, engine = "minimax") {
  const list = variantsFor(mode, engine);
  return list.find(v => v.key === key) || list[0];
}
