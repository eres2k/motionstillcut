/* THE THREE LLM ASSISTS, IN ONE PLACE.
 *
 * They used to be scattered: "Improve" only in the node view, "Rewrite in
 * H3 format" only under the Prompt tab, "Second opinion" only under Checks —
 * three verbs for three different things, each findable from one place and
 * none from the others. This is the one bar, mounted wherever the prompt is
 * being worked on (the Cut viewer header in every mode, the node view's
 * toolbar), with the same three buttons in the same order and honest labels
 * about what each one touches:
 *
 *   ✎ Improve shots    — each shot's own fields, rewritten in the model's
 *                        format. The timeline keeps driving the prompt.
 *   ✨ Second opinion  — an LLM reads the prompt back as the model would;
 *                        the reading and its suggested edits land in Checks.
 *   ⤵ Rewrite whole    — one block of prose in H3's rewriter format. Turns
 *                        on manual override: the shot list stops driving.
 */
import { h, toast } from "./util.js";
import { getProject, update, orderedShots, newBeat } from "./state.js";
import { polishShot, enhance, dryRun } from "./llm.js";

let busy = false;
export const assistBusy = () => busy;

/* The last second opinion, kept until the next one — shown under Checks. */
let reading = null;
export const lastReading = () => reading;
export const setReading = (r) => { reading = r; };

export async function improveShots(p = getProject(), { only = null, onProgress = () => {} } = {}) {
  const shots = orderedShots(p);
  const targets = only ? shots.filter(sh => sh.id === only) : shots;
  if (!targets.length) throw new Error("There is no shot to improve yet.");
  let done = 0, changed = 0;
  for (const shot of targets) {
    const index = shots.findIndex(sh => sh.id === shot.id);
    onProgress(++done, targets.length);
    const r = await polishShot(shot, index, getProject());
    update((draft) => {
      const live = draft.shots.find(x => x.id === shot.id);
      if (!live) return;
      if (r.subject) live.subject = r.subject;
      if (Array.isArray(r.beats) && r.beats.length) {
        live.beats = r.beats.map((t, i) => newBeat(String(typeof t === "string" ? t : t?.text || "").trim(), i === 0 ? "" : "then")).filter(b => b.text);
      }
      for (const k of ["setting", "lighting", "details"]) if (r[k]) live[k] = r[k];
      // A camera the creator set by hand stays theirs.
      if (r.camera && !live.camera?.byHand) live.camera = { ...live.camera, ...r.camera, custom: "" };
      changed++;
    }, "shots");
  }
  return { changed, total: targets.length };
}

export async function rewriteWhole(p = getProject()) {
  const r = await enhance(p);
  update((proj) => {
    proj.prompt.manual = true;
    proj.prompt.description = r.description;
    if (r.soundscape) proj.sound.soundscape = r.soundscape === "N/A" ? "" : r.soundscape;
    if (r.soundscape === "N/A") proj.sound.silent = true;
    if (r.music) proj.sound.music = r.music === "N/A" ? "" : r.music;
    if (r.music === "N/A") proj.sound.musicOff = true;
    if (r.subjectDefs) proj.ref2v.subjectDefs = r.subjectDefs;
    if (r.summary) proj.ref2v.summary = r.summary;
    proj.prompt.lastEnhancedAt = Date.now();
  }, "prompt");
  return r;
}

export async function secondOpinion(p = getProject()) {
  reading = await dryRun(p);
  return reading;
}

/**
 * The bar. `cls` is the button class for the surface it sits on ("btn.sm.ai"
 * in a panel header, "sn-tool.ai" in the node toolbar); `onReading` is where
 * the host shows the second opinion (the Cut page switches to Checks).
 */
export function assistBar(p, { refresh = () => {}, cls = "btn.sm.ai", onReading = null, compact = false } = {}) {
  const run = async (btn, label, work, doneToast) => {
    if (busy) return;
    busy = true;
    const text = btn.querySelector(".assist-label") || btn;
    const was = text.textContent;
    btn.classList.add("disabled"); text.textContent = label;
    try {
      const r = await work((n, total) => { text.textContent = total > 1 ? `${n}/${total}…` : label; });
      doneToast(r);
    } catch (err) {
      toast("Could not do that", err.message, "err");
    } finally {
      busy = false;
      btn.classList.remove("disabled"); text.textContent = was;
      refresh();
    }
  };
  const button = (icon, label, title, onclick) => h(`button.${cls}.assist`, { title, onclick: (e) => onclick(e.currentTarget) },
    h("span.assist-ico", icon), compact ? null : h("span.assist-label", label));

  return h("span.assist-bar", { style: { display: "inline-flex", gap: "4px", alignItems: "center" } },
    button("✎", "Improve shots",
      "Rewrite each shot's own fields — subject, beats, setting, lighting, details — in the model's format. The timeline keeps driving the prompt; ⌘Z per shot takes one back.",
      (btn) => run(btn, "improving…", (prog) => improveShots(getProject(), { onProgress: prog }),
        (r) => toast(r.total > 1 ? "Shots improved" : "Shot improved", `${r.changed} of ${r.total} rewritten — ⌘Z per shot to take one back`, "ok"))),
    button("✨", "Second opinion",
      "An LLM reads the prompt back as the model would — what each shot renders, where it reads two ways — with edits you can apply. Lands in Checks.",
      (btn) => run(btn, "reading…", () => secondOpinion(getProject()),
        (r) => { toast("Read back", `${r.model || "the LLM"} · ${r.shots?.length || 0} shots`, "ok"); onReading?.(r); })),
    button("⤵", "Rewrite whole prompt",
      p.mode === "t2v"
        ? "One block of prose in the format H3's own rewriter emits. Turns on manual override — the shot list stops driving the prompt until you turn it off in the inspector."
        : "One block of prose in H3's format, written after looking at the attached images. Turns on manual override — the shot list stops driving the prompt.",
      (btn) => run(btn, "rewriting…", () => rewriteWhole(getProject()),
        (r) => toast("Rewritten — manual override is on", `${r.model} · ${(r.ms / 1000).toFixed(1)}s${r.sawImages ? ` · read ${r.sawImages} image${r.sawImages === 1 ? "" : "s"}` : ""}`, "ok"))),
  );
}
