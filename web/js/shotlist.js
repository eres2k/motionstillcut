/* A SHOT LIST FROM A MODEL, MADE HONEST.
 *
 * Asked for four shots, a model will sometimes hand back one shot whose
 * beats read "Hard cut to close-up, glances at laptop". That is a cut
 * written as an action — and to the compiler it is a beat, so the whole
 * clip lands in one shot with the cuts described to a model that was never
 * told to make them. A cut is a new shot, always. This splits any beat that
 * opens with a cut into a shot of its own, keeps the framing it names, and
 * spaces the new shots across the clip when the model gave no times. Pure,
 * so it is tested. */

const CUT_RE = /^(?:then[,\s]+)?(?:(?:a|the)\s+)?(?:(hard|match|smash|jump)\s+)?(?:cut|cuts)\s+(?:to|into)\s+(?:(?:a|an|the)\s+)?/i;
const VIEW_RE = /^(?:the\s+)?(?:view|camera|shot|image)\s+(?:cuts|hard\s+cuts)\s+to\s+(?:(?:a|an|the)\s+)?/i;
const DISSOLVE_RE = /^(?:then[,\s]+)?(?:(?:a|the)\s+)?(?:image\s+|shot\s+)?(dissolve|dissolves|fade|fades)\s+(?:to|into)\s+(?:(?:a|an|the)\s+)?/i;

const SHOT_TYPES = [
  ["extreme close-up", /^(extreme|big)\s+close[- ]?up/i],
  ["close-up", /^close[- ]?up/i],
  ["medium close-up", /^medium\s+close[- ]?up/i],
  ["medium", /^(medium|mid)(\s+shot)?/i],
  ["wide", /^(wide|long|establishing)(\s+shot)?/i],
  ["extreme wide", /^extreme\s+wide/i],
  ["over-the-shoulder", /^over[- ]the[- ]shoulder/i],
];

/** "close-up, glances at laptop" → { shotType: "close-up", rest: "glances at laptop" } */
export function readFraming(text) {
  const t = String(text || "").trim();
  for (const [type, re] of [SHOT_TYPES[2], SHOT_TYPES[0], SHOT_TYPES[5], ...SHOT_TYPES]) {
    const m = re.exec(t);
    if (m) {
      const rest = t.slice(m[0].length).replace(/^\s*(shot\s+)?(of\s+[^,;:]+)?[,;:—-]?\s*/i, "").trim();
      return { shotType: type, rest, framingOf: (/^\s*(shot\s+)?of\s+([^,;:]+)/i.exec(t.slice(m[0].length)) || [])[2]?.trim() || "" };
    }
  }
  return { shotType: null, rest: t, framingOf: "" };
}

/** Is this beat really a cut? Returns { verb, remainder } or null. */
export function cutInBeat(text) {
  const t = String(text || "").trim();
  let m = CUT_RE.exec(t);
  if (m) return { verb: /dissolve|fade/i.test(m[1] || "") ? m[1] : "the camera cuts to", remainder: t.slice(m[0].length) };
  m = VIEW_RE.exec(t);
  if (m) return { verb: "the camera cuts to", remainder: t.slice(m[0].length) };
  m = DISSOLVE_RE.exec(t);
  if (m) return { verb: /fade/i.test(m[1]) ? "the shot fades to" : "the shot dissolves to", remainder: t.slice(m[0].length) };
  return null;
}

/**
 * @param {Array} shots   as the model returned them: { at, shotType, subject, beats: [string|{text}], ... }
 * @param {number} duration  clip length in seconds
 * @returns {Array} shots with every cut-beat promoted to a shot of its own
 */
export function splitCutBeats(shots, duration) {
  const out = [];
  for (const shot of shots || []) {
    const beats = (Array.isArray(shot.beats) ? shot.beats : [shot.action || ""]).map(b => typeof b === "string" ? b : (b?.text || ""));
    let cur = { ...shot, beats: [] };
    out.push(cur);
    for (const b of beats) {
      const cut = cutInBeat(b);
      if (!cut) { cur.beats.push(b); continue; }
      {
        const { shotType, rest, framingOf } = readFraming(cut.remainder);
        cur = {
          ...shot,
          at: undefined,
          shotType: shotType || shot.shotType || "medium",
          subject: framingOf || shot.subject || "",
          beats: rest ? [rest] : [],
          cutVerb: cut.verb,
          details: "",
          _split: true,
        };
        out.push(cur);
      }
    }
  }
  // A shot the model gave no time (every split one) is spaced evenly between
  // its neighbours that have one; the first is always 0.
  const total = Math.max(1, Number(duration) || 0);
  const known = (i) => Number.isFinite(Number(out[i]?.at)) && out[i].at !== undefined && out[i].at !== null;
  if (out.length) out[0].at = 0;
  for (let i = 1; i < out.length; i++) {
    if (known(i) && Number(out[i].at) > Number(out[i - 1].at)) { out[i].at = Number(out[i].at); continue; }
    let j = i; while (j < out.length && !(known(j) && Number(out[j].at) > Number(out[i - 1].at))) j++;
    const from = Number(out[i - 1].at), to = j < out.length ? Number(out[j].at) : total;
    const gaps = j - i + 1;
    for (let k = i; k < j; k++) out[k].at = Math.round((from + (to - from) * (k - i + 1) / gaps) * 100) / 100;
    i = j - 1;
  }
  return out.map(s => { const { _split, ...rest } = s; return rest; });
}

/** A beat with its cut phrase removed: "Cut to medium shot, the camera
 *  glides toward the tower" → "the camera glides toward the tower". A cut
 *  inside a beat is a cut the model performs mid-shot — on top of the one
 *  the shot already opens with — so the phrase never reaches the prompt. */
export function stripCutPrefix(text) {
  const cut = cutInBeat(text);
  if (!cut) return String(text || "");
  const { rest } = readFraming(cut.remainder);
  return (rest || cut.remainder || "").trim();
}
