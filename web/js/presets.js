/* ── Scene presets ─────────────────────────────────────────────
 * A template knows a shot grammar; a scene preset also knows what the
 * pictures are FOR. "Apartment showcase" is six pictures of six rooms: one
 * shot per picture, in order, each citing its own picture and nothing else
 * — which is the structure the reel that named every room in every shot
 * was missing. The preset builds the shots, sets the length and the shot
 * count, and leaves a line of guidance that every writer in the app reads
 * (breakdown, the enhancer, the director), so a rewrite keeps the shape.
 *
 * build(ctx) is pure and takes the attached tags: the Cut page's picker
 * calls it several times per paint. */
import { newShot, newBeat, referenceInventory, DURATION_FRAMES } from "./state.js";

function shot(at, spec) {
  const s = newShot(at);
  const { beats = [], camera = {}, ...rest } = spec;
  Object.assign(s, rest);
  s.camera = { ...s.camera, ...camera };
  s.beats = (beats.length ? beats : [""]).map((b, i) => newBeat(typeof b === "string" ? b : b.text, i === 0 ? "" : (b.link || "then")));
  return s;
}

/** The smallest clip length the engine's grid offers that holds n shots of
 *  `per` seconds — the lengths the Deliver page lists, nothing in between. */
export function presetDuration(n, per, floor = 5) {
  const want = Math.max(floor, n * per);
  const grid = Object.keys(DURATION_FRAMES).map(Number).sort((a, b) => a - b);
  return grid.find(d => d >= want) ?? grid[grid.length - 1];
}

/** Evenly spaced cut points for n shots over `duration`, on the quarter second. */
function spread(n, duration) {
  return Array.from({ length: n }, (_, i) => Math.round((i * duration / n) * 4) / 4);
}

/** One shot per picture, in tag order, each citing its own picture. `grammar`
 *  hands back the framing for shot i of n. */
function perPicture(ctx, per, grammar) {
  const tags = ctx.tags.length ? ctx.tags : ["<Subject 1>"];
  const n = tags.length;
  const duration = presetDuration(n, per);
  return spread(n, duration).map((at, i) => shot(at, { subject: tags[i], ...grammar(i, n) }));
}

export const SCENE_PRESETS = [
  {
    key: "apartment",
    soundscape: "Quiet room tone of an empty apartment: the hum of the building, a distant street through the glass, the faint tick of a radiator; no footsteps, no voices.",
    name: "Apartment showcase",
    blurb: "One room per picture, in the order the pictures are attached. Each shot cites its own room and nothing else; slow moves, no people, room tone.",
    mode: "r2v", perShot: 2.5, perPicture: true,
    guidance: "A property reel. Every shot shows exactly ONE room, the one in the picture it cites, in the order the pictures are attached; never name another room's subject in a shot. Architecture, furniture and finishes stay exactly as the picture shows them — nothing added, moved or restyled. No people, no pets, no text. Natural window light, calm continuous camera moves, no dialogue; the soundscape is quiet room tone with the building's ambience.",
    build: (ctx) => perPicture(ctx, 2.5, (i) => ({
      shotType: i % 2 ? "medium wide" : "wide", viewpoint: i % 3 === 2 ? "low-angle" : "front-facing",
      camera: i % 2 ? { type: "truck right", amplitude: "small", speed: "slow" } : { type: "push in", amplitude: "small", speed: "slow" },
      beats: [i === 0 ? "the camera drifts into the room and settles" : "the camera glides through the room, light from the windows leading"],
    })),
  },
  {
    key: "product",
    soundscape: "A hushed studio bed: the soft whirr of a light, a faint air tone, one delicate contact sound as the item is revealed.",
    name: "Product showcase",
    blurb: "One picture per shot — each angle or item gets its own close-up with a small orbit, on a clean set.",
    mode: "r2v", perShot: 2, perPicture: true,
    guidance: "A product reel. Every shot presents the one item or angle in the picture it cites, exactly as shown — form, colour, material, branding untouched. Clean studio set, controlled soft key light with a subtle rim, shallow depth, slow deliberate moves that reveal surface and edge; no hands unless the picture shows them, no text. The soundscape is a quiet studio bed.",
    build: (ctx) => perPicture(ctx, 2, (i) => ({
      shotType: i % 2 ? "close-up" : "medium close-up", viewpoint: i % 2 ? "three-quarter" : "front-facing",
      camera: i % 3 === 0 ? { type: "push in", amplitude: "small", speed: "slow" } : i % 3 === 1 ? { type: "arc right", amplitude: "small", speed: "slow" } : { type: "static" },
      beats: ["light rakes across the surface as the camera moves"],
    })),
  },
  {
    key: "character",
    soundscape: "The ambience of the place they stand in — light wind or room tone, their footsteps and the movement of clothing as they turn.",
    name: "Character introduction",
    blurb: "The pictures are one person or one creature. Wide to close in three shots; identity fully preserved.",
    mode: "r2v", perShot: 3.5, perPicture: false,
    guidance: "A character introduction. All the pictures show the SAME subject; every shot is of that subject and preserves face, build, hair, wardrobe and colours exactly. Wide establishes the place, medium the posture and movement, close-up the face — one clear action across the three, no other people in frame.",
    build: (ctx) => {
      const tag = ctx.tags[0] || "<Subject 1>";
      const duration = presetDuration(3, 3.5, 10);
      const [a, b, c] = spread(3, duration);
      return [
        shot(a, { subject: tag, shotType: "wide", viewpoint: "front-facing", camera: { type: "static" }, beats: ["stands in the place, looks up"] }),
        shot(b, { subject: tag, shotType: "medium", viewpoint: "three-quarter", camera: { type: "push in", amplitude: "small", speed: "slow" }, beats: ["turns and starts to move"] }),
        shot(c, { subject: tag, shotType: "close-up", viewpoint: "front-facing", camera: { type: "static" }, beats: ["meets the camera"] }),
      ];
    },
  },
  {
    key: "location",
    soundscape: "The place's own ambience — wind, distant water or traffic, birds where there would be birds; no music, no voices.",
    name: "Location montage",
    blurb: "One place per picture: wide, slow, atmospheric. Travel, architecture, landscape.",
    mode: "r2v", perShot: 3, perPicture: true,
    guidance: "A location montage. Every shot is the one place in the picture it cites, in order, held wide and unhurried; the geography, light and weather of each picture are kept. No people unless the picture has them, no text. Slow drifts and pans; the soundscape is the place's own ambience.",
    build: (ctx) => perPicture(ctx, 3, (i) => ({
      shotType: i % 3 === 1 ? "extreme wide" : "wide", viewpoint: i % 4 === 3 ? "high-angle" : "front-facing",
      camera: i % 2 ? { type: "pan right", amplitude: "small", speed: "slow" } : { type: "push in", amplitude: "small", speed: "slow" },
      beats: ["the camera drifts, the light moves across the scene"],
    })),
  },
];


/* ── More scenes: things people photograph and want moving ─── */
SCENE_PRESETS.push(
  {
    key: "vehicle",
    name: "Vehicle showcase",
    blurb: "One angle per picture: exterior sweeps, detail, interior. The car stays exactly the car.",
    mode: "r2v", perShot: 2.5, perPicture: true,
    soundscape: "Quiet: a low ambient bed, the faint tick of cooling metal, one soft door or engine note where a picture implies it.",
    guidance: "An automotive reel. Every shot is the one vehicle, from the angle the picture it cites shows; body lines, paint, wheels, badges and interior stay exactly as photographed. Low or three-quarter angles, slow arcs and trucks that let reflections travel over the paint; clean location or studio; no people unless the picture has them; no text.",
    build: (ctx) => perPicture(ctx, 2.5, (i) => ({
      shotType: i % 3 === 2 ? "close-up" : i % 2 ? "medium wide" : "wide", viewpoint: i % 2 ? "three-quarter" : "low-angle",
      camera: i % 3 === 0 ? { type: "arc right", amplitude: "medium", speed: "slow" } : i % 3 === 1 ? { type: "truck left", amplitude: "small", speed: "slow" } : { type: "push in", amplitude: "small", speed: "slow" },
      beats: ["reflections slide along the body as the camera moves"],
    })),
  },
  {
    key: "food",
    name: "Food & drink",
    blurb: "One dish or drink per picture, close and appetising: steam, pour, garnish.",
    mode: "r2v", perShot: 2, perPicture: true,
    soundscape: "Kitchen and table ambience: a soft sizzle or pour where the picture implies it, glass and cutlery, a warm room.",
    guidance: "A food reel. Every shot is the one dish or drink in the picture it cites, exactly as plated — ingredients, colours and the vessel unchanged. Close, top-down or low three-quarter framing, soft directional light, shallow focus; one small appetising motion per shot (steam rising, a pour, a garnish landing, a slow turn); no faces, no text.",
    build: (ctx) => perPicture(ctx, 2, (i) => ({
      shotType: i % 2 ? "extreme close-up" : "close-up", viewpoint: i % 3 === 0 ? "top-down" : "three-quarter",
      camera: i % 2 ? { type: "push in", amplitude: "small", speed: "slow" } : { type: "arc left", amplitude: "small", speed: "slow" },
      beats: [i % 2 ? "steam and light play over the surface" : "a slow, appetising motion — a pour, a garnish, a turn"],
    })),
  },
  {
    key: "fashion",
    name: "Fashion lookbook",
    blurb: "One look per picture: the outfit worn, walked, turned. Garments exact.",
    mode: "r2v", perShot: 3, perPicture: true,
    soundscape: "A soft studio or street bed, fabric moving, footsteps; no voices.",
    guidance: "A lookbook. Every shot is the one look in the picture it cites — garment cut, fabric, colour, accessories and the wearer's appearance exactly as shown. Full-length to medium framing, a slow walk, a turn or a pause that shows drape and movement; clean set or the pictured location; flattering soft key light; no text.",
    build: (ctx) => perPicture(ctx, 3, (i) => ({
      shotType: i % 2 ? "medium" : "wide", viewpoint: i % 3 === 2 ? "side" : "front-facing",
      camera: i % 2 ? { type: "push in", amplitude: "small", speed: "slow" } : { type: "static" },
      beats: [i % 2 ? "turns, the fabric follows" : "walks toward the camera and pauses"],
    })),
  },
  {
    key: "hospitality",
    name: "Hotel & restaurant",
    blurb: "One space per picture: lobby, room, terrace, table. Warm, inviting, unhurried.",
    mode: "r2v", perShot: 2.5, perPicture: true,
    soundscape: "A warm hospitality ambience: soft room tone, distant conversation and cutlery, a breeze on the terrace.",
    guidance: "A hospitality reel. Every shot is the one space in the picture it cites, in order, exactly as furnished and lit; warm inviting light, slow welcoming moves — a push-in through a doorway, a drift along a table; a guest may appear only if the picture shows one; no text.",
    build: (ctx) => perPicture(ctx, 2.5, (i) => ({
      shotType: i % 2 ? "medium wide" : "wide", viewpoint: "front-facing",
      camera: i % 2 ? { type: "truck right", amplitude: "small", speed: "slow" } : { type: "push in", amplitude: "small", speed: "slow" },
      beats: ["the camera moves in as if arriving"],
    })),
  },
  {
    key: "retail",
    name: "Store & product range",
    blurb: "Storefront, then the range: one picture per shot, each item or display exact.",
    mode: "r2v", perShot: 2, perPicture: true,
    soundscape: "A bright retail ambience: soft music-free room tone, footsteps, a door.",
    guidance: "A retail reel. Every shot is the one storefront, display or item in the picture it cites, in order, exactly as shown — signage, packaging and layout unchanged. Clean bright light, steady moves that browse rather than rush; no text overlays.",
    build: (ctx) => perPicture(ctx, 2, (i) => ({
      shotType: i === 0 ? "wide" : i % 2 ? "close-up" : "medium", viewpoint: i % 3 === 2 ? "three-quarter" : "front-facing",
      camera: i === 0 ? { type: "push in", amplitude: "small", speed: "slow" } : i % 2 ? { type: "static" } : { type: "truck left", amplitude: "small", speed: "slow" },
      beats: [i === 0 ? "arriving at the storefront" : "the camera browses the display"],
    })),
  },
);

/* ── Mood and quality: guidance on the look, not the structure ─
 * A mood sets the grade (a real, describable visual fact the prompt names)
 * and adds a line on light and feel; a quality preset says what the camera
 * and stock are. Neither touches the shots, and both ride on every rewrite. */
export const MOOD_PRESETS = [
  { key: "golden",      name: "Golden hour",      grade: "warm golden-hour grade, amber highlights and soft shadows",
    guidance: "Late low sun: long soft shadows, amber highlights, a little haze in the backlight; warm and unhurried throughout." },
  { key: "clean",       name: "Clean commercial", grade: "neutral Rec.709 grade with true blacks",
    guidance: "Bright, even, high-key light; spotless surfaces; open, uncluttered composition; the subject is the hero and nothing is moody." },
  { key: "noir",        name: "Noir",             grade: "bleach-bypass look, desaturated with crushed blacks and hard contrast",
    guidance: "One hard light source, deep shadows, wet or reflective surfaces; faces half-lit; movement restrained and deliberate." },
  { key: "dreamy",      name: "Dreamy",           grade: "warm golden-hour grade, amber highlights and soft shadows",
    guidance: "Soft diffusion, bloom on the highlights, floating slow moves, shallow focus; a gentle, weightless feel." },
  { key: "night",       name: "Cool night",       grade: "cool blue night grade with deep shadows and clean highlights",
    guidance: "Night: cool ambient light with practical lamps and neon as warm accents, clean highlights, a quiet city hum." },
  { key: "teal",        name: "Teal & orange",    grade: "teal-and-orange grade with cool shadows and warm skin tones",
    guidance: "Blockbuster contrast: cool shadows against warm skin and light sources; punchy, never garish." },
  { key: "documentary", name: "Documentary",      grade: "neutral Rec.709 grade with true blacks",
    guidance: "Available light and natural colour, steady handheld moves with small human imperfections, real textures; nothing staged or polished." },
  { key: "epic",        name: "Epic",             grade: "",
    guidance: "Scale: wide vistas, dramatic shafts of light, slow sweeping moves, the subject small against the place." },
];

export const QUALITY_PRESETS = [
  { key: "photoreal",  name: "Photoreal",      guidance: "Photorealistic: physically plausible light and materials, accurate skin and fabric, fine detail kept; no stylisation, no painterly smoothing." },
  { key: "film35",     name: "35 mm film",     guidance: "Shot on 35 mm film: fine organic grain, gentle halation on highlights, soft highlight roll-off, filmic colour; nothing digitally sharp." },
  { key: "anamorphic", name: "Anamorphic",     guidance: "Anamorphic lenses: oval bokeh, horizontal blue flares on point lights, a slight stretch at the edges; a wide cinematic feel." },
  { key: "crisp",      name: "Crisp digital",  guidance: "A modern digital cinema camera: clean, sharp, wide dynamic range, no grain, precise focus; the detail is the point." },
  { key: "vintage",    name: "Vintage",        guidance: "Aged footage: faded colour, softer contrast, faint gate weave and dust, a nostalgic period feel." },
];

export const moodByKey = (key) => MOOD_PRESETS.find(t => t.key === key) || null;
export const qualityByKey = (key) => QUALITY_PRESETS.find(t => t.key === key) || null;

/** Set (or clear, with "") the mood: the grade is written into the style the
 *  prompt already names; the guidance rides on every rewrite. */
export function applyMood(draft, key) {
  draft.creative = draft.creative || {};
  const mood = moodByKey(key);
  draft.creative.mood = mood ? key : "";
  if (mood) { draft.style = draft.style || {}; draft.style.grade = mood.grade; }
  return mood;
}

export function applyQuality(draft, key) {
  draft.creative = draft.creative || {};
  draft.creative.quality = qualityByKey(key) ? key : "";
  return qualityByKey(key);
}

export const presetByKey = (key) => SCENE_PRESETS.find(t => t.key === key) || null;

/** What a preset builds from, for a given project. */
export function presetContext(project) {
  const tags = referenceInventory(project).filter(e => e.kind === "picture").map(e => e.tag);
  return { tags, picCount: tags.length, mode: project.mode };
}

/** Apply a preset to a project draft (inside update()): shots, length, shot
 *  count, mode, and the key that keeps the guidance on every LLM call. Pass
 *  key "" to clear the guidance without touching the shots. */
export function applyPreset(draft, key) {
  draft.creative = draft.creative || {};
  const preset = presetByKey(key);
  if (!preset) { draft.creative.preset = ""; return null; }
  if (preset.mode) draft.mode = preset.mode;
  const shots = preset.build(presetContext(draft));
  draft.shots = shots;
  draft.render.duration = presetDuration(shots.length, preset.perShot, preset.perPicture ? 5 : 10);
  draft.creative.shotCount = Math.min(8, shots.length);
  draft.sound = draft.sound || {};
  if (!String(draft.sound.soundscape || "").trim() && preset.soundscape) draft.sound.soundscape = preset.soundscape;
  draft.creative.preset = key;
  draft.selectedShot = shots[0]?.id || null;
  return preset;
}

/** The lines every writer sees while presets are on: scene, then mood, then
 *  quality, each on its own line. */
export function presetGuidance(project) {
  const c = project?.creative || {};
  const scene = presetByKey(c.preset), mood = moodByKey(c.mood), quality = qualityByKey(c.quality);
  return [
    scene ? `Scene preset — ${scene.name}: ${scene.guidance}` : "",
    mood ? `Mood — ${mood.name}: ${mood.guidance}` : "",
    quality ? `Image quality — ${quality.name}: ${quality.guidance}` : "",
  ].filter(Boolean).join("\n");
}
