/* STEERING — the clip's six dials, and one shot's three.
 *
 * These were one panel with a scope switch, and the scope switch was the
 * problem: you set six dials, three of them silently stopped applying when a
 * shot was picked, and "which shot am I steering" became a thing you had to
 * hold in your head while dragging a slider. Worse, pointing a global control
 * at one shot is a strange idea to begin with — you do not aim the exposure
 * knob at a single frame.
 *
 * So it is split along the line the model already had:
 *
 *   The STEERING node is the clip. All six dials, always, no modes. Pace
 *   decides how many shots there are, sound is one continuous track H3
 *   generates for the whole thing, and faithfulness is a marker per reference —
 *   none of those were ever per-shot, and now they never pretend to be.
 *
 *   FINE-TUNE lives on the shot, where the shot is. Three dials — distance,
 *   energy, light — that describe a frame and can honestly differ shot to
 *   shot. Each one follows the clip until you move it, says which it is doing,
 *   and has a way back.
 *
 * Both hosts (the canvas node and the Studio inspector) draw the same two
 * functions, so there is one implementation of each.
 */

import { h } from "./util.js";
import { update, orderedShots } from "./state.js";
import {
  DIALS, PER_SHOT_DIALS, applySteering, explainDials, dialsFor, hasOwnDials,
} from "./steer.js";

let host = { refresh: () => {} };
const refresh = () => host.refresh();

const PER_SHOT = DIALS.filter(d => PER_SHOT_DIALS.includes(d.id));

/** The badge on the Steering node / group: whether anything has broken ranks. */
export function steerBadge(p) {
  const own = orderedShots(p).filter(hasOwnDials).length;
  return own ? `whole clip · ${own} tuned` : "whole clip";
}

/** The badge on a shot's fine-tune section. */
export function shotTuneBadge(shot) {
  const n = PER_SHOT_DIALS.filter(id => Number.isFinite(shot?.dials?.[id])).length;
  return n ? `${n} tuned` : "follows the clip";
}

/** One slider, its readout, and the fix it sometimes offers. */
function dialRow(d, value, say, opts = {}) {
  return h("div", { class: `sn-dial${opts.own ? " own" : ""}` },
    h("div.sn-dial-hd",
      h("span.sn-dial-ico", d.icon),
      h("span.grow", d.label),
      opts.tag || null,
    ),
    h("input", {
      type: "range", min: "0", max: "100", value: String(value), title: d.hint,
      // `input` fires continuously; steering on every pixel would rebuild the
      // host mid-drag, so the value lands on release.
      onchange: (e) => opts.onSet(Number(e.target.value)),
    }),
    h("div", { class: say?.warn ? "sn-dial-say warn" : "sn-dial-say" }, say?.text || ""),
    say?.suggestDuration && opts.onDuration ? h("button.sn-fix", {
      title: "Nothing is deleted — the clip just gets long enough for what you wrote",
      onclick: () => opts.onDuration(say.suggestDuration),
    }, `Make it ${say.suggestDuration}s`) : null,
  );
}

/**
 * The clip's dials. Every one of them applies to the whole clip; a shot that
 * has been fine-tuned overrides three of them for itself, and that is said at
 * the bottom rather than by greying half the panel out.
 */
export function steerBody(p, opts = {}) {
  host = { refresh: opts.refresh || (() => {}) };
  const shots = orderedShots(p);
  const dials = dialsFor(p, null);
  const hasRefs = p.mode === "r2v" || !!p.frames?.first;
  const say = Object.fromEntries(explainDials(p, null).map(e => [e.id, e]));
  const tuned = shots.map((sh, i) => ({ sh, i })).filter(x => hasOwnDials(x.sh));

  const setDial = (id, value) => {
    update((draft) => {
      draft.creative = draft.creative || {};
      draft.creative.dials = { ...draft.creative.dials, [id]: value };
      applySteering(draft);
    }, "creative");
    refresh();
  };

  return h("div.st",
    h("div.st-lede", "These set the whole clip."),
    h("div.sn-dials",
      ...DIALS.filter(d => !d.needsRefs || hasRefs).map(d => dialRow(d, dials[d.id], say[d.id], {
        onSet: (v) => setDial(d.id, v),
        onDuration: (secs) => {
          update((draft) => { draft.render.duration = secs; applySteering(draft); }, "render");
          refresh();
        },
      })),
    ),
    /* Which shots are not following, said once at the bottom. A dial that is
     * being overridden somewhere is not a broken dial, and greying it out to
     * say so was the old panel's central confusion. */
    tuned.length ? h("div.st-note",
      /* Name the dials each shot has actually taken over. Saying "ignores
       * distance, energy and light" when a shot only moved energy is a lie
       * you would only catch by moving the other two and watching nothing
       * happen — which is exactly the confusion this split was for. */
      ...tuned.map(({ sh, i }) => {
        const taken = PER_SHOT.filter(d => Number.isFinite(sh.dials?.[d.id])).map(d => d.label.toLowerCase());
        const list = taken.length > 1
          ? `${taken.slice(0, -1).join(", ")} and ${taken[taken.length - 1]}`
          : taken[0];
        return h("div", `Shot ${i + 1} sets its own ${list}.`);
      }),
      " ",
      h("button.dr-mini", {
        title: "Every shot follows the clip's dials again",
        onclick: () => {
          update((draft) => {
            for (const s of draft.shots) delete s.dials;
            applySteering(draft);
          }, "shots");
          refresh();
        },
      }, "put them back"),
    ) : null,
  );
}

/**
 * One shot's three dials. Shown on the shot itself — on its node, and in
 * Studio's shot inspector — because that is where the shot is.
 *
 * Each dial starts on the clip's value and says so. Move it and it becomes
 * this shot's, with a ↺ to hand it back.
 */
export function shotTune(p, shot, opts = {}) {
  host = { refresh: opts.refresh || (() => {}) };
  const live = dialsFor(p, shot);
  const say = Object.fromEntries(explainDials(p, shot.id).map(e => [e.id, e]));

  const setDial = (id, value) => {
    update((draft) => {
      const s = draft.shots.find(x => x.id === shot.id);
      if (s) s.dials = { ...s.dials, [id]: value };
      applySteering(draft);
    }, "shots");
    refresh();
  };
  const follow = (id) => {
    update((draft) => {
      const s = draft.shots.find(x => x.id === shot.id);
      if (s?.dials) {
        delete s.dials[id];
        if (!Object.keys(s.dials).length) delete s.dials;
      }
      applySteering(draft);
    }, "shots");
    refresh();
  };

  return h("div.st.st-shot",
    h("div.st-lede", "Only this shot. Pace, sound and faithfulness stay on the clip."),
    h("div.sn-dials",
      ...PER_SHOT.map(d => {
        const own = Number.isFinite(shot.dials?.[d.id]);
        return dialRow(d, live[d.id], say[d.id], {
          own,
          onSet: (v) => setDial(d.id, v),
          tag: own
            ? h("button.st-tag.on", {
                title: "Follow the clip's dial again",
                onclick: () => follow(d.id),
              }, "this shot ↺")
            : h("span.st-tag", "follows the clip"),
        });
      }),
    ),
  );
}
