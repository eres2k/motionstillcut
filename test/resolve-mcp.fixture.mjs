#!/usr/bin/env node
/* Stand-in for DaVinci Resolve's ResolveMCP: newline-delimited JSON-RPC on
 * stdio. FIXTURE_MODE: ok (default) | hang (never answers tools/call) |
 * stopped (Resolve not running). Every request is appended to FIXTURE_LOG. */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.env.FIXTURE_MODE || "ok";
const log = entry => process.env.FIXTURE_LOG && appendFileSync(process.env.FIXTURE_LOG, `${JSON.stringify(entry)}\n`);
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const text = (id, value) => reply(id, { content: [{ type: "text", text: JSON.stringify(value) }] });

createInterface({ input: process.stdin }).on("line", line => {
  const { id, method, params = {} } = JSON.parse(line);
  log({ method, tool: params.name, arguments: params.arguments });
  if (method === "initialize") return reply(id, { protocolVersion: "2024-11-05", serverInfo: { name: "davinci_resolve", version: "21.1.2" } });
  if (method === "tools/list") return reply(id, params.cursor
    ? { tools: [{ name: "run_script" }] }
    : { tools: [{ name: "get_resolve_status" }, { name: "launch_resolve" }], nextCursor: "page-2" });
  if (method !== "tools/call" || mode === "hang") return;
  if (params.name === "get_resolve_status") return text(id, { running: mode !== "stopped", version: "21.1.2" });
  const script = params.arguments?.script || "";
  if (script.startsWith("# motionstillcut:status")) {
    return text(id, { result: { product: "DaVinci Resolve Studio 21.1.2", page: "edit", project: "Test", timeline: null, rendering: false } });
  }
  if (script.startsWith("# motionstillcut:import")) {
    const literal = /^result = main\(json\.loads\((".*")\)\)$/m.exec(script)[1];
    log({ importArgs: JSON.parse(JSON.parse(literal)) });
    return text(id, { output: "", result: { ok: true, project: "Test", timeline: "Transferred", warnings: [] } });
  }
  text(id, { error: 'Traceback (most recent call last):\n  File "<script>", line 1, in <module>\nRuntimeError: No project is open\n' });
});
