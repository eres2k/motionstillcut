/* ── Voice-over, the browser half ──────────────────────────────
 * The server speaks (server/voice.js); this side turns what comes back into
 * a media item the editor can lay on its audio track, and asks the LLM for
 * a script when there is none. */
import { api } from "./api.js";
import { putBlob } from "./media.js";
import { uid } from "./util.js";

export const VOICE_ENGINES = [
  ["qwen",   "Qwen3-TTS · fast",     "~4 GB, 24 kHz, clones from a clip; German needs a German clip"],
  ["voxcpm", "VoxCPM2 · best clone", "~8 GB, 48 kHz, the better clone, takes a style note on top"],
];

export const VOICE_LANGS = [["de", "Deutsch"], ["en", "English"], ["fr", "Français"], ["es", "Español"], ["it", "Italiano"], ["pt", "Português"]];

/** Length of a WAV data URL, from its header — no decode. */
export function wavSeconds(dataUrl) {
  try {
    const b64 = String(dataUrl).split(",")[1] || "";
    const head = atob(b64.slice(0, 120));
    const bytes = Uint8Array.from(head, c => c.charCodeAt(0));
    const dv = new DataView(bytes.buffer);
    if (String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF") return 0;
    const byteRate = dv.getUint32(28, true);
    const total = Math.round((b64.length * 3) / 4) - 44;
    return byteRate ? total / byteRate : 0;
  } catch { return 0; }
}

/** Ask the server to speak, keep the result as media, return the item. */
export async function generateVoiceover({ engine = "qwen", text, voice = "default", language = "de", speed = 1, instruct = "", name = "" } = {}) {
  const r = await api.speak({ engine, text, voice, language, speed, instruct });
  const id = uid();
  await putBlob(id, r.audio);
  const seconds = wavSeconds(r.audio);
  const item = {
    id, kind: "audio", size: r.bytes || 0, addedAt: Date.now(),
    name: `${(name || text).slice(0, 40).replace(/[^\w\s-]+/g, "").trim() || "voice-over"}.wav`,
    label: name || text.slice(0, 40),
    comfyName: "", caption: "", retention: "", note: "", useAudio: false,
    voiceover: { engine, voice, language, speed, instruct, text, ms: r.ms || 0 },
    duration: seconds,
  };
  return item;
}
