/* DELIVER — the render page. Same graph, two endings: download the ComfyUI
 * workflow, or send it to ComfyUI and watch it come back. */

import {
  h, mount, toast, field, select, segmented, checkbox, textarea,
  download, copyText, modal, timecode, clamp, group, more, row,
} from "../util.js";
import {
  getProject, update, dimensions, frameCount, DURATION_FRAMES, RESOLUTIONS, MODES, selectedShot,
  H3_DURATION, LTX25_DURATION, overLength, FILM_LIMITS, filmSpan, activeEngine, durationFrames,
 onProjectSwap, LTX_DURATION_FRAMES } from "../state.js";
import { planFilm, describePlan, canChain } from "../film.js";
import { runFilm, assembleFilm } from "../filmrun.js";
import { variantsFor, variantFor } from "../vocab.js";
import { setEngine as switchEngine } from "../state.js";
import { validate, compilePrompt } from "../prompt.js";
import { buildWorkflow, estimateSeconds, estimateVram, vramLevers, humanTime, randomSeed, LTX_MAX_ANCHORS, UPSCALE_TARGETS, UPSCALE_TARGET_LABELS, upscaleSettings, upscalePlan } from "../workflow.js";
import { getSettings, getHealth, refreshVram, saveSettings } from "../config.js";
import { renderNow, renderBatch, cancelRender, currentJob, onRenderChange, uploadPending, applyLive } from "../render.js";
import * as downloads from "../downloads.js";
import { variablesFor, variableById, valuesFor, labelOf, runSweep, sweepCost } from "../experiments.js";
import { api, SERVER_BACKED } from "../api.js";
import {
  listQueue, enqueue, removeFromQueue, moveInQueue, clearQueue, openQueued,
  runQueue, isQueueRunning, requeue, onQueueChange,
} from "../queue.js";

let root = null;
let unsub = null;
let unsubQueue = null;
let statusLine = "";

/* ── Left: everything that changes the graph ──────────────── */
function settingsPanel(p) {
  const set = (patch, reason = "render") => { update((proj) => Object.assign(proj.render, patch), reason); refresh(); };
  const engine = activeEngine(p);
  const ltx = engine === "ltx25";
  const variants = variantsFor(p.mode, engine);
  const variant = variantFor(p.mode, p.render.variant, engine);
  const frames = durationFrames(p);
  const { width, height } = dimensions(p);
  const eta = estimateSeconds(p);
  const fit = estimateVram(p, { cardGB: getHealth()?.comfy?.vramTotalGB || null });

  /* Switching engines swaps the whole variant family — "turbo" is not a name
   * an LTX build answers to — so the switch reaches for whichever build was
   * last chosen for the target family rather than falling back silently. */
  const setEngine = (v) => { switchEngine(v); refresh(); };

  return h("div.panel",
    h("div.hd", h("span.title", "Render settings"), h("span.spacer"),
      h("span.hint.mono", { title: "Whatever you set here becomes the default for your next project, in every mode. Setup lists what is remembered." },
        `${width}×${height} · ${frameCount(p)}f`)),
    h("div.bd",
      h("div.insp",
        /* The model behind the render. Not offered in Ref2V — LTX has no
         * reference pipeline, so the row would be a lie there. */
        p.mode !== "r2v" ? group("Engine", {
          id: "d-engine", icon: "◉", accordion: false, defaultOpen: ltx,
          badge: ltx ? "LTX-2.5" : "H3",
          help: "The same timeline, each model in its own dialect. MiniMax gets the [Shot N] grammar its guide specifies; LTX-2.5 gets what Lightricks' prompting guide asks for — one chronological paragraph, no timestamps or shot numbers, every cut named in prose (\"a hard cut transitions to …\") with the audio continuity stated. A sweep here compares the two models on the same cut.",
        },
          segmented([["minimax", "MiniMax H3"], ["ltx25", "LTX-2.5 · experimental"]],
            p.render.engine === "ltx25" ? "ltx25" : "minimax", (v) => setEngine(v)),
          ltx ? h("div.note.warn", { style: { marginTop: "7px" } },
            h("b", "Experimental. "),
            "Same prompt, different model: the compiled text goes to LTX-2.5 unchanged. Audio generates jointly like H3's, and clips run up to 30 s without repeating — but multi-shot [Shot N] control is unproven on this encoder, dialogue tags may read as prose, and the graph needs a ComfyUI with LTX-2 AV support plus the LTX-2.5 files (Setup ▸ Models lists both). "
            + "Where the prose is not enough, pin the timeline: the Inspector's Pin (LTX) row anchors an image at a shot's cut time (LTXVAddGuide, strength per pin). Pins hold what a moment looks like; they do not force a hard cut.")
            : h("div.hint", { style: { marginTop: "7px" } },
                "MiniMax H3 is the native engine — the prompt compiler writes its rewriter's exact structure. The LTX-2.5 chip renders the same prompt on Lightricks' model instead, as an experiment."),
        ) : null,

        group("Output", {
          id: "d-output", icon: "▦", defaultOpen: true, accordion: false,
          badge: `${p.render.duration}s`,
          help: ltx
            ? "LTX-2.5's video VAE samples on the 8k+1 frame grid, so the same length rows land on slightly different frame counts than H3's. The canvases are H3's — that is deliberate: same prompt, same framing, comparable takes. LTX-2.5 generates up to 30 s, so no length here is past the model."
            : "H3's joint audio/video latent only lands on these lengths, and the two canvases are the ones the model and its distills were trained on. Anything else is rounded inside the node. MiniMax specifies 4–15 seconds of output: the last three lengths are past that, and the node renders them without complaining while the model repeats itself to fill the time.",
        },
          row("Canvas", select(RESOLUTIONS.map(r => [r[0], r[1]]), p.render.resolution, (v) => set({ resolution: v })),
            RESOLUTIONS.find(r => r[0] === p.render.resolution)?.[2] || ""),
          /* The three long rows are past what H3 can generate, and a dropdown
           * that lists them beside the real ones is a trap: the node renders
           * 30 s happily and the model repeats itself for the last half. So
           * they are labelled where the choice is made, not only in the
           * checks. (On LTX-2.5 nothing here is over-length, and the labels
           * say so by not warning.) */
          row("Length", select(Object.keys(frames).map(d => [d,
              `${d}s · ${frames[d]} frames${overLength(d, p) ? "  ⚠ repeats" : ""}`]),
            String(p.render.duration), (v) => set({ duration: Number(v) })),
            p.film?.enabled
              ? `Film mode is on, so each clip's length comes from the plan (5, 10 or 15 s) and this row only applies to a single test render.`
              : overLength(p.render.duration, p)
                ? h("span",
                    `Past H3's ${H3_DURATION.max}s ceiling — the extra seconds come back as a repeat of what you already have, and cuts do not extend it. `
                    + `Render it anyway if that is what you want, or `,
                    h("button.btn.sm.ghost", {
                      style: { marginLeft: "2px" },
                      title: `Keep the ${p.render.duration}s, cut it into clips that each fit, join them afterwards`,
                      onclick: () => makeItAFilm(p.render.duration),
                    }, "cut it into clips"))
                : ltx && p.render.duration > H3_DURATION.max
                  ? `Within LTX-2.5's ${LTX25_DURATION.max}s window — switching back to MiniMax H3 would make this length repeat.`
                  : ""),
          row("Watermark", segmented([["off", "Off"], ["signature", "Signature"], ["client", "Client preview"]], p.render.watermark || "off", (v) => set({ watermark: v })),
            p.render.watermark === "client"
              ? "Your name tiled diagonally across the whole frame at low opacity, plus the signature — on every frame, so it survives a screenshot, a re-encode and a crop. A preview a client can judge and cannot use."
              : p.render.watermark === "signature"
                ? "Your name, small, in the bottom-right corner of every frame."
                : "Nothing stamped on the delivered clip."),
          (p.render.watermark || "off") !== "off"
            ? row("Name", h("input", {
                type: "text", value: getSettings()?.watermark?.text || "", placeholder: "Your name",
                onchange: (e) => saveSettings({ watermark: { text: e.target.value.trim() } }).then(() => { toast("Saved", "", "ok"); refresh(); }),
              }), (getSettings()?.watermark?.text || "").trim()
                ? "Kept in this browser's settings — the same name on every project. Drawn at the delivered size, after the upscale."
                : "Type the name to stamp. Until there is one, the render goes out unmarked.")
            : null,
          fitLine(p, eta, fit),
          h("div.hint", { style: { marginTop: "5px" } },
            "These stick: whatever you choose here is what your next project starts from, in every mode."),
        ),

        group("Build", {
          id: "d-build", icon: "⚡", accordion: false, badge: variant.label.split(" ")[0],
          help: ltx
            ? "Both builds are Lightricks' own distilled workflows — the sigma ladders are baked into the distill, so there is no steps or shift knob to turn."
            : "Steps and flow shifts are properties of a distill, not preferences — upstream sets them together, and mixing them up degrades motion without erroring anywhere.",
        },
          segmented(variants.map(v => [v.key, v.label]), variant.key, (v) => set({ variant: v }), "stack"),
          h("div.hint", { style: { marginTop: "7px" } }, variant.note),
          h("div.hint.mono", { style: { marginTop: "5px" } },
            `${variant.steps} steps · ${variant.sampler} · ${variant.scheduler}`
            + (variant.shiftVideo != null ? ` · shift ${variant.shiftVideo}/${variant.shiftAudio}` : "")
            + (variant.trainedAt ? ` · at ${variant.trainedAt}` : "")),
        ),

        group("Seed", {
          id: "d-seed", icon: "⚄", accordion: false,
          badge: p.render.seed < 0 ? "random" : String(p.render.seed).slice(0, 8),
        },
          h("div.flex",
            h("input", {
              type: "number", value: String(p.render.seed), class: "grow",
              oninput: (e) => update(proj => { proj.render.seed = Number(e.target.value); }, "text"),
            }),
            h("button.btn.sm", { title: "New seed", onclick: () => set({ seed: randomSeed() }) }, "🎲"),
            h("button.btn.sm", { onclick: () => set({ seed: -1 }) }, "Random"),
          ),
          h("div.hint", { style: { marginTop: "5px" } },
            p.render.seed < 0 ? "A fresh seed on every render." : "Pinned — the same prompt gives the same clip."),
        ),

        upscaleGroup(p, set),
        group("Advanced", {
          id: "d-adv", icon: "⚙", accordion: false,
          help: ltx
            ? h("div",
                h("b", "Mostly stock. "),
                "The LTX-2.5 graph keeps to core nodes plus ComfyUI's LTX-2 AV support (the LTXV* latent and audio nodes). A build old enough to miss any of them is named on the Setup page — nothing beyond ComfyUI itself is used.")
            : h("div",
                h("b", "Stock nodes only. "),
                "Every node in the graph ships with ComfyUI, so the downloaded workflow runs on any install with MiniMax H3 support and nothing else to add. Sparse attention, chunked feed-forward and the free-memory nodes all live in custom packs and are deliberately not used.",
              ),
        },
          p.mode === "r2v" ? row("Reference size",
            segmented([["match", "match"], ["max", "max"]], p.render.refImageSize, (v) => set({ refImageSize: v })),
            "\"max\" holds identity better and costs real time — reference tokens ride through every step.") : null,
          !ltx ? row("Precision", segmented([["int8", "INT8"], ["nvfp4", "NVFP4"]], p.render.precision, (v) => set({ precision: v })),
            "NVFP4 is the experimental conversion — same graph, different file.") : null,
          !ltx ? h("div", { style: { margin: "9px 0" } },
            checkbox("Tiled video decode", p.render.tiledDecode, (v) => set({ tiledDecode: v }),
              "VAEDecodeTiled — worth it on long clips, pointless on short ones"))
            : h("div.hint", { style: { margin: "9px 0" } },
                "One quantization (the INT8-convrot pack — the only ComfyUI-loadable 2.5 build), and the video always decodes tiled: a 30 s clip through the conv VAE in one piece is an out-of-memory, and on short clips the tiling costs nothing."),
          row("Output prefix", h("input", {
            type: "text", value: p.render.outputPrefix || "",
            placeholder: getSettings()?.comfy?.outputPrefix || "MotionstillCut",
            oninput: (e) => update(proj => { proj.render.outputPrefix = e.target.value; }, "text"),
          }), getSettings()?.comfy?.flatOutput
            ? "Saved flat at the top of ComfyUI's output folder (Setup ▸ ComfyUI to change)."
            : "Saved into this subfolder of ComfyUI's output folder."),
          downloadFolderRow(),
        ),
      ),
    ),
  );
}


/* ── Upscale: a post-render pass ──────────────────────────── */
function upscaleGroup(p, set) {
  const up = upscaleSettings(p);
  const nodes = getHealth()?.nodes || {};
  const known = { ...(nodes.ltx || {}), ...(nodes.optional || {}) };
  const has = (name) => (known[name] ? !!known[name].present : null);   // null: ComfyUI not probed
  const plan = upscalePlan(p);
  const { width, height } = dimensions(p);
  const setUp = (patch) => set({ upscale: { ...up, ...patch } });
  const engineHint = up.engine === "seedvr2"
    ? (has("SeedVR2VideoUpscaler") === false
        ? "SeedVR2's nodes are not on this ComfyUI — install the seedvr2_videoupscaler pack (ComfyUI Manager has it), then Setup ▸ Upscalers to pick the build."
        : "Diffusion video restoration in batches of thirteen frames with overlap, so motion stays coherent and detail is invented rather than sharpened. Diffuses at 1080p-class and a resize finishes 1440p and 4K. About three seconds a frame on a big card — a 30 s clip is most of an hour.")
    : up.engine === "flashvsr"
      ? (has("FlashVSRNode") === false
          ? "FlashVSR's node is not on this ComfyUI — install the ComfyUI-FlashVSR_Ultra_Fast pack (models go in models/FlashVSR)."
          : "FlashVSR v1.1, a one-step streaming diffusion upscaler at ×2 or ×4, tiled, then resized to the target. Coherent and conservative — keeps motion blur rather than inventing texture — and several times faster than SeedVR2.")
    : up.engine === "ltx25"
      ? (has("LTXVLatentUpsampler") === false
          ? "This ComfyUI has no LTX-2.5 support — the LTX nodes are named on the Setup page."
          : "LTX-2.5 as the upscaler: the frames are encoded into its latent, doubled by its latent upsampler and put through the three-step refine pass the two-stage build uses, under the clip's own prompt. Core nodes, but the whole LTX-2.5 pack loads for it — quickest from an LTX render, where the weights are already on the card. Detail is re-imagined by a video model, ×2; the target finishes with a resize.")
    : up.engine === "esrgan"
      ? (has("ImageUpscaleWithModel") === false
          ? "The stock upscale nodes are missing — this ComfyUI is very old."
          : "RealESRGAN ×4 on every frame, then a Lanczos resize to the target. Seconds per clip. Each frame is upscaled alone, so fine texture can shimmer.")
      : "Delivered at the canvas size.";
  return group("Upscale", {
    id: "d-up", icon: "⤢", accordion: false,
    help: h("div",
      h("b", "After the render. "),
      "The decoded frames go through an upscaler before the video is muxed, so the clip is generated at the canvas size — the size the model was trained at — and delivered larger. Nothing about the render itself changes; the VRAM the sampler needs is decided by the canvas, not by this.",
    ),
  },
    row("Upscaler", segmented([["off", "Off"], ["seedvr2", "SeedVR2 · best"], ["flashvsr", "FlashVSR · balanced"], ["ltx25", "LTX-2.5 · refine ×2"], ["esrgan", "ESRGAN · fast"]], up.engine, (v) => setUp({ engine: v })), engineHint),
    up.engine !== "off"
      ? row("Output", select(Object.keys(UPSCALE_TARGETS).map(k => [k, UPSCALE_TARGET_LABELS[k]]), up.target, (v) => setUp({ target: v })),
        plan
          ? `${width}×${height} → ${plan.width}×${plan.height}, ×${plan.factor.toFixed(2)} on the short edge.`
          : `${width}×${height} already has a short edge of ${Math.min(width, height)} — ${up.target} is no larger, so the pass is skipped.`)
      : null,
  );
}

/* ── Centre: the two buttons, the bar, and the history ────── */
function renderPanel(p) {
  const job = currentJob();
  const report = validate(p);
  const running = job && ["queued", "running"].includes(job.status);
  const health = getHealth();

  const bar = h(`div.progress${running && !job.progress ? ".indet" : ""}`,
    h("i", { style: { width: `${Math.round((job?.progress || 0) * 100)}%` } }),
    h("span", { "data-live": "deliver" }, job
      ? job.status === "running"
        ? `${job.step || 0}/${job.steps || "?"} — ${job.node ? `node ${job.node}` : "starting"}`
        : job.status
      : "idle"),
  );

  const preview = h("div.viewer", { style: { minHeight: "0", flex: "1" } },
    h("div.surface",
      job?.outputs?.length && !running
        ? h("video", { src: api.viewUrl(job.outputs[0]), controls: "", autoplay: "", loop: "", playsinline: "" })
        // The sampler's own frames while it works, when ComfyUI is emitting
        // them. Watching the image resolve beats watching a bar.
        : running && job.preview
          ? h("img.live", { src: job.preview, alt: "render preview" })
          : h("div.empty", h("div.big", running ? "◐" : "▣"),
              h("div.t", running ? "Rendering…" : "Nothing rendered yet"),
              h("div.hint", { style: { marginTop: "6px" } }, statusLine || (running ? "" : "Render sends this timeline straight to ComfyUI; the clip plays here when it lands."))),
    ),
  );

  return h("div.panel",
    h("div.hd", h("span.title", "Render"), h("span.spacer"),
      h("span", { class: `badge ${report.pristine ? "" : report.errors ? "bad" : "ok"}` }, h("span.dot"),
        report.pristine ? "empty timeline"
          : report.errors ? `${report.errors} error${report.errors === 1 ? "" : "s"}` : "checks pass"),
      report.warnings ? h("span.badge.busy", h("span.dot"), `${report.warnings} warning${report.warnings === 1 ? "" : "s"}`) : null,
    ),
    h("div.bd", { style: { display: "flex", flexDirection: "column", padding: "0" } },
      h("div", { style: { padding: "10px", borderBottom: "1px solid var(--line)" } },
        h("div.btn-row",
          running
            ? h("button.btn.lg.grow", { onclick: async () => { await cancelRender(); refresh(); } }, "■ Cancel")
            : h("button.btn.lg.record.grow", { onclick: () => doRender(p) }, "● Render on ComfyUI"),
          running ? null : h("button.btn.lg", {
            title: "Change one thing, hold everything else still, render the set",
            onclick: () => doSweep(p),
          }, "⇄ Sweep"),
          running ? null : h("button.btn.lg", {
            title: "Queue the same prompt several times with different seeds",
            onclick: () => doBatch(p),
          }, "×N Seeds"),
          h("button.btn.lg", {
            title: "Put this clip on the queue and carry on working — what runs is what it looks like now",
            onclick: () => { queueThis(p); },
          }, "＋ Queue"),
          h("button.btn.lg", { onclick: () => doDownload(p) }, "⬇ Workflow JSON"),
          h("button.btn.lg", { onclick: async () => { await copyText(compilePrompt(p).text); toast("Prompt copied", "", "ok"); } }, "Copy prompt"),
        ),
        h("div", { style: { marginTop: "9px" } }, bar),
        h("div.hint", { style: { marginTop: "5px" } },
          running
            ? `${job.mode.toUpperCase()} · ${job.meta.width}×${job.meta.height} · ${job.meta.numFrames} frames · started ${new Date(job.at).toLocaleTimeString()}`
            : health.comfy?.ok
              ? `ComfyUI ${health.comfy.version || ""} on ${health.comfy.device || "?"}${health.comfy.vramFreeGB ? ` · ${health.comfy.vramFreeGB} GB free` : ""}`
              : "ComfyUI is not reachable — Setup ▸ ComfyUI. Downloading the JSON works regardless."),
        job?.error ? h("div.note.bad", { style: { marginTop: "8px" } }, job.error) : null,
        running && job.sawProgress && (job.step || 0) >= 2 && !job.sawPreview && getSettings()?.comfy?.previews !== false
          ? h("div.hint", { style: { marginTop: "6px" } },
              "No preview frames are arriving. The render asks ComfyUI for them per prompt (preview_method: auto) — a ComfyUI older than that, or one that cannot decode this model's latent, sends none; the bar still moves and the clip still lands.")
          : null,
        job?.errorKind === "save-permission" && !running ? h("div.btn-row", { style: { marginTop: "6px" } },
          h("button.btn.sm", { onclick: () => explainFailure(p, job) }, "What happened, and the way around it")) : null,
        job?.saveError ? h("div.note.bad", { style: { marginTop: "8px" } }, `Not copied to your folder: ${job.saveError}`) : null,
        job?.savedTo?.length ? h("div.hint", { style: { marginTop: "6px" } }, `Saved to ${folderLabel || "your folder"}: ${job.savedTo.join(", ")}`) : null,
      ),
      preview,
      lastExperiment ? h("div", { style: { padding: "8px 10px", borderTop: "1px solid var(--line)" } },
        h("button.btn.sm.primary.wide", {
          onclick: async () => {
            const lib = await import("./library.js");
            document.querySelector('.page-btn[data-page="library"]')?.click();
            setTimeout(() => lib.openExperiment(lastExperiment), 120);
          },
        }, "Compare the sweep in the Library →")) : null,
      historyStrip(p),
    ),
  );
}

/* ── The film ─────────────────────────────────────────────────
 * Two minutes is not a longer render, it is eight renders and a join. The
 * planner (film.js) decides where the clips break; this is the panel that
 * shows the decision before it costs an hour of GPU, runs it, and joins what
 * comes back.
 *
 * The run is deliberately NOT the queue. A queued item is complete before it
 * starts; clip 3 of a film cannot be, because what makes it continue from clip
 * 2 is a frame that does not exist yet.
 */
let filmRun = null;   // { id, running, step, results, assembled, error }

/* Every length the film picker offers, bounded by the model rather than by
 * taste: FILM_LIMITS is where the ceiling is argued. */
const FILM_LENGTHS = [20, 25, 30, 45, 60, 75, 90, 105, 120]
  .filter(v => v >= FILM_LIMITS.min && v <= FILM_LIMITS.max);

/* The longest single clip the length dropdown offers. Everything from H3's
 * 15 s ceiling up to here can be had EITHER way — one clip that repeats, or
 * clips that each fit — and which one you want is not something this app gets
 * to decide for you. So both directions are one button, at the control where
 * the length is chosen and at the one where the film is planned. */
const SINGLE_MAX = Math.max(...Object.keys(DURATION_FRAMES).map(Number));

/** Turn the timeline into a film of the length it is already set to. */
function makeItAFilm(seconds) {
  update((proj) => { proj.film.enabled = true; proj.film.seconds = seconds; }, "film");
  toast("Film mode on", `${seconds}s, cut into clips that each fit H3's window.`, "ok");
  refresh();
}

/** Put it back to one clip of that length — repeats and all, deliberately. */
function makeItOneClip(seconds) {
  update((proj) => { proj.film.enabled = false; proj.render.duration = seconds; }, "film");
  toast("One clip", `${seconds}s in a single render${seconds > H3_DURATION.max ? " — past H3's window, so expect the tail to repeat" : ""}.`, seconds > H3_DURATION.max ? "warn" : "ok");
  refresh();
}

function filmPanel(p) {
  const on = !!p.film?.enabled;
  const span = filmSpan(p);
  const plan = on ? planFilm(p, { span }) : null;
  const ltx = activeEngine(p) === "ltx25";
  /* Splitting at cuts is worth doing on a piece no longer than one render,
   * so on LTX the film may be as short as a single clip. */
  const lengthChoices = ltx && p.film.splitAtCuts
    ? [...new Set([...Object.keys(LTX_DURATION_FRAMES).map(Number), ...FILM_LENGTHS])].sort((a, b) => a - b)
    : (FILM_LENGTHS.includes(p.film.seconds) ? FILM_LENGTHS : [...FILM_LENGTHS, p.film.seconds].sort((a, b) => a - b));
  const busy = !!filmRun?.running;
  const health = getHealth();
  // undefined = an older Cut server with no probe. Offer the join and let the
  // 503 explain itself rather than hiding a button that probably works.
  const noFfmpeg = health?.ffmpeg === false;
  const results = filmRun?.results || [];
  const rendered = results.filter(r => r.output && !r.error);
  const blocking = plan ? plan.notes.filter(n => n.level === "err") : [];

  const set = (patch) => { update((proj) => Object.assign(proj.film, patch), "film"); refresh(); };

  const clipRow = (clip) => {
    const done = results.find(r => r.index === clip.index);
    const state = filmRun?.current === clip.index ? "busy"
      : done?.error ? "bad" : done?.output ? "ok" : "";
    const first = clip.shots[0];
    return h("div", { class: `qrow ${state === "ok" ? "done" : state === "bad" ? "error" : ""}` },
      h("div.qtop",
        h("span", { class: `badge ${state}` }, h("span.dot"), `${clip.index + 1}`),
        h("span.qname", (() => {
          const words = clip.shots.reduce((n, s) => n + (s.dialogue || []).reduce((m, l) => m + String(l.text || "").trim().split(/\s+/).filter(Boolean).length, 0), 0);
          return `${clip.seconds}s · ${clip.shots.length} shot${clip.shots.length === 1 ? "" : "s"}${words ? ` · ${words} words spoken` : ""}`;
        })()),
        h("span.spacer", { style: { flex: "1" } }),
        h("span.hint.mono", clip.trimmed ? `−${clip.trimmed}s trimmed` : `from ${clip.at}s`),
      ),
      h("div.qline", (first?.subject || "").trim() || (first?.beats?.[0]?.text || "").trim() || "—"),
      done?.error ? h("div.note.bad", { style: { marginTop: "5px" } }, done.error) : null,
    );
  };

  return h("div.panel",
    h("div.hd",
      h("span.title", "Film"),
      on && plan?.clips.length ? h("span.badge", h("span.dot"), describePlan(plan)) : null,
      h("span.spacer"),
      filmRun?.assembled ? h("span.badge.ok", h("span.dot"), "joined") : null,
    ),
    h("div.bd",
      h("div", { style: { padding: "9px 10px", borderBottom: "1px solid var(--line)" } },
        checkbox("Make this a film — several clips, cut together", on, (v) => set({ enabled: v }),
          ltx
            ? `LTX-2.5 renders up to ${LTX25_DURATION.max} seconds in one go. A film is several renders joined afterwards — or, below, one render per hard cut.`
            : `H3 generates ${H3_DURATION.min}–${H3_DURATION.max} seconds. Anything longer is several renders joined afterwards, not a longer render.`),
        on ? h("div", { style: { marginTop: "8px" } },
          ltx ? row("Cuts", checkbox("Every hard cut is its own clip, joined afterwards", !!p.film.splitAtCuts,
            (v) => set({ splitAtCuts: v }),
            "A real cut between two renders instead of one the model performs inside a clip. Rows marked \"no cut — same take\" stay inside their clip. With Continuity on, each clip starts from the last frame of the one before."),
            "LTX-2.5 only — the MiniMax planner packs shots into 15 s clips.") : null,
          row("Length", select(lengthChoices.map(v => [String(v), `${v}s${v >= 60 ? ` · ${(v / 60).toFixed(v % 60 ? 1 : 0)} min` : ""}`]),
            String(p.film.seconds), (v) => set({ seconds: Number(v) })),
            `The whole piece. Write your shots across it — the planner cuts at your cuts, never inside a shot.`),
          row("Continuity", checkbox("Start each clip on the last frame of the one before", !!p.film.continuity,
            (v) => set({ continuity: v }),
            "The only continuity H3 has across a join: it remembers nothing between prompts, so a face carries because the frame carries it."),
            canChain(p) ? "" : "Ref2V cannot be chained this way — its references carry identity instead."),
          row("Sound", segmented([["keep", "Keep"], ["mute", "Mute"]], p.film.audio || "keep", (v) => set({ audio: v })),
            "H3 writes audio per clip and cannot hear the clip before it, so room tone shifts and any score restarts at every join. Mute gives you a clean picture to score yourself."),
          /* Up to the longest single render the app offers, a film is a
           * CHOICE and not a verdict: one clip that repeats past 15 s, or
           * several that each fit. The way back out is here, next to the
           * length, rather than only in the checkbox above. */
          p.film.seconds <= SINGLE_MAX && DURATION_FRAMES[p.film.seconds]
            ? h("div.hint", { style: { marginTop: "6px" } },
                `${p.film.seconds}s is also a length a single render will take — it renders without complaining, and past `
                + `${H3_DURATION.max}s the model fills the rest by repeating itself. `,
                h("button.btn.sm.ghost", {
                  style: { marginLeft: "2px" },
                  title: `Turn film mode off and render ${p.film.seconds}s as one clip`,
                  onclick: () => makeItOneClip(p.film.seconds),
                }, "Render it as one clip instead"))
            : null,
        ) : null,
      ),
      on ? h("div", { style: { padding: "9px 10px", borderBottom: "1px solid var(--line)" } },
        h("div.btn-row",
          busy
            ? h("button.btn.wide.disabled", {}, `Rendering — ${filmRun.step || "…"}`)
            : h("button.btn.wide.record", {
                class: `btn wide record${plan?.clips.length && !blocking.length ? "" : " disabled"}`,
                title: blocking.length ? blocking[0].msg : "Render every clip in order, then join them",
                onclick: () => runTheFilm(p),
              }, plan?.clips.length ? `▶ Render ${plan.clips.length} clip${plan.clips.length === 1 ? "" : "s"}` : "Nothing to render"),
          h("button.btn", {
            class: `btn${rendered.length >= 2 && !busy ? "" : " disabled"}`,
            title: noFfmpeg
              ? (SERVER_BACKED
                ? "ffmpeg is not installed next to the local Cut app — the clips render, but nothing here can join them"
                : "Joining needs ffmpeg, which only the local Cut app with server saving has — every clip still renders")
              : "Join the rendered clips into one file",
            onclick: () => joinTheFilm(p),
          }, "⧉ Join"),
        ),
        filmRun?.error ? h("div.note.bad", { style: { marginTop: "7px" } }, filmRun.error) : null,
        noFfmpeg ? h("div.note", { style: { marginTop: "7px" } },
          SERVER_BACKED
            ? "ffmpeg is not installed next to the local Cut app. Every clip still renders and every clip is still in the Library — what is missing is the join, "
              + "and the last-frame continuity that needs the same tool."
            : "This version has no ffmpeg, so the join happens elsewhere: every clip still renders, still continues from the previous clip's last frame, and still lands "
              + "in the Library — download them and join them in any editor, or run the local Cut app with server saving on and it joins them for you.") : null,
        ...(plan?.notes || []).filter(n => n.level !== "info").map(n =>
          h("div", { class: `note ${n.level === "err" ? "bad" : "warn"}`, style: { marginTop: "7px" } }, n.msg)),
        ...(plan?.notes || []).filter(n => n.level === "info").map(n =>
          h("div.hint", { style: { marginTop: "7px" } }, n.msg)),
      ) : null,
      on && plan?.clips.length
        ? h("div", { style: { padding: "8px 10px", maxHeight: "260px", overflow: "auto" } }, ...plan.clips.map(clipRow))
        : null,
      filmRun?.assembled
        ? h("div", { style: { padding: "9px 10px", borderTop: "1px solid var(--line)" } },
            h("video", {
              src: api.filmUrl(filmRun.assembled.id), controls: "", playsinline: "",
              style: { width: "100%", borderRadius: "6px", background: "#000" },
            }),
            h("div.hint", { style: { marginTop: "6px" } },
              `${filmRun.assembled.clips} clips · ${(filmRun.assembled.bytes / 1048576).toFixed(1)} MB`
              + (filmRun.assembled.encoded ? " · re-encoded (the clips did not share a codec)" : " · stream copy, nothing re-encoded")),
            h("div.btn-row", { style: { marginTop: "6px" } },
              h("a.btn.sm", { href: api.filmUrl(filmRun.assembled.id), download: `${filmRun.assembled.name}.mp4` }, "⬇ Download")),
          )
        : null,
      !on ? h("div.empty-state.tight",
        h("div.hint", ltx
          ? `LTX-2.5 renders up to ${LTX25_DURATION.max}s in one go. Tick the box for something longer, or to render every hard cut as its own clip.`
          : `One clip is ${H3_DURATION.min}–${H3_DURATION.max}s because that is what H3 generates — past it the model repeats itself. Tick the box to write something longer and have it cut into clips that each fit.`)) : null,
    ),
  );
}

async function runTheFilm(p) {
  if (filmRun?.running) return;
  const plan = planFilm(p, { span: filmSpan(p) });
  if (!plan.clips.length) return toast("Nothing to render", "Write some shots first.", "");
  const blocking = plan.notes.filter(n => n.level === "err");
  if (blocking.length) return toast("Cannot cut this into clips", blocking[0].msg, "err");

  // Per clip, not the project's own length — a film's clips are 5, 10 or 15 s
  // whatever the length dropdown happens to be sitting on.
  const secs = plan.clips.reduce((n, c) => n + estimateSeconds({ ...p, render: { ...p.render, duration: c.seconds } }), 0);
  const mins = Math.max(1, Math.ceil(secs / 60));
  if (!(await okToSubmit(p, { verb: `Render ${plan.clips.length} clips`, cost: `roughly ${mins} minute${mins === 1 ? "" : "s"} of GPU, unattended` }))) return;

  filmRun = { id: null, running: true, step: "starting…", current: 0, results: [], assembled: null, error: null };
  refresh();
  try {
    const out = await runFilm(p, plan, {
      continuity: !!p.film?.continuity,
      onStep: (msg, index) => { filmRun.step = msg; filmRun.current = index; refresh(); },
      onClip: (r) => { filmRun.results = [...filmRun.results.filter(x => x.index !== r.index), r]; refresh(); },
    });
    filmRun.id = out.filmId;
    filmRun.results = out.clips;
    filmRun.running = false;
    filmRun.current = -1;
    if (out.failed) {
      filmRun.error = `Clip ${out.failed.index + 1} stopped the film: ${out.failed.error}`;
      toast("Film stopped", filmRun.error, "err");
    } else {
      toast("Clips rendered", `${out.clips.length} of them. Join them into one file when you are happy.`, "ok");
      // Nothing to decide here — the clips are rendered and the join is
      // cheap. Doing it unasked is what makes this a film rather than a
      // folder of clips.
      await joinTheFilm(p);
    }
  } catch (err) {
    filmRun.running = false;
    filmRun.error = err.message;
    toast("Film stopped", err.message, "err");
  }
  refresh();
}

async function joinTheFilm(p) {
  const results = filmRun?.results || [];
  const rendered = results.filter(r => r.output && !r.error);
  if (rendered.length < 2) return toast("Not enough clips", "Two rendered clips are the minimum for a join.", "");
  filmRun.step = "joining…";
  refresh();
  try {
    filmRun.assembled = await assembleFilm(rendered, {
      name: p.name || "film",
      audio: p.film?.audio || "keep",
      filmId: filmRun.id || undefined,
    });
    toast("Film joined", `${filmRun.assembled.clips} clips in one file.`, "ok");
  } catch (err) {
    // The no-ffmpeg answer already says which version can join and that every
    // clip is safe in the Library — both backends word it for their own case.
    filmRun.error = err.message;
    toast("Could not join the clips", filmRun.error, "err");
  }
  filmRun.step = "";
  refresh();
}

/* ── The queue ────────────────────────────────────────────────
 * One GPU, one render at a time — which the app already enforced, leaving you
 * to sit here holding the second clip in your head. The queue is where it goes
 * instead, and this is where it is run.
 */
/* ── Download folder ─────────────────────────────────────────
 * Where finished clips are copied on THIS machine, on top of ComfyUI's own
 * copy. Chrome and Edge let a page keep a folder the user picked; the row
 * says so where they cannot. */
let folderLabel = null;
downloads.folderName().then(n => { folderLabel = n; refresh(); });
downloads.onFolderChange(() => downloads.folderName().then(n => { folderLabel = n; refresh(); }));

function downloadFolderRow() {
  if (!downloads.supported()) {
    return row("Download folder", h("span.hint", "Not in this browser"),
      "Chrome and Edge can hand a page a folder to save into; here, the ⬇ button on a finished clip downloads it the ordinary way.");
  }
  const choose = async () => {
    try { await downloads.chooseFolder(); toast("Download folder set", await downloads.folderName(), "ok"); }
    catch (err) { if (err.name !== "AbortError") toast("No folder chosen", err.message, "err"); }
  };
  return row("Download folder", folderLabel
    ? h("div.flex", { style: { gap: "5px" } },
        h("span.hint.mono.grow", { title: "Every finished clip is copied here" }, folderLabel),
        h("button.btn.sm.ghost", { title: "Pick a different folder", onclick: choose }, "Change"),
        h("button.btn.sm.ghost", { title: "Stop copying clips here (ComfyUI keeps its own)", onclick: async () => { await downloads.clearFolder(); toast("Download folder cleared", "", "ok"); } }, "✕"))
    : h("button.btn.sm", { onclick: choose }, "Choose a folder…"),
    "Every clip that finishes is copied into this folder, named as ComfyUI named it. ComfyUI keeps its own copy in its output folder regardless.");
}

function queuePanel() {
  const items = listQueue();
  const running = isQueueRunning();
  const waiting = items.filter(i => i.status === "waiting").length;

  const row = (item, i) => h("div", { class: `qrow ${item.status}` },
    h("div.qtop",
      h("span", { class: `badge ${item.status === "done" ? "ok" : item.status === "error" ? "bad" : item.status === "running" ? "busy" : ""}` },
        h("span.dot"), item.status === "waiting" ? `${i + 1}` : item.status),
      h("span.qname", item.label || item.summary.name),
      h("span.spacer", { style: { flex: "1" } }),
      h("span.hint.mono", `${MODES[item.summary.mode]?.short || item.summary.mode} · ${item.summary.duration}s · ${item.summary.shots} shot${item.summary.shots === 1 ? "" : "s"}`),
    ),
    item.summary.line ? h("div.qline", item.summary.line) : null,
    item.error ? h("div.note.bad", { style: { marginTop: "5px" } }, item.error) : null,
    h("div.btn-row", { style: { marginTop: "5px" } },
      h("button.btn.sm.ghost", {
        title: "Open this snapshot in the editor. It replaces what you have open.",
        class: `btn sm ghost${running ? " disabled" : ""}`,
        onclick: () => {
          if (!confirm("Open this queued clip? It replaces the project you have open.")) return;
          openQueued(item.id);
          toast("Opened", item.label || item.summary.name, "ok");
          refresh();
        },
      }, "Open"),
      item.status === "waiting" && !running ? h("button.btn.sm.ghost", { title: "Move up", onclick: () => { moveInQueue(item.id, -1); refresh(); } }, "↑") : null,
      item.status === "waiting" && !running ? h("button.btn.sm.ghost", { title: "Move down", onclick: () => { moveInQueue(item.id, 1); refresh(); } }, "↓") : null,
      item.status === "error" || item.status === "done"
        ? h("button.btn.sm.ghost", { title: "Put it back in the line", onclick: () => { requeue(item.id); refresh(); } }, "↻ Again")
        : null,
      h("span.spacer", { style: { flex: "1" } }),
      running && item.status === "running" ? null : h("button.btn.sm.ghost", {
        title: "Take it off the queue",
        onclick: () => { removeFromQueue(item.id); refresh(); },
      }, "✕"),
    ),
  );

  return h("div.panel",
    h("div.hd",
      h("span.title", "Queue"),
      waiting ? h("span.badge", h("span.dot"), `${waiting} waiting`) : null,
      h("span.spacer"),
      items.length ? h("button.btn.sm.ghost", {
        title: "Remove everything that has already run",
        onclick: () => { clearQueue({ doneOnly: true }); refresh(); },
      }, "Clear finished") : null,
    ),
    h("div.bd",
      running || waiting ? h("div", { style: { padding: "9px 10px", borderBottom: "1px solid var(--line)" } },
        h("div.btn-row",
          running
            ? h("button.btn.wide.disabled", {}, `Running — ${queueStatus || "…"}`)
            : h("button.btn.wide.record", {
                title: "Render everything waiting, in order",
                onclick: () => runTheQueue(),
              }, `▶ Run ${waiting} render${waiting === 1 ? "" : "s"}`),
        ),
        h("div.hint", { style: { marginTop: "6px" } },
          "A queued clip is a snapshot — carry on editing and what runs is still what you queued. "
          + "The files it points at are not copied, so removing a picture from the pool before its render runs will fail that one."),
      ) : null,
      items.length
        ? h("div", { style: { padding: "8px 10px" } }, ...items.map(row))
        : h("div.empty-state",
            h("div.ico", "≡"),
            h("div.t", "Nothing queued"),
            h("div.hint", "＋ Queue puts a snapshot of this clip in line — here, on the canvas's Render node, or at the end of Create.")),
    ),
  );
}

let queueStatus = "";

/** Put a project on the queue, from anywhere, with one message. */
export async function queueThis(project = getProject(), label = "") {
  const report = validate(project);
  if (report.pristine) return toast("Nothing to queue", "Write a shot first.", "");
  // A queued item is a snapshot: whatever is wrong with it now is what runs
  // later, unattended, with nobody watching to stop it.
  if (!(await okToSubmit(project, { verb: "Queue", cost: "a slot in an unattended run" }))) return;
  const item = enqueue(project, { label });
  if (!item) return toast("The queue is full", "Run or clear some of it first.", "warn");
  toast("Queued", `${item.label || item.summary.name} — ${listQueue().filter(i => i.status === "waiting").length} waiting. Run it from Deliver.`, "ok");
  refresh();
  return item;
}

async function runTheQueue() {
  try {
    const r = await runQueue({ onStep: (m) => { queueStatus = m; refresh(); } });
    queueStatus = "";
    toast("Queue finished", `${r.done} rendered${r.failed ? `, ${r.failed} failed` : ""}.`, r.failed ? "warn" : "ok");
  } catch (err) {
    queueStatus = "";
    toast("Queue stopped", err.message, "err");
  }
  refresh();
}

function historyStrip(p) {
  const jobs = p.jobs || [];
  if (!jobs.length) return h("div.history-empty", h("div.hint", "Finished renders land here, newest first."));
  return h("div", { style: { flex: "0 0 auto", maxHeight: "168px", overflow: "auto", borderTop: "1px solid var(--line)" } },
    ...jobs.map(j => h("div.job",
      h("div.top",
        h("span", { class: `badge ${j.status === "done" ? "ok" : j.status === "error" ? "bad" : ""}` }, h("span.dot"), j.status),
        h("span.name", `${j.mode?.toUpperCase()} · ${j.meta?.variantLabel || ""} · ${j.meta?.numFrames || "?"}f`),
        h("span.time", new Date(j.at).toLocaleTimeString()),
        j.outputs?.[0] ? h("button.btn.sm", {
          onclick: () => window.open(api.viewUrl(j.outputs[0]), "_blank"),
        }, "Open") : null,
        j.outputs?.[0] ? h("button.btn.sm.ghost", {
          title: folderLabel ? `Save into ${folderLabel}` : "Download",
          onclick: async () => {
            try {
              if (await downloads.folder()) { const name = await downloads.saveOutput(j.outputs[0]); toast("Saved", `${name} → ${folderLabel}`, "ok"); }
              else await downloads.downloadOutput(j.outputs[0]);
            } catch (err) { toast("Could not save the clip", err.message, "err"); }
          },
        }, "⬇") : null,
        j.promptText ? h("button.btn.sm.ghost", {
          title: "The prompt and settings that made this clip",
          onclick: () => showJobPrompt(j),
        }, "ⓘ") : null,
      ),
      h("div.hint.mono", `seed ${j.meta?.seed ?? "?"} · ${j.settingsSnapshot?.resolution || ""} · ${j.meta?.steps || "?"} steps${j.tookMs ? ` · took ${humanTime(j.tookMs / 1000)}` : ""}`),
      j.error ? h("div.hint.bad", j.error) : null,
    )),
  );
}

/* ── Right: the graph itself ──────────────────────────────── */
function workflowPanel(p) {
  let built = null;
  let error = null;
  try { built = buildWorkflow(p, getSettings() || { models: {} }); }
  catch (err) { error = err.message; }

  const json = built ? JSON.stringify(built.prompt, null, 2) : "";
  const nodeCount = built ? Object.keys(built.prompt).length : 0;
  const health = getHealth();
  const missing = health.nodes?.missing || [];

  return h("div.panel",
    h("div.hd", h("span.title", "Workflow"), h("span.spacer"),
      h("span.hint", `${nodeCount} nodes`),
      h("button.btn.sm", { onclick: async () => { await copyText(json); toast("Workflow copied", "", "ok"); } }, "Copy"),
      h("button.btn.sm", { onclick: () => doDownload(p) }, "⬇"),
    ),
    h("div.bd.pad",
      error ? h("div.note.bad", error) : null,
      built ? h("div.kv", { style: { marginBottom: "10px" } },
        h("span.k", "engine"), h("span.v", built.meta.engine === "ltx25" ? "LTX-2.5 (experimental)" : "MiniMax H3"),
        h("span.k", "model"), h("span.v", built.meta.dit),
        built.meta.lora ? h("span.k", "lora") : null, built.meta.lora ? h("span.v", built.meta.lora) : null,
        h("span.k", "sampling"), h("span.v", `${built.meta.sampler} · ${built.meta.scheduler} · ${built.meta.steps} steps`
          + (built.meta.shiftVideo != null ? ` · shift ${built.meta.shiftVideo}/${built.meta.shiftAudio}` : ` · ${built.meta.stages === 2 ? "two-stage, 2× latent upscale" : "single-stage"}`)
          + (built.meta.tiledDecode ? " · tiled decode" : "")),
        h("span.k", "seed"), h("span.v", String(built.meta.seed)),
        built.meta.upscale ? h("span.k", "upscale") : null,
        built.meta.upscale ? h("span.v", `${{ seedvr2: "SeedVR2", flashvsr: "FlashVSR", ltx25: "LTX-2.5 refine ×2", esrgan: "ESRGAN ×4" }[built.meta.upscale.engine]} → ${built.meta.upscale.width}×${built.meta.upscale.height}`) : null,
        built.meta.guides?.length ? h("span.k", "pins") : null,
        built.meta.guides?.length ? h("span.v", built.meta.guides.map(g => `${g.at}s @ ${g.strength}`).join(" · ")) : null,
        h("span.k", "nodes"), h("span.v", `${nodeCount} · ${built.meta.nodeTypes.length} types · ${built.meta.upscale?.engine === "seedvr2" ? "core + SeedVR2 pack" : built.meta.upscale?.engine === "flashvsr" ? "core + FlashVSR pack" : built.meta.stockNodesOnly === false ? "core + LTX-2 AV" : "stock only"}`),
      ) : null,
      built?.meta.droppedPins ? h("div.hint.bad", { style: { marginBottom: "8px" } },
        `${built.meta.droppedPins} pin${built.meta.droppedPins === 1 ? "" : "s"} dropped — over the ${LTX_MAX_ANCHORS}-guide cap or landing on an already-pinned frame`) : null,

      built?.meta.inputs?.length ? h("div", { style: { marginBottom: "9px" } },
        h("h4.sec", "Input files"),
        ...built.meta.inputs.map(i => h("div.flex", { style: { marginBottom: "3px" } },
          h("span", { class: `badge ${i.media?.comfyName ? "ok" : "busy"}` }, h("span.dot"), i.media?.comfyName ? "in ComfyUI" : "local only"),
          h("span.hint.mono.grow", `${i.role}: ${i.name || "— nothing attached —"}`),
        )),
        h("div.hint", { style: { marginTop: "5px" } },
          "Render uploads these automatically. For the download path, drop them into ComfyUI/input under exactly these names."),
      ) : null,

      built?.meta.engine !== "ltx25" && missing.length ? h("div.note.bad",
        h("b", "Missing nodes: "), missing.join(", "),
        " — this ComfyUI cannot run the graph yet. Setup ▸ ComfyUI lists what each one is for.") : null,
      built?.meta.engine === "ltx25" && health.nodes?.ltxMissing?.length ? h("div.note.bad",
        h("b", "Missing LTX nodes: "), health.nodes.ltxMissing.join(", "),
        " — this ComfyUI cannot run the experimental LTX-2.5 graph yet. It needs a build with LTX-2 AV support; the MiniMax engine is unaffected.") : null,
      built?.meta.engine === "ltx25" && health.nodes && health.nodes.ltx25Support === false ? h("div.note.bad",
        h("b", "No LTX-2.5 core support: "),
        "this ComfyUI's CLIPLoader has no \"ltxv\" type, so the Gemma 4 encoder would load as a plain chat model and prompt encoding fails. Update ComfyUI.") : null,

      more(`API-format graph · ${(json.length / 1024).toFixed(0)} KB`,
        h("pre.code", { style: { maxHeight: "46vh" } }, json.length > 40000 ? `${json.slice(0, 40000)}\n… (${json.length} chars total — download for the whole graph)` : json)),
    ),
  );
}

/* ── Actions ──────────────────────────────────────────────── */
async function doDownload(p) {
  // The workflow file is this app's portable deliverable — the thing somebody
  // carries to a machine with a GPU. An error discovered there costs a trip.
  if (!(await okToSubmit(p, { verb: "Download", cost: "a trip to the render box" }))) return;
  try {
    const { prompt, meta } = buildWorkflow(p, getSettings() || { models: {} });
    const slug = (p.name || "timeline").replace(/[^\w-]+/g, "_").slice(0, 40);
    download(`${slug}_${p.mode}_${meta.width}x${meta.height}.json`, JSON.stringify(prompt, null, 2));
    toast("Workflow downloaded", "API format — ComfyUI's Open detects it, or POST it to /prompt.", "ok");
  } catch (err) { toast("Could not build the graph", err.message, "err"); }
}

/* ── Will it fit on the card? ──────────────────────────────── */
const gb = (n) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10);

/** One line under the render settings: the wall-clock guess, and — for
 *  MiniMax H3, where we have a model of it — how much of the card the
 *  render needs. Amber when the DiT will have to page, red when it will
 *  not fit at all. */
function fitLine(p, eta, fit) {
  const time = `Rough estimate: ${humanTime(eta)}`;
  if (!fit) return h("div.hint", { style: { marginTop: "8px" } }, `${time} on a 24 GB card.`);
  const tokens = `≈${Math.round(fit.tokens / 1000)}k tokens through the DiT`;
  if (fit.verdict === "unknown") {
    return h("div.hint", { style: { marginTop: "8px" } }, `${time} · about ${gb(fit.needGB)} GB of VRAM at peak (${tokens}) — ComfyUI is offline, so the card size is unknown.`);
  }
  const need = `needs about ${gb(fit.needGB)} of the card's ${gb(fit.cardGB)} GB`;
  if (fit.verdict === "ok") return h("div.hint", { style: { marginTop: "8px" } }, `${time} · ${need} (${tokens}).`);
  if (fit.verdict === "tight") {
    return h("div.hint.warn", { style: { marginTop: "8px" } },
      `${time} · ${need} (${tokens}). Fits, but the DiT cannot stay resident, so it will page weights every step and run slower.`);
  }
  const levers = vramLevers(p, fit);
  return h("div.hint.bad", { style: { marginTop: "8px" } },
    `${time} · ${need} (${tokens}) — this will not fit.${levers.length ? ` What would bring it back: ${levers.join(", ")}.` : ""}`);
}

/** The pre-render gate for VRAM. Only a hard "no" interrupts — a tight fit
 *  is slow, not broken, and the line under the settings already says so. */
async function okForVram(p, { verb = "Render" } = {}) {
  const fit = estimateVram(p, { cardGB: getHealth()?.comfy?.vramTotalGB || null });
  if (!fit || fit.verdict !== "no") return true;
  const levers = vramLevers(p, fit);
  return !!(await modal({
    title: `${verb} anyway?`,
    body: h("div",
      h("div.note.bad", "This render probably will not fit on the card."),
      h("div.hint", `Needs about ${gb(fit.needGB)} GB of VRAM at peak — ≈${Math.round(fit.tokens / 1000)}k tokens through the DiT on the ${fit.precision === "nvfp4" ? "NVFP4" : "int8"} build — and ComfyUI reports a ${gb(fit.cardGB)} GB card.`),
      h("div.hint", "ComfyUI would spend the load time, then stop on the first sampling step with an out-of-memory error."),
      levers.length ? h("div.hint", { style: { marginTop: "8px" } }, `What would bring it back: ${levers.join(", ")}.`) : null,
      h("div.hint.faint", { style: { marginTop: "8px" } }, "The estimate is rough. If you know this machine fits it, go ahead."),
    ),
    actions: [
      { label: "Change it first", onClick: (done) => done(false) },
      { label: `${verb} anyway`, kind: "record", onClick: (done) => done(true) },
    ],
  }));
}

/**
 * The checks, at every door a graph leaves by.
 *
 * There are four — render, download the JSON, queue it, sweep it — and only
 * the first one asked. So the length ceiling, the reference caps and every
 * other error were enforced on the button that costs one render and silently
 * skipped on the button that queues twelve, on the sweep that submits N, and
 * on the workflow file that is this app's stated portable deliverable. A
 * check worth showing is worth showing on all four.
 *
 * It confirms rather than blocks: the errors are about what H3 will do with
 * the prompt, and somebody deliberately testing an edge of the model is
 * entitled to. Returns true if the caller should go ahead.
 */
async function okToSubmit(p, { verb = "Render", cost = "" } = {}) {
  if (!(await okForVram(p, { verb }))) return false;
  const report = validate(p);
  if (!report.errors) return true;
  return !!(await modal({
    title: `${verb} anyway?`,
    body: h("div",
      h("div.note.bad", `${report.errors} error${report.errors === 1 ? "" : "s"} in the prompt check.`),
      ...report.checks.filter(c => c.level === "err").map(c => h("div.hint", `• ${c.msg}`)),
      h("div.hint", { style: { marginTop: "8px" } },
        `Nothing here blocks it — but every one of them costs ${cost || "GPU time"} to discover.`),
    ),
    actions: [
      { label: "Fix it first", onClick: (done) => done(false) },
      { label: `${verb} anyway`, kind: "record", onClick: (done) => done(true) },
    ],
  }));
}

/* A failed job, read for the user. The one failure the app can route
 * around is ComfyUI being refused at save time: the whole clip rendered,
 * only the write into the output subfolder was denied. Offer the flat
 * name at the top of the output folder and render again. */
async function explainFailure(p, job) {
  const why = job.errorInfo || { kind: "other", title: "Render failed", message: job.error };
  if (why.kind !== "save-permission") return toast(why.title || "Render failed", why.message, "err");
  const again = await modal({
    title: why.title,
    body: h("div",
      h("div.note.bad", why.message),
      h("div.hint", { style: { marginTop: "8px" } }, "Fix it for good in a terminal on the ComfyUI machine:"),
      h("pre.code", why.fix),
      h("div.hint", { style: { marginTop: "8px" } }, why.fallback),
    ),
    actions: [
      { label: "Leave it", onClick: (done) => done(false) },
      { label: "Save at top level and render again", kind: "record", onClick: (done) => done(true) },
    ],
  });
  if (!again) return;
  await saveSettings({ comfy: { flatOutput: true } });
  refresh();
  await doRender(p);
}

async function doRender(p) {
  if (!(await okToSubmit(p, { verb: "Render" }))) return;
  try {
    statusLine = "";
    const job = await renderNow({ onStep: (msg) => { statusLine = msg; refresh(); } });
    if (job?.status === "error") await explainFailure(p, job);
    else if (job?.saveError) toast("Rendered, but not copied to your folder", job.saveError, "err");
    else if (job?.savedTo?.length) toast("Render finished", `Saved ${job.savedTo.join(", ")} to ${await downloads.folderName()}`, "ok");
    else toast("Render finished", "", "ok");
  } catch (err) {
    if (err.message !== "cancelled") toast("Render failed", err.message, "err");
  } finally {
    statusLine = "";
    refreshVram();
    refresh();
  }
}

function showJobPrompt(job) {
  const s = job.settingsSnapshot || {};
  return modal({
    title: `${job.mode?.toUpperCase()} · ${new Date(job.at).toLocaleString()}`,
    wide: true,
    body: h("div",
      h("div.hint.mono", { style: { marginBottom: "8px" } },
        `${s.engine === "ltx25" ? "LTX-2.5 · " : ""}${s.resolution || ""} · ${s.duration || "?"}s · ${job.meta?.variantLabel || ""} · ${job.meta?.steps || "?"} steps · seed ${job.meta?.seed}`
        + (s.engine === "ltx25" ? "" : ` · ${s.precision || "int8"}`)),
      h("pre.code", { style: { maxHeight: "52vh" } }, job.promptText || ""),
    ),
    actions: [
      { label: "Copy prompt", onClick: async (done) => { await copyText(job.promptText || ""); toast("Copied", "", "ok"); done(null); } },
      {
        label: "Restore these settings", kind: "primary",
        onClick: (done) => {
          update((proj) => {
            proj.mode = s.mode || proj.mode;
            Object.assign(proj.render, {
              resolution: s.resolution || proj.render.resolution,
              duration: s.duration || proj.render.duration,
              // Jobs from before the second engine carry no engine field, and
              // every one of them rendered on MiniMax — restore that, not
              // whatever the project happens to be set to now.
              engine: s.engine || "minimax",
              variant: s.variant || proj.render.variant,
              seed: s.seed ?? proj.render.seed,
              precision: s.precision || proj.render.precision,
              refImageSize: s.refImageSize || proj.render.refImageSize,
              tiledDecode: !!s.tiledDecode,
            });
          }, "render");
          toast("Settings restored", "The seed is pinned to that run — randomise it for a new take.", "ok");
          refresh();
          done(null);
        },
      },
    ],
  });
}

/* One variable, N values, the same seed. The dialog exists to make the shape of
 * the question obvious before it costs ten minutes of GPU. */
async function doSweep(p) {
  const vars = variablesFor(p);
  let chosen = vars[0];
  let picked = new Set(valuesFor(chosen, p).selected);

  const body = h("div");
  const paint = () => {
    const { all } = valuesFor(chosen, p);
    const estimate = sweepCost([...picked], estimateSeconds(p));
    mount(body,
      h("div.note.info", { style: { marginTop: 0 } },
        h("b", "Change one thing, hold the rest still. "),
        "The seed is pinned for the whole sweep and restored afterwards, because a sweep whose seed moves is a mood board, not an experiment."),
      h("div.i-row", h("label.i-label", "Variable"),
        select(vars.map(v => [v.id, v.label]), chosen.id, (id) => {
          chosen = variableById(id);
          picked = new Set(valuesFor(chosen, p).selected);
          paint();
        })),
      chosen.scope === "shot"
        ? h("div.hint", { style: { marginBottom: "8px" } }, `Applies to the selected shot — ${(selectedShot(p)?.subject || "shot 1").slice(0, 40)}.`)
        : null,
      chosen.freeform
        ? h("div",
            h("label.i-label", "Seeds"),
            h("input", {
              type: "text", value: [...picked].join(", "),
              oninput: (e) => { picked = new Set(e.target.value.split(/[,\s]+/).filter(Boolean)); },
            }),
            h("div.hint", { style: { marginTop: "4px" } }, "Comma-separated. Four is usually enough to tell a fluke from a habit."))
        : h("div.flex.wrap",
            ...all.map((v) => {
              const value = String(Array.isArray(v) ? v[0] : v);
              return h("span", {
                class: `chip${picked.has(value) ? " on" : ""}`,
                onclick: () => { picked.has(value) ? picked.delete(value) : picked.add(value); paint(); },
              }, labelOf(chosen, value, p));
            })),
      h("div.hint", { style: { marginTop: "10px" } },
        `${estimate.runs} render${estimate.runs === 1 ? "" : "s"} · roughly ${humanTime(estimate.seconds)} in total.`),
    );
  };
  paint();

  const go = await modal({
    title: "Sweep one variable", wide: true, body,
    actions: [
      { label: "Cancel", onClick: (done) => done(false) },
      { label: "Run the sweep", kind: "primary", onClick: (done) => done(true) },
    ],
  });
  if (!go || !picked.size) return;
  if (!(await okToSubmit(p, { verb: "Sweep", cost: `${picked.size} renders` }))) return;

  try {
    statusLine = "";
    const { experimentId } = await runSweep({
      variableId: chosen.id,
      values: [...picked],
      onStep: (msg) => { statusLine = msg; refresh(); },
      onEach: (value, job) => toast(`${labelOf(chosen, value, p)} done`, job.error || "", job.error ? "err" : "ok"),
    });
    toast("Sweep finished", "Open it in the Library to compare them side by side.", "ok");
    lastExperiment = experimentId;
  } catch (err) {
    if (err.message !== "cancelled") toast("Sweep stopped", err.message, "err");
  } finally {
    statusLine = "";
    refreshVram();
    refresh();
  }
}

let lastExperiment = null;

/* The sweep that produced the "Compare in the Library →" button belongs to the
 * project it swept. Left standing, it offered a fresh project a comparison of
 * somebody else's renders. */
onProjectSwap(() => { lastExperiment = null; });

async function doBatch(p) {
  const count = await modal({
    title: "Render variations",
    body: h("div",
      h("div.note.info", { style: { marginTop: 0 } },
        "The same prompt, several seeds, queued back to back. H3's variance between seeds is large enough that one clip is a sample rather than a result — three is usually where a prompt starts telling the truth."),
      h("div.hint", `Rough estimate: ${humanTime(estimateSeconds(p))} each.`),
    ),
    actions: [2, 3, 4, 6].map(n => ({ label: `${n}×`, kind: n === 3 ? "primary" : "", onClick: (done) => done(n) })),
  });
  if (!count) return;
  if (!(await okToSubmit(p, { verb: "Run", cost: `${count} renders` }))) return;
  try {
    statusLine = "";
    const jobs = await renderBatch(count, {
      onStep: (msg) => { statusLine = msg; refresh(); },
      onEach: (job, i) => toast(`Variation ${i + 1} done`, job.error || "", job.error ? "err" : "ok"),
    });
    toast("Batch finished", `${jobs.length} variations.`, "ok");
  } catch (err) {
    if (err.message !== "cancelled") toast("Batch stopped", err.message, "err");
  } finally {
    statusLine = "";
    refreshVram();
    refresh();
  }
}

function draw() {
  const p = getProject();
  mount(root, h("div.cols", settingsPanel(p), renderPanel(p), h("div.rows", filmPanel(p), queuePanel(p), workflowPanel(p))));
}

export function render(el) {
  root = el;
  if (!unsub) unsub = onRenderChange((job, kind) => { if (root && root.classList.contains("active")) applyLive(root, job, kind, draw); });
  // The queue is filled from other pages, so this page has to hear about it.
  if (!unsubQueue) unsubQueue = onQueueChange(() => { if (root && root.classList.contains("active")) draw(); });
  draw();
}
export function refresh() { if (root) draw(); }
export { doRender, doDownload };
