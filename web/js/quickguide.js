/* MOTIONSTILL CUT — the help center.
 *
 * F1 or the ? button. It used to be one long modal; now it is a small manual:
 * sections down the left, live search across everything, worked EXAMPLES with
 * the real compiled output (copyable), a tips page, and the keyboard map.
 * Every card that belongs to a page still has its "go to" button, so the help
 * is a way INTO the app rather than a wall in front of it.
 *
 * Everything here is hand-written data plus one renderer — no markdown, no
 * dependencies, and the search is a substring match because that is enough.
 */

import { h, modal, closeModal, $$, copyText, toast } from "./util.js";

const SEEN_KEY = "mscut.guide.seen";

/* ── The manual ──────────────────────────────────────────────
 * card: { n, title, page?, body: [..], code?: {label, text}, keys?: [[k,v]],
 *         img?: {src, alt, caption?} }
 * A `code` block is real compiled output — what the encoder reads — with a
 * copy button. `keys` renders the two-column keyboard grid. `img` is a real
 * screenshot of the app (web/assets/help/*.webp, captured from the
 * two-people-talking starter), lazy-loaded and click-to-zoom. */

const helpImg = (name) => new URL(`../assets/help/${name}.webp`, import.meta.url).href;

/** The zoomed view: one image over everything, any click or Esc closes it. */
function openLightbox(src, alt) {
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  const overlay = h("div", {
    style: {
      position: "fixed", inset: "0", zIndex: "9999", background: "rgba(10,10,10,.92)",
      display: "flex", alignItems: "center", justifyContent: "center", cursor: "zoom-out", padding: "18px",
    },
    onclick: close,
  },
    h("img", { src, alt, style: { maxWidth: "96vw", maxHeight: "94vh", borderRadius: "5px", border: "1px solid #3a3a3a", boxShadow: "0 18px 60px rgba(0,0,0,.7)" } }),
  );
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(overlay);
}

function imgBlock(img) {
  const src = helpImg(img.src);
  return h("figure", { style: { margin: "8px 0 2px" } },
    h("img", {
      src, alt: img.alt, loading: "lazy",
      title: "Click to zoom",
      style: {
        width: "100%", maxWidth: img.narrow ? "420px" : "100%", display: "block", borderRadius: "5px",
        border: "1px solid var(--line)", cursor: "zoom-in", background: "#101010",
      },
      onclick: () => openLightbox(src, img.alt),
    }),
    img.caption ? h("figcaption.hint", { style: { fontSize: "10.5px", opacity: ".75", marginTop: "4px" } }, img.caption) : null,
  );
}

const SECTIONS = [
  {
    id: "start", icon: "▶", label: "Start here",
    cards: [
      {
        n: "✦", title: "What this is — a whole studio, all on your machine",
        body: [
          "Motionstill Cut is a prompt-engineering suite for two video models: MiniMax H3 — text, image and reference to video, with native audio — and Lightricks' LTX-2.5 (text and image to video, up to 30 s). It looks like an NLE, writes each model's own dialect — the exact grammar H3's rewriter emits, the prose paragraph LTX's guide asks for — plays the prompt back BEFORE you spend GPU time, and renders through your own ComfyUI.",
          "The unusual part is the pairing: a LOCAL LLM sits inside the editor as a director — it interviews you, captions your references, rewrites shots, reads your compiled prompt back like a stranger, and learns from how you rate your renders. Nothing leaves your machine: the model that writes and the model that renders are both yours, and they share your GPU by taking turns (VRAM saver).",
          "Neither engine is required to WRITE: without them the app is still a full prompt editor with previz and checks, and the workflow downloads as a ComfyUI graph.",
        ],
        img: {
          src: "studio",
          alt: "The Studio view: shot list, previz viewer with the framing box, timeline with dialogue lanes, and the inspector",
          caption: "The Studio — the “Two people talking” starter as it opens: previz with the framing box, the timeline with its dialogue lane, and the shot inspector. Click any picture in this guide to zoom.",
        },
      },
      {
        n: "▤", page: "projects", title: "Projects — the app opens on a shelf, not on a blank timeline",
        body: [
          "Work lives in a named project, the way it does in an NLE. Starting fresh means starting a NEW project, so it is never the same gesture as overwriting what you had — and opening one with unsaved work asks first.",
          "⌘S saves, media and all. Five starting points sit beside your projects — an empty one, a single take, two people talking, a wide/medium/close cut, a voiceover over a still scene. They are real, editable projects and each compiles with no errors: worked examples of the grammar.",
          "The last project you had open comes back on reload. Duplicate makes a copy to experiment on.",
        ],
        img: {
          src: "projects",
          alt: "The Projects page: five starting points on the left, saved projects on the right",
          caption: "The shelf: five worked starting points beside your saved projects.",
        },
      },
      {
        n: "1", title: "Create → Canvas → Studio",
        body: [
          "Create is where a new project opens. Paste an idea, drop pictures and audio, then use Shape your clip to choose the scene, mood, image style, shot count, writing detail, video model and length. Its dropdowns include 17 scene presets grouped into Spaces & places, Products & brands, and People & stories. Rebuild shots reapplies the scene to your current pictures. Read my material then interviews you — reading the images — before you steer the result and build the canvas.",
          "Shot count is a CEILING, written cuts included: ask for four and the model's fifth \"Cut to\" folds into the last shot that fits. On Auto, H3 gets up to six; one LTX-2.5 render is capped by length — 4 shots at 20 s, 3 at 15, 2 at 10 — because that is how many cuts it was measured to render. Beats are dealt evenly, so the last shot never comes up empty.",
          "Canvas is a node graph laid out as a timeline: shots left to right, the pictures each shot cites above it, the clip-wide things — steering, sound, the director — on a shelf underneath, the render at the end. Uncited material waits in an amber inbox.",
          "Studio is everything below: per-beat timing, dialogue, retention markers, lens and height, the framing box, the seed ladder. The two views edit the SAME fields — the same editor drawn twice, so they cannot disagree.",
          "` opens Create, 0 the Canvas, 2 the Cut page.",
        ],
        img: {
          src: "canvas",
          alt: "The node canvas: two shot nodes with their camera pads, two voice nodes wired to them, steering, look, sound and director nodes on the shelf, the render at the end",
          caption: "The Canvas — the same project as a graph: shots left to right, each voice wired to the shots it speaks in, the clip-wide nodes on the shelf, the render at the end.",
        },
      },
      {
        n: "◱", title: "The mode is not a choice",
        body: [
          "There is no T2V / I2V / Ref2V switch. Nothing attached is Text to Video; exactly one picture is Image to Video, and that picture anchors the first frame; anything more is Reference to Video. The title bar shows which one you are in, and adding or removing media is how you change it.",
          "T2V — the prompt alone. I2V — the prompt plus a fixed first frame; the opening of the description has to match that frame exactly, or the model cuts away from it in the first second. Ref2V — separate weights that read up to 9 images, 3 clips and 3 audio files, addressed as <Picture 1>, <Video 1>, <Audio 1>.",
        ],
      },
    ],
  },
  {
    id: "compose", icon: "✎", label: "Compose",
    cards: [
      {
        n: "4", page: "cut", title: "Write the shots",
        body: [
          "Type one line into the box on the left and press Auto-shots, or start from a shot structure under Templates. The timeline is a real timeline: drag a cut, split at the playhead with S, duplicate with ⌘D, delete with ⌫, undo with ⌘Z.",
          "A shot is a list of BEATS, not a paragraph. H3 renders roughly one beat per 2–3 seconds, and the badge next to Action beats counts yours against the shot's own length.",
          "Framing and Camera move are separate: lens, height and where the subject sits hold for the whole shot; the move is what changes during it.",
        ],
      },
      {
        n: "✎", page: "cut", title: "The assist bar — three LLM verbs, one place",
        body: [
          "Improve shots · Second opinion · Rewrite whole prompt sit together in the Cut viewer header in every mode, and in the node view's toolbar — same order, and labels that say what each one touches.",
          "✎ Improve shots rewrites each shot's OWN fields in the model's format; the timeline keeps driving the prompt, so you can see what changed. Each shot node has its own ✎ for one shot at a time. ✨ Second opinion has an LLM read the prompt back as the model would — the reading and its suggested edits land under Checks. ⤵ Rewrite whole prompt writes one block of prose in the rewriter's format and turns manual override ON: the shot list stops driving until you turn it back off.",
        ],
      },
      {
        n: "◎", title: "The camera, on the node",
        body: [
          "Every shot node has a camera pad. The angle you drag picks the move, the distance from centre picks the amplitude, and the centre is \"the camera remains static\" — which H3 wants said out loud, because an unstated camera is one the model invents.",
          "Turn is pan and tilt, Move is truck and pedestal, Orbit is an arc around the subject. Depth is its own control with a body/lens toggle — a push and a zoom are different shots. The sentence the model will read is printed under the pad as you drag.",
          "Steering is the CLIP (six dials, whole clip). Fine-tuning is the SHOT (Distance, Energy, Light — folded under the camera pad). Each fine-tune dial follows the clip until you move it, turns amber when it is the shot's own, and has a ↺ back.",
        ],
        img: {
          src: "camera", narrow: true,
          alt: "The camera group in the Studio inspector: motion, amplitude, speed and target compiled to the sentence the model reads",
          caption: "The same camera in Studio: motion + amplitude + speed + target, and underneath — in green — the exact sentence the model will read.",
        },
      },
      {
        n: "❝", title: "Voices are people, not properties of a shot",
        body: [
          "(S1) in shot 1 and (S1) in shot 4 are the same person, and the model keeps the voice between them. So each speaking part is its own node, wired to every shot it speaks in — the only thing in the app that answers \"who is in this scene\" at a glance.",
          "SAY WHO A VOICE IS, once: \"a little boy with a high, eager voice\". That phrase is what H3 builds the voice out of; without it the model picks one, and in a two-person frame nothing says whose mouth moves. Create's interview proposes the voice and shows it as its own field; Sound's cast panel lists every speaker with their identity — amber where one is missing — and Describe the voices has the LLM fill in the ones you left blank, keeping any you wrote yourself.",
          "The words inside <d>[Language] … </d> are verbatim — never translated, never punctuated for you. \"Off screen\" writes H3's exact voiceover phrasing ending in \"the lips stay closed\"; \"carries over the cut\" writes <scenetrans> on both sides.",
        ],
      },
      {
        n: "▣", page: "media", title: "References — a picture the prompt never names does nothing",
        body: [
          "MiniMax H3 only uses a reference the prompt actually cites. A picture attached but never named is ignored completely — invisible until the render comes back without it. The canvas flags it in amber and offers a one-click fix.",
          "Each reference gets a tag and a retention marker: fully_preserved keeps a face, attribute_transfer takes only a style, fully_copy on audio means lip-sync to it and keep it as the soundtrack.",
          "\"Describe with the LLM\" captions an image so the rewriter cites it for what it actually shows — one of the places the local vision model earns its keep.",
        ],
      },
      {
        n: "⇉", page: "cut", title: "Carrying state across a cut",
        body: [
          "H3 has no memory between shots: the subject line repeats at every cut, and the model believes the most recent description. Take the jacket off in shot 2 and the repeated line brings it back in shot 3.",
          "Every shot after the first has a Changed since line — \"in shirtsleeves, the jacket over the chair behind him\" — compiled immediately after the clause it corrects, the only position where it reliably wins. The checks find the beats that change something and warn when a later shot forgets.",
        ],
      },
      {
        n: "6", page: "sound", title: "Sound is three separate things",
        body: [
          "Dialogue goes in the shot it belongs to, verbatim, with a stable speaker id. Ambience goes in overall_soundscape. Score goes in non_diegetic_music. They must never overlap — saying music twice is the most common way to get two competing tracks.",
          "Mentioning that someone talks without giving the words makes the model invent dialogue.",
        ],
      },
    ],
  },
  {
    id: "preview", icon: "▷", label: "Preview & checks",
    cards: [
      {
        n: "▶", title: "The readthrough — watch the prompt play",
        body: [
          "You cannot see a prompt, and you cannot afford to render every guess. Press ⇧Space and the instructions play back in real time: the plate showing where the frame is going, every channel as a lane — shots, action, camera, speech, sound, music, references — and the compiled text with the clause in effect lit up.",
          "It catches the mistakes that only exist in time: six beats crammed into five seconds, a shot where nothing happens, a camera move that never ends, dialogue with no room to be said, a reference no shot ever cites.",
        ],
        img: {
          src: "readthrough",
          alt: "The readthrough mid-play: the plate on the left, the compiled prompt with the live clause highlighted on the right, and every channel as a lane below the playhead",
          caption: "The readthrough, mid-play: the plate, the compiled text with the clause in effect lit up, and every channel — shots, action, camera, speech, sound — as a lane under the playhead.",
        },
      },
      {
        n: "5", page: "cut", title: "Previz — the frame, lit and moving",
        body: [
          "Viewer ▸ Previz plays the clip back as frames: the cuts where they actually fall, each shot's framing, the camera move at its own amplitude and speed, the dialogue as captions. It is lit — the key goes where the Lighting line puts it and the grade tints the frame, so the Light dial is something you watch.",
          "Paused, the frame carries two boxes: orange where the subject starts, blue where the move leaves it. Drag them and the camera vocabulary is read back out of the drag. The five tabs: Previz · Board (B, the same clip as a storyboard) · Render (the job on the GPU) · Prompt (exactly what the encoder reads) · Checks.",
          "It simulates the PROMPT, not the model: whether the timing, framing and structure are what you meant — the part a render cannot tell you cheaply. Checks lists everything wrong before a GPU second is spent; Second opinion on the assist bar has the LLM read the finished prompt as a stranger would, and its reading lands under Checks.",
        ],
      },
      {
        n: "✓", title: "Checked against MiniMax's own guide",
        body: [
          "The compiled prompt is the shape MiniMax's rewriter emits, documented in the guides that ship inside the model repo — and `npm test` holds it there: golden files freeze the exact output, and the app's own warnings are run over MiniMax's canonical examples. Any rule that fires on the guide's own output is a rule this app invented, and it gets deleted.",
          "What the checker enforces is all from the guides: strictly increasing cut times, the five approved cut verbs, <d> tags closed and opening with a supported language, a described speaker at first appearance, no music repeated in the soundscape, retention markers from the right vocabulary — and more.",
        ],
        img: {
          src: "checks",
          alt: "The Checks tab reporting one error: an empty soundscape exports as N/A, which renders the clip silent",
          caption: "A real finding, in terms of the thing to change: an empty soundscape is an instruction to render SILENCE, and the checker says so before a GPU second is spent.",
        },
      },
    ],
  },
  {
    id: "director", icon: "✦", label: "The local LLM",
    cards: [
      {
        n: "✦", title: "The director — the LLM operates the app",
        body: [
          "The assistant does not hand you text to paste, it edits the project and shows you the edit first. Ask in plain words — \"bring her closer\", \"why does it keep adding music?\" — and it answers with a sentence and a plan: concrete changes, each with the model's reason and a checkbox.",
          "Nothing lands until you press Apply; the whole plan applies as one step so a single ⌘Z takes all of it back. It reads your shot list, the compiled prompt, the checks, your references as pictures, and how you rated past renders.",
          "⌘J from anywhere. It needs no wire — it reads the whole graph; narrow it to one shot by dragging its node onto that shot.",
        ],
      },
      {
        n: "◆", title: "Which model? Gemma 3 12B is the sweet spot",
        body: [
          "Any OpenAI-compatible local server works — LM Studio, Ollama, llama.cpp. What the app needs from the model: follow instructions, answer with JSON, write plain prose. What makes it shine: vision, so the interview and \"Describe with the LLM\" can actually read your references.",
          "VRAM saver means the LLM and the video model take TURNS on the card — so run the best model your card fits, not the one that co-fits with a DiT.",
        ],
        list: [
          ["Recommended — Gemma 3 12B (instruct/QAT).", "Strong prose, reliable JSON, and it has vision — one model covers the director, the rewriter AND image captioning. ~8 GB in Q4/QAT."],
          ["Small cards (≤8 GB) — Gemma 3 4B or Llama 3.1 8B.", "Fine for rewrites and captions; second opinions get shallower."],
          ["Big cards (24 GB+) — Gemma 3 27B or Qwen3 32B.", "The best director plans and critiques. Keep Thinking Off for Qwen3 — the app's default."],
          ["Vision on a budget — Qwen2.5-VL 7B as the separate Vision model,", "with anything you like as the text model. Setup has both fields."],
        ],
      },
      {
        n: "✚", title: "If the model will not answer",
        body: [
          "The cause is usually thinking, not size. A reasoning model (Qwen3, DeepSeek-R1, gpt-oss, GLM) can spend its whole token budget deliberating before it writes anything — so thinking does NOT need to be on for this app, and is usually what breaks it.",
          "Setup ▸ Thinking is Off by default and asks the backend to skip it in every dialect at once; the reasoning is stripped from the answer either way, and a reply that ran out of room is retried with a bigger budget. Setup ▸ Test structured answers shows exactly what came back — and the error names the setting to change, not \"try a larger model\".",
        ],
      },
    ],
  },
  {
    id: "render", icon: "⚙", label: "Render & engines",
    cards: [
      {
        n: "⚑", page: "setup", title: "Point it at your box",
        body: [
          "Setup has one job: two addresses. ComfyUI (usually http://127.0.0.1:8188) does the rendering; an OpenAI-compatible LLM server (LM Studio, Ollama, llama.cpp) does the prompt work. Auto-detect finds either one if it is running, and both badges in the title bar go green when they answer.",
          "In the hosted version the page talks to both DIRECTLY, so each needs CORS on once: start ComfyUI with --enable-cors-header; LM Studio has a CORS switch under Developer; Ollama takes OLLAMA_ORIGINS=*. The local app with server saving proxies both instead — no flags anywhere.",
          "No custom nodes are needed. Every node this editor emits ships with ComfyUI, which is what makes the downloaded workflow run on someone else's install.",
        ],
      },
      {
        n: "7", page: "deliver", title: "Deliver, two ways",
        body: [
          "Workflow JSON downloads the ComfyUI API graph — drop it on ComfyUI, or POST it to /prompt yourself. Render sends the same graph, uploads whatever media it references first, and follows the job to the end — with the sampler's own preview frames streaming in while it runs.",
          "×N Variations queues the same prompt on a ladder of seeds, which is how you find out whether a prompt is good or whether one seed was. The build row picks the trade: Full is the official template, Turbo is a step-distill — its step count and flow shifts come with it.",
        ],
        img: {
          src: "deliver",
          alt: "The Deliver page: engine chips, canvas and length, the build ladder, seed row, film and queue panels, and the API-format workflow graph",
          caption: "Deliver: the engine and build on the left, the queue and film on the right, and the exact stock-node graph — 16 nodes — that will be sent, readable before anything runs.",
        },
      },
      {
        n: "≡", page: "deliver", title: "The render queue",
        body: [
          "One GPU renders one clip at a time; the queue is where the next one waits instead of in your head. A queued clip is a SNAPSHOT — you queue what the project looks like now and carry on editing. A failure never stops the queue, and the error stays on the row.",
        ],
      },
      {
        n: "⏱", page: "deliver", title: "H3 renders 4–15 seconds — and cuts do not buy more",
        body: [
          "MiniMax's model card gives H3's output as 4–15 seconds at 24 fps. ComfyUI accepts a longer latent without complaining, and the extra time comes back as a repeat of what you already have. A shot list is prompt syntax, not a longer window: \"[Shot 3] At 00:08.000\" says when to cut, not how much to generate.",
          "For something longer, tick The Film: it cuts the writing into clips that each fit, renders them in order — each continuing from the previous clip's final frame — and joins them at the end (the join runs on the local app; the hosted version hands you the clips).",
        ],
      },
      {
        n: "L", page: "deliver", title: "LTX-2.5 — the second engine, in its own dialect",
        body: [
          "Deliver's Engine row (and the chip in the title bar) switches the same timeline to Lightricks' LTX-2.5. It is not the H3 prompt pushed through another model: LTX gets one chronological paragraph, no timestamps or shot numbers, every cut named in prose — \"A hard cut transitions to a close-up …\" — the new shot re-established, dialogue as quoted lines with the voice named, the ambient sound at the end. Lightricks' prompt enhancer stays OFF: it helps a thin prompt and dilutes a compiled one.",
          "Its own pipeline: stock ComfyUI LTX-2 AV nodes, Two-stage 8+3 or Single-stage 8-step distilled, cfg 1, frames on the 8k+1 grid, clips to a real 30 s. Five model files (~40 GB, Setup ▸ Models); a ComfyUI without the LTX nodes still renders MiniMax. Pins attach an image to a shot at its cut time (LTXVAddGuide) — they land on an 8-frame grid, the pin row prints the frame really hit, and the same picture pinned at two cuts at strength ≥ 0.7 freezes the character; the checks warn.",
        ],
      },
      {
        n: "✂", page: "cut", title: "What makes LTX-2.5 actually cut",
        body: [
          "Measured on the model with fixed seeds, 21 renders scored per frame and then read frame by frame. The model places a seam at nearly every cut you write — six beats in 20 s came back as seven seams — so the question is never whether it cuts but whether the seam lands as a hard cut or a dissolve. A four-shot prompt that looks like one continuous take is four shots joined by dissolves. Verbosity is not the cause; the guide's own compact prose dissolved at the same seams. What makes a seam land as a cut: a spoken line in every shot; a cutaway to something else (the waves, her hands, the tower); a different angle and camera move per shot, small or static; and the Two-stage 8+3 build, which on one prompt and seed turned four dissolves into three hard cuts at 768p. Keep shots to 3 s or more — past five in 20 s the seams land as flash frames.",
          "Create is steered by this on LTX — angles walked, no two consecutive shots sharing a move, the line dealt across shots, shots held to what the length can carry — and the checker names which case you are in: nobody speaks and every shot is the same subject (add a cutaway, or Film ▸ Cuts), only shot 1 speaks (deal a line), or Single-stage with cuts that matter (switch to Two-stage 8+3). Or take the sure route: Film ▸ Cuts renders every hard cut as its own clip and joins them afterwards.",
        ],
      },
      {
        n: "9", title: "VRAM saver — two engines, one card",
        body: [
          "H3's DiT is around 20 GB and a 32B text encoder is another 20. On one card they do not co-fit, and the failure is silent: the driver spills to shared memory and the render crawls.",
          "With VRAM saver on, one engine holds the GPU at a time: rewriting unloads ComfyUI, rendering unloads the LLM — in whichever dialect your LLM server speaks (LM Studio, Ollama, llama.cpp router, llama-swap, Nexus). The badge in the title bar says who has the card, and a render in flight is never interrupted.",
        ],
      },
    ],
  },
  {
    id: "edit", icon: "⧉", label: "Edit",
    cards: [
      {
        n: "7", page: "edit", title: "Edit — the renders, cut together",
        body: [
          "Open Edit clips in the top workflow bar from any view (or press 7). Deliver makes clips; Edit puts them after one another. Add to edit beside a finished render opens the multi-clip timeline. A dropped video or sound file joins it. Click a clip to name it, trim it (in and out, in seconds), mute its own sound or move it; a sound on the audio lane has a start time and a gain. The totals under the strip are the export's own numbers, and anything that would stop the export is listed in amber.",
          "The voice-over box speaks a script on this machine — Qwen3-TTS or VoxCPM2, a language, a built-in or cloned voice, a speed — and lays the file on the audio lane; the director drafts the script from the cut as it stands, at a pace a narrator can speak. Quick clip makes a five- or ten-second intro, B-roll or outro from one line, in this project's look, straight onto the timeline.",
          "Export is one ffmpeg pass on the local Cut app: name, frame rate, frame size, then a file to play and download. The hosted version keeps the timeline with the project and says where to take it. Everything on the strip is undoable (⌘Z) and saved with the project.",
          "Send to Resolve creates a new editable timeline in the project open in DaVinci Resolve, carrying clip order, source trims, muted audio and the audio lane. Set the MCP endpoint in Setup → DaVinci Resolve and test the connection. The local Cut app prepares media on disk; the Linux option converts sound to PCM and keeps supported video streams. Keep the prepared media folder while the Resolve project uses it. A timed-out send keeps its transfer ID to prevent duplicates — check Resolve before starting a new transfer.",
        ],
      },
    ],
  },
  {
    id: "learn", icon: "★", label: "Learn & library",
    cards: [
      {
        n: "8", page: "library", title: "The Library — the half after the render",
        body: [
          "Every render is saved automatically with the exact prompt, settings and seed that made it. The star rating is the only thing that feeds back: rate a clip and the director weighs YOUR results over general advice. Two stars means it did not work; four or five means do more of this.",
          "The tags name the failure so it can be counted — and each knows the house rule it implies. Tag a clip \"camera did its own thing\" and the app offers the rule that prevents it; one click adopts it, and every rewrite from then on carries it.",
          "Compare puts two takes side by side with a word-level diff of their prompts. Import from ComfyUI shelves renders made before this editor existed — the graph carries its own prompt, canvas and seed.",
        ],
      },
      {
        n: "🎭", page: "library", title: "Who H3 already knows",
        body: [
          "There is a second way to hold a face: naming someone the model was trained on. For some characters the name alone is enough; for most it renders a stranger. Which is which is not guessable, so it is looked up: 1293 characters community-tested one clip at a time — 405 recognisable, 53 half the time, 835 not at all.",
          "Browse them under Cast & phrases, from ⌘K, or from the 🎭 beside a shot's Subject. The checker warns on the bottom two buckets, with what to do instead: describe them concretely, or pin the face with a reference image.",
        ],
      },
    ],
  },
  {
    id: "examples", icon: "❐", label: "Examples",
    cards: [
      {
        n: "1", title: "Two shots, one cut — the grammar at its smallest",
        body: [
          "What the encoder actually reads for a 10-second, two-shot clip. Notice: the cut timestamp on shot 2 only, one of the five approved cut verbs, the camera stated even when static, and beats as short verb clauses — not prose.",
        ],
        code: {
          label: "compiled by the app · t2v · 10 s",
          text: "integrated_multimodal_description: [Shot 1] A live-action cinematic medium shot, front-facing: a woman in a charcoal coat. The setting is a rain-streaked cafe window at night. Teal-and-orange grade with cool shadows and warm skin tones. The camera remains static. Lowers her cup, then looks up. [Shot 2] At 00:04.500, the camera cuts to a close-up shot, front-facing of her hands. The camera tilts down with small amplitude at slow speed. Twist the portafilter free.",
        },
        after: ["You never type this shape by hand — the shots, beats and camera pad compile it. But being able to READ it is what previz and the checks are teaching you."],
      },
      {
        n: "2", title: "Dialogue that keeps its voices",
        body: [
          "Two speakers over one image anchor. The words inside <d> are verbatim; (S1) and (S2) are stable people, not labels per shot:",
        ],
        code: {
          label: "the dialogue clauses · i2v",
          text: "(S1) says, <d>[English] Please help us</d> (S2) says, <d>[English] I am sorry</d>",
        },
        after: [
          "The checks on this exact project flag what is still missing — \"(S1) speaks in shot 1 with no description. Say who they are and how they sound — 'a young woman with a quiet, breathy voice' — or the model picks a voice for you.\" That description compiles at the speaker's first line only, and the voice holds for every later line.",
        ],
      },
      {
        n: "3", title: "Recipe — a product orbit from one photo",
        list: [
          ["Drop the photo anywhere.", "The mode flips to I2V by itself and the picture anchors the first frame."],
          ["Open the shot and describe the opening to MATCH the photo", "— what is in frame, on what surface, in what light. I2V cuts away from a first frame the words contradict."],
          ["On the camera pad pick Orbit,", "drag a small amplitude at slow speed. The sentence under the pad should read like \"the camera arcs right around the subject with small amplitude at slow speed\"."],
          ["Give the soundscape one line", "— \"quiet studio room tone\" — or tick deliberate silence; an empty field renders the clip SILENT and the checks say so."],
          ["⇧Space to watch it, then ×3 seed variations on Deliver.", "Rate the best one in the Library."],
        ],
      },
      {
        n: "4", title: "Recipe — the same character next week",
        list: [
          ["Write her once, under Cast & phrases:", "\"@anna — a wiry woman in her 30s, cropped grey hair, a scar through the left eyebrow, olive field jacket\"."],
          ["Type @anna in any subject line", "and the same words compile every time — H3 has no memory between clips; that text IS the character."],
          ["For a real face lock, go Ref2V:", "attach her portrait, cite <Picture 1> in the shots that show her, retention fully_preserved."],
          ["Rate the renders where she drifted", "and tag them — the tag offers the house rule, and the rewriter carries it from then on."],
        ],
      },
      {
        n: "5", title: "Recipe — find out what actually matters",
        list: [
          ["Pin the seed", "on Deliver (any number beats -1) so the only thing changing is the thing you change."],
          ["Sweep ONE variable:", "render the same prompt at three Light settings, or three camera speeds — ×N with the seed held is the app's version of a controlled experiment."],
          ["Compare two takes in the Library", "— the word-level diff shows exactly which words moved."],
          ["Write the conclusion down as a house rule.", "\"Handheld reads as panic above medium energy — keep it small for domestic scenes.\" Every rewrite now knows."],
        ],
      },
    ],
  },
  {
    id: "tips", icon: "◈", label: "Tips",
    cards: [
      {
        n: "◈", title: "Eleven things people find out late",
        list: [
          ["An empty soundscape renders SILENCE.", "N/A is an instruction, not an omission — describe the room, or mean the silence."],
          ["The camera must be told to hold still.", "\"The camera remains static\" is a sentence H3 wants; an unstated camera is one the model invents."],
          ["One beat per 2–3 seconds.", "Six beats in a five-second shot is a slideshow; the readthrough makes it visible before the GPU does."],
          ["A reference the prompt never cites does nothing.", "Amber on the canvas means the model will ignore that picture entirely."],
          ["Thinking OFF is the fix, not the compromise.", "Reasoning models fail this app by deliberating past their token budget, not by being too small."],
          ["The seed is a take, not a setting.", "-1 rolls fresh; pin it only to compare — and sweep one variable at a time."],
          ["Rate your renders.", "The director reads your stars and weighs your box's results over the vendor's guide. Unrated libraries teach it nothing."],
          ["Say what changed since the last shot.", "The subject line repeats at every cut and the model believes it — the Changed since line is how clothes stay off."],
          ["15 seconds is the ceiling per clip on H3.", "More time repeats; more SHOTS is syntax, not duration. Longer pieces are films — several clips, chained and joined. LTX-2.5 holds a real 30 s, but only 3–4 cuts of it."],
          ["On LTX-2.5, a silent shot of the same subject is not a cut.", "Give every shot a line, cut away to something else, or render every hard cut as its own clip (Film ▸ Cuts)."],
          ["⌘K knows everything.", "Modes, pages, templates, GPU controls, import/export — type a few letters of what you want."],
        ],
      },
      {
        n: "⌦", title: "In the hosted version, your browser IS the disk",
        body: [
          "Everything you make lives in this browser's own storage — nothing is uploaded, and nothing follows you to another machine by itself. Setup ▸ Where your work lives has one-click Export backup (settings, projects, library, media — one JSON file) and Restore.",
          "Want files on disk, engine access without CORS flags, and ffmpeg film joins? Run the local app: node server/server.js — same interface, plus a data/ folder.",
        ],
      },
    ],
  },
  {
    id: "interface", icon: "⌘", label: "Interface & keys",
    cards: [
      {
        n: "⇔", title: "The layout is yours",
        body: [
          "Every seam between two panels drags, on every page; double-click a seam to reset it, Setup ▸ Reset panel sizes resets all. Sizes are remembered per window shape — a width you dragged on a big screen is not applied to a phone layout it was never about.",
          "⌘+ and ⌘− scale the whole interface; a phone starts at 125%. The node canvas pinches to zoom with two fingers.",
        ],
      },
      {
        n: "⌸", title: "What this machine remembers",
        body: [
          "The render settings you chose last are what your next project starts from — canvas, precision, checkpoint variant (kept once per family), tiled decode. They describe the machine, not the clip. The seed and the clip length are deliberately NOT remembered; those belong to a take.",
        ],
      },
      {
        n: "⌘", title: "Keyboard",
        keys: [
          ["⌘K / Ctrl+K", "Command palette — everything is on it"],
          ["⌘J", "Ask the director"],
          ["⇧Space", "The readthrough — watch the prompt play"],
          ["`", "Create"],
          ["0", "The Canvas"],
          ["1 – 7", "Library · Media · Cut · Sound · Deliver · Setup · Edit"],
          ["Space", "Play the previz"],
          ["← →", "Nudge the playhead"],
          ["S", "Split the shot at the playhead"],
          ["N", "Show / hide the node view"],
          ["B", "Storyboard ⇄ previz"],
          ["⌘D", "Duplicate the selected shot"],
          ["⌫", "Delete the selected shot"],
          ["⌘Z / ⇧⌘Z", "Undo · redo"],
          ["⌘⏎", "Render"],
          ["⌘S", "Save the project"],
          ["F1", "This guide"],
        ],
      },
    ],
  },
];

/* ── Rendering ─────────────────────────────────────────────── */

function badge(n) {
  return h("div", {
    style: {
      width: "22px", height: "22px", borderRadius: "2px", display: "flex", flex: "none",
      alignItems: "center", justifyContent: "center", background: "#2f4058",
      border: "1px solid #16283a", color: "#cfe2f4", fontFamily: "var(--mono)", fontSize: "11px",
    },
  }, n);
}

function codeBlock(code) {
  return h("div", { style: { margin: "6px 0 2px", border: "1px solid var(--line)", borderRadius: "4px", background: "#161616", overflow: "hidden" } },
    h("div", { style: { display: "flex", alignItems: "center", gap: "8px", padding: "4px 8px", borderBottom: "1px solid var(--line)" } },
      h("span.hint", { style: { fontSize: "10px", letterSpacing: ".06em", textTransform: "uppercase" } }, code.label || "compiled output"),
      h("span", { style: { flex: "1" } }),
      h("button.btn.sm.ghost", {
        onclick: async () => { await copyText(code.text); toast("Copied", "", "ok"); },
      }, "⧉ copy")),
    h("div.mono", {
      style: { padding: "8px 10px", fontSize: "11px", lineHeight: "1.6", whiteSpace: "pre-wrap", color: "#b8c7b8", maxHeight: "180px", overflow: "auto" },
    }, code.text),
  );
}

function card(c) {
  return h("div", { style: { display: "grid", gridTemplateColumns: "26px 1fr", gap: "10px", marginBottom: "16px" } },
    badge(c.n),
    h("div",
      h("div.flex", { style: { marginBottom: "3px", gap: "8px" } },
        h("b", { style: { color: "var(--fg-bright)" } }, c.title),
        c.page ? h("button.btn.sm.ghost", {
          onclick: () => { closeModal(null); $$(`.page-btn[data-page="${c.page}"]`)[0]?.click(); },
        }, `go to ${c.page} ↗`) : null,
      ),
      ...(c.body || []).map(t => h("div.hint", { style: { marginBottom: "4px", lineHeight: "1.55" } }, t)),
      c.img ? imgBlock(c.img) : null,
      c.code ? codeBlock(c.code) : null,
      ...(c.after || []).map(t => h("div.hint", { style: { margin: "4px 0", lineHeight: "1.55" } }, t)),
      c.list ? h("div", { style: { marginTop: "2px" } },
        ...c.list.map(([lead, rest], i) => h("div.hint", { style: { marginBottom: "5px", lineHeight: "1.55" } },
          h("span.mono", { style: { color: "var(--fg-dim, #888)", marginRight: "7px" } }, String(i + 1)),
          h("b", { style: { color: "var(--fg-bright)" } }, lead + " "), rest))) : null,
      c.keys ? h("div", { style: { display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 12px", marginTop: "4px" } },
        ...c.keys.flatMap(([k, v]) => [h("span.mono", { style: { color: "var(--fg-bright)" } }, k), h("span.hint", v)])) : null,
    ),
  );
}

function cardText(c) {
  return [c.title, ...(c.body || []), ...(c.after || []),
    ...(c.list || []).flat(), ...(c.keys || []).flat(), c.code?.text || ""].join(" ").toLowerCase();
}

export function showQuickGuide(sectionId = "start") {
  let active = SECTIONS.some(s => s.id === sectionId) ? sectionId : "start";
  let query = "";

  const nav = h("div");
  const content = h("div", {
    style: { overflowY: "auto", padding: "14px 18px 8px", minWidth: "0" },
  });

  const navBtn = (s) => h("button", {
    "data-sec": s.id,
    style: {
      display: "flex", alignItems: "center", gap: "8px", width: "100%", textAlign: "left",
      background: s.id === active && !query ? "var(--accent-dim, #2f4058)" : "transparent",
      color: s.id === active && !query ? "#cfe2f4" : "var(--fg, #c9c9c9)",
      border: "none", borderRadius: "4px", padding: "6px 9px", cursor: "pointer",
      font: "inherit", fontSize: "12px", marginBottom: "1px",
    },
    onclick: () => { query = ""; search.value = ""; active = s.id; draw(); },
  }, h("span", { style: { width: "14px", textAlign: "center", opacity: ".8" } }, s.icon), s.label);

  const search = h("input", {
    type: "search", placeholder: "Search the guide…",
    style: {
      width: "100%", marginBottom: "10px", background: "#161616", border: "1px solid var(--line)",
      borderRadius: "4px", color: "var(--fg-bright)", padding: "6px 8px", font: "inherit", fontSize: "12px",
    },
    oninput: (e) => { query = e.target.value.trim().toLowerCase(); draw(); },
  });

  function draw() {
    nav.replaceChildren(search, ...SECTIONS.map(navBtn));
    if (query) {
      const hits = [];
      for (const s of SECTIONS) {
        for (const c of s.cards) if (cardText(c).includes(query)) hits.push([s, c]);
      }
      content.replaceChildren(
        h("div.hint", { style: { marginBottom: "10px" } },
          hits.length ? `${hits.length} match${hits.length === 1 ? "" : "es"} for “${query}”` : `Nothing matches “${query}”.`),
        ...hits.flatMap(([s, c]) => [
          h("div.hint", { style: { fontSize: "10px", textTransform: "uppercase", letterSpacing: ".08em", opacity: ".7", margin: "2px 0 4px 36px" } }, `${s.icon} ${s.label}`),
          card(c),
        ]),
      );
    } else {
      const s = SECTIONS.find(x => x.id === active);
      const intro = active === "start" ? [h("div.note.info", { style: { marginTop: "0" } },
        h("b", "Motionstill Cut"),
        " pairs a local LLM with your own ComfyUI: one writes and critiques the prompt with you, the other renders it — same GPU, taking turns, nothing leaving your machine.")] : [];
      content.replaceChildren(...intro, ...s.cards.map(card));
    }
    content.scrollTop = 0;
  }

  draw();

  const shell = h("div", {
    style: {
      display: "grid", gridTemplateColumns: "185px 1fr", gap: "0",
      height: "min(74vh, 780px)", margin: "-6px", minWidth: "0",
    },
  },
    h("div", { style: { borderRight: "1px solid var(--line)", padding: "10px 10px 10px 4px", overflowY: "auto" } }, nav),
    content,
  );

  return modal({
    title: "Guide",
    full: true,
    body: shell,
    actions: [
      {
        label: "Don't show this again",
        onClick: (done) => { try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* private mode */ } done(true); },
      },
      { label: "Start editing", kind: "primary", onClick: (done) => done(true) },
    ],
  });
}

export function maybeShowOnFirstRun() {
  let seen = false;
  try { seen = localStorage.getItem(SEEN_KEY) === "1"; } catch { seen = false; }
  if (seen) return;
  try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* private mode — it shows once per session instead */ }
  setTimeout(() => showQuickGuide(), 400);
}
