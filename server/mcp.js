/* Stdio MCP client for DaVinci Resolve's built-in server (ResolveMCP, Resolve
 * Studio 21.1+). A process belongs to one operation, so a restarted Resolve
 * never leaves the next operation with a stale connection. Mutating tool
 * calls are never automatically retried. */
import { spawn } from "node:child_process";

const VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const MAX_LINE = 8 * 1024 * 1024;

export class McpClient {
  constructor(command, { args = [], timeout = 15000 } = {}) {
    if (typeof command !== "string" || !command) throw new Error("No Resolve MCP command is configured.");
    this.command = command;
    this.args = args;
    this.timeout = timeout;
    this.id = 0;
    this.pending = new Map();
    this.child = null;
    this.exited = null;
  }

  start() {
    const child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    let buffer = "", stderr = "";
    const failAll = err => { for (const p of this.pending.values()) p.reject(err); this.pending.clear(); };
    child.on("error", err => {
      this.exited = err.code === "ENOENT"
        ? new Error(`Resolve's MCP server was not found at ${this.command}. Install DaVinci Resolve Studio 21.1 or newer.`)
        : new Error(`Could not start Resolve's MCP server: ${err.message}`);
      failAll(this.exited);
    });
    child.on("exit", code => {
      this.exited ||= new Error(`Resolve's MCP server stopped (exit ${code}).${stderr.trim() ? ` ${stderr.trim().slice(-300)}` : ""}`);
      failAll(this.exited);
    });
    child.stdin.on("error", () => { /* reported through exit */ });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", s => { stderr = (stderr + s).slice(-2000); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > MAX_LINE) { failAll(new Error("Resolve MCP response is too large.")); child.kill(); return; }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const waiter = this.pending.get(message.id);
        if (!waiter || !("result" in message || "error" in message)) continue;
        this.pending.delete(message.id);
        waiter.resolve(message);
      }
    });
  }

  async request(method, params = {}, { notification = false, timeout = this.timeout } = {}) {
    if (!this.child) this.start();
    if (this.exited) throw this.exited;
    const id = notification ? undefined : ++this.id;
    const body = JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params });
    if (notification) { this.child.stdin.write(`${body}\n`); return null; }
    let timer;
    const answer = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(method === "tools/call"
          ? "Resolve did not answer in time. Close any dialog in Resolve, then check its timeline before retrying."
          : "Resolve's MCP server did not answer. Check that DaVinci Resolve Studio is running."));
      }, timeout);
    });
    this.child.stdin.write(`${body}\n`);
    try {
      const message = await answer;
      if (message.error) throw new Error(`Resolve MCP: ${message.error.message || "request failed"}`);
      return message.result;
    } finally { clearTimeout(timer); }
  }

  async connect() {
    const info = await this.request("initialize", {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "motionstillcut", version: "1.0.0" },
    });
    if (!VERSIONS.includes(info?.protocolVersion)) {
      throw new Error(`Resolve MCP negotiated an unsupported protocol: ${info?.protocolVersion || "none"}.`);
    }
    await this.request("notifications/initialized", {}, { notification: true });
    this.info = info.serverInfo;
    return info;
  }

  async listTools() {
    const tools = [], cursors = new Set();
    let cursor;
    do {
      const page = await this.request("tools/list", cursor ? { cursor } : {});
      if (!Array.isArray(page?.tools)) throw new Error("Resolve MCP returned an invalid tool list.");
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("Resolve MCP repeated its tool-list cursor.");
      cursors.add(cursor);
      if (tools.length > 2000) throw new Error("Resolve MCP exposed too many tools.");
    } while (cursor);
    return tools;
  }

  /** ResolveMCP reports script failures as {"error": "<traceback>"} inside a
   *  successful result, so those count as failures too. */
  async call(name, args = {}, options = {}) {
    const result = await this.request("tools/call", { name, arguments: args }, options);
    const text = (result?.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
    let data = result?.structuredContent;
    if (!data && text) { try { data = JSON.parse(text); } catch { /* text-only tool */ } }
    if (result?.isError || data?.error || data?.ok === false || data?.success === false) {
      throw new Error(scriptError(String(data?.error || text || `${name} failed in Resolve`)));
    }
    return data || { text };
  }

  async close() {
    const child = this.child;
    if (!child || child.exitCode !== null || this.exited) return;
    const gone = new Promise(r => child.once("exit", r));
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 2000);
    await gone;
    clearTimeout(timer);
  }
}

/** A Python traceback's last line, without the exception class, is the message
 *  a person needs; anything else is passed through trimmed. */
export function scriptError(text) {
  const lines = text.trim().split("\n");
  if (/^Traceback /.test(lines[0])) {
    const last = lines.at(-1).replace(/^[A-Za-z_][\w.]*(Error|Exception): /, "");
    return last.slice(0, 1500);
  }
  return text.slice(0, 1500);
}
