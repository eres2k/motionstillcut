# Motionstill Cut — quick guide

An online editor for one model: **MiniMax H3**, in its three conditioning modes
(T2V, I2V, Ref2V). It writes prompts in the format H3's own rewriter emits, plays
them back before you spend GPU time on them, and hands the result to ComfyUI —
either as a workflow file you download, or as a job it queues for you.
(One marked exception: Deliver's **Engine** row can render the same compiled
prompt on **LTX-2.5** as an experiment — see §11.)

The same guide is in the app: press **F1** or the **?** button.

---

## 1 · Start it

Open the hosted web link — nothing to install, and everything you make stays
in your own browser. Or run the local app:

```bash
node server/server.js                # → http://127.0.0.1:3091
```

No dependencies, no build step, no `npm install`. The first run opens a
one-page setup wizard where **local server saving** is switched on (projects
and the library as plain JSON under `data/`) or off (browser storage, exactly
like the hosted version).

Useful environment variables:

| Variable | Default | What it does |
|---|---|---|
| `CUT_PORT` | `3091` | listen port |
| `CUT_HOST` | `127.0.0.1` | listen address |
| `CUT_PW` | *(unset)* | password; unset means open, which is fine on localhost and not fine on anything you tunnel |
| `CUT_COMFY_URL` | `http://127.0.0.1:8188` | ComfyUI |
| `CUT_LLM_URL` | `http://127.0.0.1:1234` | OpenAI-compatible LLM server |
| `CUT_LLM_KEY` | *(unset)* | API key for that server, if it wants one |
| `CUT_VRAM_SAVER` | `1` | one engine on the GPU at a time |

Everything here can also be set on the **Setup** page, and is stored in
`cut/data/settings.json`.

---

## 1b · Projects

The app opens on a shelf of projects, not on a blank timeline. Work lives in a
**named project on the server**, the way it does in an NLE, which means
"start something new" is never the same gesture as "overwrite what I had".

* **⌘S saves.** Saving carries the media with it — the pictures, clips and
  audio a project cites are uploaded once and re-used, so re-saving a project
  with a 40 MB reference video costs a HEAD request, not an upload. Opening the
  project on another browser brings them back.
* **Opening one with unsaved work asks first.**
* **The last project you had open comes back on reload.** A refresh does not
  send you to the manager.
* **Duplicate** makes a copy to experiment on. **Delete** is permanent.

Five **starting points** sit beside your projects:

| Starter | What it demonstrates |
|---|---|
| Empty project | nothing at all |
| One take, one person | a single continuous shot, no cut |
| Two people talking | two speakers, identity and delivery, `<scenetrans>` |
| Wide, medium, close | a three-shot cut with real cut times |
| Voiceover over a still scene | the off-screen voiceover form, lips-closed clause and all |

They are real projects rather than read-only samples — open one and edit it.
Each compiles with **no errors and no warnings**, which is the point of shipping
them: they are worked examples of the grammar, so they have to be right.

Projects are files under `cut/data/projects/`; their media is in
`cut/data/media/`, shared between projects that cite the same file.

---

## 2 · One step, then two views

**Create** is step 1. **Canvas** and **Studio** are two views of the same
project, and you move between them as often as you like.

The title bar says exactly that: Create is numbered, sits on its own, and has
an arrow pointing into the pair. The pair dims while you are in Create, because
it is the step *before* them and not a third peer alongside them.

**Create** is where a new project opens, and where the **shot count** is set
(**How many shots?** — Auto lets the Pace dial decide, and a beat written as
"Cut to close-up, …" always starts a new shot whatever the dial says; a
number is exact), and where the **model** is chosen — **Which model?**, above **How long?**: MiniMax H3 and LTX-2.5 read different prompts, so it is asked before anything is written for it; the title-bar chip switches it later. Paste a rough idea, drop your pictures
and audio, and it interviews you — reading the images — then steers the result
with seven dials in plain language. Its job is to hand you a working canvas, so
the last step is **Build the canvas →**.

**Canvas** is where most of the work happens. It is laid out as a timeline:
shots run **left to right**, the pictures each shot cites sit **directly above
it**, what governs the whole clip (steering, sound, the director) is on a shelf
**underneath**, and the render is at the **end of the cut**. Material nothing
cites yet waits in an inbox at the far left, flagged in amber. One
graph: drop an image, type a line, press Render. Nodes are the project's own
pieces — your material, the steering dials, the shots, the sound, the director,
the render — and wiring one to another edits the same fields the studio edits.
The generation mode is not even a choice here: it follows from what you
connect, because "a picture wired into a shot" and "image to video" are the
same statement.

Everything about connecting is meant to be guessable:

* **Drag from anywhere on a node** onto a shot to connect it. The port dot on
  the right edge still works if that is what your hands reach for.
* The **Director** needs no wire — it reads the whole graph, and says so. Drag
  it onto a shot only when you want it to work on that shot alone.
* Or press **Link** on the node, then click a shot. Same result, no dragging.
* While a connection is in flight, valid targets light up, invalid ones dim,
  and a label under the cursor says what the drop will do.
* To disconnect, click the wire or the **✕** on it.
* **Drag the background** to pan, **wheel** to zoom, **Fit** to frame it all,
  **Tidy** to put every node back in its lane.

Each shot node carries a **camera pad**. The angle you drag picks the move, the
distance from centre picks the amplitude, and the centre is *"the camera
remains static"* — which H3 wants said out loud rather than left unstated. A
segmented control above the pad says what a direction means: **Turn** (pan and
tilt, the camera pivots), **Move** (truck and pedestal, the camera travels), or
**Orbit** (arc, around the subject). Depth is its own control beside it, with a
**body/lens** toggle because a push and a zoom are different shots. Under it,
speed and a *feel* — track, handheld, shake, roll — which becomes the second
half of a compound move. The sentence the model will read is printed underneath
as you go.

A camera you set by hand is yours: the Energy dial stops driving that shot and
says so, until you press **release**.

**Steering is the clip. Fine-tuning is the shot.**

The **Steering** node — and the **Steering** group in Studio's inspector, the
same panel drawn in two places — sets the whole clip, all seven dials, always.
There is no scope switch and nothing is ever greyed out, because everything on
it applies: pace decides how many shots there **are**, sound is one continuous
track H3 generates for the whole clip, and faithfulness is a marker per
reference. None of those were ever per-shot, and pointing a clip-wide control
at one shot was a strange idea to start with.

When one shot genuinely needs to differ, that lives **on the shot**:
**Fine-tune this shot**, folded away under the camera pad on its node and under
the shot group in Studio. Three dials — **Distance**, **Energy**, **Light** —
because three is how many of the six honestly describe a single frame. Each one
follows the clip until you move it and says which it is doing; moving it turns
it amber and gives it a **↺** back. The shot's node marks itself with a ◎, and
the Steering panel names, at the bottom, exactly which shot took over exactly
which dial — with *put them back* to clear the lot.

Steering the clip afterwards moves every shot that is still following and
leaves the fine-tuned ones alone. That is the whole point of the split.

**Light is one axis, and previz draws it.** The Light dial has five stops
between *soft and flat* and *hard and contrasty*, and each stop writes two
things at once: a named source into the shot's Lighting, and the grade that
belongs with it into the Look. Overcast and high-key, a soft key and Rec.709,
a practical lamp and print film, harsh sun and bleach bypass, a hard key and
low-key — shadows closing one notch at a time. The key stays on the same side
the whole way, because where the light comes *from* is a different decision
from how hard it is; move it in the shot's own **Lighting** field. And previz
lights the frame from that field, so the dial is something you watch rather
than something you read.

### What is on the canvas

Everything the project has, as a node. Reading roughly top to bottom:

| Node | What it is | Where it sits |
|---|---|---|
| **Material** | each picture, clip and sound you dropped | above the shot that cites it — or in the inbox at the far left if nothing does |
| **Shot** | one idea: subject, beats, where, light, camera, fine-tune | the cut, left to right |
| **Render** | length, canvas, the button | at the end of the cut |
| **(S1)…(S4)** | a speaking part — who they are, how they sound, and every line in order | under the first shot it speaks in |
| **Steering** | the seven dials, for the whole clip | the shelf underneath |
| **Look** | the medium, the grade, anything true of the whole clip | the shelf |
| **Cast sheet** | Ref2V only: what each tag *is*, the task type, the summary | the shelf |
| **Sound** | the soundscape and the score | the shelf |
| **Director** | the LLM, reading all of it | the shelf, last |

**Voices are people, not properties of a shot.** A line belongs to a shot —
that is where H3 reads it — but `(S1)` in shot 1 and `(S1)` in shot 4 are the
same person and the model keeps the voice between them. So each speaking part
gets one node showing its lines in order, wired to every shot it speaks in.
That wire is the only thing in the app that answers "who is in this scene" at a
glance. **＋ Voice** in the toolbar adds one; drag the node onto a shot (or
press a numbered chip on it) to give it a line there.

**Say who a voice IS, once.** The guide is explicit: *"When a speaker first
appears, provide enough information … such as character type, age, gender,
whether the person is on-screen, pitch, timbre, speaking rate, or accent. Place
the speaker's identifying phrase, ID, action, and delivery outside `<d>`."* The
box at the top of the voice node is that phrase — *"the young woman with a
quiet, breathy voice"* — and it is written into the prompt at that speaker's
first line only. Without it H3 picks a voice for you, and in a two-person frame
nothing tells it whose mouth to move. Each line also has a **delivery**: the
verb and its manner — *says*, *shouts*, *replies quietly*.

The words go in verbatim, punctuation included, and nothing is added around
them: `<d>[English] the exact words.</d>`. Leave a line without a full stop and
the checker says so rather than writing one for you.

**off screen** writes the guide's exact voiceover phrasing, ending in the
statement that the lips stay closed — anything else and the mouth moves.
**carries over the cut** writes `<scenetrans>` on both sides of the cut and says
the line continues; on the last shot the same box becomes **cut off by the
end**, which writes `<cutoff>`.

**A reference no shot names does nothing.** H3 only uses a picture the prompt
actually cites, so an attached-but-uncited one is ignored completely. The
canvas flags it in amber on the node itself — *"No shot uses this"* — with a
one-click **Use it**. Create and the **Idea** button cite the tags themselves,
and wire up anything the model left loose before handing over.

Wherever a compiled prompt is shown — the Studio's Prompt tab, the readthrough,
Create's preview — a reference tag is a **chip carrying the picture it names**,
coloured by kind. A tag with nothing behind it turns red with a wavy underline,
because H3 ignores those silently.

**Improve** rewrites the shots, not the compiled paragraph — so you can see
what changed and everything downstream keeps working. Each shot node has its
own **✎** for one shot at a time.

**The two views edit the same fields, not two versions of them.** A shot's
subject is one input and each beat is its own row with its connective, on the
node exactly as in the inspector — the same editor, drawn twice. Press **Enter**
at the end of a beat to start the next one; **Backspace** in an empty one
removes it.

**Studio** is everything below: five pages, four viewer tabs, an inspector.
Per-beat timing, dialogue, retention markers, lens and height, the framing box,
the seed ladder — everything too detailed to belong on a node.

**The Director and the Steering dials are in Studio too**, as the first two
groups of the inspector, above whatever shot is selected. They are the same
modules the canvas nodes use, holding the same state: a plan you have not
accepted is still waiting after you switch view, and a shot you narrowed the
director to on the canvas is the shot it is still reading in Studio. The only
difference is how you point them at a shot — a wire on the canvas, a numbered
chip in the inspector.

The switch is in the title bar and the app remembers which you used. `` ` ``
opens Create, `0` the Canvas, `2` goes to Cut.

### The panels are resizable

Every seam between two panels can be dragged, on every page, with a mouse or a
finger. Fixed sidebars stay fixed when the window changes and the middle keeps
absorbing the difference — dragging changes the number, not the behaviour.

* **Double-click a seam** to give that one back to the stylesheet.
* **Setup ▸ Reset panel sizes** (or ⌘K ▸ *Put every panel back*) resets all of
  them.
* Sizes are remembered **per window shape**. The layout changes at 1420, 1180
  and 880 pixels — sometimes with a different number of panels — so a width
  dragged on a big screen is never applied to a layout it was not about.
* Stacked on a phone, the same seams run horizontally: drag the boundary
  between the viewer, the timeline and the inspector.

### Zoom

The node canvas takes **two fingers**: pinch to zoom, and the same gesture pans
with it. It needs its own handler because the canvas claims the one-finger drag
for panning the graph, which switches off the browser's pinch over it —
everywhere else in the app you can still pinch the page normally.

The interface itself also has a size. It is drawn at 11px, copying a tool made
for a 27-inch monitor, so **⌘+** and **⌘−** scale the whole app — and a phone
starts at 125% rather than making you do it. Setup ▸ *Interface size* has the
four sizes. This is the app scaling itself rather than the browser scaling the
page, which for a full-height grid layout would leave you panning around with
the chrome half off screen.

### On a phone

This is a node-graph video-prompt editor; the canvas, the timeline and the
previz all want a big screen and always will. What a phone does honestly is
read a project, change a value, ask the director for something and press
render — and that is what is built to work. Create is fully usable on a phone.
The title bar sheds its status badges, the page bar becomes its icons, controls
grow to a fingertip's worth of hit area, and everything draggable claims the
gesture so a drag is a drag rather than a page scroll.

---

## 3 · The readthrough — watching the prompt play

**⇧Space**, the **Read through** button, or ⌘K → *Readthrough*.

You cannot see a prompt, and you cannot afford to render every guess. The
readthrough plays the **instructions** back in real time, so the mistakes that
only exist in time are visible before you spend the GPU on them.

Three views of the same instant, locked together:

| | |
|---|---|
| **The plate** | where the frame is, and where the camera is taking it |
| **The score** | every channel as a lane on one timeline — shots, action, camera, speech, sound, music, references — plus a density curve showing where the clip is crowded |
| **The text** | the compiled description, with the clause in effect **right now** lit up, scrolling itself as the playhead moves |

Click anywhere in the lanes to scrub. What it is good at catching:

* six beats crammed into five seconds (the Action lane goes solid, the density
  curve spikes)
* a shot where nothing happens (an empty Action lane, and the readout says so)
* a camera move that never ends, or one you never stated
* dialogue with no room to be said
* a reference you attached that no shot ever cites — the References lane is
  empty across that shot

---

## 4 · The director — the LLM operating the app

**⌘J**, the Director node on the canvas, the **Director** group at the top of
Studio's inspector, or ⌘K → *Director*.

⌘J answers *where you are*: the Canvas draws it as a node, Studio as an
inspector group, and both are the same module holding the same conversation.
A plan you have not accepted is still waiting after you switch view.

The assistant does not hand you text to paste. It **edits the project**, and
shows you the edit first.

Ask it anything in plain words — *"bring her closer"*, *"why does it keep
adding music?"*, *"give me a second shot on her hands"* — and it answers in a
sentence plus a **plan**: a list of concrete changes, each one written out in
plain language with the model's own reason, each with a checkbox.

* Nothing is applied until you press **Apply**.
* Clear any box to decline that part and keep the rest.
* The whole plan applies as one step, so one **⌘Z** takes all of it back.
* Suggestions it cannot make — a shot that does not exist, a camera move that
  is not a camera move, anything outside its vocabulary — are rejected and
  listed with the reason, not silently dropped.

It reads the real state: your shot list, the compiled prompt, the checker's
complaints, your references **as pictures**, and how you rated past renders.

Four standing jobs are one click each: **Check it** (what will actually go
wrong), **That didn't work** (diagnose the last render and change one thing),
**Make it stronger**, **Add the sound**.

**Narrowing it to one shot** is optional and it says so — by default it reads
the whole clip. Drag the node onto a shot on the canvas, or click that shot's
number in Studio. Either way it is the same focus.

### When the assistant says the model didn't answer

Two causes, and **thinking is the usual one**.

**A reasoning model spending its budget thinking.** Qwen3, DeepSeek-R1, gpt-oss
and GLM think before they answer, and the thought can be thousands of tokens.
If the budget runs out first, no answer is ever written.

> Thinking does **not** need to be on for this app — it is usually what breaks
> it. Setup ▸ **Thinking: Off** is the default and asks the backend to skip it,
> in every dialect at once (`chat_template_kwargs`, Ollama's `think`, Qwen3's
> `/no_think`); an unfamiliar backend just ignores what it doesn't know. The
> reasoning is stripped from the answer either way, an answer that ran out of
> room is retried with three times the budget, and the parser reads through
> `<think>`, `[THINK]`, `◁think▷` and gpt-oss channels. Some models —
> DeepSeek-R1 especially — cannot be told to stop; raise Setup ▸ **Max tokens**
> to 4000+ for those.

**A backend that rejects `response_format`.** llama.cpp's server, several LM
Studio runtimes and most proxies do. The server probes once per backend, drops
whichever extra was refused, and remembers — answers are parsed out of prose
regardless, so nothing is lost.

Setup ▸ **Test structured answers** reports exactly where you stand and shows
what the model actually replied. When a call does fail, the app now says which
of the two it was and what to change, and the Director shows the raw reply
under *what the model actually said*.

## 4b · The format is checked against MiniMax's own guide

The compiled prompt is not this app's idea of what H3 wants. It is the shape
MiniMax's rewriter emits, documented in the two prompt guides that ship inside
the model repo (`MiniMaxAI/MiniMax-H3` → `docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md`
and `…_ref_en.md`), and `npm test` holds it there:

* **`test/golden/*.txt`** freezes the exact compiled output of six projects,
  checks included, so any change to the compiler arrives as a reviewable diff
  rather than as a render that comes back subtly wrong.
* **`test/guide.test.js`** runs this app's own warnings over MiniMax's canonical
  examples — the four cases in the base guide and the complete example in the
  reference guide. **Anything that fires there is a rule this app invented**, and
  is steering you away from the format that works. It has deleted three so far,
  including a word-count minimum that every one of the four official examples
  failed.

What the checker enforces, all of it from the guides: strictly increasing cut
times inside the clip, the five approved cut verbs, `[Shot 1]` present and
without a timestamp, the I2VA alignment line verbatim, `<d>` tags closed and
opening with a supported language, speaker ids assigned in the order people
actually speak, a described speaker at first appearance, no dialogue or music
repeated in `overall_soundscape`, `N/A` only where silence was asked for, no
mood words or purpose statements in `non_diegetic_music`, retention markers from
the right one of the two vocabularies, and no speaker id in
`retention_analysis`.

---

## 5 · Point it at your box — *Setup*

Two addresses. **Auto-detect** finds either server if it is already running; both
badges in the title bar go green when they answer.

**No custom nodes are needed.** Every node the editor emits ships with ComfyUI —
that is what makes a downloaded workflow run on someone else's install. If Setup
reports missing nodes, the ComfyUI build is simply older than MiniMax H3 support
(the 2026-08 nightlies); there is nothing to clone from GitHub.

Neither server is required to write a prompt and download a graph. They are
required to render and to rewrite.

## 6 · The mode is not a choice

There is no T2V / I2V / Ref2V switch, because there is nothing to decide. The
mode is what your material already says it is:

| What is attached | Mode |
|---|---|
| nothing | **Text to Video** — the prompt alone |
| exactly one picture | **Image to Video** — that picture anchors the first frame |
| anything more | **Reference to Video** — up to 9 images, 3 clips, 3 audio files |

The title bar shows which one you are in, and adding or removing media is how
you change it. The picture also *moves* to the slot that mode reads from, so
`<Picture 1>` keeps meaning the same picture whichever side of the line you are
on — a project can no longer sit in I2V with six references it silently
ignores.


## 7 · Fill the pool — *Media*

Drop files **anywhere in the window**; they land in the bin your mode uses.

Every reference carries a **retention marker**, which is a directive, not a
description:

- visual — `fully_preserved` · `partially_preserved` · `attribute_transfer` · `weak_reference`
- audio — `fully_copy` · `partially_copy` · `reference` · `weak_reference`

`fully_copy` on an audio clip is the documented way to say *lip-sync to this and
keep it as the finished soundtrack*. A reference video's own soundtrack gets its
own marker, separate from what the frames are for.

**A tag with no media behind it is silently ignored**, so the editor hands the
rewriter the exact tag inventory and flags any tag you cite that isn't attached.

Reference clips are read as 24 fps, and the stock loader passes a file's own rate
through unchanged — export reference clips at 24 fps and their motion lines up
exactly.

## 8 · Write the shots — *Cut*

- One line into the idea box → **Auto-shots** turns it into a timed shot list.
- Or start from a **Template**: single take, establish → close, talking head,
  product turn, reveal, long-form montage, reference performance.
- The timeline behaves: drag a cut, **S** to split at the playhead, **⌘D** to
  duplicate, **⌫** to delete, **⌘Z** to undo.

A shot is a list of **beats**, not a paragraph. H3 renders roughly one beat per
2–3 seconds and the badge counts yours against the shot's own length. Beats are
joined the way the guide joins them — `…, then …`, `…, as …`.

**Framing** (lens, camera height, where the subject sits in the rectangle, and
what the lens does about depth) holds for the whole shot. **Camera move** is what
changes during it — a primary move with amplitude and speed, optionally a second
simultaneous one, or a line you write yourself. Camera motion is always stated;
if there is none, the prompt says the camera remains static, because leaving it
out is what makes the model invent one.

**Depth is a separate control** because it is a separate fact to the model:
focal length sets the geometry, depth sets what is sharp and what the geometry
does during the shot — shallow or deep focus, a rack focus in either direction,
a dolly zoom that stretches the background away. It compiles to its own sentence
rather than a clause, because a rack focus is an event and events buried in
clauses get dropped.

**Or frame it by hand.** In Previz, paused, the frame carries two boxes: orange
where the subject starts, blue where the move leaves it, joined by a tie-line.
Drag the orange box to place the subject; drag its corner to change the shot
size (the shot-type dropdown follows). Drag the blue box — or the ↔ chip parked
beside it, which is how you create a move where there is none yet — and the
camera vocabulary is read back out of it: the dominant axis becomes the move,
a significant second axis becomes the simultaneous one, and a size change
becomes a push or a pull. The boxes are not a second model; they write the same
fields the dropdowns write, so the inspector and the prompt say what you just
dragged.

## 8b · How long a clip can be

**H3 renders 4–15 seconds. That is the model, not a setting.**

> | Output duration | 4–15 seconds |
> | Output frame rate | 24 FPS |
>
> — [the MiniMax H3 model card](https://huggingface.co/MiniMaxAI/MiniMax-H3), System Overview

The Length control offers 20, 25 and 30 s as well, because other H3 tooling
renders with that table and a length that silently vanished from a saved
project would be worse. But ComfyUI accepts a longer latent without complaining
and the model has nothing trained past 15 s, so **the extra seconds come back as
a repeat of what you already have**. Those three rows are marked `⚠ repeats`
wherever a length is chosen, and the checks call a clip past 15 s an error.

**Cuts do not buy seconds.** A shot list is prompt syntax — `[Shot 3] At
00:08.000,` tells the model when to cut, not how long to generate. A six-shot
30-second clip repeats exactly as a one-shot 30-second clip does. This guide used
to say the opposite; it was wrong.

For something longer, render it as separate clips and join them in an editor.
The frame counts themselves are on the model's own grid — the VAE's `clip_length`
is 17, so every offered length is ≡ 5 (mod 17) and anything else is rounded
inside the node.

Ref2V has an input budget from the same table: ≤ 9 images, ≤ 3 video clips, ≤ 3
audio clips — **and at most 12 files in total**, which is less than 9 + 3 + 3.
The checks enforce both.

---

## 8c · Keeping state across a cut

H3 has no memory between shots, and the compiled prompt repeats the subject line
at every one — it has to, because a cut "should introduce new information about
the subject, space, state, viewpoint, or time" and the model only knows what this
shot says.

Which means a subject introduced as *"a courier in a heavy canvas jacket"* is
described that way again at 00:08, **after the beats have spent eight seconds
taking the jacket off**. The model believes the most recent description. The
jacket comes back.

Every shot after the first therefore has a **Changed since** line — in the studio
inspector under Subject, and on the canvas node in the same place:

> `in shirtsleeves, the jacket over the chair behind him`

It is compiled directly after the clause it corrects, which is the only position
where it reliably wins:

> `At 00:08.000, the camera cuts to a medium shot, front-facing of a courier in a
> heavy canvas jacket, now in shirtsleeves, the jacket over the chair behind him.`

The checks find this for you: if a shot's beats change something (`removes`,
`puts on`, `opens`, `draws`, `picks up`, …) and a later shot repeats the subject
**word for word** with nothing in its Changed since line, you get a warning
naming both shots. Two shots that already describe the subject differently are
left alone.

---

## 9 · Watch it before you render — *Cut ▸ Viewer ▸ Previz*

**Space** plays the timeline back in real time: the cuts where they actually
fall, each shot's framing and lens as a crop, the camera move animated at its own
amplitude and speed, the beats appearing when they would happen, dialogue as
captions, and the soundscape and score as cues.

It simulates the **prompt**, not the model. What it tells you is whether the
timing, framing and structure are what you meant — the three things a prompt can
get wrong that you should not need a render to discover.

Three of those answers used to need something outside the frame, so they are
inside it now:

* **The strip along the bottom is the clip.** One block per shot at its real
  length, a tick where each beat starts, the playhead sweeping across, and the
  seconds to the next cut in the corner. Six ticks inside three seconds is what
  a crowded shot looks like, and the timecode was never going to tell you that.
* **The frame is lit.** The key goes where the shot's Lighting line puts it, as
  hard as the words ask — *soft*, *harsh*, *diffused*, *from the left*, *backlit*
  — with the shadow it leaves and the grade's tint over the whole frame. A shot
  that says nothing about light is drawn as the plate, which is what saying
  nothing means.
* **The move shows where it is going.** A faint blue box marks where the move
  leaves the subject and a line marks the path there, so an amplitude is a
  distance rather than a word. Speed is how much of the *shot* the move occupies,
  so a fast one finishes halfway through and the camera line says the frame holds
  from there — a held second used to read as previz having stopped.

**Board** (`B`) is the same clip as a storyboard: one card per beat, in render
order, each with a miniature of its frame — the subject box where it starts, a
ghost where the move leaves it, an arrow between them — plus the time, the
camera line and the words. Playback answers "does this play the way I meant";
the board answers it at a glance, and answers one playback cannot: whether six
beats ended up where three were intended.

The other two viewer tabs: **Prompt** is exactly what the encoder will read,
coloured by field; **Checks** is every problem findable before a GPU second is
spent — cuts past the end of the clip, beats packed too tight, negations,
intensifiers, quality tags, speech mentioned without words, references attached
but never cited, a Turbo build on the wrong canvas.

**Nodes** (`N`, or the button in the timeline header) is the strip between the
viewer and the timeline: sources on the left, shots in cut order in the middle,
the render on the right. An edge exists where a shot's text *actually cites* a
reference — not where a file was attached — so a reference with no edge is
flagged, which is exactly the failure Ref2V hides best: a tag nobody mentions is
silently ignored by the model. Colours follow the tag kind, the dashed verticals
are the cuts, and clicking a node selects that shot or jumps to its bin.

**The rewriter reads your images.** In I2V and Ref2V, "Rewrite" sends the fixed
first frame and the reference images to the vision model along with the draft,
and is told that where the draft contradicts an image, the image wins. Set a
**Vision model** on the Setup page if your server keeps writing and seeing in
different models. The Media page's **Describe** button captions a whole bin in
one go, which is what feeds the rewriter when it cannot see pixels itself.

**Second opinion** (on the Checks tab) is the other half of "how will this play
out": it has the LLM read the finished prompt back and report, shot by shot,
what it would render and which phrase reads two ways. Previz shows what the
*timeline* says; this shows what the *prompt* says to someone who wasn't there
when you wrote it.

## 10 · Sound is three separate things — *Sound*

| Field | Holds | Never holds |
|---|---|---|
| the description | dialogue, verbatim, per speaker | — |
| `overall_soundscape` | ambience, physical sounds, non-verbal vocals | dialogue, music |
| `non_diegetic_music` | instrumentation, tempo, rhythm, dynamics | mood words |

Dialogue syntax is `(S1) says, <d>[English] the exact words</d>.` Speaker ids are
stable across shots and the words are never translated. Voiceover uses the exact
phrase *"says in an off-screen voiceover"* plus a statement that the lips stay
closed. `N/A` in either audio field means *deliberately none*.

## 10b · Watching a render

The render node shows a real bar, the step count, the node ComfyUI is on, and
a running estimate — and, when ComfyUI is streaming them, the sampler's own
**preview frames** as the image resolves.

Previews need ComfyUI started with a preview method:

```bash
python main.py --preview-method auto        # or latent2rgb (cheap) / taesd (good)
```

Without one the bar still moves; there is just nothing to show. Setup ▸ **Show
render previews** turns them off if you would rather not pay the bandwidth.

---

### Between two shots

Each shot after the first carries a **Cut** — in the Inspector, on the shot
strip (`✂ Cut`, `✂ Dissolve`, `⟶ same take`), and in the node view as the
little selector on the wire that joins one shot node to the next. **Cut** and
the four after it are the guide's approved cut verbs, written as `[Shot 2] At
00:03.000, the camera cuts to …`. On the **LTX-2.5** engine every plain cut
is written the way Lightricks' 2.5 prompt guide names one — `a hard cut
transitions to a close-up …` — because LTX reads cuts as prose, not as
markers; **Dissolve** and **Fade** exist but the guide asks for
them only on explicit request, so they are labelled. **No cut — same take**
is the one the guide has no word for, because it is not a cut: the row
continues the previous shot, and compiles *into* its `[Shot N]` block —
`At 00:03.000, without a cut, the camera reframes to a close-up …` — with no
new marker, and the markers after it renumber. That is how one long take gets
several moments without pretending to be several shots.

### One render per cut (LTX-2.5)

On the LTX-2.5 engine the **Film** panel gains a **Cuts** row: *Every hard
cut is its own clip, joined afterwards.* Each cut in the timeline then
becomes a separate render — a real cut between two files instead of one the
model is asked to perform inside a clip — and the clips are joined on
Deliver as any film is. Rows marked **No cut — same take** stay inside their
clip, so a long take with several moments is still one render. With
**Continuity** on, each clip starts from the last frame of the one before.
The film may be as short as a single render here; the planner uses LTX's own
lengths (5–30 s). MiniMax ignores the row — its planner packs shots into
15 s clips as before.

### The Detail dial

It is asked twice, on purpose: **How detailed?** on Create's first screen
(spare · measured · rich · exhaustive), because *Read my material* writes to
it from there, and as the **Detail** dial on the steering rail after — the
same setting, shown two ways.

**Detail** (spare → exhaustive) is the one dial that steers the *writer*
rather than the frame: it sets how much each shot says, in four bands —
spare (~25 words a shot: a phrase per thing), measured (~45), rich (~70:
clothing, colour, a key object, two or three anchors in the setting, one
sentence on the background) and exhaustive (~100: materials, textures,
weather, what only someone who was there would notice). Read my material,
Polish and Enhance all write to it; the dial's own line says the target so
the word counter has something to be measured against. It never rewrites
what you typed by itself — once the shots are written, the dial carries a
**✨ Rewrite N shots at "rich"** button, which runs Polish over every shot at
the new level, as a click and not as a side effect of moving a slider. The model invents whatever is not written, so
spare is a choice to let it.

## 11 · Deliver

- **⬇ Workflow JSON** — the ComfyUI API graph, stock nodes only. The Input files
  list names every file it expects in `ComfyUI/input`.
- **● Render on ComfyUI** — uploads the media it references, queues, and follows
  the job with a progress bar (ComfyUI's WebSocket when the browser can reach it,
  polling when it can't).
- **×N Variations** — the same prompt on a ladder of seeds. H3's seed-to-seed
  variance is large enough that one clip is a sample, not a result.
- **＋ Queue** — put this clip in the line and carry on working. The GPU renders
  one at a time; the second clip used to have to live in your head until the
  first finished.

### Where the clip goes

ComfyUI writes every render into its own output folder, under the **Output
prefix** (`MotionstillCut/T2V_name…`). On top of that, the **Download
folder** row lets you pick a folder on *this* machine — Chrome and Edge can
hand a page a folder — and every clip that finishes is copied there, named
as ComfyUI named it. The browser asks once per session before the first
write. Other browsers: the ⬇ button on a finished clip downloads it the
ordinary way.

**"Permission denied" at the end of a render** means the clip rendered in
full and only the save was refused: the output *subfolder* belongs to another
user (a run under `sudo` leaves it owned by root) and ComfyUI runs as you.
The app reads that error for you, prints the `chown` that fixes it for good,
and offers **Save at top level and render again** — the flat name
`MotionstillCut_T2V_name…` at the top of ComfyUI's output folder, which is
always ComfyUI's own. The switch stays on (Setup ▸ ComfyUI) until you turn it
off.

### The render queue

Queue a clip from **Deliver**, from the canvas's **Render** node, or at the end
of **Create** — then run the lot from the Queue panel here.

A queued clip is a **snapshot**. You queue what the project looks like now and
keep editing it; what comes out of the queue is what you queued. The queue lives
outside any one project, which is the point — it is for lining up several
different clips, not seed variations of one, which is what ×N already does.

What a snapshot does *not* copy is the media. Pictures live in the media pool and
the snapshot points at them, so deleting one before its render runs will fail
that item — and only that item. A failure never stops the queue; the rest carry
on and the error stays on the row so you can read it afterwards.

Rows can be reordered, removed, re-run (**↻ Again**), or **Open**ed, which puts
that snapshot back in the editor in place of what you have open.

Every finished render keeps the prompt and the settings that made it: the **ⓘ**
button on a history row shows the exact text that went to the encoder, and
restores its canvas, length, build, seed and precision in one click.

Build row:

| Build | Steps | Sampler / scheduler | Flow shift | Notes |
|---|---|---|---|---|
| Full (T2V/I2V) | 20 | `res_multistep` / `simple` | 12 / 3 | the official template |
| Turbo 8-step | 8 | `euler` / `beta` | 12 / 3 | distilled at 544p |
| Turbo 4-step 768p | 4 | `euler` / `beta` | **6** / 3 | distilled on 1344×768 |
| Full (Ref2V) | 25 | `res_multistep` / `beta` | 12 / 3 | 25, not 20 — ref2va audio degrades first |
| Turbo 4-step ref2v | 4 | `euler` / `simple` | 12 / 3 | v0.1; check the soundtrack |

Steps and flow shifts are properties of a distill, not preferences — they are set
together or the motion degrades without erroring anywhere.

### The Engine row (experimental)

On T2V and I2V an **Engine** row sits above the build picker: **MiniMax H3**
(native) or **LTX-2.5 · experimental** — and the same choice sits in the
title bar as a chip beside the mode, on every page, because it decides what
the timeline may do (15 s or 30 s, pins or no pins). Click the chip to switch;
the prompt does not change, the checks use the other engine's limits. A check
that the other engine would resolve — a 20 s clip on H3, a pinned shot on H3 —
carries a **Switch to LTX-2.5** button of its own. The LTX chip compiles the *same
timeline* the way Lightricks' prompting guide asks — one chronological paragraph, no
timestamps or shot numbers, each cut named in prose (`a hard cut transitions to …`,
`the image dissolves into …`) with the audio continuity stated, the sound described
at the end — and sends it to Lightricks' model through its own distilled pipeline
(Two-stage 8+3 or Single-stage 8-step, cfg 1, no LoRAs). Same canvases, the
frame counts move to LTX's 8k+1 grid, clips run to a real 30 s, and I2V pins
the first frame with `LTXVAddGuide`. It needs the five LTX-2.5 files
(Setup ▸ Models, ~40 GB) and a ComfyUI with LTX-2 AV support — Setup's node
check has a separate LTX row, and a missing LTX node never blocks the MiniMax
modes. The point of keeping the prompt identical: the **Engine** sweep
renders H3 and LTX-2.5 from one prompt on one pinned seed, which is how you
find out what H3's grammar is worth on a model that wasn't trained on it.

On this engine the timeline can also be **pinned**: the Inspector's
**Pin (LTX)** row attaches an image to a shot, and the graph anchors it at
that shot's cut time with `LTXVAddGuide` — strength per pin (0.1–1.0, and
**Pin strength** is a sweepable variable). A pin holds what the frame looks
like when the shot lands; it does not force a hard cut. Pins are ignored on
the MiniMax engine (H3 has no per-frame guide input) and the checks warn
when that is about to happen.

Two things about pins that ComfyUI will not tell you, so this app does:

- **Pins land on a ⅓ s grid.** `LTXVAddGuide` anchors on the video VAE's
  8-frame stride, and it rounds to it silently — a pin at 4.20 s is really
  at 4.33 s, and that looks like drift, not rounding. The pin row prints
  the frame it actually lands on (`→ f104 · 00:04.333`), and the checks
  list every pin that moved. Put the cut on the grid if the exact frame
  matters.
- **The same picture pinned twice freezes the character.** A guide says
  "the frame looks like this, here". Pin one image at several cuts and the
  guides agree with each other: the model has been told the pose does not
  change, and it holds still between them. It is the intuitive move with a
  cast sheet — the same reference at every shot — and the checks warn when
  you make it. Pin a different frame at each cut, or drop the strength
  under 0.7 on all but one.

The LTX chip also leaves Lightricks' **prompt enhancer off** on purpose.
It helps a thin prompt; it dilutes a compiled one, and every prompt this
app sends is compiled.

### These settings stick

Whatever you choose on this page becomes the default your **next** project
starts from, in every mode — canvas, build, precision, tiled decode. They
describe the machine you are on, not the clip you are making.

**Length is not one of them, and used to be.** A clip's length belongs to the
clip. Carrying it meant that one try at 30 s made every project afterwards
30 s — past what H3 renders, arriving as a setting nobody had chosen twice, and
producing a repeat in every clip until somebody noticed the dropdown. The output
folder was carried for the same reason and had the same problem: a folder typed
for one job quietly collected every later project's renders.

The build is remembered **once per checkpoint family**, because the two lists
share no names: fl2va (text and image to video) offers full / turbo / turbo4,
ref2va (reference to video) offers full / ref4. Attach a second picture and
come back, and your Turbo is still Turbo rather than having silently fallen
back to the first entry in a different list.

The **seed is deliberately not remembered** — a seed belongs to a take, not to
a setup. *Setup ▸ Remembered on this machine* lists everything that is kept and
has the button that forgets it.

## 12 · The Library — the half after the render

Every render is saved here automatically with the exact prompt, settings and
seed that made it. That much needs nothing from you.

**The star rating is the only thing that feeds back.** When you rate a clip, the
director reads it: it weighs your own results over general advice every time
you ask it anything. Rate nothing and it works from the vendor's guide alone.
Two stars means "this didn't work"; four or five means "do more of this".

**The tags name the failure** so it can be counted — and each one knows the
house rule it implies. Tag a clip *"camera did its own thing"* and the app
offers you the rule *"State the camera on every shot — motion, amplitude and
speed, or 'the camera remains static'."* One click adopts it.

**House rules** are what this box has learned that MiniMax's guide does not say.
Every active rule is appended to the rewriter's system prompt, so a lesson
learned once keeps working. Give a rule a watch phrase and the checks flag it
too.

**Cast & phrases** is for recurring subjects: write Anna once, type `@anna` in
any field, and the same words describe her every time. H3 has no memory between
clips — that text *is* the character.

**Import from ComfyUI** reads ComfyUI's own history and shelves every MiniMax H3
render it finds, so clips made before this editor existed are on the shelf too.

### Who H3 already knows

There is a second way to hold a face: not describing it, but **naming someone
the model was trained on**. For some characters the name alone is enough —
write "Walter White" and Walter White turns up. For most it is not, and the
name renders a stranger, which is worse than useless because it looks like it
should have worked.

Which is which is not guessable, so it is looked up. 1293 characters were
generated one clip at a time and judged by eye:

| | |
|---|---|
| **405** | came back recognisable from the name alone |
| **53** | half the time |
| **835** | not at all |

Browse them under **Cast & phrases**, from **⌘K**, or from the **🎭** beside a
shot's Subject in the studio. Search by character, by actor or by show —
typing `cranston` finds Walter White, typing `the office` finds everyone in it.
Picking one fills a cast entry with the name and the anchor the encoder needs
("Abby Sciuto, from NCIS, as played by Pauley Perrette"), so `@abby_sciuto`
works everywhere from then on.

**The checker reads it too.** Name someone from the bottom two buckets and it
says so, with what to do instead: describe them concretely, or pin the face
with a reference image. It is a *warning*, never an error — with a picture
attached the name is only a label and the reference is doing the work, and the
message says so.

The index is [community testing by malcolmrey](https://huggingface.co/datasets/malcolmrey/various)
(`h3-center/known-characters`), not an official MiniMax list, and it is one
person's read of a handful of clips per name. Treat it as a strong hint. The
snapshot the app ships is `cut/web/assets/known-characters.tsv`; `npm test`
checks it still holds the counts the source index declared.

Names that are also ordinary English — Angel, Data, Driver, Eleven, God, Ray,
Vision, Wash, Wolverine, "The Doctor" — are deliberately left out of the
automatic scan, so *"the driver pulls away from the kerb"* is never mistaken
for a casting decision. They stay fully searchable in the picker.
Under-reporting costs a hint; crying wolf costs the checker its credibility.


## 13 · VRAM saver

H3's DiT is around 20 GB; a 32B text encoder is another 20. On one card they do
not co-fit, and the failure mode is not an error — the driver spills to shared
memory and the render crawls.

With the saver on, **one engine holds the GPU at a time**: a rewrite unloads
ComfyUI's models first, a render unloads the LLM first, and a render already in
flight is never interrupted. The title-bar badge says who has the card.

Unloading is per-backend: LM Studio, Ollama, llama-swap, a Nexus gateway and
llama.cpp **in router mode** can all do it. A plain `llama-server` started with
`-m` cannot — it holds its model until the process exits, and the app says so
once instead of pretending.

## 14 · Everything is on ⌘K

The command palette is the menu bar this app doesn't have: modes, pages,
templates, renders, GPU controls, project import and export.

| Key | |
|---|---|
| `⌘K` / `Ctrl+K` | command palette |
| `⌘J` | ask the director |
| `⇧Space` | the readthrough |
| `` ` `` | Create |
| `0` | the Canvas |
| `1` – `6` | Media · Cut · Sound · Deliver · Library · Setup |
| `Space` | play the previz |
| `←` `→` | nudge the playhead |
| `S` | split at the playhead |
| `N` | show / hide the node view |
| `B` | storyboard ⇄ previz |
| `⌘D` | duplicate the selected shot |
| `⌫` | delete the selected shot |
| `⌘Z` / `⇧⌘Z` | undo · redo |
| `⌘⏎` | render |
| `⌘S` | export the project file |
| `F1` | quick guide |

---

## Where things live

Projects live on the server as one JSON file each under
`cut/data/projects/`, with their media beside them in `cut/data/media/` —
shared, so two projects citing the same reference image store it once. The
project you have open also sits in `localStorage` and its media bytes in
IndexedDB, which is what survives a reload before you have saved.

An exported `.mscut.json` carries the timeline but not the media bytes —
re-attach media after importing one on another machine, or save the project on
the server and open it there instead.

Server-side settings are in `cut/data/settings.json`; the library, rulebook and
cast are `library.json`, `rulebook.json` and `cast.json` beside it. The
character index is a static file, `cut/web/assets/known-characters.tsv`.
