import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { McpClient } from "../server/mcp.js";
import { localOutput, validateTransfer } from "../server/resolve.js";
import { resolveXml } from "../server/resolve-xml.js";

async function mockMcp(t, handler) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    handler(req, res, body);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return new McpClient(`http://127.0.0.1:${server.address().port}/mcp`, { timeout: 1000 });
}
const json = (res, body, result) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result })); };

test("MCP negotiates sessions, discovers paginated tools and consumes SSE without waiting for stream closure", async t => {
  const methods = [], sessionErrors = [];
  const mcp = await mockMcp(t, (req, res, body) => {
    methods.push(body.method || req.method);
    if (body.method === "initialize") {
      res.setHeader("Mcp-Session-Id", "test-session");
      return json(res, body, { protocolVersion: "2025-11-25", serverInfo: { name: "test" } });
    }
    if (req.headers["mcp-session-id"] !== "test-session") sessionErrors.push(body.method);
    if (body.method === "notifications/initialized" || req.method === "DELETE") { res.writeHead(202); return res.end(); }
    if (body.method === "tools/list") return json(res, body, body.params.cursor
      ? { tools: [{ name: "import_timeline" }] } : { tools: [{ name: "resolve_status" }], nextCursor: "page-2" });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(': keepalive\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n');
    const response = JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: '{"ok":true,"project":"Test"}' }] } });
    // Split an SSE event across chunks and leave the stream open.
    res.write(`event: message\r\ndata: ${response.slice(0, 25)}`);
    setTimeout(() => res.write(`${response.slice(25)}\r\n\r\n`), 5);
  });
  await mcp.connect();
  assert.deepEqual((await mcp.listTools()).map(t => t.name), ["resolve_status", "import_timeline"]);
  assert.equal((await mcp.call("resolve_status")).project, "Test");
  await mcp.close();
  assert.deepEqual(sessionErrors, []);
  assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list", "tools/list", "tools/call", "DELETE"]);
});

test("MCP rejects tool errors inside successful HTTP responses and never retries a mutation", async t => {
  let calls = 0;
  const mcp = await mockMcp(t, (req, res, body) => {
    calls++;
    json(res, body, { content: [{ type: "text", text: '{"ok":false,"error":"No project is open"}' }] });
  });
  await assert.rejects(mcp.call("import_timeline"), /No project is open/);
  assert.equal(calls, 1);
});

test("MCP times out even when the server sends headers then hangs", async t => {
  let calls = 0;
  const mcp = await mockMcp(t, (req, res) => { calls++; res.writeHead(200, { "Content-Type": "application/json" }); res.flushHeaders(); });
  await assert.rejects(mcp.call("import_timeline", {}, { timeout: 40 }), /check its timeline before retrying/i);
  assert.equal(calls, 1);
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

test("a full transfer prepares WAV audio, retains clip names and reuses its receipt on retry", async t => {
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); }
  catch { return t.skip("ffmpeg is not installed"); }
  const dir = mkdtempSync(join(tmpdir(), "cut-resolve-transfer-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const video = join(dir, "sample.mp4"), audio = join(dir, "voice.wav");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=s=320x180:r=24:d=1", "-c:v", "libx264", video]);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=duration=1", audio]);
  let imports = 0, importedFile;
  const mcp = await mockMcp(t, (req, res, body) => {
    if (body.method === "initialize") return json(res, body, { protocolVersion: "2025-11-25", serverInfo: { name: "fixture" } });
    if (body.method === "notifications/initialized") { res.writeHead(202); return res.end(); }
    if (body.method === "tools/list") return json(res, body, { tools: [{ name: "resolve_status" }, { name: "import_timeline", inputSchema: { properties: Object.fromEntries(["file_path", "expected_project", "expected_clips", "request_id"].map(p => [p, {}])) } }] });
    if (body.params.name === "resolve_status") return json(res, body, { structuredContent: { ok: true, project: "Test" } });
    imports++;
    importedFile = body.params.arguments.file_path;
    json(res, body, { structuredContent: { ok: true, project: "Test", timeline: "Transferred" } });
  });
  // Isolate settings and media from the user's data. The mock server must
  // remain responsive while the child prepares the real media with ffmpeg.
  const { spawn } = await import("node:child_process");
  const script = `
    import { readFileSync } from 'node:fs';
    import { putMedia } from './server/projects.js';
    import { sendToResolve } from './server/resolve.js';
    putMedia('video', 'data:video/mp4;base64,' + readFileSync(${JSON.stringify(video)}).toString('base64'));
    putMedia('voice', 'data:audio/wav;base64,' + readFileSync(${JSON.stringify(audio)}).toString('base64'));
    const body = {requestId:'test-retry',name:'Test',fps:24,width:0,height:0,clips:[
      {source:{mediaId:'video'},name:'Opening',in:0,out:.5},
      {source:{mediaId:'video'},name:'Second angle',in:.5,out:1}],audio:[{mediaId:'voice',at:.25,gain:.5}]};
    console.log(JSON.stringify(await sendToResolve(body)));
    console.log(JSON.stringify(await sendToResolve(body)));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL("../", import.meta.url), env: { ...process.env, CUT_DATA: dir, CUT_RESOLVE_URL: mcp.url },
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
  const code = await new Promise(r => child.on("close", r));
  assert.equal(code, 0, stderr);
  assert.equal(imports, 1);
  const results = stdout.trim().split("\n").map(JSON.parse);
  assert.deepEqual(results[0], results[1]);
  const { readFileSync } = await import("node:fs");
  const xml = readFileSync(importedFile, "utf8");
  assert.match(xml, /name="Second angle"/);
  assert.match(xml, /source-2-resolve.wav/);
});
