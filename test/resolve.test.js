import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { McpClient, scriptError } from "../server/mcp.js";
import { localOutput, validateTransfer, scriptWithArgs } from "../server/resolve.js";
import { resolveXml } from "../server/resolve-xml.js";

const FIXTURE = new URL("./resolve-mcp.fixture.mjs", import.meta.url).pathname;

/* A stand-in ResolveMCP on stdio. Returns the client and a reader for every
 * request the fixture saw (across all of its processes). */
function mockMcp(t, mode = "ok") {
  const dir = mkdtempSync(join(tmpdir(), "cut-resolve-mcp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "requests.jsonl");
  const env = { FIXTURE_MODE: mode, FIXTURE_LOG: log };
  const requests = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];
  Object.assign(process.env, env);
  t.after(() => { delete process.env.FIXTURE_MODE; delete process.env.FIXTURE_LOG; });
  return { mcp: new McpClient(FIXTURE, { timeout: 1000 }), requests, env };
}

test("MCP speaks stdio, accepts ResolveMCP's protocol version and discovers paginated tools", async t => {
  const { mcp, requests } = mockMcp(t);
  const info = await mcp.connect();
  assert.equal(info.serverInfo.name, "davinci_resolve");
  assert.deepEqual((await mcp.listTools()).map(t => t.name), ["get_resolve_status", "launch_resolve", "run_script"]);
  assert.equal((await mcp.call("get_resolve_status")).running, true);
  await mcp.close();
  assert.equal(mcp.child.exitCode, 0);
  assert.deepEqual(requests().map(r => r.method), ["initialize", "notifications/initialized", "tools/list", "tools/list", "tools/call"]);
});

test("MCP turns script tracebacks into errors and never retries a mutation", async t => {
  const { mcp, requests } = mockMcp(t);
  await mcp.connect();
  await assert.rejects(mcp.call("run_script", { script: "raise" }), /^Error: No project is open$/);
  await mcp.close();
  assert.equal(requests().filter(r => r.method === "tools/call").length, 1);
  assert.equal(scriptError("plain failure"), "plain failure");
});

test("MCP times out a call that never answers", async t => {
  const { mcp, requests } = mockMcp(t, "hang");
  await mcp.connect();
  await assert.rejects(mcp.call("run_script", { script: "x" }, { timeout: 40 }), /check its timeline before retrying/i);
  await mcp.close();
  assert.equal(requests().filter(r => r.method === "tools/call").length, 1);
});

test("MCP explains a missing ResolveMCP binary", async () => {
  const mcp = new McpClient("/nonexistent/ResolveMCP");
  await assert.rejects(mcp.connect(), /not found at \/nonexistent\/ResolveMCP.*21\.1/);
  await mcp.close();
});

test("script arguments survive quotes, backslashes, replacement patterns and non-ASCII names", () => {
  const args = { name: 'A $& $1 "q" \\ ü 😀', clips: [{ label: "line\u2028sep", mute: true }] };
  const script = scriptWithArgs("x\nresult = main(json.loads(ARGS))\n", args);
  const literal = /^result = main\(json\.loads\((".*")\)\)$/m.exec(script)[1];
  assert.deepEqual(JSON.parse(JSON.parse(literal)), args);
});

test("local media lookup rejects traversal and symlinks outside the configured output folder", t => {
  const root = mkdtempSync(join(tmpdir(), "cut-resolve-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "clip.mp4"), "video");
  assert.equal(localOutput({ filename: "clip.mp4" }, root), join(root, "clip.mp4"));
  assert.equal(localOutput({ filename: "missing.mp4" }, root), null);
  assert.throws(() => localOutput({ filename: "../outside.mp4" }, root), /escapes/);
  symlinkSync(import.meta.filename || new URL(import.meta.url).pathname, join(root, "link.mp4"));
  assert.throws(() => localOutput({ filename: "link.mp4" }, root), /escapes/);
});

test("Resolve payload validation refuses invalid timing before contacting Resolve", () => {
  const body = { requestId: "send-1", name: "Test", fps: 24, width: 0, height: 0,
    clips: [{ source: { filename: "clip.mp4" }, in: 1, out: 3 }], audio: [] };
  assert.doesNotThrow(() => validateTransfer(body));
  assert.throws(() => validateTransfer({ ...body, requestId: "../escape" }), /transfer ID/);
  assert.throws(() => validateTransfer({ ...body, clips: [{ ...body.clips[0], out: .5 }] }), /trim/);
  assert.throws(() => validateTransfer({ ...body, audio: [{ mediaId: "a1", at: -1, gain: 1 }] }), /audio/);
});

test("FCPXML preserves source trims, timeline order, mute, audio offset and gain, and escapes names", () => {
  const probe = { duration: 10, fps: 24, width: 1920, height: 1080, hasAudio: true };
  const result = resolveXml({ name: 'My "cut" & film', fps: 24, width: 1920, height: 1080,
    clips: [{ file: "/tmp/clip one.mp4", name: "Opening & title", start: 2, end: 5, probe, mute: true },
      { file: "/tmp/clip2.mp4", name: "Second", start: 0, end: 2, probe }],
    audio: [{ file: "/tmp/voice.wav", name: 'Voice "A"', at: 1, gain: .5, probe: { duration: 9, fps: 0, hasAudio: true } }] });
  assert.match(result, /name="My &quot;cut&quot; &amp; film"/);
  assert.match(result, /clip%20one.mp4/);
  assert.match(result, /name="Opening &amp; title" offset="0\/24s" start="48\/24s" duration="72\/24s" srcEnable="video"/);
  assert.match(result, /name="Second" offset="72\/24s" start="0\/24s" duration="48\/24s"/);
  assert.match(result, /lane="-1" offset="72\/24s" start="0s" duration="96\/24s" srcEnable="audio"/);
  assert.match(result, /amount="-6.021dB"/);
  assert.match(result, /sequence[^>]*duration="120\/24s"/);
});

test("a full transfer prepares WAV audio, passes clip names and mutes, and reuses its receipt on retry", async t => {
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); }
  catch { return t.skip("ffmpeg is not installed"); }
  const dir = mkdtempSync(join(tmpdir(), "cut-resolve-transfer-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const video = join(dir, "sample.mp4"), audio = join(dir, "voice.wav");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=s=320x180:r=24:d=1", "-c:v", "libx264", video]);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=duration=1", audio]);
  const { requests, env } = mockMcp(t);
  // Isolate settings and media from the user's data.
  const { spawn } = await import("node:child_process");
  const script = `
    import { readFileSync } from 'node:fs';
    import { putMedia } from './server/projects.js';
    import { sendToResolve } from './server/resolve.js';
    putMedia('video', 'data:video/mp4;base64,' + readFileSync(${JSON.stringify(video)}).toString('base64'));
    putMedia('voice', 'data:audio/wav;base64,' + readFileSync(${JSON.stringify(audio)}).toString('base64'));
    const body = {requestId:'test-retry',name:'Test',fps:24,width:0,height:0,clips:[
      {source:{mediaId:'video'},name:'Opening',in:0,out:.5,mute:true},
      {source:{mediaId:'video'},name:'Second angle',in:.5,out:1}],audio:[{mediaId:'voice',at:.25,gain:.5}]};
    console.log(JSON.stringify(await sendToResolve(body)));
    console.log(JSON.stringify(await sendToResolve(body)));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL("../", import.meta.url), env: { ...process.env, ...env, CUT_DATA: dir, CUT_RESOLVE_MCP: FIXTURE },
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
  const code = await new Promise(r => child.on("close", r));
  assert.equal(code, 0, stderr);
  const imports = requests().filter(r => r.importArgs).map(r => r.importArgs);
  assert.equal(imports.length, 1);
  const results = stdout.trim().split("\n").map(JSON.parse);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].timeline, "Transferred");
  assert.deepEqual(imports[0].clips, [{ label: "Opening", mute: true }, { label: "Second angle", mute: false }]);
  assert.equal(imports[0].expected_project, "Test");
  assert.equal(imports[0].request_id, "test-retry");
  const xml = readFileSync(imports[0].file, "utf8");
  assert.match(xml, /name="Second angle"/);
  assert.match(xml, /srcEnable="video"/);
  assert.match(xml, /source-2-resolve.wav/);
});
