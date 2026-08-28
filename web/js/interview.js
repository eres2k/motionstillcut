/* MOTIONSTILL CUT — the interview.
 *
 * A creator arrives with material, not with a specification. The gap between
 * "this photo, and something about her leaving" and a prompt MiniMax H3 can do
 * its best work on is a handful of questions — and the app should ask them,
 * with its own answers already filled in, rather than presenting an empty form.
 *
 * One model call reads everything that was dropped and proposes the lot: who we
 * are watching, where it is, what happens beat by beat, whether anyone speaks,
 * and where the dials should start. Every proposal is a suggestion the creator
 * can take, edit or ignore — the app never silently decides.
 */

import { api } from "./api.js";
import { referenceInventory, activeEngine } from "./state.js";
import { getBlob } from "./media.js";
import { DEFAULT_DIALS } from "./steer.js";

const clampDial = (v, fallback) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Math.round(Number(v)))) : fallback);

/** Everything the creator dropped, in a shape a model can read. */
export async function gatherMaterial(project) {
  const images = [];
  const add = async (media, role) => {
    if (!media) return;
    const data = await getBlob(media.id);
    // The id rides along so the tag list can be built from the images actually
    // sent, rather than by counting positions in a differently-filtered array.
    if (data && String(data).startsWith("data:image/")) {
      images.push({ id: media.id, role, dataUrl: data, name: media.label || media.name });
    }
  };
  await add(project.frames?.first, "the opening frame");
  // The whole pool, not the first five. The intake caps at 9 and the node takes
  // 9, so reading fewer meant the model was told to cite pictures it had never
  // been shown — and it would dutifully invent what was in them.
  for (const m of (project.refs?.images || []).slice(0, 9)) await add(m, "a reference");

  const clips = (project.refs?.videos || []).map(v => v.label || v.name);
  const sounds = (project.refs?.audios || []).map(a => a.label || a.name);
  return { images, clips, sounds, text: (project.creative?.material?.text || "").trim() };
}

/**
 * One call, everything proposed. Returns a draft the interview cards render.
 */
export async function readMaterial(project) {
  const material = await gatherMaterial(project);
  /* One LTX-2.5 render: measured on this app's own renders (28 Aug 2026),
   * six cuts in 20 s came back as one take; the guide's 2–4 shots held. A
   * shot needs ~5 s to be a shot, so the cut budget follows the duration:
   * 10 s → 1, 15 s → 2, 20 s and up → 3. */
  const ltxOne = activeEngine(project) === "ltx25" && !(project.film?.enabled && project.film?.splitAtCuts);
  const typed = Number(project.creative?.shotCount) || 0;
  const maxCuts = typed > 1 ? typed - 1 : Math.max(1, Math.min(3, Math.floor((project.render?.duration || 5) / 5) - 1));
  const has = {
    text: !!material.text, images: material.images.length,
    clips: material.clips.length, sounds: material.sounds.length,
  };

  // The tags, in the order the images are attached — which is the order they
  // ride in the message. Without these the model writes prose that describes
  // the pictures instead of CITING them, and H3 ignores a reference no part of
  // the prompt names.
  /* Only the pictures the model can actually see. Listing a tag it was never
   * shown is worse than omitting it: the prompt tells the model to cite and
   * describe that reference, so it invents what is in it. Anything unread is
   * named separately as unread, so the creator can see why. */
  const seen = new Set(material.images.map(i => i.id));
  const inv = referenceInventory(project).filter(e => e.kind !== "audio");
  const shown = inv.filter(e => e.ref?.id && seen.has(e.ref.id));
  const unread = inv.filter(e => e.ref?.id && !seen.has(e.ref.id));
  const roleOf = (e) => material.images.find(i => i.id === e.ref?.id)?.role || "a reference";
  const tagLines = shown.map(e => `${e.tag} — ${roleOf(e)}: ${e.ref?.label || e.ref?.name || "attached media"}`);

  const r = await api.chat({
    json: true,
    expect: ["idea","subject","setting","beats","speaks","line","voice","mood","dials","questions"],
    mode: project.mode,
    system: `You are a director reading a creator's raw material and proposing a first pass at a video.
The video will be made by ${ltxOne ? "LTX-2.5 in ONE generation, which reads its cuts out of prose and holds at most " + (maxCuts + 1) + " shots: write at most " + maxCuts + " \"Cut to\" beat" + (maxCuts === 1 ? "" : "s") + ", each shot at least 4 seconds with one or two beats of its own" : "MiniMax H3"}, which renders about one action beat every 2–3 seconds, with its own audio.
Never write that someone "speaks", "says" or "shouts" inside a beat — the words go in "line", and a beat that mentions speech without them makes the model invent dialogue.
If the video needs more than one shot, the beat where a new shot begins STARTS WITH "Cut to <framing>, " — for example
"Cut to close-up, she looks up from the letter" — and that beat is the first of the new shot. A cut is never described any other way,
and never buried inside a beat.${(Number(project.creative?.shotCount) || 0) > 1
  ? `\nThe creator wants EXACTLY ${project.creative.shotCount} shots: write exactly ${project.creative.shotCount - 1} "Cut to" beats, spaced through the action.`
  : (Number(project.creative?.shotCount) || 0) === 1 ? "\nThe creator wants ONE continuous shot: no \"Cut to\" beats at all." : ""}
${tagLines.length ? `
THE PICTURES HAVE NAMES, AND YOU MUST USE THEM:
${tagLines.join("\n")}

H3 only uses a reference the prompt actually cites. A picture that is attached but never named is
ignored completely — so "subject" MUST contain the tag for every picture the video is of, written
inline exactly as shown, e.g. "<Picture 1>, a woman in a grey wool coat". Describe what is in the
picture AND cite it; a description alone is not enough. Never invent a tag that is not listed above.
${unread.length ? `${unread.map(e => e.tag).join(", ")} ${unread.length === 1 ? "is" : "are"} also attached but NOT shown to you — do not describe ${unread.length === 1 ? "it" : "them"}.\n` : ""}` : ""}

Return exactly:
{"idea":"…","subject":"…","setting":"…","beats":["…","…"],"speaks":false,"line":"","voice":"","mood":"…",
 "dials":{"distance":0-100,"energy":0-100,"pace":0-100,"light":0-100,"sound":0-100,"faithfulness":0-100},
 "questions":[{"id":"…","ask":"…","options":["…","…","…"]}]}

- "subject" is a noun phrase describing who or what we watch, concrete and observable —
  appearance, clothing, age if visible. If an image was given, describe WHAT IS IN IT, not what you imagine.
- "setting" is where it happens, in a few words.
- "beats" are what happens, in order, present tense, each a short clause. Give ${has.text ? "as many as the idea supports" : "two or three"}, never more than six.
- "speaks": true only if the material implies someone talking. "line" is the exact words if so.
- "voice": who speaks and how they sound, when "speaks" is true — the model builds the voice from this
  alone. One phrase: character type, age, on screen or not, pitch, timbre, pace, accent —
  "a woman in her forties with a low, unhurried voice", "an off-screen narrator, older man, warm and dry".
  Empty when nobody speaks.
- "dials" are your reading of the material: distance (far → close), energy (still → restless),
  pace (one long breath → quick), light (soft → hard), sound (silent → full mix),
  faithfulness (loose → keep the pictures exactly). Pick what the material asks for, not the middle.
- "questions": at most three, ONLY where a real decision is missing and would change the result.
  Each needs 3 short concrete options. Do not ask about things the material already answers.
Answer with JSON only.`,
    prompt: [
      has.text ? `What they wrote:\n${material.text}` : "They wrote nothing — the material is the pictures.",
      has.images ? `\nAttached images, in order: ${material.images.map(i => i.role).join("; ")}. Describe what is actually in them.` : "",
      has.clips ? `\nReference clips: ${material.clips.join(", ")}.` : "",
      has.sounds ? `\nReference audio: ${material.sounds.join(", ")}.` : "",
      `\nThe clip will be ${project.render?.duration || 5} seconds long.`,
    ].filter(Boolean).join("\n"),
    images: material.images.map(i => i.dataUrl),
    temperature: 0.7,
    maxTokens: 1600,
  });

  // A null here used to mean an empty interview and a GREEN toast — the model
  // failed and the app said it had succeeded. Fail out loud instead; api.chat
  // ships the reason with the reply.
  if (!r.json) {
    const why = r.jsonFailure;
    const err = new Error(why ? `${why.title}. ${why.detail}` : "The model did not answer with JSON.");
    err.raw = r.text;
    err.fix = why?.fix || "model";
    throw err;
  }
  const d = r.json;
  return {
    model: r.model, ms: r.ms, sawImages: material.images.length,
    idea: String(d.idea || "").trim(),
    subject: String(d.subject || "").trim(),
    setting: String(d.setting || "").trim(),
    beats: (Array.isArray(d.beats) ? d.beats : []).map(b => String(typeof b === "string" ? b : b?.text || "").trim()).filter(Boolean).slice(0, 6),
    speaks: !!d.speaks,
    line: String(d.line || "").trim(),
    voice: String(d.voice || "").trim(),
    mood: String(d.mood || "").trim(),
    dials: {
      distance: clampDial(d.dials?.distance, DEFAULT_DIALS.distance),
      energy: clampDial(d.dials?.energy, DEFAULT_DIALS.energy),
      pace: clampDial(d.dials?.pace, DEFAULT_DIALS.pace),
      light: clampDial(d.dials?.light, DEFAULT_DIALS.light),
      sound: clampDial(d.dials?.sound, DEFAULT_DIALS.sound),
      faithfulness: clampDial(d.dials?.faithfulness, DEFAULT_DIALS.faithfulness),
    },
    questions: (Array.isArray(d.questions) ? d.questions : []).slice(0, 3).map((q, i) => ({
      id: String(q.id || `q${i}`),
      ask: String(q.ask || "").trim(),
      options: (Array.isArray(q.options) ? q.options : []).map(o => String(o).trim()).filter(Boolean).slice(0, 4),
    })).filter(q => q.ask && q.options.length),
  };
}

/**
 * More of what happens — asked for when the pace dial wants more beats than the
 * pool holds, so moving a dial can go on being instant afterwards.
 */
export async function moreBeats(project, existing, wanted) {
  const r = await api.chat({
    json: true,
    expect: ["beats"],
    mode: project.mode,
    system: `You extend a shot's action into more beats for MiniMax H3, which renders about one beat every 2–3 seconds.
Return exactly: {"beats":["…","…"]}
Each beat is a short present-tense clause continuing the ones given, in order, no repetition, never a new subject.
If a new shot is needed, that beat starts with "Cut to <framing>, " and nothing else marks a cut.`,
    prompt: `Subject: ${project.creative?.answers?.subject || ""}\nSetting: ${project.creative?.answers?.setting || ""}\n`
      + `So far: ${existing.join(" → ") || "(nothing yet)"}\nGive ${Math.max(1, wanted - existing.length)} more.`,
    temperature: 0.8,
    maxTokens: 700,
  });
  const beats = (r.json?.beats || []).map(b => String(b).trim()).filter(Boolean);
  return [...existing, ...beats].slice(0, wanted);
}

/** The questions the app always has an answer for, so the interview is a
 *  handful of taps rather than a form. Model-proposed questions are appended. */
export function baseQuestions(project, proposal) {
  const duration = project.render?.duration || 5;
  return [
    {
      id: "subject",
      ask: "Who or what are we watching?",
      kind: "text",
      value: proposal?.subject || "",
      placeholder: "a woman in a grey wool coat",
      why: "The model has no memory between clips. Whatever is written here IS the character.",
    },
    {
      id: "setting",
      ask: "Where is this?",
      kind: "text",
      value: proposal?.setting || "",
      placeholder: "a rain-streaked café window at night",
      why: "The setting is also where the sound comes from — the ambience is written from it.",
    },
    {
      id: "beats",
      ask: "What happens?",
      kind: "beats",
      value: proposal?.beats || [],
      why: `H3 renders about one beat every 2–3 seconds, so ${duration}s is room for roughly ${Math.max(1, Math.round(duration / 2.6))}.`,
    },
    {
      id: "speech",
      ask: "Does anyone speak?",
      kind: "speech",
      value: proposal?.speaks ? proposal.line : "",
      why: "Mentioning speech without the exact words makes the model invent dialogue — often in another language.",
    },
  ];
}
