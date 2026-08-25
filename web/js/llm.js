/* MOTIONSTILL CUT — the local-LLM prompt assistant.
 *
 * MiniMax ship an H3-Context-IR rewriter with the hosted model and say plainly
 * that you should use it or an equivalent. This is the equivalent: the same
 * output format, produced by whatever is loaded in LM Studio / Ollama /
 * llama.cpp on the same box.
 *
 * Every call goes through the server, which claims the GPU for the LLM first —
 * so in VRAM saver mode asking for a rewrite unloads ComfyUI, and rendering
 * unloads the LLM, automatically and in that order.
 */

import { detailToWriting, DEFAULT_DIALS } from "./steer.js";
import { api } from "./api.js";
import { getBlob } from "./media.js";
import { compilePrompt } from "./prompt.js";
import { referenceInventory, orderedShots, shotActionText, filmSpan, activeEngine } from "./state.js";
import { CLIP_MAX } from "./film.js";
import { CAMERA_TYPES, SHOT_TYPES, VIEWPOINTS } from "./vocab.js";

const BASE_RULES = `You write prompts for MiniMax H3 (Hailuo 3.0), an omni-modal video model with native
32 kHz audio, text-encoded by Qwen3-VL 32B. Rules that come from MiniMax's own prompt guide:

- Prose, never tags. The encoder is an LLM: it reads grammar and meaning. Booru tails
  ("masterpiece, best quality, 8k") are placebo and push toward a digital-art look.
- Concrete beats abstract. "Shifts her weight to her left foot, then slowly arches her back"
  survives encoding; "moves gracefully" does not.
- Restrained wording. "red dress", not "vibrant red dress". Intensifiers destabilise output.
- No negations. Never write what should be absent — the model tends to summon what you name.
  (One exception the guide itself uses: a clause that stops the model ADDING something,
  e.g. "without becoming a separate speaker source", is fine.)
- Present tense, chronological, one continuous take unless the shot list says otherwise.
- Emotions only as observable detail ("his eyebrows angle downward"), never inferred states.
- Describe people specifically, but never infer ethnicity, nationality or religion.
- Camera motion is ALWAYS stated. Motion type + amplitude + speed, as prose:
  "The camera pushes in with small amplitude at slow speed toward the doorway."
  If the camera does not move, say "The camera remains static." Never invent motion the idea
  doesn't call for.
- Shot types: ${SHOT_TYPES.map(s => s[0]).join(", ")}. Viewpoints: ${VIEWPOINTS.map(v => v[0]).join(", ")}.
  Camera moves: ${CAMERA_TYPES.map(c => c[0]).join(", ")}.
- Action beats are BARE CLAUSES, lowercase, beginning with a verb: "looks up at the standing
  soldier", never "She looks up at the standing soldier." The app joins them into one sentence
  and writes ", then " in front of each one after the first, so a capitalised sentence lands in
  the middle of another sentence and reaches the encoder as "…, then She looks up".
- Dialogue: stable speaker ids (S1), (S2) and the tag <d>[Language] exact words</d>. The words go
  in verbatim, are never translated, and carry their own final punctuation INSIDE the tag.
  Mentioning speech without quoted words makes the model invent dialogue.
  The FIRST time a speaker talks, say who they are and how they sound outside the tag —
  "The young woman with a quiet, breathy voice (S1) says, <d>[English] …</d>" — character type,
  age, whether they are on screen, pitch, timbre, pace or accent. A bare "(S1) says" gives H3
  nothing to build a voice out of. Voiceover uses the exact phrase "says in an off-screen
  voiceover" and is immediately followed by a statement that the lips remain completely closed.
- A line the cut lands in the middle of takes <scenetrans> at BOTH sides and a sentence saying it
  carries over; a line the clip ends before finishing takes <cutoff>.
- On-screen text — signs, banners, labels, subtitles, neon — goes in double quotes, verbatim,
  never translated: A red neon sign reading "OPEN" glows above the doorway. Escape the quotes
  for JSON.
- Shot syntax: [Shot 1] with no timestamp, then "[Shot 2] At 00:03.500, the camera cuts to …".
  A single-shot clip still opens with [Shot 1]. Cut times strictly increase and stay inside the
  clip. A cut must introduce new information — if only the distance or angle changes, prefer
  camera motion.
- overall_soundscape: 1–4 sentences NAMING SOUNDS — wind, rain, traffic, footsteps, fabric,
  impacts, breathing, laughter. Not categories of sound: "the physical sounds of what is
  happening" names nothing and is not an answer. Dialogue and music must NOT be repeated here.
  "N/A" ONLY if the brief explicitly asks for a completely silent video.
- Music the characters can hear — an instrument, a radio, a phone, someone singing — is diegetic
  and belongs in the description, not in either sound field.
- non_diegetic_music: 1–3 sentences of instrumentation, tempo, rhythm and dynamics. No abstract
  mood words ("epic", "haunting"), and never explain what the score is FOR. "N/A" if none.

Answer with JSON only. No prose outside the JSON, no code fences.`;

/**
 * @param {object} body  … plus `expect`: the top-level keys this call wants
 *   back. A reply can contain more than one parseable object — a worked
 *   example the model talked itself through, a draft it abandoned — and the
 *   keys are what tell the parser which one is the answer.
 */
async function ask(body) {
  // `images` rides through untouched: the server routes a call that carries
  // them to the configured vision model.
  const r = await api.chat({ json: true, ...body });
  const data = r.json ?? null;
  if (!data) {
    // The server works out WHY and what to change; repeating "try a larger
    // model" at someone whose model was simply told to think was wrong most of
    // the time, and gave them nothing to act on.
    const why = r.jsonFailure;
    const err = new Error(why ? `${why.title}. ${why.detail}` : "The model did not answer with JSON.");
    err.raw = r.text;
    err.jsonCause = why?.cause || "not-json";
    err.fix = why?.fix || "model";
    throw err;
  }
  return { data, model: r.model, ms: r.ms };
}

/**
 * The reference tags, and the rule that makes them matter.
 *
 * MiniMax H3 only uses a reference the prompt actually NAMES. A picture that
 * is attached but never cited is ignored completely — so every writer in this
 * file has to be told the tags, not merely shown the pictures. Describing what
 * is in an image is not the same as citing it, and the difference is invisible
 * until the render comes back without it.
 */
function tagRules(project) {
  const inv = referenceInventory(project).filter(e => e.kind !== "audio");
  /* I2V's first frame is <Picture 1> and lives outside referenceInventory, so
   * this used to return nothing at all for the one mode where citing the tag
   * is what anchors the opening. */
  if (project.mode === "i2v" && project.frames?.first) {
    inv.unshift({ kind: "picture", tag: "<Picture 1>", ref: project.frames.first });
  }
  if (!inv.length) return "";
  return `
THE ATTACHED REFERENCES HAVE NAMES, AND YOU MUST USE THEM:
${inv.map(e => `  ${e.tag} — ${e.ref?.label || e.ref?.name || e.kind}${e.ref?.caption ? `: ${e.ref.caption}` : ""}`).join("\n")}
Write the tag inline in "subject" for every reference the shot is of, exactly as shown —
e.g. "${inv[0]?.tag || "<Subject 1>"}, a woman in a grey wool coat". Describing the picture is NOT
enough: an attached reference that no part of the prompt names is ignored by the model. Never
invent a tag that is not listed here, and never change one label into another — <Subject N> is a
person, an object or a place to reproduce; <Picture N> is an image used as an actual frame of the
video; <Video N> is a clip whose motion or structure is followed; <Audio N> is a sound.`;
}

function projectBrief(project) {
  const inv = referenceInventory(project);
  const shots = orderedShots(project);
  return [
    `Mode: ${project.mode.toUpperCase()} (${project.mode === "t2v" ? "text to video" : project.mode === "i2v" ? "image to video, the first frame is fixed" : "reference to video"}).`,
    project.film?.enabled
      ? `Length: ${filmSpan(project)} seconds at ${project.render.fps} fps, ${project.render.resolution} — rendered as SEVERAL clips of at most `
        + `${CLIP_MAX} s each, broken at your cuts and joined afterwards.`
      : `Clip length: ${project.render.duration} seconds at ${project.render.fps} fps, ${project.render.resolution}.`,
    `Overall style: ${project.style?.look || "live-action cinematic"}${project.style?.grade ? `, ${project.style.grade}` : ""}.`,
    shots.length > 1
      ? `Shot list: ${shots.length} shots, cutting at ${shots.map(s => `${(s.at || 0).toFixed(2)}s`).join(", ")}.`
      : "A single continuous take.",
    shots.some(s => shotActionText(s))
      ? `Action beats, in order: ${shots.map((s, i) => `[Shot ${i + 1}] ${shotActionText(s) || "—"}`).join(" ")}`
      : "",
    inv.length ? `Attached references — cite EXACTLY these tags and no others: ${inv.map(e => `${e.tag} (${e.ref?.label || e.ref?.name || e.kind})`).join(", ")}. A tag with no media behind it is silently ignored.` : "",
    project.mode === "i2v" && project.frames?.first?.caption ? `The fixed first frame shows: ${project.frames.first.caption}` : "",
    /* How much to say per shot — the Detail dial. It is a target for the
     * writer, so it rides on every call that writes: breakdown, polish, enhance. */
    (() => {
      const w = detailToWriting((project.creative?.dials || {}).detail ?? DEFAULT_DIALS.detail);
      return `Level of detail per shot — ${w.name.toUpperCase()}, about ${w.wordsPerShot} words a shot across its fields: ${w.rules}`;
    })(),
  ].filter(Boolean).join("\n");
}

/* ── 1. Idea → shot list ──────────────────────────────────
 * The director's-assistant verb: one line in, a timed shot list out. Past
 * H3's ~15 s training window a single-take prompt degrades, so this is how a
 * long clip stays coherent. */
export async function breakdown(idea, project, shotCount = 0) {
  /* In a film the target is the whole piece, not one clip — and the shot count
   * has to scale with it, or a 90-second film comes back as six shots of
   * fifteen seconds each and every one of them is its own clip with nothing
   * happening in it. */
  const isFilm = !!project.film?.enabled;
  const duration = isFilm ? filmSpan(project) : project.render.duration;
  const suggested = shotCount || Math.max(1, Math.min(isFilm ? 24 : 6, Math.round(duration / (isFilm ? 6 : 5))));
  const { data, model, ms } = await ask({
    expect: ["shots"],
    system: `${BASE_RULES}

You are breaking an idea into a shot list for a ${duration}-second ${isFilm ? "film" : "clip"}.
Return: {"shots":[{"at":0,"shotType":"medium","viewpoint":"front-facing","subject":"…","beats":["…","…"],"setting":"…","lighting":"…","camera":{"type":"push in","amplitude":"small","speed":"slow","target":"…"},"details":"…"}]}
- Exactly ${suggested} shots unless the idea clearly needs a different number (never more than ${isFilm ? 24 : 8}).
- "at" is seconds from the start; the first is always 0 and they strictly increase, all inside ${duration} s.
- Give each shot at least 2 seconds${isFilm ? ` and at most ${CLIP_MAX}` : ""}. A cut must introduce new information.${isFilm ? `
- This is rendered as several clips of at most ${CLIP_MAX} s, broken at YOUR cut times: a run of shots is packed into one clip until the next
  shot would not fit. So place cuts where a hard break would be acceptable — the model renders each clip separately and remembers nothing across
  a break except the final frame. Do not write a shot that only makes sense because of something two shots earlier.
- Say what is on screen in every shot's own words. A subject described once in shot 1 and referred to as "she" in shot 6 arrives at a clip that
  never saw shot 1.` : ""}
- "subject" is a noun phrase; "setting" is where it happens.
- "beats" are the shot's action, in order, present tense, ONE PER 2–3 SECONDS OF THAT SHOT and no more.
  A 4-second shot gets 1–2 beats. Each beat is a short clause, not a sentence with its own subject.
- camera.type must be one of: ${CAMERA_TYPES.map(c => c[0]).join(", ")}.
${tagRules(project)}`,
    prompt: `${projectBrief(project)}\n\nThe idea:\n${idea}`,
    temperature: 0.8,
    maxTokens: 2000,
  });
  const shots = Array.isArray(data.shots) ? data.shots : [];
  if (!shots.length) throw new Error("The model returned no shots.");
  return { shots, model, ms };
}

/**
 * Every image the prompt is conditioned on, as data URLs, so the rewriter can
 * LOOK at them rather than trusting a caption someone may not have written.
 * I2V's fixed first frame first, then the reference images in tag order; a
 * vision model is asked for at most `max` of them, because reference tokens
 * are not free and the tail of a long pool rarely changes the description.
 */
export async function projectImages(project, { max = 6 } = {}) {
  const wanted = [];
  if (project.mode === "i2v" && project.frames?.first) {
    wanted.push({ tag: "<Picture 1>", role: "the fixed first frame", media: project.frames.first });
  }
  if (project.mode === "r2v") {
    (project.refs?.images || []).forEach((m, i) => wanted.push({ tag: `<Picture ${i + 1}>`, role: "a reference image", media: m }));
  }
  const out = [];
  for (const item of wanted.slice(0, max)) {
    const data = await getBlob(item.media.id);
    if (data && String(data).startsWith("data:image/")) out.push({ ...item, dataUrl: data });
  }
  return out;
}

/* ── 2. The rewriter ──────────────────────────────────────
 * Takes whatever the timeline currently compiles to and returns it in the
 * shape H3's own IR rewriter emits. This is the button the guide is really
 * asking for. */
export async function enhance(project, { instruction = "", useVision = true } = {}) {
  const compiled = compilePrompt(project);
  // The optimizer used to rewrite a prompt about images it had never seen.
  const images = useVision ? await projectImages(project) : [];
  const isRef = project.mode === "r2v";
  /* The base guide states NO word count. The number that used to be here came
   * from this app quoting itself, and all four of MiniMax's canonical examples
   * are shorter than it — 85, 81, 93 and 98 words. Asking for 150 minimum was
   * asking the writer to pad. The reference guide's 350-500 IS real (ref §5.2),
   * with its own carve-out for dialogue-dense clips. */
  const budget = isRef ? "350–500 words unless the clip is dialogue-dense, in which case fit the whole spoken timeline instead" : "a paragraph — as long as the shot list needs and no longer";
  const schema = isRef && project.ref2v?.useFullIR
    ? `{"subject_definitions":"…","summary":"…","detailed_description":"…","overall_soundscape":"…","non_diegetic_music":"…"}`
    : isRef
      ? `{"detailed_description":"…","overall_soundscape":"…","non_diegetic_music":"…"}`
      : `{"integrated_multimodal_description":"…","overall_soundscape":"…","non_diegetic_music":"…"}`;

  const { data, model, ms } = await ask({
    expect: ["integrated_multimodal_description", "detailed_description", "description", "overall_soundscape", "non_diegetic_music"],
    system: `${BASE_RULES}

You are rewriting a draft into the final MiniMax H3 prompt.
Return exactly: ${schema}
- The description field is ${budget}, one flowing paragraph that ${activeEngine(project) === "ltx25"
    ? "keeps every cut named in prose EXACTLY as given (\"A hard cut transitions to…\", \"The image dissolves into…\") with the audio continuity stated after each — no [Shot N] markers, no timestamps, no field labels."
    : "keeps the [Shot N] markers and their cut timestamps EXACTLY as given. A single-shot clip still opens with [Shot 1] and carries no timestamp."}
- Keep every concrete detail the draft gives: names, wardrobe, props, locations, quoted dialogue,
  camera moves and their amplitude/speed. Add only what is implied. Invent no new camera motion.
- Keep every <d>[Language] … </d> tag and every (S1)/(S2) speaker id byte-for-byte.
${isRef ? "- Keep every <Picture N>/<Video N>/<Audio N> tag exactly as given, and cite each attached reference for what it actually shows. Never cite a tag that is not attached.\n" : ""}${project.mode === "i2v" ? "- The opening must match the fixed first frame exactly — same subject, appearance, clothing and setting — and then narrate forward from it. Cite <Picture 1> where you establish it, and say what is preserved: \"the young woman shown in <Picture 1> remains beside the window, preserving her appearance, clothing and seat position\".\n" : ""}- Dialogue and music never appear in overall_soundscape.
${instruction ? `\nThe user also asks: ${instruction}` : ""}`,
    prompt: [
      projectBrief(project),
      images.length
        ? `\nThe attached images, in order: ${images.map(i => `${i.tag} — ${i.role}`).join("; ")}.\n`
          + "Describe what is ACTUALLY in them — subject, appearance, clothing, setting, lighting, framing — and make the prompt agree with it. "
          + "Where the draft contradicts an image, the image wins."
        : "",
      `\nThe current draft:\n\n${compiled.text}`,
    ].filter(Boolean).join("\n"),
    images: images.map(i => i.dataUrl),
    temperature: 0.7,
    maxTokens: isRef ? 2600 : 1800,
  });

  return {
    model, ms, sawImages: images.length,
    description: data.detailed_description || data.integrated_multimodal_description || data.description || "",
    soundscape: data.overall_soundscape || "",
    music: data.non_diegetic_music || "",
    subjectDefs: data.subject_definitions || "",
    summary: data.summary || "",
  };
}

/* ── 3. One shot at a time ────────────────────────────────
 * The inspector's own rewrite: same rules, scoped to the selected clip, so a
 * shot can be sharpened without touching the rest of the timeline. */
export async function polishShot(shot, index, project, instruction = "") {
  const ordered = orderedShots(project);
  const end = index + 1 < ordered.length ? ordered[index + 1].at : project.render.duration;
  const lengthSeconds = Math.max(0, end - (shot.at || 0));
  const { data, model, ms } = await ask({
    expect: ["subject", "beats", "camera"],
    system: `${BASE_RULES}

You are rewriting ONE shot of a shot list. Return exactly:
{"subject":"…","beats":["…","…"],"setting":"…","lighting":"…","details":"…","camera":{"type":"…","amplitude":"small|medium|large","speed":"slow|normal|fast","target":"…"}}
Keep the shot's existing intent; make it concrete and observable. Do not add dialogue.
Keep the same number of beats unless the shot clearly needs fewer — never add beats.
camera.type must be one of: ${CAMERA_TYPES.map(c => c[0]).join(", ")}.
${tagRules(project)}${instruction ? `\nThe user also asks: ${instruction}` : ""}`,
    prompt: `${projectBrief(project)}\n\nShot ${index + 1} of ${project.shots.length}, at ${(shot.at || 0).toFixed(2)}s, lasting ${lengthSeconds.toFixed(1)}s (room for about ${Math.max(1, Math.ceil(lengthSeconds / 2))} beats):\n`
      + JSON.stringify({
          subject: shot.subject,
          beats: (shot.beats || []).map(b => b.text).filter(Boolean),
          setting: shot.setting, lighting: shot.lighting, details: shot.details, camera: shot.camera,
        }, null, 2),
    temperature: 0.7,
    maxTokens: 900,
  });
  return { ...data, model, ms };
}

/* ── 4. Sound ─────────────────────────────────────────────
 * The soundscape and the score are separate fields for a reason, and the
 * model is strict about what belongs in each. Generating both together is the
 * only way to keep them from overlapping. */
export async function soundFor(project, instruction = "") {
  const compiled = compilePrompt(project);
  const { data, model, ms } = await ask({
    expect: ["overall_soundscape", "non_diegetic_music"],
    system: `${BASE_RULES}

Write the two audio fields for this video. Return exactly:
{"overall_soundscape":"…","non_diegetic_music":"…"}
- overall_soundscape: 1–4 sentences. Ambience, physical sounds, non-verbal vocals, in the order
  they happen. No dialogue (it is already written), no music. "N/A" for deliberate silence.
- non_diegetic_music: 1–3 sentences. Instrumentation, tempo, rhythm, dynamics — no mood words
  like "epic" or "emotional". "N/A" if the clip should have no score.${instruction ? `\nThe user also asks: ${instruction}` : ""}`,
    prompt: `${projectBrief(project)}\n\nThe video:\n${compiled.description}`,
    temperature: 0.75,
    maxTokens: 700,
  });
  return { soundscape: data.overall_soundscape || "", music: data.non_diegetic_music || "", model, ms };
}

/* ── 5. Vision: describe an attached image ────────────────
 * I2V's opening has to match the reference frame exactly or the model cuts
 * away from it in the first second. Asking a vision model what is actually in
 * the picture is the cheapest way to get that right. */
export async function captionImage(dataUrl, { purpose = "first frame", model = "" } = {}) {
  const r = await api.chat({
    system: "You describe images for a video model's prompt. Plain observable facts only: subject, appearance, clothing, pose, setting, lighting, framing. No interpretation, no mood, no quality words. Two to four sentences, present tense.",
    prompt: purpose === "first frame"
      ? "Describe this image as the opening frame of a video: what is in it, how it is framed, how it is lit."
      : "Describe this reference image: who or what it shows, and the details that identify it.",
    images: [dataUrl],
    model: model || undefined,
    temperature: 0.4,
    maxTokens: 400,
  });
  return { caption: (r.text || "").trim(), model: r.model, ms: r.ms };
}

/* ── 6. The dry run ───────────────────────────────────────
 * Previz shows what the TIMELINE says. This asks a reader what the PROMPT
 * says — shot by shot, what it would actually render, and where two readings
 * are both available. Ambiguity is the failure mode a prompt can't see in
 * itself: you know what you meant, so the sentence looks fine.
 */
export async function dryRun(project) {
  const compiled = compilePrompt(project);
  const shots = orderedShots(project);
  const { data, model, ms } = await ask({
    expect: ["shots", "overall", "biggestRisk", "fixes"],
    system: `You are reading a MiniMax H3 prompt the way the model would, and reporting what you
would render from it. You are not improving it and not rewriting it.

Return exactly:
{"shots":[{"n":1,"renders":"…","ambiguity":"…","risk":"low|medium|high"}],"overall":"…","biggestRisk":"…",
 "fixes":[{"shot":1,"field":"subject|beats|setting|lighting|details|shotType|viewpoint|camera.type|camera.amplitude|camera.speed|camera.target|camera.lens|camera.height|camera.depth|at|soundscape|music","value":"…","why":"…"}]}
- One entry per [Shot N] in the prompt (or a single entry for a continuous take).
- "renders": what you would actually put on screen for that shot, in one or two sentences.
  Be concrete about what you had to decide for yourself.
- "ambiguity": the specific phrase that could be read more than one way, and the two readings.
  Empty string if there is genuinely none.
- "risk": how likely this shot is to come back as something other than intended.
- "overall": whether the shots read as one continuous piece, and whether the audio fields
  match what is on screen.
- "biggestRisk": the single thing most likely to go wrong, named plainly.
- "fixes": at most five concrete edits that would remove the ambiguities you just named.
  Each one names the shot, ONE field from the list above, and the exact value to put in it —
  not advice, the value itself. "beats" takes an array of short clauses. "at" is a number of
  seconds. "soundscape" and "music" are clip-wide and take shot 0. Camera fields must use the
  vocabulary above (${CAMERA_TYPES.map(c => c[0]).join(", ")}; amplitude small|medium|large;
  speed slow|normal|fast). Omit the array entirely if the prompt needs nothing.`,
    prompt: `A ${project.render.duration}-second clip at ${project.render.resolution}, ${shots.length} shot(s).\n\n${compiled.text}`,
    temperature: 0.5,
    maxTokens: 2000,
  });
  return {
    shots: Array.isArray(data.shots) ? data.shots : [],
    overall: data.overall || "",
    biggestRisk: data.biggestRisk || "",
    fixes: Array.isArray(data.fixes) ? data.fixes : [],
    model, ms,
  };
}

/* ── 7. Ref2V bookkeeping ─────────────────────────────────
 * subject_definitions and the summary line are the two fields of the official
 * reference format that are pure description of the cast — the retention
 * markers stay a user decision, because they are a directive, not a guess. */
export async function describeReferences(project) {
  const inv = referenceInventory(project);
  if (!inv.length) throw new Error("No references attached.");
  const { data, model, ms } = await ask({
    expect: ["subject_definitions", "summary", "captions"],
    system: `${BASE_RULES}

Write the reference bookkeeping for a MiniMax H3 ref2va prompt. Return exactly:
{"subject_definitions":"…","summary":"…"}
- subject_definitions: one sentence per tag, in the order given, naming what each tag shows and the
  details that identify it. Use the tags verbatim.
- summary: one or two sentences describing the video to be produced with those references.
Cite only the tags listed. A tag with no media behind it is silently ignored by the model.`,
    prompt: `${projectBrief(project)}\n\nThe intended video:\n${compilePrompt(project).description || "(not written yet)"}`,
    temperature: 0.6,
    maxTokens: 1200,
  });
  return { subjectDefs: data.subject_definitions || "", summary: data.summary || "", model, ms };
}
