# Motionstill Cut

A self-contained editor for **MiniMax H3** — text-to-video, image-to-video and
reference-to-video. It looks and works like a professional NLE (the reference
is DaVinci Resolve's chrome and page layout), it writes prompts in the exact
structure H3's own rewriter emits, it plays the prompt back before you render
it, and it delivers either a downloadable ComfyUI workflow or a queued job on
your own ComfyUI. An **experimental second engine — LTX-2.5** — renders the
same compiled prompt on Lightricks' model (T2V and I2V only).

This is the **public release**, and it comes in two forms that share every
line of front-end code:

|  | **The web app** | **The local app** |
|---|---|---|
| Get it | open the Netlify link — nothing to install | `git clone` + `node server/server.js` |
| Where your work lives | **your browser only** (localStorage + IndexedDB) — the host never sees it | your browser, **or** a `data/` folder on disk — your choice in the first-use wizard |
| ComfyUI / LLM server | reached directly from the page (one-time CORS flag, below) | proxied by the app when saving is on — no CORS setup |
| Multi-clip films | every clip renders and chains; the final join needs ffmpeg, so it is handed to the local app | joined with ffmpeg, stream-copy first |
| Backup | one-click export/import of everything on the Setup page | copy the `data/` folder |

**New here? Read [QUICKGUIDE.md](QUICKGUIDE.md)** — or press `F1` in the app.

---

## The web app (client-only, on Netlify)

The hosted version is nothing but static files: **there is no server-side
saving of any kind**. Settings live in localStorage; projects, the render
library, your house rules, the cast and all media live in IndexedDB — in your
browser, on your machine. The page talks straight to the two engines on your
own computer:

- **ComfyUI** — start it with the CORS flag so a web page may call it:

  ```
  python main.py --enable-cors-header
  ```

- **LLM server** — any OpenAI-compatible local server, with CORS on:
  - *LM Studio*: Developer settings → enable CORS
  - *Ollama*: run with `OLLAMA_ORIGINS=*`
  - *llama.cpp server*: recent builds answer CORS by default

That is the whole setup. Both addresses are probed and set on the app's
**Setup** page, which also tells you — in plain words — what is unreachable
and which flag is missing.

Because the browser is the only place your work exists, the Setup page carries
**Export backup / Restore backup**: everything (settings, projects, library,
rulebook, cast, and the media your projects reference) as one JSON file.
Export one once in a while; clearing site data deletes the lot.

### Deploying your own

The repo is Netlify-ready: `netlify.toml` publishes the `web/` folder with an
SPA fallback, no build step. Fork the repo, point a new Netlify site at it,
done. Any static host works the same way — the folder is the app.

## The local app (Node, optional server saving)

```
node server/server.js       # → http://127.0.0.1:3091
```

Zero dependencies — Node 18+ and nothing else, no `npm install`. On the first
run it opens your browser on a **one-page setup wizard** (`/setup`) with two
choices:

1. **Local server saving — recommended.** Projects, the library, the rulebook,
   the cast and settings are saved as plain JSON under `data/` next to the
   app: readable, diffable, recoverable with `cp`. The app also proxies both
   engines (so no CORS setup anywhere) and joins multi-clip films with ffmpeg
   when it is installed.
2. **Browser only.** The exact behaviour of the hosted version, served from
   your own machine: the Node process hosts the interface and persists
   nothing.

The wizard also asks where ComfyUI and the LLM server are (with auto-detect),
and can be re-run at `/setup` any time.

Env (all optional):

```
CUT_PORT        listen port          (default 3091)
CUT_HOST        listen address       (default 127.0.0.1)
CUT_PW          password gate; unset = open, fine on localhost only
CUT_COMFY_URL   ComfyUI base         (default http://127.0.0.1:8188)
CUT_LLM_URL     LLM server base      (default http://127.0.0.1:1234)
CUT_LLM_KEY     API key for the LLM server
CUT_VRAM_SAVER  0/1 — one engine on the GPU at a time (default 1)
CUT_SAVING      0/1 — force local server saving off/on
CUT_NO_OPEN     1 — never auto-open the browser
CUT_DATA        where data/ lives    (default next to the app)
CUT_FFMPEG      path to ffmpeg       (default: whatever `ffmpeg` resolves to)
```

## The loop

Prompt engineering is not writing a prompt. It is **idea → prompt → result →
learn → better prompt**, and a tool that stops at "prompt" makes you re-learn
the same lesson every session. So the app is built around the whole loop:

| | |
|---|---|
| **Compose** | The node canvas, the guided Create flow, or the studio pages. The prompt is a grammar with controls, not a text box — and a local LLM edits it *with* you, proposing concrete changes you accept or decline one at a time. |
| **Preview** | The **readthrough** plays the instructions back in real time — the plate, every channel as a lane, and the compiled text lighting up clause by clause. Three ways to be wrong for free. |
| **Render** | Stock-node ComfyUI graph, downloaded or queued, one engine on the GPU at a time. |
| **Judge** | Every render lands in the **Library** with the exact text that made it. Rate it; say what went wrong from a closed list. |
| **Learn** | **Compare** two takes with a word-level diff. **Sweep** one variable with the seed pinned. Turn what you find into a **house rule** that rides along with every rewrite. |

The **cast** is the other half of consistency: a subject written once and used
as `@anna` everywhere, so the same words describe her in shot 4 and again next
week.

## What it needs to render

MiniMax H3 (Hailuo 3.0, open weights) — an omni-modal DiT generating video
with native 32 kHz audio in one pass — running on **your own ComfyUI** with
stock nodes only. The Setup page checks the node catalog by name, lists the
model files (the Comfy-Org repack plus the Turbo distills), and hands over the
exact download commands. Without a GPU the app still works as a prompt
editor: everything compiles, previews and lints, and the workflow downloads.

## Architecture, briefly

One front end (`web/`), two interchangeable backends behind the same API
contract:

- `web/js/backend/` — the **client backend**: the old Cut server's routes
  answered inside the tab. Settings in localStorage, stores in IndexedDB,
  engines fetched directly, the film's last-frame job done by the browser's
  own decoder.
- `server/` — the **local app**: the original zero-dependency Node server,
  plus the first-use wizard, an injected one-line marker that tells the page
  which backend is live, and a hard 403 on every persistence route when
  saving is off.

`web/js/api.js` reads the marker and routes each call; no page module knows or
cares which backend answered.

## Tests

```
npm test
```

93 tests — the prompt compiler against golden files, the film planner, the
linter, cast handling and the fresh-start templates. Node's own test runner,
no dependencies.

## License

[MIT](LICENSE)
