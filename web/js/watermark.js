/* ── Watermark ────────────────────────────────────────────────
 * Two marks, both drawn by the browser as a transparent PNG at the delivered
 * size, uploaded like any other input and composited over every frame by
 * stock nodes (LoadImage → InvertMask → ImageCompositeMasked). No text node
 * from any custom pack, and the mark is exactly what the canvas here draws.
 *
 *   signature — the name, small, bottom-right. A credit.
 *   client    — the name tiled diagonally across the whole frame at low
 *               opacity, plus the signature: a preview a client can judge
 *               and cannot use. Every frame carries it, so it survives a
 *               screenshot, a re-encode and a crop.
 *
 * The text lives in this browser's settings, not in the project: it is the
 * owner's name, and it is the same for every project.
 */
export const WATERMARK_MODES = ["off", "signature", "client"];

export function watermarkSettings(project, settings) {
  const mode = WATERMARK_MODES.includes(project?.render?.watermark) ? project.render.watermark : "off";
  const text = String(settings?.watermark?.text || "").trim();
  return { mode, text };
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Geometry only, so it can be tested without a canvas: the PNG's size, where
 *  it lands on the frame, and the type sizes the drawing uses. */
export function watermarkLayout(mode, width, height, text = "") {
  const short = Math.min(width, height);
  const font = clamp(Math.round(short / 26), 14, 72);
  const pad = Math.round(font * 0.5);
  const margin = Math.round(short / 40);
  // Roughly 0.58 em per character for a medium sans; the drawing right-aligns
  // inside the box, so a narrower face only leaves a little air on the left.
  const boxW = Math.min(width, Math.ceil(font * 0.58 * Math.max(4, text.length) + pad * 2));
  const boxH = Math.ceil(font * 1.6);
  const signature = { font, pad, boxW, boxH, x: width - boxW - margin, y: height - boxH - margin };
  if (mode === "signature") return { mode, width: boxW, height: boxH, x: signature.x, y: signature.y, font, pad, signature };
  const big = clamp(Math.round(short / 7), 28, 400);
  return {
    mode: "client", width, height, x: 0, y: 0, font, pad,
    signature: { ...signature, x: width - boxW - margin, y: height - boxH - margin },
    tile: { font: big, angle: -Math.PI / 6, stepX: Math.ceil(big * 0.58 * Math.max(6, text.length + 10)), stepY: big * 3, opacity: 0.2 },
  };
}

/** A stable input name: same mode, text and size → same file, so a re-render
 *  overwrites rather than litters ComfyUI/input. */
export function watermarkFileName(mode, text, width, height) {
  let h = 2166136261;
  for (const ch of `${mode}|${text}|${width}x${height}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return `mscut_wm_${mode}_${h.toString(16).padStart(8, "0")}.png`;
}

/** Browser only: the PNG as a data URL. */
export function drawWatermark({ mode, text, width, height }) {
  const layout = watermarkLayout(mode, width, height, text);
  const c = document.createElement("canvas");
  c.width = layout.width; c.height = layout.height;
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);

  const drawSignature = (ox, oy) => {
    const { font, pad, boxW, boxH } = layout.signature;
    ctx.save();
    ctx.font = `600 ${font}px system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.6)"; ctx.shadowBlur = Math.max(2, font / 6); ctx.shadowOffsetY = Math.max(1, font / 18);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fillText(text, ox + boxW - pad, oy + boxH / 2);
    ctx.restore();
  };

  if (layout.mode === "signature") { drawSignature(0, 0); return c.toDataURL("image/png"); }

  // The tile: rotated text on a diagonal grid, offset every other row so no
  // straight corridor of clean picture is left.
  const { tile } = layout;
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate(tile.angle);
  ctx.font = `700 ${tile.font}px system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const label = `${text} · PREVIEW`;
  const reach = Math.hypot(width, height);
  let rowIdx = 0;
  for (let y = -reach; y <= reach; y += tile.stepY, rowIdx++) {
    const shift = rowIdx % 2 ? tile.stepX / 2 : 0;
    for (let x = -reach - shift; x <= reach; x += tile.stepX) {
      ctx.lineWidth = Math.max(2, tile.font / 14);
      ctx.strokeStyle = `rgba(0,0,0,${tile.opacity * 1.4})`;
      ctx.strokeText(label, x + shift, y);
      ctx.fillStyle = `rgba(255,255,255,${tile.opacity})`;
      ctx.fillText(label, x + shift, y);
    }
  }
  ctx.restore();
  drawSignature(layout.signature.x, layout.signature.y);
  return c.toDataURL("image/png");
}
