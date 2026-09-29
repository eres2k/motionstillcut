/* Copyable, dependency-free producer for Nexus. Runs only on the server.
   Set NEXUS_PUSH_URL/TOKEN or point NEXUS_PUSH_CONFIG at a mode-0600 JSON
   file containing {url, token}. Outbox entries survive both server restarts.
   publish() never makes a successful render fail because push is unavailable. */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
function createPushClient({ project, configFile, outboxFile, fetchImpl = globalThis.fetch, interval = 15000, log = console.warn } = {}) {
  let queue = [], busy = false;
  try { queue = JSON.parse(fs.readFileSync(outboxFile, 'utf8')); if (!Array.isArray(queue)) queue = []; }
  catch (e) { if (e.code !== 'ENOENT') log(`[nexus-push] Cannot read outbox: ${e.message}`); }
  function configuration() {
    // Project test suites must never publish into the operator's live hub.
    if (process.env.NODE_TEST_CONTEXT && fetchImpl === globalThis.fetch) return {};
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(process.env.NEXUS_PUSH_CONFIG || configFile, 'utf8')); } catch {}
    return { url: process.env.NEXUS_PUSH_URL || cfg.url, token: process.env.NEXUS_PUSH_TOKEN || cfg.token };
  }
  function save() {
    fs.mkdirSync(path.dirname(outboxFile), { recursive: true, mode: 0o700 });
    const tmp = outboxFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(queue), { mode: 0o600 });
    fs.renameSync(tmp, outboxFile);
  }
  async function flush() {
    if (busy || !queue.length) return;
    const cfg = configuration();
    if (!cfg.url || !cfg.token) return;
    let u;
    try { u = new URL(cfg.url); } catch { return; }
    // Credentials may use HTTP only over loopback, never over the public LAN.
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) return;
    busy = true;
    try {
      for (let n = 0; n < 10 && queue.length; n++) {
        const entry = queue[0];
        if (Date.now() - entry.at > 86400000) { queue.shift(); save(); continue; }
        const r = await fetchImpl(u, { method: 'POST', headers: { 'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.token}`, 'X-Nexus-Project': project },
          body: JSON.stringify(entry.event), signal: AbortSignal.timeout(5000), redirect: 'error' });
        await r.text();
        if (!r.ok) {
          if ([400, 413, 415].includes(r.status)) { queue.shift(); save(); log(`[nexus-push] Invalid event rejected (${r.status})`); continue; }
          break; // Keep unauthorized/transient failures for a config fix or retry.
        }
        queue.shift(); save();
      }
    } catch { /* Retry from the persistent outbox, with the SAME event ID. */ }
    finally { busy = false; }
  }
  function publish(event) {
    const cfg = configuration();
    if (!cfg.url || !cfg.token) return false;
    try {
      const id = String(event.id || crypto.randomUUID());
      if (queue.some(q => q.event.id === id)) return true;
      if (queue.length >= 500) { log('[nexus-push] Outbox full; event not queued'); return false; }
      queue.push({ at: Date.now(), event: { ...event, id } }); save();
      void flush(); return true;
    } catch (e) { log(`[nexus-push] Could not persist event: ${e.message}`); return false; }
  }
  const timer = interval ? setInterval(() => { void flush(); }, interval) : null;
  timer?.unref();
  return { publish, flush, close() { clearInterval(timer); } };
}
module.exports = { createPushClient };
