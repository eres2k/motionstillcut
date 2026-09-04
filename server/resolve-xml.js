/* FCPXML 1.9: independent source clips, source trims, clip sound and connected
 * audio. Resolve imports this directly; media remains editable with handles. */
import { pathToFileURL } from "node:url";

const xml = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
function rate(fps) {
  for (const n of [24000, 30000, 60000]) if (Math.abs(fps - n / 1001) < .01) return [n, 1001];
  return [Math.round(fps) || 24, 1];
}
const time = (seconds, fps) => { const [n, d] = rate(fps); return `${Math.round(seconds * n / d) * d}/${n}s`; };

export function resolveXml({ name, fps, width, height, clips, audio = [] }) {
  const assets = [], formats = [], ids = new Map();
  function asset(c) {
    if (ids.has(c.file)) return ids.get(c.file);
    const id = `a${ids.size + 1}`, format = `f${ids.size + 1}`;
    ids.set(c.file, id);
    const p = c.probe, sourceFps = p.fps || fps, [n, d] = rate(sourceFps);
    if (!(p.duration > 0)) throw new Error(`${c.name}: source duration is unknown.`);
    if (p.width) formats.push(`<format id="${format}" frameDuration="${d}/${n}s" width="${p.width}" height="${p.height}"/>`);
    assets.push(`<asset id="${id}" name="${xml(c.name)}" start="0s" duration="${time(p.duration, sourceFps)}" hasVideo="${p.width ? 1 : 0}" hasAudio="${p.hasAudio ? 1 : 0}"${p.width ? ` format="${format}"` : ""}${p.hasAudio ? ` audioSources="1" audioChannels="${p.audioChannels || 2}" audioRate="${p.sampleRate || 48000}"` : ""}><media-rep kind="original-media" src="${xml(pathToFileURL(c.file).href)}"/></asset>`);
    return id;
  }
  clips.forEach(asset); audio.forEach(asset);
  const totalFrames = clips.reduce((sum, c) => sum + Math.round((c.end - c.start) * fps), 0);
  const duration = totalFrames / fps;
  const connected = audio.map((a, i) => {
    const length = Math.min(a.probe.duration, duration - a.at);
    if (length <= 0) return "";
    const gain = a.gain > 0 ? Math.max(-96, 20 * Math.log10(a.gain)) : -96;
    return `<asset-clip ref="${asset(a)}" name="${xml(a.name)}" lane="-${i + 1}" offset="${time(clips[0].start + a.at, fps)}" start="0s" duration="${time(length, fps)}" srcEnable="audio" audioRole="dialogue"><adjust-volume amount="${gain.toFixed(3)}dB"/></asset-clip>`;
  }).join("");
  let frames = 0;
  const spine = clips.map((c, i) => {
    const lengthFrames = Math.round((c.end - c.start) * fps);
    const entry = `<asset-clip ref="${asset(c)}" name="${xml(c.name)}" offset="${time(frames / fps, fps)}" start="${time(c.start, c.probe.fps || fps)}" duration="${time(lengthFrames / fps, fps)}"${c.mute ? ' srcEnable="video"' : ""}>${i === 0 ? connected : ""}</asset-clip>`;
    frames += lengthFrames;
    return entry;
  }).join("");
  const [n, d] = rate(fps);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9"><resources><format id="timeline" frameDuration="${d}/${n}s" width="${width}" height="${height}"/>${formats.join("")}${assets.join("")}</resources><library><event name="Motionstill Cut"><project name="${xml(name)}"><sequence format="timeline" tcStart="0s" tcFormat="NDF" duration="${time(duration, fps)}"><spine>${spine}</spine></sequence></project></event></library></fcpxml>`;
}
