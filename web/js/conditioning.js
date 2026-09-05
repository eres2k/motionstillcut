/* THE TWO AUDIO INPUTS OF AN LTX-2.5 RENDER — pickers shared by Create and
 * Deliver, because both answer to the same project fields:
 *
 *   render.ltxAudio.item — the CONDITIONING TRACK: what the clip's audio IS.
 *     The encoded file replaces the audio half of the AV latent and the
 *     video is generated against it (lip-sync, beat-sync).
 *   render.ltxVoice.item — the VOICE REFERENCE: who speaks when the model
 *     does the speaking. ~5 s of any voice (an mp3 is enough);
 *     LTXVReferenceAudio patches the speaker identity, and dialogue in the
 *     prompt comes out in that voice.
 *
 * A track fixes the sound, a reference fixes the speaker — they compose, and
 * neither is a render-only fact: both shape what the prompt should say (a
 * spoken track wants its words IN the prompt as dialogue; a cloned voice
 * needs dialogue at all). That is why the pickers live on Create too, not
 * only under Deliver ▸ Audio where the trim/separation knobs stay. */

import { h, toast, select, uid } from "./util.js";
import { update } from "./state.js";
import { putBlob } from "./media.js";

/** Every sound already in the project: the Edit page's audio tracks
 *  (voice-overs land there) and Ref2V's reference audios — plus whatever is
 *  currently picked, so a file from disk stays listed after a redraw. */
export function audioPool(p, ...picked) {
  const pool = [];
  const seen = new Set();
  const add = (id, name) => { if (id && !seen.has(id)) { seen.add(id); pool.push({ id, name: name || id }); } };
  for (const it of picked) if (it) add(it.id, it.name);
  for (const t of p.edit?.audio || []) if (t.kind === "audio") add(t.mediaId, t.name);
  for (const m of p.refs?.audios || []) add(m?.id, m?.name);
  return pool;
}

/** Browse for an audio file, keep the bytes in the pool, hand back a fresh
 *  media item ({ id, name, comfyName: "" }) — uploadPending moves the bytes
 *  to ComfyUI on the next render, exactly like a dropped first frame. */
export function pickAudioFile(cb) {
  const inp = h("input", { type: "file", accept: "audio/*,.wav,.mp3,.flac,.ogg,.m4a" });
  inp.onchange = async () => {
    const f = inp.files?.[0];
    if (!f) return;
    try {
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error("could not read the file")); r.readAsDataURL(f);
      });
      const id = uid();
      await putBlob(id, dataUrl);
      cb({ id, name: f.name, kind: "audio", comfyName: "" });
    } catch (e) { toast("File not read", e.message, "err"); }
  };
  inp.click();
}

/* One select for both fields: off · every pooled sound · browse. `field` is
 * "ltxAudio" or "ltxVoice"; picking writes a FRESH item (comfyName "") so a
 * re-pick after a ComfyUI change re-uploads. */
function audioSelect(p, field, offLabel, redraw) {
  const current = p.render?.[field]?.item || null;
  const pool = audioPool(p, current);
  const pick = (item) => {
    update((proj) => { proj.render[field] = { ...(proj.render[field] || {}), item }; }, "render");
    redraw();
  };
  return select(
    [["", offLabel], ...pool.map(x => [x.id, x.name]), ["__pick__", "a file from disk…"]],
    current ? current.id : "",
    (v) => {
      if (v === "") return pick(null);
      if (v === "__pick__") return pickAudioFile(pick);
      const hit = pool.find(x => x.id === v);
      if (hit) pick({ id: hit.id, name: hit.name, kind: "audio", comfyName: "" });
      // A cancelled browse leaves the select on "__pick__" — the caller's
      // redraw() after pick() is what snaps it back, so nothing to do here.
    },
  );
}

export const trackPicker = (p, redraw) => audioSelect(p, "ltxAudio", "off — the model writes the sound", redraw);
export const voicePicker = (p, redraw) => audioSelect(p, "ltxVoice", "off — the model invents a voice", redraw);
