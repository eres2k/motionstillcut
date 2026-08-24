/* MOTIONSTILL CUT — who H3 already knows.
 *
 * H3 was trained on a lot of film and television, and for some characters
 * writing the name is enough: "Walter White" renders Walter White. For most
 * it is not, and the name renders a stranger — which is worse than useless,
 * because it looks like it should have worked.
 *
 * malcolmrey generated test clips character by character and judged each one
 * by eye. The result is web/assets/known-characters.tsv, 1293 names sorted
 * into three buckets:
 *
 *   https://huggingface.co/datasets/malcolmrey/various  (h3-center/known-characters)
 *
 * It is community testing rather than an official list, and it is one
 * person's read of a handful of clips per name, so everything downstream of
 * it is a hint: the picker says what was seen, and the checker warns rather
 * than errors. Naming a character it calls unusable is a perfectly reasonable
 * thing to do if you have a reference image pinning the face.
 */

import { h, mount, modal, closeModal, debounce } from "./util.js";

export const STATUS = {
  g: { label: "reproduced",   icon: "✓", tone: "ok",
       blurb: "The name alone rendered someone recognisable." },
  f: { label: "mixed",        icon: "~", tone: "warn",
       blurb: "Sometimes recognisable, sometimes not — worth a reference image." },
  b: { label: "unrecognised", icon: "✕", tone: "err",
       blurb: "The name alone rendered a stranger. Describe them, or pin the face with a reference." },
};

const SOURCE_URL = "https://huggingface.co/datasets/malcolmrey/various";

/* ── The data ────────────────────────────────────────────────
 * Fetched once, on demand. 59 KB of TSV that most sessions never open, so it
 * is not worth putting in the module graph — but every caller can ask for it
 * without caring who asked first. */

let rows = [];
let byName = new Map();
let loading = null;

export const knownCast = () => rows;

/** Fold case and accents so "Éowyn" is findable by typing "eowyn". */
const fold = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export function loadKnownCast() {
  if (loading) return loading;
  loading = fetch(new URL("../assets/known-characters.tsv", import.meta.url))
    .then(r => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((text) => {
      return adoptKnownCast(parseIndex(text));
    })
    .catch((err) => {
      // A missing index is a missing convenience, never a broken editor: the
      // picker says so and everything else carries on as if the file did not
      // exist.
      console.warn("[knowncast] could not read the character index:", err.message);
      loading = null;
      rows = [];
      return rows;
    });
  return loading;
}

/** The shipped TSV → entries. Exported because the unit test is the second
 *  caller: it reads the file off disk and checks the index the app ships
 *  against the buckets the source index actually declared. */
export function parseIndex(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line || line[0] === "#") continue;
    const [status, name, actor, franchise, clips] = line.split("\t");
    if (!STATUS[status] || !name) continue;
    out.push({
      status, name,
      actor: actor || name,          // blank in the file means "plays themselves"
      franchise: franchise || "",
      clips: Number(clips) || 1,
      real: !actor,                  // a real person rather than a character
    });
  }
  return out;
}

/** Adopt a parsed index. loadKnownCast() is the normal caller; the test uses
 *  it to seed the same lookups from disk. */
export function adoptKnownCast(list) {
  rows = Array.isArray(list) ? list : [];
  byName = new Map(rows.map(e => [fold(e.name), e]));
  buildScanIndex();
  return rows;
}

/** What the index says about this exact name, or null. */
export function lookupKnown(name) {
  return byName.get(fold(name).trim()) || null;
}

/* ── Search ──────────────────────────────────────────────────
 * Ranked so the thing you typed the start of comes first: a name prefix beats
 * a name substring beats the actor beats the franchise. Typing "cranston"
 * finds Walter White, and typing "the office" finds everyone in it. */
export function searchKnown(query, { status = "", limit = 60 } = {}) {
  const q = fold(query).trim();
  const pool = status ? rows.filter(e => e.status === status) : rows;
  if (!q) {
    const sorted = [...pool].sort((a, b) => a.name.localeCompare(b.name));
    return { hits: sorted.slice(0, limit), total: sorted.length };
  }
  const scored = [];
  for (const e of pool) {
    const n = fold(e.name);
    let s = 0;
    if (n === q) s = 100;
    else if (n.startsWith(q)) s = 80;
    else if (n.includes(q)) s = 60;
    else if (fold(e.actor).includes(q)) s = 40;
    else if (fold(e.franchise).includes(q)) s = 20;
    if (s) scored.push({ e, s });
  }
  scored.sort((a, b) => b.s - a.s || a.e.name.localeCompare(b.e.name));
  return { hits: scored.slice(0, limit).map(x => x.e), total: scored.length };
}

/* ── Finding names in a prompt ───────────────────────────────
 *
 * Some of these names are also ordinary English — Angel, Data, Driver,
 * Eleven, God, Ray, Vision, Wash, Wolverine, and "The Doctor" in any scene
 * set in a hospital. A scanner that flags "the driver pulls away" for naming
 * a character from Drive is a scanner people learn to ignore, so those names
 * are skipped here and stay fully searchable in the picker. Under-reporting
 * costs a hint; crying wolf costs the checker its credibility.
 */
const AMBIGUOUS = new Set([
  "angel", "bane", "bill", "blade", "bubbles", "data", "driver", "eleven",
  "frenchie", "god", "jay", "jinx", "magneto", "max", "peacemaker", "penny",
  "q", "ray", "spike", "tallahassee", "trinity", "vi", "vision", "wash",
  "wolverine",
  // Names that are a role plus an article, and so are also how you would
  // write an extra you have not named.
  "the doctor", "the narrator", "the bride", "the man in black",
]);

const scannable = (e) => !AMBIGUOUS.has(fold(e.name));

/* One pass over the text, not 1293 regexes over it.
 *
 * The first version compiled a pattern per character and ran all of them on
 * every check — 70 ms, on a function the editor calls after every keystroke.
 * This one buckets the names by their own first word, so a word in the prompt
 * is only compared against the handful of names that could start with it.
 * Same answers, about three hundred times faster. */
const TOKEN = /[\p{L}\p{N}'\u2019-]+/gu;
const WORDISH = /[\p{L}\p{N}'\u2019-]/u;
/* A typographic apostrophe and a typewriter one are the same letter to a
 * reader, and the index only has one of them. */
const flat = (s) => s.toLowerCase().replace(/\u2019/g, "'");

let scanIndex = new Map();

function buildScanIndex() {
  scanIndex = new Map();
  for (const e of rows) {
    if (!scannable(e)) continue;
    TOKEN.lastIndex = 0;
    const first = TOKEN.exec(e.name);
    if (!first) continue;
    const key = flat(first[0]);
    const bucket = scanIndex.get(key);
    if (bucket) bucket.push(e); else scanIndex.set(key, [e]);
  }
  // Longest first inside each bucket, so "Bruce Wayne / Batman" is matched
  // before the "Bruce Wayne" that starts it.
  for (const bucket of scanIndex.values()) bucket.sort((a, b) => b.name.length - a.name.length);
}

/**
 * Every known character named in this text, longest match first so "Bruce
 * Wayne / Batman" is not also reported as three separate people.
 */
export function mentionedKnown(text) {
  const hay = String(text || "");
  if (!hay || !scanIndex.size) return [];
  const found = [];
  let lastEnd = -1;
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(hay); m; m = TOKEN.exec(hay)) {
    const start = m.index;
    if (start < lastEnd) continue;                 // inside a name already claimed
    const bucket = scanIndex.get(flat(m[0]));
    if (!bucket) continue;
    for (const e of bucket) {
      const end = start + e.name.length;
      if (flat(hay.slice(start, end)) !== flat(e.name)) continue;
      if (end < hay.length && WORDISH.test(hay[end])) continue;   // inside a longer word
      lastEnd = end;
      if (!found.includes(e)) found.push(e);
      break;   // the longest name starting here wins
    }
  }
  return found;
}

/* ── The picker ──────────────────────────────────────────────
 * One modal, opened from the Cast page, from the palette and from the studio
 * inspector. Resolves with the chosen entry, or null. */

export async function pickCharacter({ title = "Who does H3 already know?", verb = "Use" } = {}) {
  await loadKnownCast();

  let status = "g";
  const search = h("input", {
    type: "search", placeholder: "a character, an actor, a show…", spellcheck: "false",
    style: { width: "100%" },
  });
  const results = h("div.kc-results");
  const count = h("span.hint");

  const draw = () => {
    const { hits, total } = searchKnown(search.value, { status, limit: 60 });
    count.textContent = rows.length
      ? `${total} of ${status ? rows.filter(e => e.status === status).length : rows.length}`
      : "index unavailable";
    if (!rows.length) {
      mount(results, h("div.hint", { style: { padding: "14px 2px" } },
        "The character index could not be read. Everything else works — this is only a lookup."));
      return;
    }
    if (!hits.length) {
      mount(results, h("div.hint", { style: { padding: "14px 2px" } },
        search.value.trim()
          ? `Nothing under “${search.value.trim()}” in this bucket. Nobody tested it, which is not the same as it not working — try another bucket, or just describe them.`
          : "Nobody in this bucket."));
      return;
    }
    mount(results, ...hits.map(entry => characterRow(entry, verb, () => closeModal(entry))),
      total > hits.length ? h("div.hint", { style: { padding: "8px 2px" } }, `+${total - hits.length} more — keep typing.`) : null);
  };

  search.addEventListener("input", debounce(draw, 90));
  const filter = h("div.seg.kc-filter",
    ...[["g", "Works"], ["f", "Mixed"], ["b", "Doesn’t"], ["", "All"]].map(([v, label]) =>
      h("button", { class: v === status ? "on" : "", onclick: (e) => {
        status = v;
        [...e.currentTarget.parentElement.children].forEach(b => b.classList.toggle("on", b === e.currentTarget));
        draw();
      } }, label)),
  );
  draw();

  const picked = await modal({
    title, wide: true,
    body: h("div.kc",
      h("div.kc-top", search, filter, count),
      results,
      h("div.hint.kc-source",
        "Community testing by malcolmrey — clips generated per name and judged by eye. ",
        h("a", { href: SOURCE_URL, target: "_blank", rel: "noreferrer noopener" }, "The index on Hugging Face"),
        ". A strong hint, not a guarantee: a name in the last bucket still works if a reference image is pinning the face.",
      ),
    ),
    actions: [{ label: "Close", onClick: (done) => done(null) }],
  });
  return picked && picked.name ? picked : null;
}

function characterRow(entry, verb, onPick) {
  const st = STATUS[entry.status];
  return h("div.kc-row",
    h(`span.kc-dot.${st.tone}`, { title: st.blurb }, st.icon),
    h("div.grow",
      h("div.kc-name", entry.name),
      h("div.hint",
        entry.real ? "real person" : entry.actor,
        entry.franchise && entry.franchise !== "Real Person / Celebrity" ? ` · ${entry.franchise}` : "",
        ` · ${entry.clips} clip${entry.clips === 1 ? "" : "s"}`),
    ),
    h("button.btn.sm", { onclick: onPick }, verb),
  );
}

/** The prompt text a picked character is worth: the name, plus the anchor that
 *  tells the encoder which one — there is more than one Batman, and the guide
 *  asks for the concrete detail either way. */
export function castLine(entry) {
  if (!entry) return "";
  if (entry.real) return entry.name;
  const parts = [entry.name];
  if (entry.franchise && entry.franchise !== "Real Person / Celebrity") parts.push(`from ${entry.franchise}`);
  if (entry.actor && entry.actor !== entry.name) parts.push(`as played by ${entry.actor}`);
  return parts.join(", ");
}
