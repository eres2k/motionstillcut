/* MOTIONSTILL CUT — the quick guide.
 *
 * Shown once on the first visit and from the ? button (or F1) after that. It
 * is deliberately short: seven steps, each one naming the page it happens on,
 * so a first-time user can get from an empty timeline to a rendered clip
 * without reading the README. */

import { h, modal, closeModal, $, $$ } from "./util.js";

const SEEN_KEY = "mscut.guide.seen";

const STEPS = [
  {
    n: "▤", page: "projects", title: "Projects — the app opens on a shelf, not on a blank timeline",
    body: [
      "Work lives in a named project on the server, the way it does in an NLE. Starting fresh means starting a NEW project, so it is never the same gesture as overwriting what you had — and opening one with unsaved work asks first.",
      "⌘S saves. Saving carries the media with it: the pictures, clips and audio a project cites are uploaded once and re-used, so re-saving a project with a 40 MB reference video costs nothing. Opening it on another browser brings them back.",
      "Five starting points sit beside your projects: an empty one, a single take, two people talking, a wide/medium/close cut, and a voiceover over a still scene. They are real projects rather than read-only samples — open one and edit it. Each compiles with no errors and no warnings, which is the point of shipping them: they are worked examples of the grammar.",
      "The last project you had open comes back on reload. Duplicate makes a copy to experiment on.",
    ],
  },
  {
    n: "0", page: null, title: "Create → Canvas → Studio",
    body: [
      "Create is where a new project opens. Paste a rough idea, drop your pictures and audio, and it interviews you — reading the images — then steers the result with six dials in plain language. Its job is to hand you a working canvas, so its last step is Build the canvas.",
      "Canvas is where most of the work happens, laid out as a timeline: shots run LEFT TO RIGHT, the pictures each shot cites sit directly above it, what governs the whole clip — steering, sound, the director — is on a shelf underneath, and the render is at the end of the cut. Material nothing cites yet waits in an inbox at the far left, flagged in amber.",
      "One graph: nodes are the project's own pieces — your material, the steering dials, the shots, the sound, the director, the render — and wiring one to another edits the same fields the studio edits. The generation mode is not even a choice here, it follows from what you connect.",
      "Connecting is meant to be guessable: drag from anywhere on a node onto a shot, or press Link and then click a shot. Valid targets light up while you drag and a label says what the drop will do. Click a wire or its ✕ to disconnect. Drag the background to pan, wheel to zoom, Fit to frame everything, Tidy to put the nodes back in their lanes.",
      "Studio is everything below: per-beat timing, dialogue, retention markers, lens and height, the framing box, the seed ladder — everything too detailed to belong on a node. The Director and the Steering dials are there too, at the top of the inspector, so switching view never costs you a tool.",
      "The two views edit the same fields, not two versions of them: a shot's subject is one input and each beat is its own row with its connective, on the node exactly as in the inspector — the same editor drawn twice, so they cannot disagree about what a shot says. Enter at the end of a beat starts the next one; Backspace in an empty one removes it.",
      "Create is a STEP and the title bar says so: it is numbered 1, sits outside the pair, and has an arrow into it. Canvas and Studio are two views of the same project — switch between them as often as you like, nothing is lost either way.",
      "The switch is in the title bar. ` opens Create, 0 the Canvas, 2 goes to Cut.",
    ],
  },
  {
    n: "◎", page: null, title: "The camera, on the node",
    body: [
      "Every shot node has a camera pad. The angle you drag picks the move, the distance from centre picks the amplitude, and the centre is \"the camera remains static\" — which H3 wants said out loud rather than left unstated, because an unstated camera is one the model invents.",
      "The segmented control above the pad says what a direction MEANS: Turn is pan and tilt (the camera pivots where it stands), Move is truck and pedestal (the camera travels), Orbit is an arc around the subject. Depth is its own control beside the pad, with a body/lens toggle — a push and a zoom are different shots. Underneath: speed, and a feel (track, handheld, shake, roll) that becomes the second half of a compound move.",
      "The sentence the model will actually read is printed under the pad as you drag. A camera you set by hand is yours: the Energy dial stops driving that shot and says so, until you press release.",
      "Steering is the CLIP. The Steering node — and the Steering group in Studio's inspector, the same panel drawn twice — sets all six dials for the whole thing, with no scope switch and nothing greyed out, because everything on it applies. Pace decides how many shots there ARE, sound is one continuous track, and faithfulness is a marker per reference: none of those were ever per-shot.",
      "Fine-tuning is the SHOT. When one shot needs to differ, open Fine-tune this shot — folded under the camera pad on its node, and under the shot group in Studio. Three dials, Distance, Energy and Light, because three is how many of the six honestly describe a frame. Each follows the clip until you move it, turns amber when it is the shot's own, and has a ↺ back. Steering the clip afterwards moves everything still following and leaves the fine-tuned shots alone.",
    ],
  },
  {
    n: "❝", page: null, title: "Voices are people, not properties of a shot",
    body: [
      "A line belongs to a shot — that is where H3 reads it — but (S1) in shot 1 and (S1) in shot 4 are the same person and the model keeps the voice between them. So each speaking part is its own node, showing its lines in order through the cut and wired to every shot it speaks in. That wire is the only thing in the app that answers \"who is in this scene\" at a glance.",
      "＋ Voice in the toolbar adds a speaking part. Drag its node onto a shot, or press a numbered chip on it, to give it a line there. The words are verbatim inside <d>[Language] … </d> — never translated, and nothing is added around them, so a line you leave without a full stop stays that way and the checker tells you instead of writing one for you.",
      "SAY WHO A VOICE IS, once. The box at the top of the node is the speaker's identifying phrase — \"the young woman with a quiet, breathy voice\" — and it is what H3 builds the voice out of. The guide asks for character type, age, whether they are on screen, pitch, timbre, pace or accent, outside the tag; without it the model picks a voice, and in a two-person frame nothing tells it whose mouth to move. It is written into the prompt at that speaker's first line only. Each line also has a delivery: the verb and its manner — says, shouts, replies quietly.",
      "\"off screen\" writes H3's exact voiceover phrasing, ending in the statement that the lips stay closed — anything else and the mouth moves. \"carries over the cut\" writes <scenetrans> on both sides of the cut and says the line continues; on the last shot the same box becomes \"cut off by the end\", which writes <cutoff>.",
      "The rest of the project is on the canvas too, each node where its relationship puts it: material above the shot that cites it, the cut left to right with the render at the end, and on the shelf underneath — Steering (the six dials), Look (medium, grade, anything true of the whole clip), the Cast sheet (Ref2V only: what each tag IS, the task type, the summary), Sound, and the Director last because it reads all of them.",
    ],
  },
  {
    n: "▣", page: null, title: "A picture the prompt never names does nothing",
    body: [
      "MiniMax H3 only uses a reference the prompt actually cites. A picture that is attached but never named is ignored completely — which is invisible until the render comes back without it. The canvas flags it in amber on the node itself, says the model will ignore it, and offers a one-click fix.",
      "Create and the Idea button are told the tags and cite them themselves, and wire up anything the model left loose before handing the canvas over.",
      "Improve rewrites the SHOTS rather than the compiled paragraph, so you can see what changed and the camera pad, beats and dials keep working. Each shot node has its own ✎ for one shot at a time.",
    ],
  },
  {
    n: "▶", page: null, title: "Watch the prompt play — the readthrough",
    body: [
      "You cannot see a prompt, and you cannot afford to render every guess. Press ⇧Space (or Read through) and the instructions play back in real time: the plate showing where the frame is going, every channel as a lane on one timeline — shots, action, camera, speech, sound, music, references — and the compiled text with the clause in effect right now lit up, scrolling itself as the playhead moves.",
      "It is built to catch the mistakes that only exist in time: six beats crammed into five seconds, a shot where nothing happens, a camera move that never ends, dialogue with no room to be said, a reference you attached that no shot ever cites. Click anywhere in the lanes to scrub.",
    ],
  },
  {
    n: "✦", page: null, title: "The director — the LLM operates the app",
    body: [
      "The assistant does not hand you text to paste, it edits the project and shows you the edit first. Ask in plain words — \"bring her closer\", \"why does it keep adding music?\" — and it answers with a sentence and a plan: concrete changes, each written out with the model's own reason, each with a checkbox.",
      "Nothing lands until you press Apply, clearing a box declines that part, and the whole plan applies as one step so a single ⌘Z takes all of it back. Suggestions it cannot make are rejected and listed with the reason rather than silently dropped. It reads your shot list, the compiled prompt, the checks, your references as pictures, and how you rated past renders.",
      "⌘J from anywhere, and it answers where you are: on the Canvas as a node, in Studio as the first group in the inspector. One conversation either way — a plan you have not accepted yet is still sitting there after you switch.",
      "The Director needs no wire — it reads the whole graph and says so. Narrow it to one shot by dragging the node onto that shot on the Canvas, or by clicking its number in Studio.",
      "If the model will not answer, the cause is usually thinking, not size. A reasoning model (Qwen3, DeepSeek-R1, gpt-oss, GLM) can spend its whole token budget deliberating before it writes anything — so thinking does NOT need to be on for this app, and is usually what breaks it. Setup ▸ Thinking is Off by default and asks the backend to skip it in every dialect at once; the reasoning is stripped from the answer either way, and a reply that ran out of room is retried with a bigger budget. Setup ▸ Test structured answers shows exactly what came back.",
    ],
  },
  {
    n: "◱", page: null, title: "The mode is not a choice",
    body: [
      "There is no T2V / I2V / Ref2V switch. Nothing attached is Text to Video; exactly one picture is Image to Video, and that picture anchors the first frame; anything more is Reference to Video. The title bar shows which one you are in, and adding or removing media is how you change it.",
      "The picture also moves to the slot that mode reads from, so <Picture 1> keeps meaning the same picture whichever side of the line you are on — a project can no longer sit in I2V with six references it silently ignores.",
    ],
  },
  {
    n: "⇔", page: null, title: "The layout is yours",
    body: [
      "Every seam between two panels can be dragged, on every page. Sidebars keep their width when the window changes and the middle absorbs it, exactly as before — dragging changes the number, not the behaviour. Double-click a seam to put that one back; Setup ▸ Reset panel sizes puts all of them back.",
      "The sizes are remembered per window shape. This app lays itself out differently at 1420, 1180 and 880 pixels wide — sometimes with a different number of panels — so a width you dragged on a big screen is not applied to a layout it was never about.",
      "On a phone the same seams run horizontally: the pages stack, and you drag the boundary between the viewer, the timeline and the inspector to give whichever one you are working in the room it needs.",
      "ZOOM. The node canvas takes two fingers — pinch to zoom, and the same gesture pans with it. It needs its own handler because the canvas claims the one-finger drag for panning the graph, which switches off the browser's pinch over it; everywhere else you can still pinch the page normally. The interface itself also has a size: ⌘+ and ⌘− scale the whole app, a phone starts at 125% rather than making you do it, and Setup has the four sizes. That is the app scaling itself rather than the browser scaling the page, which for a full-height grid would leave you panning around with the chrome half off screen.",
    ],
  },
  {
    n: "⌸", page: null, title: "What this machine remembers",
    body: [
      "The render settings you choose last are what your next project starts from — canvas, length, checkpoint variant, precision, tiled decode. They describe the machine you are on, not the clip you are making, and picking them again on every project was busywork.",
      "The checkpoint variant is remembered once per family: fl2va (text and image to video) offers full/turbo/turbo4 and ref2va (reference to video) offers full/ref4, so one slot could only ever hold half the answer. Attach a second picture and come back — your Turbo is still Turbo.",
      "The seed is deliberately NOT remembered. A seed belongs to a take, not to a setup. Setup lists everything that is remembered and has the button that forgets it.",
    ],
  },
  {
    n: "✓", page: null, title: "The format is checked against MiniMax's own guide",
    body: [
      "The compiled prompt is not this app's idea of what H3 wants — it is the shape MiniMax's rewriter emits, documented in the two prompt guides that ship inside the model repo. `npm test` holds it there: test/golden freezes the exact compiled output of six projects so a change to the compiler arrives as a reviewable diff, and test/guide.test.js runs this app's own warnings over MiniMax's canonical examples.",
      "That second one is the important half. Anything that fires on the guide's own output is a rule this app invented, and it is steering you away from the format that works. It has deleted three so far — including a word-count minimum that every one of the four official examples failed.",
      "What the checker enforces is all from the guides: strictly increasing cut times inside the clip, the five approved cut verbs, [Shot 1] present and without a timestamp, the I2VA alignment line verbatim, <d> tags closed and opening with a supported language, speaker ids assigned in the order people actually speak, a described speaker at first appearance, no dialogue or music repeated in overall_soundscape, N/A only where silence was asked for, no mood words or purpose statements in non_diegetic_music, and retention markers from the right one of the two vocabularies.",
    ],
  },
  {
    n: "1", page: "setup", title: "Point it at your box",
    body: [
      "Setup has one job: two addresses. ComfyUI (usually http://127.0.0.1:8188) does the rendering; an OpenAI-compatible LLM server (LM Studio, Ollama, llama.cpp) does the prompt writing. Auto-detect finds either one if it is already running, and both badges in the title bar go green when they answer.",
      "No custom nodes are needed anywhere. Every node this editor emits ships with ComfyUI, which is what makes the downloaded workflow run on someone else's install.",
      "Neither server is required to write a prompt and download a graph — only to render and to rewrite.",
    ],
  },
  {
    n: "2", page: null, title: "Pick a mode",
    body: [
      "T2V — the prompt alone.",
      "I2V — the prompt plus a fixed first frame. The opening of the description has to match that frame exactly, or the model cuts away from it in the first second.",
      "Ref2V — separate ref2va weights that read up to 9 images, 3 clips and 3 audio files. The prompt addresses them as <Picture 1>, <Video 1>, <Audio 1>.",
    ],
  },
  {
    n: "3", page: "media", title: "Fill the pool (I2V / Ref2V)",
    body: [
      "Drop files anywhere in the window — an image lands in the bin your mode uses, a clip and a sound file always land in theirs.",
      "Each reference gets a tag and a retention marker: fully_preserved keeps a face, attribute_transfer takes only a style, fully_copy on audio means lip-sync to it and keep it as the soundtrack. A reference clip's own soundtrack gets its own marker.",
      "\"Describe with the LLM\" captions an image so the rewriter cites it for what it actually shows.",
    ],
  },
  {
    n: "4", page: "cut", title: "Write the shots",
    body: [
      "Type one line into the box on the left and press Auto-shots, or start from a shot structure under Templates. The timeline is a real timeline: drag a cut, split at the playhead with S, duplicate with ⌘D, delete with ⌫, undo with ⌘Z.",
      "A shot is a list of BEATS, not a paragraph. H3 renders roughly one beat per 2–3 seconds, and the badge next to Action beats counts yours against the shot's own length.",
      "Framing and Camera move are separate: lens, height and where the subject sits hold for the whole shot; the move is what changes during it. Two moves can run at once, or you can write the move yourself.",
    ],
  },
  {
    n: "5", page: "cut", title: "Watch it before you render",
    body: [
      "Viewer ▸ Previz plays the prompt back in real time — the cuts where they actually fall, each shot's framing, the camera move at its own amplitude and speed, the beats as they would happen, the dialogue as captions. Space plays it.",
      "The strip along the bottom of the frame is the clip: one block per shot at its real length, a tick where each beat starts, the playhead sweeping across it, and the seconds to the next cut in the corner. Six ticks inside three seconds is what a crowded shot looks like.",
      "It is lit, too. The key goes where the shot's Lighting line puts it, as hard as the words ask, and the grade tints the frame — so the Light dial is something you watch rather than something you read.",
      "While it plays, a faint blue box shows where the move leaves the subject and a line shows the path there: an amplitude is a distance you can see. A fast move is over halfway through its shot, and the camera line says so when the frame starts holding.",
      "Paused, the frame carries two boxes: orange where the subject starts, blue where the move leaves it. Drag the orange one to place the subject, its corner to change the shot size, and the blue one (or the ↔ chip) to set the move — the camera vocabulary is read back out of the drag.",
      "Viewer ▸ Board (B) is the same clip as a storyboard: one card per beat in render order, each with a miniature of its frame.",
      "It simulates the prompt, not the model: what it tells you is whether the timing, the framing and the structure are what you meant. That is the part a render cannot tell you cheaply.",
      "Viewer ▸ Prompt is exactly what the encoder will read. Viewer ▸ Checks lists everything wrong with it before a GPU second is spent — and Second opinion there has the LLM read the finished prompt back and say what it would render.",
      "Nodes (N) is the strip between viewer and timeline: sources, shots in cut order, the render. An edge exists where a shot actually cites a reference, so a reference nobody mentions is flagged — that is the failure Ref2V hides best.",
    ],
  },
  {
    n: "6", page: "sound", title: "Sound is three separate things",
    body: [
      "Dialogue goes in the shot it belongs to, verbatim, with a stable speaker id. Ambience goes in overall_soundscape. Score goes in non_diegetic_music. They must never overlap — saying music twice is the most common way to get two competing tracks.",
      "Mentioning that someone talks without giving the words makes the model invent dialogue.",
    ],
  },
  {
    n: "7", page: "deliver", title: "Deliver, two ways",
    body: [
      "Workflow JSON downloads the ComfyUI API graph — drop it on ComfyUI, or POST it to /prompt yourself.",
      "Render sends the same graph, uploads whatever media it references first, and follows the job to the end. ×N Variations queues the same prompt on a ladder of seeds, which is how you find out whether a prompt is good or whether one seed was.",
      "The build row picks the trade: Full is the official template, Turbo is a step-distill — its step count and flow shifts come with it, they are not preferences.",
    ],
  },
  {
    n: "≡", page: "deliver", title: "The render queue",
    body: [
      "One GPU renders one clip at a time. The queue is where the next one waits instead of in your head — fill it from Deliver, from the canvas's Render node, or at the end of Create, and run the lot from the Queue panel on Deliver.",
      "A queued clip is a SNAPSHOT. You queue what the project looks like now and carry on editing it; what comes out of the queue is what you queued. The queue lives outside any one project, because the point is to line up several different clips — seed variations of one are what ×N Seeds already does.",
      "What a snapshot does not copy is the media. Pictures live in the media pool and the snapshot points at them, so deleting one before its render runs fails that item, and only that item — a failure never stops the queue, and the error stays on the row. Rows can be reordered, removed, re-run, or opened back into the editor.",
    ],
  },
  {
    n: "8", page: "library", title: "The Library — the half after the render",
    body: [
      "Every render is saved here automatically with the exact prompt, settings and seed that made it. That much needs nothing from you.",
      "The star rating is the only thing that feeds back: when you rate a clip, the director reads it and weighs your own results over general advice. Rate nothing and it works from the vendor's guide alone. Two stars means it did not work; four or five means do more of this.",
      "The tags name the failure so it can be counted — and each one knows the house rule it implies. Tag a clip \"camera did its own thing\" and the app offers you the rule that prevents it. One click adopts it, and every rewrite from then on carries it.",
      "Cast & phrases is for recurring subjects: write Anna once, type @anna anywhere, and the same words describe her every time. Import from ComfyUI shelves renders made before this editor existed.",
    ],
  },
  {
    n: "🎭", page: "library", title: "Who H3 already knows",
    body: [
      "There is a second way to hold a face: not describing it, but naming someone the model was trained on. For some characters the name alone is enough — write \u201cWalter White\u201d and Walter White turns up. For most it is not, and the name renders a stranger.",
      "Which is which is not guessable, so it is looked up. 1293 characters were generated one clip at a time and judged by eye: 405 came back recognisable, 53 half the time, 835 not at all. Browse them under Cast & phrases, from \u2318K, or from the 🎭 beside a shot\u2019s Subject in the studio \u2014 searchable by character, by actor or by show.",
      "The checker reads it too. Name someone from the bottom two buckets and it says so, with what to do instead: describe them concretely, or pin the face with a reference image. It is a warning, never an error \u2014 with a picture attached the name is only a label and the reference is doing the work.",
      "The index is community testing by malcolmrey, not an official MiniMax list, and it is one person\u2019s read of a handful of clips per name. Treat it as a strong hint. Names that are also ordinary English \u2014 Angel, Data, Driver, Eleven \u2014 are left out of the automatic scan so \u201cthe driver pulls away\u201d is never mistaken for a casting decision.",
    ],
  },
  {
    n: "⏱", page: "deliver", title: "H3 renders 4–15 seconds — and cuts do not buy more",
    body: [
      "MiniMax's model card gives H3's output duration as 4–15 seconds at 24 fps. ComfyUI accepts a longer latent without complaining and the model has nothing trained past 15 s, so the extra time comes back as a repeat of what you already have.",
      "20, 25 and 30 s stay selectable — other H3 tooling renders with that table — but they are marked ⚠ repeats wherever a length is chosen, and the checks call a clip past 15 s an error.",
      "A shot list is prompt syntax, not a longer window: \u201c[Shot 3] At 00:08.000\u201d says when to cut, not how much to generate. A six-shot 30 s clip repeats exactly as a one-shot 30 s clip does. This guide used to say the opposite. For something longer, render separate clips and join them.",
      "The frame counts are on the model's own grid — the VAE's clip_length is 17, so every offered length is \u2261 5 (mod 17) and anything else is rounded inside the node.",
    ],
  },
  {
    n: "⇉", page: "cut", title: "Carrying state across a cut",
    body: [
      "H3 has no memory between shots, and the prompt repeats the subject line at every cut because that is all the model gets. Which means a subject introduced as \u201ca courier in a heavy canvas jacket\u201d is described that way again at 00:08 — after the beats spent eight seconds taking the jacket off. The model believes the most recent description, so the jacket comes back.",
      "Every shot after the first has a Changed since line: \u201cin shirtsleeves, the jacket over the chair behind him\u201d. It compiles immediately after the clause it corrects, which is the only position where it reliably wins.",
      "The checks find it for you. Beats that change something — removes, puts on, opens, draws, picks up — followed by a later shot that repeats the subject word for word with nothing in its Changed since line, and you get a warning naming both shots.",
    ],
  },
  {
    n: "9", page: null, title: "VRAM saver",
    body: [
      "H3's DiT is around 20 GB and a 32B text encoder is another 20. On one card they do not co-fit, and the failure mode is silent: the driver spills to shared memory and the render crawls.",
      "With VRAM saver on, one engine holds the GPU at a time. Rewriting unloads ComfyUI; rendering unloads the LLM. The badge in the title bar says who has it, and a render in flight is never interrupted.",
    ],
  },
  {
    n: "10", page: null, title: "Everything is on ⌘K",
    body: [
      "The command palette is the menu bar this app doesn't have: modes, pages, templates, renders, GPU controls, project import and export. Type a few letters of what you want.",
    ],
  },
];

const KEYS = [
  ["⌘K / Ctrl+K", "Command palette"],
  ["⌘J", "Ask the director"],
  ["⇧Space", "The readthrough — watch the prompt play"],
  ["`", "Create"],
  ["0", "The Canvas"],
  ["1 – 6", "Media · Cut · Sound · Deliver · Library · Setup"],
  ["Space", "Play the previz"],
  ["← →", "Nudge the playhead"],
  ["S", "Split the shot at the playhead"],
  ["N", "Show / hide the node view"],
  ["B", "Storyboard ⇄ previz"],
  ["⌘D", "Duplicate the selected shot"],
  ["⌫", "Delete the selected shot"],
  ["⌘Z / ⇧⌘Z", "Undo · redo"],
  ["⌘⏎", "Render"],
  ["⌘S", "Export the project file"],
  ["F1", "This guide"],
];

function stepCard(step) {
  return h("div", { style: { display: "grid", gridTemplateColumns: "26px 1fr", gap: "10px", marginBottom: "14px" } },
    h("div", {
      style: {
        width: "22px", height: "22px", borderRadius: "2px", display: "flex",
        alignItems: "center", justifyContent: "center", background: "#2f4058",
        border: "1px solid #16283a", color: "#cfe2f4", fontFamily: "var(--mono)", fontSize: "11px",
      },
    }, step.n),
    h("div",
      h("div.flex", { style: { marginBottom: "3px" } },
        h("b", { style: { color: "var(--fg-bright)" } }, step.title),
        step.page ? h("button.btn.sm.ghost", {
          onclick: () => {
            closeModal(null);
            $$(`.page-btn[data-page="${step.page}"]`)[0]?.click();
          },
        }, `go to ${step.page} ↗`) : null,
      ),
      ...step.body.map(t => h("div.hint", { style: { marginBottom: "3px" } }, t)),
    ),
  );
}

export function showQuickGuide() {
  const body = h("div",
    h("div.note.info", { style: { marginTop: "0" } },
      h("b", "Motionstill Cut"),
      " is a prompt-engineering suite for one model: MiniMax H3, in its three conditioning modes. It writes prompts in the exact format H3's own rewriter emits, plays them back before you spend GPU time on them, lets a local LLM edit them with you, and hands the result to ComfyUI as a graph — or to you as a JSON file."),
    ...STEPS.map(stepCard),
    h("h4.sec", "Keyboard"),
    h("div", { style: { display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 12px" } },
      ...KEYS.flatMap(([k, v]) => [h("span.mono", { style: { color: "var(--fg-bright)" } }, k), h("span.hint", v)])),
  );

  return modal({
    title: "Quick guide",
    wide: true,
    body,
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
