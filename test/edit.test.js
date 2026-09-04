/* THE EDIT — the arithmetic behind the Editor page, and the ffmpeg command
 * behind its export.
 *
 * Two things are worth pinning down without a server. The plan: a clip's
 * trimmed length, where it starts, and what the page may honestly show
 * before anything has been probed. The filter graph: one wrong character in
 * a -filter_complex string is an ffmpeg error twenty minutes into an export,
 * and the graph is built from a spec that a test can hand over whole — with
 * ffprobe's answers stubbed in — so the string is checked here, not there.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { blankProject } from "../web/js/state.js";
import {
  editPlan, exportBody, exportId, MIN_CLIP,
  addRenderClip, addMediaClip, addAudio, moveClip, removeClip, setClip, setAudio, removeAudio,
} from "../web/js/edit.js";
import { editArgs, editLayout } from "../server/film.js";

/** A finished render, as project.jobs and the library both keep it. */
const job = (n, { duration = 5, resolution = "832x480" } = {}) => ({
  id: `job${n}`, name: `Take ${n}`, status: "done",
  outputs: [{ filename: `MiniMax_${n}_.png`, kind: "images" }, { filename: `MiniMax_${n}_.mp4`, subfolder: "", type: "output", kind: "images" }],
  settingsSnapshot: { resolution, duration },
});

/** A dropped file, as media.js's ingest() returns it. */
const item = (kind, n) => ({ id: `m${n}`, name: `${kind}${n}.${kind === "audio" ? "mp3" : "mp4"}`, kind, size: 1000 });

/** Two renders and a phone clip: the second render muted, the phone clip trimmed. */
function cut() {
  const p = blankProject();
  addRenderClip(p, job(1));
  const b = addRenderClip(p, job(2));
  setClip(p, b.id, { mute: true });
  const c = addMediaClip(p, item("video", 1));
  setClip(p, c.id, { in: 1, out: 3.5 });
  return p;
}

/* ── The model ───────────────────────────────────────────── */

test("a fresh project carries an empty edit", () => {
  const p = blankProject();
  assert.deepEqual(p.edit.clips, []);
  assert.deepEqual(p.edit.audio, []);
  assert.deepEqual(p.edit.export, { name: "", fps: 24, width: 0, height: 0 });
});

test("a render on the timeline is the mp4 output, with the size and length it was made at", () => {
  const p = blankProject();
  const clip = addRenderClip(p, job(1, { duration: 10, resolution: "1280x720" }));
  assert.equal(clip.kind, "render");
  // The extension picks the file, not the key it arrived under — core
  // SaveVideo reports its .mp4 as "images".
  assert.equal(clip.output.filename, "MiniMax_1_.mp4");
  assert.equal(clip.output.type, "output");
  assert.equal(clip.duration, 10);
  assert.equal(clip.width, 1280);
  assert.equal(clip.height, 720);
  assert.equal(clip.in, 0);
  assert.equal(clip.out, null);
  assert.equal(clip.mute, false);
  assert.equal(p.edit.clips.length, 1);
  // No video, no clip.
  assert.equal(addRenderClip(p, { id: "x", outputs: [] }), null);
  assert.equal(p.edit.clips.length, 1);
});

test("a dropped file is a clip only if it is a video; a sound file goes under", () => {
  const p = blankProject();
  assert.equal(addMediaClip(p, item("audio", 1)), null);
  assert.equal(addMediaClip(p, item("image", 2)), null);
  const v = addMediaClip(p, item("video", 3));
  assert.equal(v.kind, "media");
  assert.equal(v.mediaId, "m3");
  assert.equal(v.duration, undefined);   // nobody has probed it
  assert.equal(addAudio(p, item("image", 4)), null);
  const a = addAudio(p, item("audio", 5));
  assert.deepEqual([a.mediaId, a.at, a.gain], ["m5", 0, 1]);
  assert.equal(p.edit.audio.length, 1);
});

/* ── The plan ────────────────────────────────────────────── */

test("the plan lays the clips end to end with their trims applied", () => {
  const plan = editPlan(cut());
  assert.equal(plan.ok, true, plan.problems.join("; "));
  assert.equal(plan.clips.length, 3);

  const [a, b, c] = plan.clips;
  assert.deepEqual([a.at, a.length, a.mute], [0, 5, false]);
  assert.deepEqual([b.at, b.length, b.mute], [5, 5, true]);
  // in 1, out 3.5 → 2.5 s, starting where the second one ends.
  assert.deepEqual([c.at, c.in, c.out, c.length], [10, 1, 3.5, 2.5]);
  assert.equal(plan.duration, 12.5);

  assert.deepEqual(a.source, { filename: "MiniMax_1_.mp4", subfolder: "", type: "output" });
  assert.deepEqual(c.source, { mediaId: "m1" });
  // Nothing asked for a size, so the first clip's is the frame.
  assert.deepEqual([plan.width, plan.height, plan.fps], [832, 480, 24]);
});

test("an unprobed media clip with no out point is not a problem, just an unknown length", () => {
  const p = blankProject();
  addMediaClip(p, item("video", 1));
  addRenderClip(p, job(2));
  const plan = editPlan(p);
  assert.equal(plan.ok, true);
  assert.equal(plan.clips[0].length, null);
  // The plan does not invent a length: the render still starts at 0 as far
  // as anyone knows, and the total is a floor.
  assert.equal(plan.clips[1].at, 0);
  assert.equal(plan.duration, 5);
});

test("an out point past a known end is brought back to it, and a trim never goes below the floor", () => {
  const p = blankProject();
  const a = addRenderClip(p, job(1));
  setClip(p, a.id, { in: 4.95, out: 99 });
  const plan = editPlan(p);
  assert.equal(plan.clips[0].out, 5);
  assert.equal(plan.clips[0].length, MIN_CLIP);
});

test("the export's own size wins over the clips'", () => {
  const p = cut();
  p.edit.export = { ...p.edit.export, width: 1920, height: 1080, fps: 30 };
  const plan = editPlan(p);
  assert.deepEqual([plan.width, plan.height, plan.fps], [1920, 1080, 30]);
});

test("problems: an empty timeline, and a clip with nothing behind it", () => {
  assert.deepEqual(editPlan(blankProject()).problems, ["nothing on the timeline"]);

  const p = blankProject();
  addRenderClip(p, job(1));
  p.edit.clips.push({ id: "ghost", kind: "render", name: "a ghost", output: null, mute: false, in: 0, out: null });
  p.edit.clips.push({ id: "ghost2", kind: "media", name: "another", mediaId: "", mute: false, in: 0, out: null });
  p.edit.audio.push({ id: "t", mediaId: null, name: "no file", at: 0, gain: 1 });
  const plan = editPlan(p);
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.problems, [
    "a ghost has no video behind it",
    "another has no video behind it",
    "no file has no file behind it",
  ]);
});

test("the export body is exactly what the route takes", () => {
  const p = cut();
  p.id = "abc-123";
  const t = addAudio(p, item("audio", 9));
  setAudio(p, t.id, { at: 2.5, gain: 0.6 });
  const body = exportBody(p);
  assert.equal(body.id, "edit-abc-123");
  assert.equal(body.name, "Untitled Timeline");
  assert.deepEqual([body.fps, body.width, body.height], [24, 832, 480]);
  assert.deepEqual(body.clips, [
    { source: { filename: "MiniMax_1_.mp4", subfolder: "", type: "output" }, mute: false, in: 0, out: 5 },
    { source: { filename: "MiniMax_2_.mp4", subfolder: "", type: "output" }, mute: true, in: 0, out: 5 },
    { source: { mediaId: "m1" }, mute: false, in: 1, out: 3.5 },
  ]);
  assert.deepEqual(body.audio, [{ mediaId: "m9", at: 2.5, gain: 0.6 }]);
  // The export name, when there is one, is the film's name.
  p.edit.export.name = "Rough cut";
  assert.equal(exportBody(p).name, "Rough cut");
});

test("the export id is stable, safe as a directory name, and falls back to the project's name", () => {
  const p = blankProject();
  p.name = "Rain / the loading bay (v2)";
  assert.equal(exportId(p), "edit-rain-the-loading-bay-v2");
  assert.equal(exportId(p), exportId(p));
  assert.match(exportId(p), /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
  p.name = "";
  assert.equal(exportId(p), "edit-untitled");
});

/* ── The helpers ─────────────────────────────────────────── */

test("move, remove and set on clips and audio", () => {
  const p = cut();
  const ids = () => p.edit.clips.map(c => c.name);
  assert.deepEqual(ids(), ["Take 1", "Take 2", "video1.mp4"]);
  const [a, b, c] = p.edit.clips;

  assert.equal(moveClip(p, a.id, -1), false);   // already first
  assert.equal(moveClip(p, c.id, +1), false);   // already last
  assert.equal(moveClip(p, c.id, -1), true);
  assert.deepEqual(ids(), ["Take 1", "video1.mp4", "Take 2"]);
  assert.equal(moveClip(p, "nope", +1), false);

  assert.equal(removeClip(p, b.id), true);
  assert.equal(removeClip(p, b.id), false);
  assert.deepEqual(ids(), ["Take 1", "video1.mp4"]);

  // A trim can never be negative or end before it starts; "to the end" is null.
  const set = setClip(p, a.id, { in: -3, out: 0.5 });
  assert.deepEqual([set.in, set.out], [0, 0.5]);
  setClip(p, a.id, { in: 2, out: 1 });
  assert.equal(p.edit.clips[0].out, 2 + MIN_CLIP);
  setClip(p, a.id, { out: "" });
  assert.equal(p.edit.clips[0].out, null);
  assert.equal(setClip(p, "nope", {}), null);

  const t = addAudio(p, item("audio", 1));
  setAudio(p, t.id, { at: -1, gain: -2 });
  assert.deepEqual([t.at, t.gain], [0, 0]);
  assert.equal(setAudio(p, "nope", {}), null);
  assert.equal(removeAudio(p, t.id), true);
  assert.equal(removeAudio(p, t.id), false);
  assert.deepEqual(p.edit.audio, []);
});

/* ── The ffmpeg command ──────────────────────────────────── */

/** The three clips of cut(), as exportEdit hands them to editArgs after
 *  fetching and probing — the phone clip is portrait 1080p at 30 fps. */
const probed = () => [
  { file: "/w/in-000.mp4", in: 0, out: null, mute: false, probe: { duration: 5, width: 832, height: 480, fps: 24, hasAudio: true } },
  { file: "/w/in-001.mp4", in: 0, out: null, mute: true,  probe: { duration: 5, width: 832, height: 480, fps: 24, hasAudio: true } },
  { file: "/w/in-002.mov", in: 1, out: 3.5, mute: false,  probe: { duration: 12.4, width: 1080, height: 1920, fps: 30, hasAudio: false } },
];

const graphOf = (args) => args[args.indexOf("-filter_complex") + 1];

test("editArgs builds one filter graph: trim, fit, concat, delay, mix", () => {
  const args = editArgs({ clips: probed(), audio: [{ file: "/w/aud-000.mp3", at: 2.5, gain: 0.6 }], fps: 24, out: "/w/film.mp4" });
  const graph = graphOf(args);

  // Every input once, clips first, then the track.
  const inputs = args.filter((a, i) => args[i - 1] === "-i");
  assert.deepEqual(inputs, ["/w/in-000.mp4", "/w/in-001.mp4", "/w/in-002.mov", "/w/aud-000.mp3"]);

  // The frame is the first clip's, and every clip is fitted into it.
  assert.match(graph, /\[0:v\]trim=start=0:end=5,setpts=PTS-STARTPTS,scale=832:480:force_original_aspect_ratio=decrease,pad=832:480:\(ow-iw\)\/2:\(oh-ih\)\/2,setsar=1,fps=24\[v0\]/);
  assert.match(graph, /\[2:v\]trim=start=1:end=3\.5,/);
  assert.match(graph, /scale=832:480:.*\[v2\]/);

  // Sound: the first clip's own, silence for the muted one AND for the one
  // that has none — the concat needs an audio stream from every segment.
  assert.match(graph, /\[0:a\]atrim=start=0:end=5,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo\[a0\]/);
  assert.match(graph, /anullsrc=r=48000:cl=stereo,atrim=0:5\[a1\]/);
  assert.match(graph, /anullsrc=r=48000:cl=stereo,atrim=0:2\.5\[a2\]/);
  assert.ok(graph.includes("[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[vcat][acat]"));

  // The track: 2.5 s is 2500 ms on both channels, at its gain, mixed under.
  assert.match(graph, /\[3:a\]aresample=48000,aformat=channel_layouts=stereo,volume=0\.6,adelay=2500\|2500\[t0\]/);
  assert.ok(graph.includes("[acat][t0]amix=inputs=2:duration=first:normalize=0[aout]"));

  // Mapped, encoded, and cut at the picture's end.
  assert.deepEqual(args.slice(args.indexOf("-map"), args.indexOf("-map") + 4), ["-map", "[vcat]", "-map", "[aout]"]);
  assert.ok(args.includes("-shortest"));
  assert.ok(args.includes("libx264") && args.includes("yuv420p") && args.includes("aac"));
  assert.equal(args.at(-1), "/w/film.mp4");
  assert.equal(args[0], "-y");
});

test("with no audio track the concat's own sound is the output, and no amix is built", () => {
  const args = editArgs({ clips: probed(), out: "/w/film.mp4" });
  const graph = graphOf(args);
  assert.ok(!graph.includes("amix"));
  assert.ok(!graph.includes("adelay"));
  assert.deepEqual(args.slice(args.indexOf("-map"), args.indexOf("-map") + 4), ["-map", "[vcat]", "-map", "[acat]"]);
});

test("width and height default to the first clip's probed size, rounded to even; a request wins", () => {
  const clips = probed();
  clips[0].probe = { ...clips[0].probe, width: 1080, height: 1917 };
  const lay = editLayout({ clips });
  assert.deepEqual([lay.width, lay.height], [1080, 1918]);
  assert.equal(lay.duration, 12.5);
  const asked = editLayout({ clips, width: 1280, height: 720 });
  assert.deepEqual([asked.width, asked.height], [1280, 720]);
  assert.match(graphOf(editArgs({ clips, width: 1280, height: 720, out: "x.mp4" })), /scale=1280:720:/);
});

test("the layout refuses what ffmpeg would have refused twenty minutes later", () => {
  assert.throws(() => editLayout({ clips: [] }), /nothing on the timeline/);
  const noPicture = [{ file: "a.mp3", in: 0, out: null, probe: { duration: 3, width: 0, height: 0, hasAudio: true } }];
  assert.throws(() => editLayout({ clips: noPicture }), /no video stream/);
  const noEnd = [{ file: "a.mp4", in: 0, out: null, label: "the phone clip", probe: { duration: null, width: 640, height: 360, hasAudio: true } }];
  assert.throws(() => editLayout({ clips: noEnd }), /the phone clip: ffprobe could not tell how long/);
  // …but the same clip with an out point is fine.
  noEnd[0].out = 4;
  assert.equal(editLayout({ clips: noEnd }).clips[0].length, 4);
  const tooShort = [{ file: "a.mp4", in: 4.99, out: null, probe: { duration: 5, width: 640, height: 360, hasAudio: true } }];
  assert.throws(() => editLayout({ clips: tooShort }), /less than/);
});
