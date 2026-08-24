/* THE CHARACTER INDEX — the file the app ships must say what the source said,
 * and the scanner over it must not cry wolf.
 *
 * web/assets/known-characters.tsv is a snapshot of malcolmrey's h3-center
 * usability index: 1293 characters, each generated as a test clip and judged
 * by eye. Two things can go wrong with a shipped snapshot — it can be
 * mis-transcribed, and the thing reading it can find characters that are not
 * there. Both are checked here, because the failure mode of the second is a
 * warning on ordinary prose, and a checker that warns about ordinary prose is
 * one people stop reading.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseIndex, adoptKnownCast, searchKnown, lookupKnown, mentionedKnown, castLine, STATUS,
} from "../web/js/knowncast.js";

const TSV = readFileSync(fileURLToPath(new URL("../web/assets/known-characters.tsv", import.meta.url)), "utf-8");
const rows = adoptKnownCast(parseIndex(TSV));

/* The three counts the source index states in its own headings. Transcribing
 * 1293 rows by script is exactly the kind of thing that silently drops the
 * last row of a section. */
test("the shipped index has the characters the source index counted", () => {
  assert.equal(rows.length, 1293);
  assert.equal(rows.filter(e => e.status === "g").length, 405);
  assert.equal(rows.filter(e => e.status === "f").length, 53);
  assert.equal(rows.filter(e => e.status === "b").length, 835);
  for (const e of rows) {
    assert.ok(STATUS[e.status], `${e.name} has an unknown status`);
    assert.ok(e.name && e.actor && e.franchise, `${e.name} is missing a column`);
    assert.ok(e.clips >= 1, `${e.name} has no clips`);
  }
});

test("a real person is their own actor", () => {
  const driver = lookupKnown("Adam Driver");
  assert.equal(driver.status, "g");
  assert.equal(driver.actor, "Adam Driver");
  assert.equal(driver.real, true);
  assert.equal(castLine(driver), "Adam Driver");
});

test("a character carries its franchise and its actor into the prompt", () => {
  const abby = lookupKnown("Abby Sciuto");
  assert.equal(abby.franchise, "NCIS");
  assert.equal(castLine(abby), "Abby Sciuto, from NCIS, as played by Pauley Perrette");
});

test("names are found however they are typed", () => {
  assert.equal(lookupKnown("gandalf")?.name, "Gandalf");
  assert.equal(lookupKnown("  GANDALF ")?.name, "Gandalf");
  assert.equal(lookupKnown("Eowyn")?.name, "Éowyn", "an accent should not be a wall");
});

test("search finds a character by its actor and by its show", () => {
  assert.ok(searchKnown("Pauley Perrette").hits.some(e => e.name === "Abby Sciuto"));
  assert.ok(searchKnown("NCIS").hits.some(e => e.name === "Ziva David"));
  assert.ok(searchKnown("gand").hits[0].name === "Gandalf", "a name prefix outranks everything");
  assert.equal(searchKnown("Gandalf", { status: "b" }).total, 0, "the bucket filter is a filter");
});

/* ── The scanner ──────────────────────────────────────────── */

test("a character named in a description is found", () => {
  const found = mentionedKnown("[Shot 1] Gandalf lowers his staff as the gate holds.");
  assert.deepEqual(found.map(e => e.name), ["Gandalf"]);
});

test("a longer name wins over the shorter one inside it", () => {
  const found = mentionedKnown("Bruce Wayne / Batman stands on the ledge.");
  assert.equal(found.length, 1);
  assert.ok(found[0].name.includes("Batman"));
});

test("a name inside a longer word is not a mention", () => {
  assert.deepEqual(mentionedKnown("The thorn bushes catch her sleeve."), [], "Thor is not in thorn");
  assert.deepEqual(mentionedKnown("Neon signs light the alley."), [], "Neo is not in Neon");
});

test("punctuation inside a name survives the scan", () => {
  assert.equal(mentionedKnown("Dr. Hannibal Lecter turns from the window.")[0]?.name, "Dr. Hannibal Lecter");
  assert.equal(mentionedKnown("Star-Lord ducks behind the crate.")[0]?.name, "Star-Lord");
  assert.equal(mentionedKnown("\u00c9owyn lowers the shield.")[0]?.name, "\u00c9owyn");
  // The index writes T'Pol with a typewriter apostrophe; people type both.
  assert.equal(mentionedKnown("T\u2019Pol raises an eyebrow.")[0]?.name, "T'Pol");
  assert.equal(mentionedKnown("T'Pol raises an eyebrow.")[0]?.name, "T'Pol");
});

test("two people in one shot are two mentions", () => {
  assert.deepEqual(
    mentionedKnown("Gandalf and Frodo Baggins cross the bridge.").map(e => e.name),
    ["Gandalf", "Frodo Baggins"]);
});

/* The whole reason the ambiguous list exists. Every one of these sentences is
 * ordinary prose that happens to contain a character's name, and a warning on
 * any of them would be the checker's last credible day. */
test("ordinary prose is not a casting decision", () => {
  const prose = [
    "The driver pulls away from the kerb without looking back.",
    "Data scrolls down the terminal in pale green.",
    "An angel carved in stone leans over the grave.",
    "Eleven candles burn along the windowsill.",
    "Her vision blurs at the edges.",
    "Rain washes the last of the chalk off the pavement.",
    "A wolverine crosses the treeline at dusk.",
    "He counts out a bill and sets it on the counter.",
    "The blade catches the light.",
    "God knows how long she waited.",
    "The doctor reads the chart without looking up.",
    "The narrator keeps talking over the credits.",
  ];
  for (const line of prose) {
    assert.deepEqual(mentionedKnown(line), [], `false positive on: ${line}`);
  }
});

test("the ambiguous names are still findable by hand", () => {
  assert.equal(lookupKnown("Eleven")?.franchise, "Stranger Things");
  assert.ok(searchKnown("Wolverine", { status: "" }).total >= 1);
});

test("an empty or unloaded index reports nothing rather than guessing", () => {
  adoptKnownCast([]);
  assert.deepEqual(mentionedKnown("Gandalf lowers his staff."), []);
  adoptKnownCast(rows);
});
