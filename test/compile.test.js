/* GOLDEN OUTPUT — the compiled prompt, frozen.
 *
 * Every fixture's exact emitted text lives in test/golden/<name>.txt. The
 * prompt compiler is a pure function of the project, so any change to it shows
 * up here as a reviewable diff rather than as a render that comes back subtly
 * wrong three days later.
 *
 *   node --test test/                 check
 *   UPDATE_GOLDEN=1 node --test test/ rewrite, then READ THE DIFF
 *
 * Updating a golden file is not a way to make a test pass. It is a way to
 * record a change you have already decided is correct.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FIXTURES } from "./fixtures.js";
import { compilePrompt, validate } from "../web/js/prompt.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "golden");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

for (const fixture of FIXTURES) {
  test(`golden: ${fixture.name}`, () => {
    const project = fixture.build();
    const compiled = compilePrompt(project);
    const report = validate(project);

    const body = [
      `# ${fixture.name}`,
      `# ${fixture.why}`,
      `# mode=${project.mode} duration=${project.render.duration}s`,
      "",
      compiled.text,
      "",
      "--- checks ---",
      ...report.checks.map(c => `${c.level}: ${c.msg}`),
      "",
    ].join("\n");

    const path = join(DIR, `${fixture.name}.txt`);
    if (UPDATE || !existsSync(path)) {
      writeFileSync(path, body);
      if (!UPDATE) assert.fail(`no golden for ${fixture.name} — one was written, review it and re-run`);
      return;
    }
    assert.equal(body, readFileSync(path, "utf8"),
      `compiled output changed for ${fixture.name}. If the change is correct, re-run with UPDATE_GOLDEN=1 and commit the diff.`);
  });
}

/* ── Invariants that hold for every fixture ─────────────────── */

test("every fixture compiles to the three fields the guide requires", () => {
  // §2.2: the core fields, in this exact order.
  for (const f of FIXTURES) {
    const p = f.build();
    const { text, fields } = compilePrompt(p);
    const keys = Object.keys(fields);
    assert.ok(keys.includes("overall_soundscape"), `${f.name} has no overall_soundscape`);
    assert.ok(keys.includes("non_diegetic_music"), `${f.name} has no non_diegetic_music`);
    assert.equal(keys[keys.length - 2], "overall_soundscape", `${f.name}: soundscape is not second-to-last`);
    assert.equal(keys[keys.length - 1], "non_diegetic_music", `${f.name}: music is not last`);
    assert.ok(!/\n\n\n/.test(text), `${f.name} has a doubled blank line`);
  }
});

test("the I2VA instruction is the first line, followed by one blank line", () => {
  // §2.1: "The instruction must be the first line of the final prompt,
  // followed by one blank line before the core fields."
  for (const f of FIXTURES) {
    const p = f.build();
    const { text, align } = compilePrompt(p);
    if (!align) continue;
    const lines = text.split("\n");
    assert.equal(lines[0], align, `${f.name}: the alignment line is not first`);
    assert.equal(lines[1], "", `${f.name}: no blank line after the alignment line`);
    assert.equal(align, "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.",
      `${f.name}: the I2VA instruction is quoted verbatim in §2.1 and must not be paraphrased`);
  }
});

test("every <d> is closed and opens with a language tag", () => {
  // ref §5.1: "Write dialogue and lyrics as <d>[Language] ...</d>."
  for (const f of FIXTURES) {
    const { text } = compilePrompt(f.build());
    const open = (text.match(/<d>/g) || []).length;
    const close = (text.match(/<\/d>/g) || []).length;
    assert.equal(open, close, `${f.name}: ${open} <d> against ${close} </d>`);
    for (const m of text.matchAll(/<d>(.{0,20})/g)) {
      assert.match(m[1], /^\[[A-Za-z]+\] /, `${f.name}: a <d> block does not open with a language tag`);
    }
  }
});

test("an N/A soundscape nobody asked for is an error, not a shrug", () => {
  // §4.6: "Use N/A only when the user explicitly requests complete silence
  // throughout the video."
  //
  // The field has to be present (§2.2), so N/A stays as the last-resort
  // emission — but it is a positive instruction to render a silent clip, and a
  // half-finished project must not send one quietly. The guarantee is the
  // checker's, and this is the test that it holds.
  for (const f of FIXTURES) {
    const p = f.build();
    const { soundscape } = compilePrompt(p);
    if (soundscape !== "N/A") continue;
    if (p.sound?.silent) continue;                       // asked for, and fine
    const errs = validate(p).checks.filter(c => c.level === "err" && /silent/i.test(c.msg));
    assert.ok(errs.length,
      `${f.name}: overall_soundscape exports as N/A with no request for silence, and the checker says nothing`);
  }
});

test("a deliberately silent clip is not warned about", () => {
  const p = FIXTURES.find(f => f.name === "silent").build();
  const errs = validate(p).checks.filter(c => c.level === "err");
  assert.deepEqual(errs, [], `silence was asked for, so nothing should complain: ${errs.map(e => e.msg).join(" | ")}`);
});

test("proper nouns survive the mid-sentence normaliser", () => {
  // phrase() de-capitalises a closed-class opener so "The setting is A
  // dilapidated area" cannot happen. It must never touch a name — expandTokens
  // splices cast entries straight into these fields.
  const p = FIXTURES.find(f => f.name === "t2v-single-shot").build();
  p.shots[0].setting = "Paris at dusk";
  p.shots[0].subject = "Anna in a grey coat";
  p.shots[0].beats = [
    { ...p.shots[0].beats[0], text: "Anna sets down her cup" },
    { id: "b2", text: "Anna looks up", link: "then" },
  ];
  const d = compilePrompt(p).description;
  assert.match(d, /The setting is Paris at dusk\./);
  assert.match(d, /: Anna in a grey coat\./);
  assert.match(d, /, then Anna looks up/);
  assert.doesNotMatch(d, /\banna\b/, "a name was lower-cased");
  assert.doesNotMatch(d, /\bparis\b/, "a place name was lower-cased");
});

test("no clause opens with a capital in the middle of a sentence", () => {
  // The defect a user pasted back: "…at her chest, then She looks up…".
  for (const f of FIXTURES) {
    const d = compilePrompt(f.build()).description;
    assert.doesNotMatch(d, /, (then|as|while) (The|A|An|She|He|They|It|His|Her|Their)\b/,
      `${f.name}: a beat joins mid-sentence with a capital`);
    assert.doesNotMatch(d, /\b(is|of|toward|from) (A|An|The) [a-z]/,
      `${f.name}: a field is spliced behind a carrier phrase with its capital intact`);
  }
});

test("a line crossing a cut is tagged at both sides", () => {
  // §4.4: "When the same line of dialogue or lyrics crosses a cut, use
  // <scenetrans> at the connecting points in both parts and explicitly state
  // that the audio continues across the cut."
  const d = compilePrompt(FIXTURES.find(f => f.name === "t2v-line-across-a-cut").build()).description;
  assert.equal((d.match(/<scenetrans>/g) || []).length, 2, "both connecting points need the tag");
  assert.match(d, /carries over from the previous shot|continues seamlessly across the cut|continues uninterrupted into the next shot|remains audible across the transition/,
    "one of the guide's four continuity phrasings");
  assert.match(d, /<cutoff>/, "a line the clip ends before finishing");
  assert.doesNotMatch(d, /<scenetrans>\s*\.|<cutoff>\s*\./, "the markers are tags, not words that take a full stop");
});

test("the terminal stop never lands outside a dialogue span", () => {
  // Zero occurrences of "</d>." in either guide: the author's punctuation goes
  // inside the tag, where they put it.
  for (const f of FIXTURES) {
    const { text } = compilePrompt(f.build());
    assert.doesNotMatch(text, /<\/d>\s*\./, `${f.name}: a full stop was added after </d>`);
  }
});
