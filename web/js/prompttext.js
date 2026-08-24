/* MOTIONSTILL CUT — showing a compiled prompt.
 *
 * The prompt is the artefact. Reading it back should be as informative as
 * writing it, and the one thing you cannot tell from the raw text is whether
 * <Picture 2> is the picture you meant — or, worse, whether it is a picture at
 * all. A tag with nothing behind it looks exactly like a tag that works, and
 * MiniMax H3 ignores the first silently.
 *
 * So a reference is rendered as a chip that carries what it names, coloured by
 * what kind of media it is, and marked in red when nothing is attached to it.
 * Everything else — the field keys, the shot markers, the camera sentences,
 * the dialogue tags — keeps the shape it always had.
 */

import { h } from "./util.js";
import { referenceInventory } from "./state.js";

/* <Subject N> is the label full-reference mode actually uses for a person or
 * a place; <Picture N> stays for a genuine frame anchor. Both are tags. */
const TAG_RE = /<(?:Subject|Picture|Video|Audio) \d+>/g;

const KIND_COLOUR = { picture: "#7fb2e5", video: "#c79ae0", audio: "#79c79b" };

/** tag → what is behind it, or null when nothing is. */
export function tagIndex(project) {
  const map = new Map();
  for (const e of referenceInventory(project)) {
    const entry = { kind: e.kind, label: e.ref?.label || e.ref?.name || e.kind, ref: e.ref };
    map.set(e.tag, entry);
    /* In full-reference mode a picture is cited as <Subject N>, but its SOURCE
     * label still appears — subject_definitions is the line that binds the two,
     * "<Subject 1> is the subject shown in <Picture 1>". Without this the chip
     * for that <Picture 1> renders as a dangling reference to a file that is
     * very much attached. */
    if (e.source && !map.has(e.source)) map.set(e.source, { ...entry, source: true });
  }
  // I2V's fixed first frame answers to <Picture 1> when the pool is empty.
  if (project?.mode === "i2v" && project.frames?.first && !(project.refs?.images || []).length) {
    map.set("<Picture 1>", {
      kind: "picture",
      label: project.frames.first.label || project.frames.first.name || "first frame",
      ref: project.frames.first,
    });
  }
  return map;
}

/** One reference tag, as a chip that says what it points at. */
export function tagChip(tag, index) {
  const hit = index.get(tag);
  return h("span", {
    class: `ptag${hit ? "" : " dangling"}`,
    style: hit ? { "--ptag": KIND_COLOUR[hit.kind] || "#7fb2e5" } : {},
    title: hit
      ? `${tag} — ${hit.label}${hit.ref?.retention ? `, kept ${hit.ref.retention}` : ""}`
      : `${tag} has nothing attached to it. The model ignores a tag with no media behind it.`,
    dataset: { tag },
  }, tag, hit ? h("i.ptag-name", hit.label) : h("i.ptag-name", "nothing attached"));
}

/**
 * The compiled prompt as DOM: safe by construction (no innerHTML), with the
 * reference tags carrying their media.
 *
 * @param {string} text
 * @param {object} project
 * @returns {DocumentFragment}
 */
export function renderPrompt(text, project) {
  const index = tagIndex(project);
  const frag = document.createDocumentFragment();

  for (const line of String(text || "").split("\n")) {
    // A leading `field_name:` is the prompt's own structure — and the REST of
    // that line still has to go through the highlighter, because the fields
    // that carry the tags (integrated_multimodal_description, subject_
    // definitions, retention_analysis) are exactly these lines. Emitting the
    // remainder as one text node put every tag in the prompt beyond reach.
    const key = /^(\w+):/.exec(line);
    const rest = key ? line.slice(key[0].length) : line;
    if (key) frag.appendChild(h("span.k", `${key[1]}:`));
    appendMarkup(frag, rest, index);
    frag.appendChild(document.createTextNode("\n"));
  }
  return frag;
}

/** Shot markers, cut times, dialogue tags and the two continuity markers, then
 *  the references inside whatever is left. A tag the tokenizer does not know
 *  renders as plain prose, which is how you end up unable to see that a
 *  <scenetrans> is in the wrong place. */
function appendMarkup(frag, line, index) {
  const parts = line.split(/(\[Shot \d+\]|At \d{2}:\d{2}\.\d{3}|<d>.*?<\/d>|<scenetrans>|<cutoff>)/g);
  for (const part of parts) {
    if (!part) continue;
    if (/^\[Shot \d+\]$/.test(part) || /^At \d{2}:\d{2}\.\d{3}$/.test(part)) {
      frag.appendChild(h("span.shot", part));
    } else if (/^<d>/.test(part)) {
      frag.appendChild(h("span.dlg", part));
    } else if (part === "<scenetrans>" || part === "<cutoff>") {
      frag.appendChild(h("span.cont", { title: part === "<scenetrans>"
        ? "The same line of dialogue continues across this cut"
        : "This line is cut off by the end of the video" }, part));
    } else {
      appendWithTags(frag, part, index);
    }
  }
}

function appendWithTags(frag, text, index) {
  let last = 0;
  for (const m of text.matchAll(TAG_RE)) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    frag.appendChild(tagChip(m[0], index));
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
}
