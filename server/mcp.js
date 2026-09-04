/* Streamable HTTP MCP client. A connection belongs to one operation, so a
 * restarted server never leaves the next operation with a stale session.
 * Mutating tool calls are never automatically retried. */
export class McpClient {
  constructor(url, { token = "", timeout = 15000 } = {}) {
    const endpoint = new URL(url);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
      throw new Error("Use an HTTP or HTTPS MCP endpoint without embedded credentials.");
    }
    this.url = endpoint.href;
    this.token = token;
    this.timeout = timeout;
    this.version = "2025-11-25";
    this.session = null;
    this.id = 0;
  }

  headers() {
    return {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": this.version,
      ...(this.session ? { "Mcp-Session-Id": this.session } : {}),
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  async request(method, params = {}, { notification = false, timeout = this.timeout } = {}) {
    const id = notification ? undefined : ++this.id;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const response = await fetch(this.url, {
        method: "POST", headers: this.headers(), signal: ctl.signal, redirect: "error",
        body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(response.status === 401 || response.status === 403
          ? "Resolve MCP refused the connection. Check its access token in Setup."
          : `Resolve MCP returned HTTP ${response.status}. Check the endpoint (normally /mcp).`);
      }
      if (method === "initialize") this.session = response.headers.get("mcp-session-id");
      if (notification) { await response.body?.cancel(); return null; }
      let message;
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "", size = 0;
        try {
          while (!message) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            size += value?.byteLength || 0;
            if (size > 8 * 1024 * 1024) throw new Error("Resolve MCP response is too large.");
            let boundary;
            while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
              const event = buffer.slice(0, boundary.index);
              buffer = buffer.slice(boundary.index + boundary[0].length);
              const data = event.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).replace(/^ /, "")).join("\n");
              if (!data) continue;
              const candidate = JSON.parse(data);
              if (candidate.id === id && ("result" in candidate || "error" in candidate)) { message = candidate; break; }
            }
            if (done) break;
          }
        } finally { await reader.cancel().catch(() => {}); }
      } else {
        message = await response.json();
      }
      if (!message || message.id !== id) throw new Error("Resolve MCP returned no matching response.");
      if (message.error) throw new Error(`Resolve MCP: ${message.error.message || "request failed"}`);
      return message.result;
    } catch (err) {
      if (ctl.signal.aborted) throw new Error(method === "tools/call"
        ? "Resolve did not answer in time. Close any dialog in Resolve, then check its timeline before retrying."
        : "Resolve MCP timed out. Check that the server is running.");
      if (err instanceof TypeError) throw new Error("Cannot reach Resolve MCP. Start its HTTP server and check the endpoint in Setup.");
      throw err;
    } finally { clearTimeout(timer); }
  }

  async connect() {
    const info = await this.request("initialize", {
      protocolVersion: this.version, capabilities: {}, clientInfo: { name: "motionstillcut", version: "1.0.0" },
    });
    if (!["2025-03-26", "2025-06-18", "2025-11-25"].includes(info?.protocolVersion)) {
      throw new Error(`Resolve MCP negotiated an unsupported protocol: ${info?.protocolVersion || "none"}.`);
    }
    this.version = info.protocolVersion;
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

  async call(name, args = {}, options = {}) {
    const result = await this.request("tools/call", { name, arguments: args }, options);
    const text = (result?.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
    let data = result?.structuredContent;
    if (!data && text) { try { data = JSON.parse(text); } catch { /* text-only tool */ } }
    if (result?.isError || data?.ok === false || data?.success === false) {
      throw new Error(String(data?.error || text || `${name} failed in Resolve`).slice(0, 1500));
    }
    return data || { text };
  }

  async close() {
    if (!this.session) return;
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 2000);
    try {
      const r = await fetch(this.url, { method: "DELETE", headers: this.headers(), signal: ctl.signal, redirect: "error" });
      await r.body?.cancel();
    } catch { /* session expiry is harmless */ }
    finally { clearTimeout(timer); this.session = null; }
  }
}
