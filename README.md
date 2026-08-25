# Motionstill Cut

**A film editor for prompts.** Text, image and reference to video on **MiniMax
H3** — written in a DaVinci-Resolve-style NLE where a **local LLM** and **your
own ComfyUI** share the desk: one writes and critiques the prompt with you, the
other renders it, and they take turns on the same GPU. No cloud, no account,
no upload — the model that writes and the model that renders are both yours.

**Open the web app, or run it locally — same interface, every line of code
shared:**

```
Web    → the Netlify link · nothing to install · everything stays in your browser
Local  → git clone …/motionstillcut && node server/server.js   (Node 18+, zero deps)
```

**New here?** Press `F1` in the app — the guide has worked examples, recipes,
real screenshots and a searchable manual — or read [QUICKGUIDE.md](QUICKGUIDE.md).

![The Studio — previz with the framing box, the timeline with its dialogue lane, and the shot inspector](web/assets/help/studio.webp)

---

## Two AIs, one desk

```
        you ──────────────┐
                          ▼
   ┌───────────────  Motionstill Cut  ───────────────┐
   │   shots · beats · camera pad · voices · previz  │
   └──────┬──────────────────────────────────┬───────┘
          │ writes, critiques,               │ renders, as a
          │ interviews, captions             │ stock-node graph
          ▼                                  ▼
   local LLM server                     your ComfyUI
   (LM Studio · Ollama ·                (MiniMax H3 ·
    llama.cpp — e.g. Gemma 3 12B)        LTX-2.5 experimental)
          ▲                                  ▲
          └────────── VRAM saver ────────────┘
             one engine on the GPU at a time
```

This pairing is the whole idea. The LLM is not a chatbox pasted onto an
editor — it **operates the app**:

- **The interview.** Paste a rough idea, drop your pictures, and Create
  interviews you — *reading the images* — then builds a working shot canvas.
- **The director (⌘J).** "Bring her closer." "Why does it keep adding music?"
  It answers with a plan of concrete edits, each with its reason and a
  checkbox. Nothing lands until you press Apply; one ⌘Z takes it all back.
- **The second opinion.** Before you render, the model reads your compiled
  prompt the way a stranger would and tells you what it would actually make.
- **Captioning.** "Describe with the LLM" looks at a reference image and
  writes what it really shows — which is what makes an I2V opening match its
  first frame.
- **Your house rules.** Rate renders, tag failures, adopt the rule each tag
  implies — and every rewrite from then on carries what worked *on your box*.

And because H3's DiT (~20 GB) and a big text encoder do not co-fit on one
card, the **VRAM saver** makes them take turns: asking for a rewrite unloads
ComfyUI, queueing a render unloads the LLM — in whichever unload dialect your
LLM server speaks. A render in flight is never interrupted.

## What you can do with it

- **A two-person scene with voices that hold.** Speakers are people, not
  labels: describe a voice once and `(S1)` keeps it across every cut. Lines
  go in verbatim; "off screen" compiles H3's exact voiceover phrasing.
- **A product orbit from one photo.** Drop the photo (the mode flips to I2V
  by itself), describe the opening to match it, drag a small slow Orbit on
  the camera pad, render ×3 seeds, keep the best.
- **The same character next week.** Write `@anna` once and the same words
  describe her in shot 4 and next month — H3 has no memory, that text *is*
  the character. For a face lock, go Ref2V and pin her portrait
  `fully_preserved`.
- **Watch the prompt before you pay for it.** The readthrough (⇧Space) plays
  the instructions back in real time — every channel as a lane, the compiled
  text lighting up clause by clause. Previz shows the framing, the move at
  its real amplitude, even the lighting. A wrong prompt is minutes of GPU
  time; three ways to be wrong are free.

  ![The readthrough mid-play — the plate, the compiled text with the live clause lit, and every channel as a lane](web/assets/help/readthrough.webp)
- **Controlled experiments.** Pin the seed, sweep one variable across N
  renders, diff two takes word by word in the Library, and turn the finding
  into a house rule.
- **Films longer than 15 seconds.** H3 renders 4–15 s per clip, so The Film
  cuts the writing into clips that each fit, chains them — each starting from
  the previous clip's final frame — and joins them with ffmpeg (local app).

What the encoder actually gets is a grammar, not prose — compiled from shots,
beats and the camera pad, checked against MiniMax's own prompt guides, and
frozen by golden tests:

```
integrated_multimodal_description: [Shot 1] A live-action cinematic medium
shot, front-facing: a woman in a charcoal coat. The setting is a rain-streaked
cafe window at night. Teal-and-orange grade with cool shadows and warm skin
tones. The camera remains static. Lowers her cup, then looks up. [Shot 2] At
00:04.500, the camera cuts to a close-up shot, front-facing of her hands. The
camera tilts down with small amplitude at slow speed. Twist the portafilter free.
```

You never type that by hand. You also never have to wonder what you are
sending.

## Pick a local LLM

Any OpenAI-compatible server works (LM Studio, Ollama, llama.cpp). The VRAM
saver means the LLM and the video model **take turns** — so size the model for
your card, not for co-fitting with a 20 GB DiT.

| Card | Model | Why |
|---|---|---|
| **12 GB+ — recommended** | **Gemma 3 12B** (instruct) | The sweet spot: strong prose, reliable JSON, and **vision** — one model covers the director, the rewriter *and* image captioning. ~8 GB at Q4/QAT. |
| ≤ 8 GB | Gemma 3 4B · Llama 3.1 8B | Rewrites and captions are fine; second opinions get shallower. |
| 24 GB+ | Gemma 3 27B · Qwen3 32B | The best director plans and critiques. Keep **Thinking Off** for Qwen3 — the app's default. |
| Vision on a budget | Qwen2.5-VL 7B as the separate *Vision model* | Pair it with any text model you like; Setup has both fields. |

Reasoning models deserve one sentence: **thinking does not need to be on for
this app — it is usually what breaks it.** A model that deliberates past its
token budget never reaches the answer; the app asks backends to skip thinking
in every dialect at once, strips any reasoning from replies, retries truncated
answers with a bigger budget, and — when something still fails — names the
setting to change instead of saying "try a larger model".

## The web app (client-only)

The hosted version is static files and nothing else — **no server-side saving
of any kind**. Settings live in localStorage; projects, library, house rules,
cast and media live in IndexedDB, in your browser. The page talks straight to
the two engines on your machine, which each need CORS switched on once:

- **ComfyUI** — start with `python main.py --enable-cors-header`
- **LM Studio** — Developer settings → enable CORS
- **Ollama** — run with `OLLAMA_ORIGINS=*`

The first visit opens a **setup conversation** — where your work lives, where
the engines are (with auto-detect), which model to feed the director. Re-run
it any time from ⌘K or Setup. And since the browser is the only place your
work exists, Setup carries one-click **Export / Restore backup**: everything,
media included, as one JSON file.

**Deploying your own:** the repo is Netlify-ready (`netlify.toml` publishes
`web/`, SPA fallback, no build step). Fork it, point a Netlify site at it,
done. Any static host works the same way.

## The local app (Node, optional server saving)

```
node server/server.js       # → http://127.0.0.1:3091
```

Node 18+ and nothing else — no `npm install`. The first run opens a one-page
wizard (`/setup`) with the one choice that matters:

1. **Local server saving — recommended.** Projects, library, rulebook, cast
   and settings as plain JSON under `data/` (readable, diffable, backed up
   with `cp`), both engines proxied so **no CORS flags anywhere**, and
   multi-clip films joined with ffmpeg.
2. **Browser only.** The hosted behaviour exactly, served from your machine:
   the Node process hosts the interface and persists nothing.

Env (all optional): `CUT_PORT` `CUT_HOST` `CUT_PW` `CUT_COMFY_URL`
`CUT_LLM_URL` `CUT_LLM_KEY` `CUT_VRAM_SAVER` `CUT_SAVING` `CUT_NO_OPEN`
`CUT_DATA` `CUT_FFMPEG`.

## What it needs to render

MiniMax H3 (Hailuo 3.0, open weights) — an omni-modal DiT that generates
video with native 32 kHz audio in one pass — on **your own ComfyUI**, stock
nodes only: every node this editor emits ships with ComfyUI, which is what
makes the downloaded workflow run on anyone's install. The Setup page checks
the node catalog by name, lists the model files (the Comfy-Org repack plus the
Turbo distills) and hands over exact download commands. An **experimental
second engine — LTX-2.5** — renders the *same compiled prompt* on Lightricks'
model for comparison (T2V/I2V).

No GPU at all? The app is still a full prompt editor: everything compiles,
previews and lints, and the workflow downloads as JSON.

## The loop

Prompt engineering is not writing a prompt. It is **idea → prompt → result →
learn → better prompt**, and a tool that stops at "prompt" makes you re-learn
the same lesson every session:

| | |
|---|---|
| **Compose** | The node canvas, the guided Create flow, or the studio pages — the prompt is a grammar with controls, and the LLM edits it *with* you. |
| **Preview** | The readthrough, the lit previz, the checker, the second opinion. Three ways to be wrong for free. |
| **Render** | Stock-node ComfyUI graph, downloaded or queued, one engine on the GPU at a time. |
| **Judge** | Every render lands in the Library with the exact text that made it. Rate it; name what went wrong. |
| **Learn** | Word-level diffs, seed-pinned sweeps, and house rules that ride along with every rewrite. |

## Architecture, briefly

One front end (`web/`), two interchangeable backends behind the old Cut
server's API contract — no page module knows which one answered:

- `web/js/backend/` — the **client backend**: every route answered inside the
  tab (localStorage + IndexedDB + direct engine fetches; the film's
  last-frame job done by the browser's own decoder).
- `server/` — the **local app**: the original zero-dependency Node server
  plus the first-use wizard; one injected line in index.html tells the page
  which backend is live, and every persistence route answers 403 when saving
  is off.

## Tests

```
npm test
```

93 tests, Node's own runner, no dependencies: the compiler against golden
files, the film planner, the linter run over MiniMax's canonical examples,
cast handling, the fresh-start templates.

## License

[MIT](LICENSE)
