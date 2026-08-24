/* MOTIONSTILL CUT — getting JSON out of a local model.
 *
 * Without JSON mode — which most local backends reject — this is the only
 * thing standing between a good answer and "the model did not answer with
 * JSON". Reasoning models make it harder still: they emit a scratchpad full of
 * braces and quotes before the answer, and they sometimes wrap the answer in
 * tags of their own.
 *
 * The order matters. Strip the reasoning first (its contents routinely include
 * a JSON *example*, which is a trap), then try the largest candidates before
 * the smallest, so a nested array is never mistaken for the whole answer.
 *
 * Ported verbatim from the Cut server's router; every branch here is a failure
 * seen from a real local backend.
 */

/**
 * Why an answer would not parse, in terms of the thing to change.
 */
export function diagnoseJson(r) {
  const text = String(r?.text || "");
  const onlyThought = r?.fromReasoning || /^<(think|thinking|thought)>/i.test(text);
  if (r?.truncated) {
    return {
      cause: "truncated",
      title: r.reasoned ? "The model ran out of room while thinking" : "The model ran out of room",
      detail: r.reasoned
        ? `It spent its whole token budget${r.retriedWith ? ` (retried at ${r.retriedWith})` : ""} on reasoning and never reached the answer. Turn thinking off for this model, or raise Max tokens on Setup.`
        : `The answer was cut off${r.retriedWith ? ` even at ${r.retriedWith} tokens` : ""}. Raise Max tokens on Setup.`,
      fix: r.reasoned ? "thinking" : "maxTokens",
    };
  }
  if (!text.trim()) {
    return {
      cause: "empty",
      title: "The model returned nothing",
      detail: "No content and no reasoning came back. Check that a model is actually loaded, and that the model name on Setup matches one the server has.",
      fix: "model",
    };
  }
  if (onlyThought) {
    return {
      cause: "thought-only",
      title: "The model thought but never answered",
      detail: "The whole reply was reasoning, with no answer after it. Turn thinking off for this model on Setup — reasoning models often need to be told to stop.",
      fix: "thinking",
    };
  }
  return {
    cause: "not-json",
    title: "The model answered, but not with JSON",
    detail: "It wrote prose instead of the object it was asked for. An instruct-tuned model of 7B or more usually fixes this; a base or heavily quantised model often cannot follow the format.",
    fix: "model",
    sample: text.slice(0, 240),
  };
}

/** Everything a reasoning model puts around its answer. */
export function stripReasoning(raw) {
  let s = String(raw)
    // Zero-width and BOM: some runtimes prepend them and JSON.parse chokes.
    .replace(/^[\uFEFF\u200B-\u200D\u2060]+/, "")
    // Closed scratchpads, whatever they are called.
    .replace(/<(think|thinking|thought|reasoning|scratchpad)>[\s\S]*?<\/\1>/gi, "")
    // Magistral / Devstral, and Kimi's unicode brackets.
    .replace(/\[THINK\][\s\S]*?\[\/THINK\]/gi, "")
    .replace(/\u25c1think\u25b7[\s\S]*?\u25c1\/think\u25b7/gi, "")
    // gpt-oss / harmony: keep the final channel, drop analysis and commentary.
    .replace(/<\|channel\|>(?:analysis|commentary)<\|message\|>[\s\S]*?(?=<\|(?:end|start|channel|return)\|>|$)/gi, "")
    .replace(/<\|[a-z_]+\|>/gi, "")
    .trim();
  /* An unterminated scratchpad: a closer with no opener, or an opener with no
   * closer. The well-formed pairs are already gone, so whatever is left is a
   * fragment — and BOTH sides of it can hold the answer. Neither side is
   * thrown away — they are RANKED: text outside the scratchpad is searched
   * first, the thought only as a last resort. */
  const close = s.search(/<\/(?:think|thinking|thought|reasoning|scratchpad)>|\[\/THINK\]/i);
  if (close !== -1) return { outside: s.slice(close).replace(/^(?:<\/[a-z]+>|\[\/THINK\])/i, "").trim(), inside: "" };
  const open = s.search(/<(?:think|thinking|thought|reasoning|scratchpad)>|\[THINK\]/i);
  if (open !== -1) {
    return {
      outside: s.slice(0, open).trim(),
      inside: s.slice(open).replace(/^(?:<[a-z]+>|\[THINK\])/i, "").trim(),
    };
  }
  return { outside: s, inside: "" };
}

/** Unwrap an answer the model chose to put in tags of its own. */
function unwrap(s) {
  const wrapped = String(s).match(/<(answer|output|final|json|result)>([\s\S]*?)<\/\1>/i);
  return wrapped ? wrapped[2].trim() : String(s);
}

/**
 * Is this the model's schema echo rather than its answer?
 *
 * A reasoning model restates the shape it was given before filling it in, and
 * when it never reaches the answer that restatement is the only object in the
 * reply. A real answer has real words in it.
 */
function isPlaceholder(value) {
  const leaves = [];
  const walk = (v, depth = 0) => {
    if (depth > 6 || leaves.length > 60) return;
    if (typeof v === "string") leaves.push(v.trim());
    else if (Array.isArray(v)) v.forEach(x => walk(x, depth + 1));
    else if (v && typeof v === "object") Object.values(v).forEach(x => walk(x, depth + 1));
  };
  walk(value);
  const bare = /^(?:\u2026|\.{2,3})$/;
  // One field whose whole value is an ellipsis is conclusive: that is the
  // shape as it was handed to the model, not anything it decided.
  if (leaves.some(t => bare.test(t))) return true;
  if (leaves.length < 2) return false;
  return leaves.every(t => !t || /^(?:-|_|x+|todo|tbd|string|placeholder|your \w+ here)$/i.test(t));
}

/** Every substring that could be the answer, most promising first. */
function candidates(cleaned) {
  const out = [cleaned];
  // Fenced blocks anywhere in the reply, not only at the ends.
  for (const m of cleaned.matchAll(/```(?:json5?|javascript|js)?\s*([\s\S]*?)```/gi)) {
    out.push(m[1].trim());
  }
  /* Every balanced object or array. Two orderings matter, in this priority:
   * TOP-LEVEL, LAST FIRST (a model that thinks out loud writes its schema
   * echo, its abandoned draft and its worked example BEFORE the answer);
   * THEN EVERYTHING ELSE, LONGEST FIRST, as a net. */
  const spans = [];
  for (let i = 0; i < cleaned.length; i++) {
    const open = cleaned[i];
    if (open !== "{" && open !== "[") continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < cleaned.length; j++) {
      const c = cleaned[j];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        if (--depth === 0) { spans.push({ start: i, end: j, text: cleaned.slice(i, j + 1) }); break; }
      }
    }
  }
  const nested = (sp) => spans.some(o => o !== sp && o.start < sp.start && o.end >= sp.end);
  const top = spans.filter(sp => !nested(sp)).sort((a, b) => b.start - a.start);
  const rest = spans.filter(sp => nested(sp)).sort((a, b) => b.text.length - a.text.length);
  out.push(...top.map(sp => sp.text), ...rest.map(sp => sp.text));
  // A truncated answer: nothing balanced, so offer the tail from each opener
  // and let the repairs close it.
  if (!spans.length) {
    for (let i = 0; i < cleaned.length; i++) {
      if (cleaned[i] === "{" || cleaned[i] === "[") { out.push(cleaned.slice(i)); break; }
    }
  }
  return out;
}

/**
 * @param {string} text  the model's reply
 * @param {string[]} [expect]  keys the caller actually wants — given the keys,
 *   the guessing between multiple parseable objects stops.
 */
export function parseLooseJson(text, expect = []) {
  return parseLooseJsonDetailed(text, expect).value;
}

/**
 * The same search, plus where the answer came from — an object found INSIDE an
 * unterminated scratchpad may be a draft the model talked itself out of, and
 * the caller (which knows whether the reply was also cut off) decides whether
 * to trust it.
 *
 * @returns {{ value: any, fromScratchpad: boolean }}
 */
export function parseLooseJsonDetailed(text, expect = []) {
  if (!text) return { value: null, fromScratchpad: false };
  const { outside, inside } = stripReasoning(text);
  const wanted = Array.isArray(expect) ? expect.filter(Boolean) : [];

  // Outside the scratchpad first, inside it only if nothing else is there.
  for (const region of [outside, inside]) {
    if (!region) continue;
    const isInside = region === inside && !!inside;
    const got = searchRegion(unwrap(region), wanted, isInside);
    if (got !== undefined) return { value: got, fromScratchpad: isInside };
  }
  return { value: null, fromScratchpad: false };
}

/**
 * @param {boolean} suspect  true when this text came from inside a scratchpad,
 *   where a schema echo is likelier than an answer and has to prove itself.
 */
function searchRegion(cleaned, wanted, suspect) {
  if (!cleaned) return undefined;
  const parsed = [];
  for (const c of candidates(cleaned)) {
    const got = tryParse(c);
    if (got === undefined) continue;
    // A doubly-encoded answer: the object arrived as a JSON string.
    const value = typeof got === "string" && /^[\s]*[{[]/.test(got) ? (tryParse(got) ?? got) : got;
    // A restatement of the shape is not an answer, wherever it was found.
    if (isPlaceholder(value)) continue;
    if (wanted.length && value && typeof value === "object" && !Array.isArray(value)
        && wanted.some(k => k in value)) {
      return value;   // it has what was asked for; nothing beats that
    }
    parsed.push(value);
  }
  // Inside a scratchpad, an object that does not even carry the keys the
  // caller asked for is a draft or an aside — not worth guessing at.
  if (suspect && wanted.length) return undefined;
  // Otherwise the candidate order decides: last top-level span first, because
  // a model that thinks out loud writes its notes before its answer.
  return parsed.length ? parsed[0] : undefined;
}

/**
 * JSON.parse, then the repairs that account for nearly every local-model
 * near-miss, applied in increasing order of how much they assume. Returns
 * undefined when nothing works, so a legitimately parsed `null` is not
 * mistaken for failure.
 */
function tryParse(raw) {
  if (!raw || !/[{[]/.test(raw)) return undefined;
  const repairs = [
    (s) => s,
    // A comma before a closer.
    (s) => s.replace(/,(\s*[}\]])/g, "$1"),
    // Curly quotes, from a model that "prettified" its own output.
    (s) => s.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'"),
    // Python's literals, which small models reach for constantly.
    (s) => s.replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false").replace(/\bNone\b/g, "null"),
    // A raw newline inside a string is illegal JSON and very common in prose
    // fields; escape the ones that fall between quotes.
    escapeNewlinesInStrings,
    // Single-quoted keys and values, when the reply uses no double quotes at
    // all — safe precisely because there is nothing to confuse it with.
    (s) => (s.includes('"') ? s : s.replace(/'/g, '"')),
    // // and /* */ comments, which small models add to be helpful.
    (s) => stripComments(s),
    // Bare keys, the JavaScript object literal a model writes when it forgets
    // it was asked for JSON. Only outside strings.
    (s) => quoteBareKeys(s),
  ];
  let s = raw;
  for (const repair of repairs) {
    s = repair(s);
    try { return JSON.parse(s); } catch { /* next repair */ }
  }
  return closeAndParse(s);
}

/** Drop // and /* *\/ comments that fall outside strings. */
function stripComments(raw) {
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (esc) { out += c; esc = false; continue; }
    if (c === "\\") { out += c; esc = true; continue; }
    if (c === '"') { inStr = !inStr; out += c; continue; }
    if (!inStr && c === "/" && raw[i + 1] === "/") { while (i < raw.length && raw[i] !== "\n") i++; out += "\n"; continue; }
    if (!inStr && c === "/" && raw[i + 1] === "*") { i += 2; while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++; i++; continue; }
    out += c;
  }
  return out;
}

/** Quote bare object keys — `{reply: "x"}` — leaving string contents alone. */
function quoteBareKeys(raw) {
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (esc) { out += c; esc = false; continue; }
    if (c === "\\") { out += c; esc = true; continue; }
    if (c === '"') { inStr = !inStr; out += c; continue; }
    if (inStr) { out += c; continue; }
    const rest = raw.slice(i);
    const key = /^([A-Za-z_$][\w$]*)(\s*):/.exec(rest);
    if (key && /[{,]\s*$/.test(out)) { out += `"${key[1]}"${key[2]}:`; i += key[0].length - 1; continue; }
    out += c;
  }
  return out;
}

/** Escape newlines that sit inside a JSON string, leave the structural ones. */
function escapeNewlinesInStrings(raw) {
  let out = "", inStr = false, esc = false;
  for (const c of raw) {
    if (esc) { out += c; esc = false; continue; }
    if (c === "\\") { out += c; esc = true; continue; }
    if (c === '"') { inStr = !inStr; out += c; continue; }
    if (inStr && (c === "\n" || c === "\r")) { out += c === "\n" ? "\\n" : "\\r"; continue; }
    if (inStr && c === "\t") { out += "\\t"; continue; }
    out += c;
  }
  return out;
}

/** An answer cut off by max_tokens: drop the half-written tail and close what
 *  is still open. Better a plan missing its last action than no plan at all. */
function closeAndParse(raw) {
  const depth = [];
  let inStr = false, esc = false, lastSafe = -1;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{" || c === "[") depth.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") depth.pop();
    else if (c === "," && depth.length) lastSafe = i;
  }
  if (!depth.length) return undefined;
  const stem = lastSafe > 0 ? raw.slice(0, lastSafe) : raw.replace(/[,\s]*"[^"]*"?\s*:?\s*$/, "");
  // Re-close from the stem, which may have a different depth than the whole.
  const stack = [];
  let str = false, e2 = false;
  for (let i = 0; i < stem.length; i++) {
    const c = stem[i];
    if (e2) { e2 = false; continue; }
    if (c === "\\") { e2 = true; continue; }
    if (c === '"') { str = !str; continue; }
    if (str) continue;
    if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") stack.pop();
  }
  try { return JSON.parse(stem + stack.reverse().join("")); } catch { return undefined; }
}
