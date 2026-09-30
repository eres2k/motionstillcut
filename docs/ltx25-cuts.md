# LTX-2.5: where the cuts come from

What 21 scored renders on the distilled checkpoint and a controlled rerun on
dev weights say about making LTX-2.5 cut, measured rather than read from the
prompting guide. This file is the permanent version of a finding that spent
its first month in an email thread; it is what `web/js/steer.js` and
`web/js/prompt.js` are steered by, and what the harness in `scripts/` exists
to reproduce.

Everything here is one machine (RTX 5090, ComfyUI, stock LTX-2 AV nodes), one
prompt chain — the app's own compiler, not a hand-typed approximation — and
fixed seeds. External reproduction is worth more than another 21 renders from
this box; [reproducing it](#reproducing-any-of-this) takes two scripts.

## The finding, in two lines

**The model keeps every seam you write.** In all 21 renders it placed a seam
at nearly every authored cut, three to seven per clip. What the prompt decides
is whether a seam lands as a hard cut or as a dissolve — not whether it lands
at all.

**Resolution is what turns dissolves into cuts.** Not the prompt, and not the
refine pass as such. Authored structure survives; you steer its hardness.

## The asymmetry between the two checkpoints

This is the part that changes how the two-stage pipeline should be described,
and it only became visible once the same prompt ran on both checkpoints.

| | how the seams harden |
|---|---|
| **distilled** (8-step, or 8+3 two-stage) | resolution arrives **through the refine pass**. Single-stage at 480p is the one configuration in the whole corpus that loses authored structure — four dissolves. The same prompt and seed through the 8+3 two-stage at 768p gives three clean hard cuts. |
| **dev** (22b, 20 steps, single full-resolution pass) | resolution arrives **directly**, no refine pass required. 832×480 gives brief dissolves; 960×544 — same prompt, same seed, same settings — gives three clean hard cuts at the same positions; 1344×768 at 10 s gives the strongest cut scores of the campaign. |

So the honest description of the two-stage build is **not** "distilled is
faster". It is **distilled is where the cut lives**: on that checkpoint the
refine pass is how you reach the resolution that hardens a seam, which makes
two-stage a product decision rather than only a speed one.

And the outlier is worth naming, because it is the default a new user hits
first: **distilled single-stage at 480p** is the configuration that dissolves
authored seams. Dev keeps them at every working setting.

## Texture: there is no sweet spot on raw dev

Single-pass raw 2.5-dev holds your seams at every working setting and never
quite looks like footage at any of them.

| cfg | seams | texture |
|---|---|---|
| **1** | six spurious cuts at 480p — content instability, not authored seams | muddy; the prompt itself stops holding (the editing room renders as something like a caravan cab) |
| **3** | the three authored seams, clean hard cuts (4.17 @0.46, 8.88 @0.59, 14.71 @0.70) | least bad, and in *still frames* it briefly passes as video — but in motion it still reads oil-painting |
| **4** | the same three seams at the same positions (0.48 / 0.62 / 0.69) | waxy, watercolour — "CFG burn" |

Two things follow.

**cfg 1 is correct for distilled and wrong for dev.** The distill is guidance
distillation with the CFG baked in, which is why the template ships cfg 1.
Rerunning a distilled corpus on dev while holding cfg 1 would not have been
biased — it would have been noise. Swap the checkpoint and you must move cfg
with it, or you change two things at once.

**The plastic look at cfg 3–4 is a missing ingredient, not a dev regression.**
The cfg 4 reference comes from the 2.0 Full workflow — and that workflow does
not run raw dev: it blends a **distilled LoRA at 0.6** into the checkpoint.
2.5 cannot replicate this, because its distill is a separate transformer and
no equivalent LoRA is published. That is provenance worth having before
anyone files the texture as a quality regression: on this build, texture
quality lives in the distill+refine.

Stills undersell this failure mode. Judge it in motion.

## What makes a seam land as a cut

From the corpus, one variable at a time:

- **A spoken line in every shot** anchors cuts. The same four-shot piece cut
  at every seam with a sentence per shot and small camera moves; with the
  whole line in shot 1 and a big two-axis move it dissolved through them
  instead (6 of 7 renders).
- **A cutaway to a different subject** (waves, gulls, boots) cuts reliably
  even with no speech at all. One silent subject travelling through connected
  spaces is what the model traverses rather than cuts — it is trained for
  temporal continuity, and a journey is continuity.
- **A different angle and camera move per shot**, with the new shot
  re-established in full rather than continued, and the cut named in prose.
- **Verbosity is not the cause.** Compact guide-style prose of the same
  content dissolved the same way. The model is not losing the instruction in
  the noise.

Create's generator is steered by all of the above, and the checker flags the
"silent cuts", "only shot 1 speaks" and "single-stage with cuts" cases.

## A defect for engineering: the int8 dev token ceiling

**The `int8-convrot` dev transformer renders solid black above roughly 31k
video tokens, with a NaN audio latent as the canary.**

| resolution × duration | ≈ video tokens | result |
|---|---|---|
| 1344×768 × 10 s | ~30k | renders normally |
| 960×544 × 20 s | ~31k | renders normally |
| 1344×768 × 20 s | ~61k | **solid black**; audio latent NaN, rejected by the AAC encoder with `avcodec_send_frame` EINVAL |

Reproduces across both cfg values and both samplers, same seed, same prompt,
same graph — only the latent size changes. **Not the scheduler:** the
stretched sigma ladders are near-identical across these sizes, computed
rather than assumed. It smells like a numeric range problem in the quant.

Practical consequence: nobody on the int8 build can reproduce the corpus's
768p × 20 s two-stage config on dev at all. 20 s clips are fine to ~960×544;
768p needs ≤ ~10 s.

## Reproducing any of this

Both scripts are in the repo and run against your own ComfyUI.

```
node scripts/render-test.mjs --prompt web/public/ltx-hardcut-test-prompt.txt \
  --label mytest --duration 20 --resolution 960x544 --variant ltx_single --seed 4242
python3 scripts/scenes.py /opt/ComfyUI/output/render-test/mytest*.mp4
```

`render-test.mjs` runs the app's real chain headlessly — Create's interview,
steering, prompt compiler, workflow builder, ComfyUI, mp4, scores — so the
prompt under test is exactly what the app would send.

**Dev-weights overrides.** The app's builder *is* the distilled pipeline
(baked sigma ladder, cfg 1), so a dev run patches the built graph rather than
forking the builder: the prompt chain, guides and AV wiring stay
byte-identical to what the corpus ran.

| flag | what it does |
|---|---|
| `--dit FILE` | swap the transformer file |
| `--cfg N` | set both CFGGuiders (pass 1 and the refine, if present) |
| `--steps N` | replace the distill's ManualSigmas ladder with core `LTXVScheduler` at N steps — the ladder is a property of the distill; dev needs a real schedule |
| `--sampler NAME` | KSamplerSelect name for pass 1 |
| `--tsize N` | decode in temporal chunks of N latent frames instead of the whole clip — the default peaks at 50+ GB host RAM on long clips |
| `--neg TEXT` | replace the negative prompt — the app's is inert boilerplate because the distill samples at cfg 1; at real CFG the negative is live |
| `--noaudio` | mux no audio track, for when dev emits an audio latent the AAC encoder rejects |

The dev rerun above is, in full:

```
--dit ltx-2.5-22b-dev-transformer-comfy-int8-convrot.safetensors \
--steps 20 --sampler res_multistep --cfg 4 --tsize 256 \
--neg "blurry, low quality, still frame, frames, watermark, overlay, titles, has blurbox, has subtitles"
```

### Scoring, and what the scorer is for

`scenes.py` prints two columns. Column 1 is ffmpeg's per-frame scene score —
a hard cut is one big step; calibrated on this corpus, a real cut scores 0.2
to 0.35 in a dark scene and 0.3 to 0.9 in a bright one, and continuous motion
stays under 0.05. Column 2 is a rolling **per-block** histogram delta over a
half-second window, adaptive to each clip's own motion baseline.

Column 2 reports **dissolve candidates for the eye, not verdicts**, and that
framing is load-bearing: the two columns are wrong in different ways, and the
by-eye pass stays the reference. A global-luma version of column 2 validated
cleanly on known fades and then missed two same-brightness dissolves in the
same room that the eye caught — which is why it is per-block now.

## Corrections, kept on purpose

Every headline number here has survived a retraction of an earlier one. The
retractions are the method, not an embarrassment, so they stay written down.

- **The "cut budget" is withdrawn.** The original corpus was scored by a
  per-frame detector alone, which sees only single-frame changes — so every
  dissolve, morph and camera that travelled into the next setup scored flat
  and was written up as "one take". Read frame by frame, the corpus has **82
  shot changes, not 20**: 20 hard cuts, 20 clean cuts that scored under
  threshold because the frames are dark, and 42 dissolves. The budget was the
  detector's, not the model's — and the replacement finding is the better
  one: authored structure survives, where the first version said it collapsed
  past three shots.
- **"Dev renders seams as dissolves" is withdrawn.** The first dev pass paired
  the checkpoint with **euler at 20 steps** and the app's inert negative.
  Everything came out smeared at 480p and solid black at 768p. It was the
  sampler: 20 first-order steps undersample this model, and the official Full
  workflow runs dev with a second-order res-family sampler and a real
  negative. Swap the checkpoint but keep a first-order sampler and you measure
  the sampler, not the model. Everything above is from the corrected config.
- **The single-reader caveat stands.** "Clean cut" versus "dissolve" is a
  judgement made at 4 frames a second by one reader; dissolve times are
  ±0.25 s. Most conditions are a single render — only the editing-room and
  lighthouse prompts were repeated across seed or settings.
- **Two artefacts are defects, not data,** and are reported separately: K's
  single bright flash frames at 0.0 s and 2.75 s, and S's two-frame bright
  insert at 9.96–10.46 s. They are the highest scene scores in the whole set
  and neither is an authored cut.

## The numbers

Default is 832×480, 24 fps, seed 4242, single-stage 8-step distilled, cfg 1,
no prompt enhancer; anything else is marked. Two-stage is the 8+3 build: 8
steps at half resolution, 2× latent upscale, 3-step refine. In the seams
column a bare number is a hard cut, `*` a clean cut confirmed by eye below
threshold, `~` a dissolve or morph.

### Distilled corpus, 21 renders

| Run | What changed | Seams (s) | Read |
|---|---|---|---|
| A | Lighthouse control, 4 shots, line in shot 1, fast arc + tilt | 1~ 5.29* 8~ 12.75~ | 1 cut by eye, 3 dissolves |
| B | Lightricks' 3-shot guide example verbatim, 10 s | 3.38 6.25 7.75~ | 2 clean cuts, then a dissolve |
| C | Same guide example stretched to 20 s | 7.17 15~ 17.5~ | 1 clean cut, 2 dissolves |
| D | Lighthouse, lighting/framing contradictions removed | 2.4~ 5.1* 7.9~ 13.1~ | 1 cut by eye, 3 dissolves |
| E | Lighthouse as compact guide-style prose, 20 s | 2.4~ 8.5~ 13.1~ | 3 dissolves; the camera travels up the tower |
| F | Shots 1 and 4 of D only, 20 s | 1~ 2.5~ 5.12* 8.25 | 1 clean + 1 by eye, 2 dissolves |
| G | Create's own generator output, v1 (pre-fix), 20 s | 2.5~ 5.5~ 8~ 10.9* 13.5* | 2 cuts by eye, 3 dissolves |
| H | = E at 10 s (duration only) | 2.25~ 4.46* 6.4~ | 1 cut by eye, 2 dissolves |
| I | = E two-stage, 20 s (sampler only) | 2.4~ 8.96* 13.2~ | 1 cut by eye, 2 dissolves |
| J | = E + shot 2 becomes a cutaway to the tower | 7.2~ 10.75~ 13.5~ | 3 dissolves, no clean cut |
| K | = E two-stage, 10 s | 4.25 6.3~ | 1 hard cut (0.97, highest in the set), 1 dissolve, **2 flash frames** |
| L | Lighthouse, a spoken line per shot, small cameras, 20 s | 4.04* 7.5* 12.29* 16.54* | **4 clean cuts, no dissolves** — the speech finding |
| M | Editing room, 4-shot talking head, 20 s | 4~ 8.4~ 13.6~ 16~ | 4 dissolves — the single-stage 480p outlier |
| N | Beach, cutaways (woman → waves → gulls → woman), no speech | 4.71 8.79 14.33 18.5~ | 3 clean cuts, 1 dissolve |
| O | = M two-stage 480p (sampler only) | 3.96* 8.71 10~ 14.67* 17.5~ | 1 hard + 2 by eye, 2 dissolves |
| P | = M seed 7 (seed only) | 4.17* 9.21 10.9~ 14.33 16.5~ | 2 hard + 1 by eye, 2 dissolves |
| Q | = M two-stage 1344×768 | 4.12 9.54 13.6* 14.83 | **3 hard + 1 by eye, no dissolves** |
| R | Editing room, 30 s, seed 925021102506 | 5.25 12.96 20~ 22.42~ 25~ | 2 hard cuts, 3 dissolves |
| R2 | Beach, 1344×768 two-stage, seed 456523002451 | 4.25 10.2~ 14.92 19~ | 2 hard cuts, 2 dissolves |
| S | Generator v2, six "Cut to" beats, line dealt over shots 1–2 | 1.25* 2.54* 6.6~ 9.96 10.46 11.25* 17.12* | 2 hard (a two-frame flash) + 4 by eye, 1 dissolve |
| T | Generator v3, cut budget 3 shots / 20 s | 5.12* 10.8~ 12.4~ | 1 cut by eye, 2 dissolves (very dark) |

### Dev rerun, 2026-09-21

Same editing-room prompt, same seed 4242, single full-resolution pass at 20
steps with `res_multistep` and the Full workflow's negative.

| Run | Config | Scored cuts | Read |
|---|---|---|---|
| dev2-M-cfg4 | 832×480, cfg 4 | none ≥0.2 (sub-threshold 4.29, 9.17) | all three authored seams present by eye as brief dissolves; waxy texture |
| dev2-M-cfg1 | 832×480, cfg 1 | 1.75 3.04 4.21 10.75 14.25 17.67 (@0.24–0.32) | under-guidance collapse: wrong room, drifting anatomy. The six cuts are content instability, not the authored seams |
| dev2-544p-cfg3 | 960×544, cfg 3 | 4.17 @0.46, 8.88 @0.59, 14.71 @0.70 | **three clean hard cuts at the authored seams**; in motion still oil-painting |
| diag-544p-20s | 960×544, cfg 4 | 4.17 @0.48, 8.88 @0.62, 14.71 @0.69 | same three cuts, full 4-shot structure; more burned |
| diag-768p-10s | 1344×768 × 10 s, cfg 4 | 2.29 @0.20, 5.46 @0.73, 7.50 @0.78 | strongest cut scores of the campaign after K |
| dev2-Q-cfg4 / cfg1 | 1344×768 × 20 s | — | **black**, NaN audio — the token ceiling |
| distilled-Q-2stage | 1344×768 × 20 s, distilled 8+3, cfg 1 | 4.08 @0.51, 8.25 @0.72, 14.83 @0.55 | the quality baseline: three clean hard cuts **and** photographic texture — the one render of that day that reads as footage |

The raw prompts and per-render score lines for the rerun live beside the
renders in `render-tests/dev-rerun-2026-09-21/` (untracked — they are
outputs); the table above is the part worth keeping.
