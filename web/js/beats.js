/* ACTION BEATS — one editor, drawn by both views.
 *
 * This exists because the canvas and the studio disagreed about what a shot
 * said, and the canvas was the one that was wrong.
 *
 * The canvas used to show a shot as one line of text — "subject — beat; beat;
 * beat" — and parse it back on blur. Any parse round-trip is lossy, and this
 * one lost three separate things:
 *
 *   The connective. A beat linked with "as" or "while" is CONCURRENT; one
 *   linked with "then" is sequential. The join wrote semicolons and the parse
 *   made everything "then", so "as the steam curls up" quietly became "then the
 *   steam curls up" — a different shot, and a different compiled prompt.
 *
 *   A semicolon inside a beat. "the steam curls up; the light catches it" came
 *   back as two beats.
 *
 *   An em dash inside a subject. "her hands — knuckles white" split at the
 *   first dash, so the subject became "her hands" and the rest fell into the
 *   action.
 *
 * And the trigger was not typing. Focusing the box and clicking away fired the
 * change handler, so merely LOOKING at a shot on the canvas rewrote it.
 *
 * The fix is not a better parser. It is not parsing: both views now edit the
 * same structure through this one function, so they cannot disagree about a
 * shot any more than a number can disagree with itself.
 */

import { h, textarea, select } from "./util.js";
import { update, newBeat } from "./state.js";

/* The four ways one beat joins to the last. "" is a full stop — a new sentence
 * inside the same shot — which is why it is offered rather than implied. */
export const LINKS = [["then", "…, then"], ["as", "…, as"], ["while", "…, while"], ["", "new sentence"]];

/**
 * @param opts.refresh  repaint the host
 * @param opts.compact  true on a canvas node, where the column is 236px wide
 */
export function beatEditor(p, shot, index, shots, opts = {}) {
  const refresh = opts.refresh || (() => {});
  const compact = !!opts.compact;
  const end = index + 1 < shots.length ? shots[index + 1].at : p.render.duration;
  const len = end - (shot.at || 0);
  // H3 renders roughly one beat per 2–3 seconds. More than that and the later
  // ones blur together, so the shot's own length is the budget.
  const room = Math.max(1, Math.ceil(len / 2));
  const beats = shot.beats || [];
  const filled = beats.filter(b => (b.text || "").trim()).length;

  const setBeat = (id, patch, reason = "text") => update((proj) => {
    const s = proj.shots.find(x => x.id === shot.id);
    const b = s?.beats?.find(x => x.id === id);
    if (b) Object.assign(b, patch);
  }, reason);

  const addBeat = (after = null) => {
    let added = null;
    update((proj) => {
      const s = proj.shots.find(x => x.id === shot.id);
      if (!s) return;
      added = newBeat("", "then");
      const at = after ? s.beats.findIndex(x => x.id === after) : -1;
      if (at >= 0) s.beats.splice(at + 1, 0, added);
      else s.beats.push(added);
    }, "shots");
    refresh();
    return added;
  };

  const removeBeat = (id) => {
    update((proj) => {
      const s = proj.shots.find(x => x.id === shot.id);
      if (s) s.beats = s.beats.filter(x => x.id !== id);
    }, "shots");
    refresh();
  };

  /* Enter makes the next beat rather than a newline. A beat is one clause —
   * a line break inside one has no meaning anywhere downstream — and typing
   * three beats without reaching for the mouse is what the canvas's one-box
   * editor was actually good at. Shift+Enter still breaks the line for anyone
   * who wants it. */
  const onKey = (b, i) => (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      setBeat(b.id, { text: e.target.value });
      const made = addBeat(b.id);
      if (made) {
        requestAnimationFrame(() => {
          const boxes = document.querySelectorAll(`[data-beats="${shot.id}"] textarea`);
          boxes[i + 1]?.focus();
        });
      }
    }
    // Backspace in an empty beat removes it, which is what every list editor
    // does and what stops empty rows accumulating.
    if (e.key === "Backspace" && !e.target.value && beats.length > 1) {
      e.preventDefault();
      removeBeat(b.id);
      requestAnimationFrame(() => {
        const boxes = document.querySelectorAll(`[data-beats="${shot.id}"] textarea`);
        const prev = boxes[Math.max(0, i - 1)];
        prev?.focus();
        if (prev) prev.selectionStart = prev.value.length;
      });
    }
  };

  return h("div", { class: `beats${compact ? " compact" : ""}`, dataset: { beats: shot.id } },
    h("div.beats-hd",
      h("span.grow", compact ? "What happens" : "Action beats"),
      h("span", {
        class: `badge ${filled > room ? "busy" : "ok"}`,
        title: `About one beat per 2–3s — this shot is ${len.toFixed(1)}s long`,
      }, h("span.dot"), `${filled}/${room}`),
    ),
    ...beats.map((b, i) => h("div.beat-row",
      h("div.beat-hd",
        i === 0
          ? h("span.tag", "beat 1")
          : select(LINKS, b.link, (v) => { setBeat(b.id, { link: v }, "shots"); refresh(); }, { class: "beat-link" }),
        h("span.hint.grow", i === 0 && !compact ? "the main action — what the model anchors on" : ""),
        beats.length > 1 ? h("button.btn.ghost.sm", {
          title: "Remove this beat",
          onclick: () => removeBeat(b.id),
        }, "✕") : null,
      ),
      textarea(b.text, (v) => setBeat(b.id, { text: v }), {
        rows: compact ? 2 : 2,
        onkeydown: onKey(b, i),
        placeholder: i === 0
          ? "pours the last of the water in a slow spiral"
          : "lifts the kettle away and sets it down",
      }),
    )),
    h("div.btn-row",
      h("button.btn.sm", { title: "Enter at the end of a beat does this too", onclick: () => addBeat() }, "＋ Beat"),
      filled > room ? h("span.hint.warn", compact ? "more beats than seconds" : "more beats than this shot has seconds for") : null,
    ),
  );
}
