/* MEDIA — the pool. Whatever the current mode conditions on lives here:
 * the fixed first frame for I2V, and the reference images, clips and audio
 * that Ref2V addresses as <Picture N>, <Video N> and <Audio N>. */

import { h, mount, clear, toast, field, select, checkbox, bytes, textarea } from "../util.js";
import { getProject, update, referenceInventory } from "../state.js";
import { ingest, getBlob, delBlob, posterFor } from "../media.js";
import { VISUAL_RETENTION, AUDIO_RETENTION } from "../vocab.js";
import { captionImage } from "../llm.js";
import { api } from "../api.js";
import { uploadName } from "../render.js";

let root = null;
let selectedBin = "images";
let selectedId = null;

const BINS = [
  { key: "first",  label: "First Frame",       ico: "▣", modes: ["i2v"], max: 1 },
  { key: "images", label: "Reference Images",  ico: "▤", modes: ["r2v"], max: 9, tag: "Picture" },
  { key: "videos", label: "Reference Videos",  ico: "▶", modes: ["r2v"], max: 3, tag: "Video" },
  { key: "audios", label: "Reference Audio",   ico: "♪", modes: ["r2v"], max: 3, tag: "Audio" },
];

const binItems = (p, key) =>
  key === "first" ? (p.frames.first ? [p.frames.first] : []) : (p.refs[key] || []);

function setBinItems(p, key, items) {
  if (key === "first") p.frames.first = items[0] || null;
  else p.refs[key] = items;
}

const acceptFor = (key) =>
  key === "audios" ? "audio/*" : key === "videos" ? "video/*" : "image/*";

async function addFiles(key, fileList) {
  const bin = BINS.find(b => b.key === key);
  const files = [...fileList];
  if (!files.length) return;
  const added = [];
  for (const file of files) {
    try {
      const item = await ingest(file);
      if (item.kind === "video") item.poster = await posterFor(await getBlob(item.id));
      added.push(item);
    } catch (err) { toast("Could not read the file", `${file.name}: ${err.message}`, "err"); }
  }
  if (!added.length) return;
  update((p) => {
    const current = binItems(p, key);
    const next = [...current, ...added].slice(0, bin.max);
    setBinItems(p, key, next);
    if (next.length < current.length + added.length) toast("Bin is full", `${bin.label} takes at most ${bin.max}.`, "warn");
  }, "media");
  selectedId = added[added.length - 1].id;
  refresh();
}

function removeItem(key, id) {
  update((p) => setBinItems(p, key, binItems(p, key).filter(m => m.id !== id)), "media");
  delBlob(id);
  if (selectedId === id) selectedId = null;
  refresh();
}

function patchItem(key, id, patch, reason = "media") {
  update((p) => {
    const items = binItems(p, key).map(m => (m.id === id ? { ...m, ...patch } : m));
    setBinItems(p, key, items);
  }, reason);
}

/* ── Left: bins ───────────────────────────────────────────── */
function binList(p) {
  const rows = BINS.map((b) => {
    const items = binItems(p, b.key);
    const active = b.modes.includes(p.mode);
    return h("div", {
      class: `bin${selectedBin === b.key ? " sel" : ""}`,
      style: active ? {} : { opacity: ".45" },
      title: active ? "" : `Used by ${b.modes.map(m => m.toUpperCase()).join(" / ")} — the current mode ignores it`,
      onclick: () => { selectedBin = b.key; selectedId = null; refresh(); },
    },
      h("span.ico", b.ico),
      h("span", b.label),
      h("span.count", `${items.length}${b.max > 1 ? `/${b.max}` : ""}`),
    );
  });

  return h("div.panel",
    h("div.hd", h("span.title", "Bins")),
    h("div.bd", ...rows,
      h("div", { style: { padding: "12px 10px" } },
        h("div.hint", p.mode === "t2v"
          ? "Text to Video conditions on nothing but the prompt — the pool stays empty."
          : p.mode === "i2v"
            ? "Image to Video anchors the clip's first frame. One image, matched to the canvas."
            : "Ref2V reads up to 9 images, 3 clips and 3 audio files, and the prompt addresses them by tag."),
      ),
    ),
  );
}

/* ── Centre: the pool itself ──────────────────────────────── */
function pool(p) {
  const bin = BINS.find(b => b.key === selectedBin) || BINS[1];
  const items = binItems(p, bin.key);
  const inv = referenceInventory(p);
  const tagOf = (item) => inv.find(e => e.ref?.id === item.id)?.tag || "";

  const input = h("input", {
    type: "file", accept: acceptFor(bin.key), multiple: bin.max > 1,
    style: { display: "none" },
    onchange: (e) => { addFiles(bin.key, e.target.files); e.target.value = ""; },
  });

  const zone = h("div.dropzone", {
    onclick: () => input.click(),
    ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add("over"); },
    ondragleave: (e) => e.currentTarget.classList.remove("over"),
    ondrop: (e) => {
      e.preventDefault();
      e.currentTarget.classList.remove("over");
      addFiles(bin.key, e.dataTransfer.files);
    },
  }, h("div", { style: { fontSize: "20px", opacity: ".4", marginBottom: "4px" } }, "⬇"),
     h("div", `Drop ${bin.label.toLowerCase()} here, or click to browse`),
     h("div.hint", { style: { marginTop: "3px" } }, `${items.length} of ${bin.max} used`));

  const tiles = items.map((m) => {
    const tile = h("div", {
      class: `tile${selectedId === m.id ? " sel" : ""}`,
      onclick: () => { selectedId = m.id; refresh(); },
    },
      h("div.pic", m.kind === "audio" ? "♪" : m.kind === "video" ? "▶" : "▣"),
      tagOf(m) ? h("span", { class: `tag ${m.kind === "video" ? "t-vid" : m.kind === "audio" ? "t-aud" : "t-pic"} corner-tag` }, tagOf(m)) : null,
      h("button.kill", { title: "Remove", onclick: (e) => { e.stopPropagation(); removeItem(bin.key, m.id); } }, "✕"),
      h("div.cap", m.label || m.name),
    );
    const pic = tile.querySelector(".pic");
    if (m.kind === "image" || m.poster) {
      getBlob(m.id).then((data) => {
        const src = m.kind === "image" ? data : m.poster;
        if (src) { pic.style.backgroundImage = `url("${src}")`; pic.textContent = ""; }
      });
    }
    return tile;
  });

  const imageBin = bin.key !== "audios" && bin.key !== "videos";
  const uncaptioned = items.filter(m => m.kind === "image" && !(m.caption || "").trim()).length;

  return h("div.panel",
    h("div.hd",
      h("span.title", bin.label),
      h("span.spacer"),
      imageBin && items.length ? h("button.btn.sm.ai", {
        title: "Look at every image in this bin and write what is in it",
        onclick: (e) => describeAll(e.currentTarget, bin.key, items),
      }, uncaptioned ? `✨ Describe ${uncaptioned}` : "✨ Re-describe all") : null,
      h("button.btn.sm", { onclick: () => input.click() }, "＋ Add"),
      items.length ? h("button.btn.sm.ghost", {
        onclick: () => { items.forEach(m => delBlob(m.id)); update(p2 => setBinItems(p2, bin.key, []), "media"); refresh(); },
      }, "Clear") : null,
    ),
    h("div.bd",
      input,
      h("div", { style: { padding: "10px 10px 0" } }, zone),
      items.length ? h("div.grid", ...tiles) : h("div", { style: { padding: "18px", textAlign: "center" } }, h("div.hint", "Nothing in this bin yet.")),
    ),
  );
}

/* Caption a whole bin. The prompt optimizer reads captions when it cannot read
 * pixels, and a pool of nine references nobody has described is the usual
 * reason a rewrite comes back generic. */
async function describeAll(btn, binKey, items) {
  const targets = items.filter(m => m.kind === "image");
  if (!targets.length) return;
  const label = btn.textContent;
  btn.classList.add("disabled");
  let done = 0, failed = 0;
  for (const item of targets) {
    btn.textContent = `looking… ${done + failed + 1}/${targets.length}`;
    try {
      const data = await getBlob(item.id);
      if (!data) { failed++; continue; }
      const { caption } = await captionImage(data, { purpose: binKey === "first" ? "first frame" : "reference" });
      patchItem(binKey, item.id, { caption });
      done++;
    } catch (err) {
      failed++;
      // One unreachable model means the rest will fail the same way.
      if (/unreachable|not signed in|timed out/i.test(err.message)) {
        toast("Vision failed", err.message, "err");
        break;
      }
    }
  }
  btn.classList.remove("disabled");
  btn.textContent = label;
  toast(`${done} described`, failed ? `${failed} could not be read.` : "Handed to the rewriter with the prompt.", failed ? "warn" : "ok");
  refresh();
}

/* ── Right: the item inspector ────────────────────────────── */
function inspector(p) {
  const bin = BINS.find(b => b.key === selectedBin) || BINS[1];
  const items = binItems(p, bin.key);
  const item = items.find(m => m.id === selectedId) || items[0] || null;
  const body = h("div.insp");

  if (!item) {
    body.appendChild(h("div", { style: { padding: "16px" } },
      h("div.hint", "Select something in the pool to inspect it.")));
  } else {
    const inv = referenceInventory(p);
    const tag = inv.find(e => e.ref?.id === item.id)?.tag || "";
    const preview = h("div", { style: { padding: "10px" } });
    getBlob(item.id).then((data) => {
      if (!data) return;
      clear(preview);
      if (item.kind === "image") preview.appendChild(h("img", { src: data, style: { width: "100%", borderRadius: "2px", border: "1px solid #000" } }));
      else if (item.kind === "video") preview.appendChild(h("video", { src: data, controls: "", style: { width: "100%", borderRadius: "2px", background: "#000" } }));
      else preview.appendChild(h("audio", { src: data, controls: "", style: { width: "100%" } }));
    });

    // The visual marker always describes what the eye takes from a reference;
    // a clip's soundtrack gets its own marker above.
    const retentionOptions = item.kind === "audio" ? AUDIO_RETENTION : VISUAL_RETENTION;

    body.append(
      preview,
      h("div", { style: { padding: "0 10px 10px" } },
        tag ? h("div.flex", { style: { marginBottom: "7px" } },
          h("span", { class: `tag ${item.kind === "video" ? "t-vid" : item.kind === "audio" ? "t-aud" : "t-pic"}` }, tag),
          h("span.hint", "how the prompt addresses it")) : null,
        field("Label", h("input", {
          type: "text", value: item.label || "",
          oninput: (e) => patchItem(bin.key, item.id, { label: e.target.value }, "text"),
        })),
        h("div.hint", `${item.name} · ${bytes(item.size)}${item.comfyName ? ` · uploaded as ${item.comfyName}` : " · not uploaded yet"}`),
      ),
    );

    if (bin.key === "videos") {
      body.appendChild(h("div", { style: { padding: "0 10px 10px" } },
        checkbox("Use this clip's own soundtrack", !!item.useAudio,
          (v) => { patchItem(bin.key, item.id, { useAudio: v }); refresh(); },
          "Feeds ref_video_audio_N alongside the frames — the clip's audio claims an <Audio> tag just before its <Video> tag"),
        item.useAudio ? h("div", { style: { marginTop: "6px" } },
          h("label.hint", "Soundtrack retention"),
          select(AUDIO_RETENTION.map(r => [r[0], r[1]]), item.audioRetention || "reference",
            (v) => patchItem(bin.key, item.id, { audioRetention: v })),
        ) : null,
        h("div.hint", { style: { marginTop: "5px" } },
          "H3 reads reference frames as 24 fps and the stock loader passes the file's own rate through — export reference clips at 24 fps and their motion lines up exactly."),
      ));
    }

    if (p.mode === "r2v") {
      body.appendChild(h("div", { style: { padding: "0 10px 10px" } },
        h("h4.sec", "Retention"),
        select(retentionOptions.map(r => [r[0], r[1]]), item.retention || (item.kind === "audio" ? "fully_copy" : "fully_preserved"),
          (v) => patchItem(bin.key, item.id, { retention: v })),
        h("div.hint", { style: { marginTop: "4px" } },
          retentionOptions.find(r => r[0] === (item.retention || (item.kind === "audio" ? "fully_copy" : "fully_preserved")))?.[2] || ""),
        h("div", { style: { marginTop: "7px" } },
          h("label.hint", "Note carried into retention_analysis"),
          textarea(item.note || "", (v) => patchItem(bin.key, item.id, { note: v }, "text"),
            { rows: 2, placeholder: "e.g. keep the jacket, change the pose" })),
      ));
    }

    body.appendChild(h("div", { style: { padding: "0 10px 14px" } },
      h("h4.sec", "Description"),
      textarea(item.caption || "", (v) => patchItem(bin.key, item.id, { caption: v }, "text"),
        { rows: 4, placeholder: item.kind === "image" ? "What is in this image?" : "What does this reference carry?" }),
      item.kind === "image" ? h("button.btn.ai.sm", {
        style: { marginTop: "6px" },
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.textContent = "looking…"; btn.classList.add("disabled");
          try {
            const data = await getBlob(item.id);
            const { caption } = await captionImage(data, { purpose: bin.key === "first" ? "first frame" : "reference" });
            patchItem(bin.key, item.id, { caption });
            toast("Described", "", "ok");
            refresh();
          } catch (err) { toast("Vision failed", err.message, "err"); }
          finally { btn.textContent = "✨ Describe with the LLM"; btn.classList.remove("disabled"); }
        },
      }, "✨ Describe with the LLM") : null,
      h("div.hint", { style: { marginTop: "6px" } },
        bin.key === "first"
          ? "I2V's opening must match this frame exactly or the model cuts away from it in the first second — the description is handed to the rewriter."
          : "Handed to the rewriter so the prompt cites this reference for what it actually shows."),
    ));

    body.appendChild(h("div", { style: { padding: "0 10px 16px" } },
      h("button.btn.sm.wide", {
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.textContent = "uploading…"; btn.classList.add("disabled");
          try {
            const data = await getBlob(item.id);
            const r = await api.upload(uploadName(item), data);
            patchItem(bin.key, item.id, { comfyName: r.subfolder ? `${r.subfolder}/${r.name}` : r.name });
            toast("Uploaded to ComfyUI", r.name, "ok");
            refresh();
          } catch (err) { toast("Upload failed", err.message, "err"); }
          finally { btn.classList.remove("disabled"); btn.textContent = "Upload to ComfyUI now"; }
        },
      }, "Upload to ComfyUI now"),
      h("div.hint", { style: { marginTop: "5px" } }, "Deliver uploads whatever it needs before it queues — this is only for the download-the-JSON path."),
      h("button.btn.sm.wide", { style: { marginTop: "8px" }, onclick: () => removeItem(bin.key, item.id) }, "Remove from pool"),
    ));
  }

  return h("div.panel", h("div.hd", h("span.title", "Inspector")), h("div.bd", body));
}

function draw() {
  const p = getProject();
  // A bin the current mode doesn't use is a confusing place to land.
  if (!BINS.find(b => b.key === selectedBin)?.modes.includes(p.mode)) {
    selectedBin = p.mode === "i2v" ? "first" : "images";
  }
  mount(root, h("div.cols", binList(p), pool(p), inspector(p)));
}

export function render(el) { root = el; draw(); }
export function refresh() { if (root) draw(); }
