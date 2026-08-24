/**
 * MOTIONSTILL CUT — the local app.
 *
 *   node server/server.js          → http://127.0.0.1:3091
 *
 * Zero dependencies: Node 18+ and nothing else. On the first run it opens
 * the browser on a one-page setup wizard (/setup), where local server saving
 * is switched on or off:
 *
 *   saving ON   projects, library, rulebook, cast and settings live as plain
 *               JSON under data/; both engines are proxied (no CORS setup);
 *               multi-clip films are joined with ffmpeg when it is installed
 *   saving OFF  this process only hosts the interface; the app behaves
 *               exactly like the hosted web version — everything stays in
 *               the browser
 *
 * Env:
 *   CUT_PORT        listen port          (default 3091)
 *   CUT_HOST        listen address       (default 127.0.0.1)
 *   CUT_PW          optional password; unset = open, which is fine on
 *                   localhost and not fine on anything you tunnel
 *   CUT_COMFY_URL   ComfyUI base         (default http://127.0.0.1:8188)
 *   CUT_LLM_URL     LLM server base      (default http://127.0.0.1:1234)
 *   CUT_LLM_KEY     optional API key for the LLM server
 *   CUT_VRAM_SAVER  0/1 — one engine on the GPU at a time (default 1)
 *   CUT_SAVING      0/1 — force local server saving off/on
 *   CUT_NO_OPEN     1 — never auto-open the browser
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { createCutHandler, CUT_VERSION, savingEnabled } from "./router.js";
import { loadSettings, SETTINGS_FILE } from "./settings.js";

const PORT = parseInt(process.env.CUT_PORT || "3091", 10);
const HOST = process.env.CUT_HOST || "127.0.0.1";
const PW = (process.env.CUT_PW || "").trim();

/* Signed, self-describing tokens rather than a server-side set, so a restart
 * doesn't log everyone out mid-edit. The secret is per-process when no
 * password is set (in which case nothing checks tokens anyway). */
const SECRET = PW ? `cut:${PW}` : randomBytes(32).toString("hex");
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;

function sign(payload) {
  return createHmac("sha256", SECRET).update(payload).digest("base64url");
}

function makeToken() {
  const payload = `${Date.now() + TOKEN_TTL_MS}`;
  return `cut.${payload}.${sign(payload)}`;
}

function validToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== "cut") return false;
  const expected = Buffer.from(sign(parts[1]));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  return Number(parts[1]) > Date.now();
}

const handler = createCutHandler(
  PW
    ? {
        auth: async (req) => {
          const header = req.headers.authorization || "";
          let token = header.startsWith("Bearer ") ? header.slice(7) : "";
          if (!token) {
            // A <video src> and an <img src> cannot carry a header, so media
            // URLs sign themselves with ?_t=… instead. Same tokens, same
            // check — but ONLY on the media routes: a token in a URL ends up
            // in logs, in history and in Referer headers, so the exception is
            // limited to the requests that cannot be made any other way — a
            // clip out of ComfyUI, and an assembled film off this server.
            try {
              const u = new URL(req.url || "/", "http://cut.local");
              if (u.pathname === "/api/comfy/view" || u.pathname === "/api/film/view") {
                token = u.searchParams.get("_t") || "";
              }
            } catch { token = ""; }
          }
          return validToken(token);
        },
        login: async (password) => {
          const a = Buffer.from(password || ""), b = Buffer.from(PW);
          if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
          return makeToken();
        },
      }
    : {},
);

const server = createServer((req, res) => {
  // Standalone serves the editor at both / and /cut/, so a link copied out of
  // the mounted instance still resolves here.
  if (req.url === "/cut") { res.writeHead(302, { Location: "/cut/" }); return res.end(); }
  if (req.url?.startsWith("/cut/")) req.url = req.url.slice("/cut".length);
  handler(req, res, () => {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }).catch((err) => {
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  });
});

/** Open the default browser on `url`. Best effort and silent about failure —
 *  the banner prints the address either way. */
function openBrowser(url) {
  if (process.env.CUT_NO_OPEN === "1") return;
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] :
    process.platform === "win32"  ? ["cmd", ["/c", "start", "", url]] :
                                    ["xdg-open", [url]];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref(); }
  catch { /* headless box, container, WSL without a browser — the URL is printed */ }
}

server.listen(PORT, HOST, () => {
  const s = loadSettings();
  const firstRun = !s.local?.setupDone;
  const editorUrl = `http://${HOST}:${PORT}/`;
  const line = (l, r) => console.log(`  ║  ${String(l).padEnd(11)}${String(r).slice(0, 46).padEnd(46)}║`);
  console.log("");
  console.log("  ╔═══════════════════════════════════════════════════════════╗");
  console.log("  ║              M O T I O N S T I L L   C U T                ║");
  console.log("  ║        MiniMax H3 · T2V · I2V · Ref2V · online cut        ║");
  console.log("  ╠═══════════════════════════════════════════════════════════╣");
  line("Editor", editorUrl);
  if (firstRun) line("First run", `setup wizard at ${editorUrl}setup`);
  line("Saving", savingEnabled()
    ? "LOCAL — projects & library on disk (data/)"
    : "browser only — this app just hosts the UI");
  line("ComfyUI", s.comfy.url);
  line("LLM", s.llm.url);
  line("VRAM saver", s.vram.saver ? "ON — one engine on the GPU at a time" : "off");
  line("Password", PW ? "required (CUT_PW)" : "none — localhost only, please");
  line("Settings", SETTINGS_FILE);
  line("Version", CUT_VERSION);
  console.log("  ╚═══════════════════════════════════════════════════════════╝");
  console.log("");
  // First use should not begin with copying a URL out of a terminal: the
  // wizard opens itself. After that the user knows where the editor lives.
  if (firstRun) openBrowser(`${editorUrl}setup`);
});

server.on("clientError", (err, socket) => {
  if (["ECONNRESET", "EPIPE", "ECANCELED"].includes(err.code)) return socket.destroy();
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

process.on("uncaughtException", (err) => {
  if (["ECONNRESET", "EPIPE", "ECONNABORTED"].includes(err.code)) return;
  console.error("[CUT] uncaught:", err);
});
