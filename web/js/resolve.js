/* Shared Resolve status and handoff controls for Edit, Deliver and Setup. */
import { h, toast, group, row, checkbox, uid } from "./util.js";
import { api, SERVER_BACKED } from "./api.js";
import { getSettings, saveSettings } from "./config.js";
import { editPlan, exportBody } from "./edit.js";
import { getBlob } from "./media.js";
import { onProjectSwap } from "./state.js";

let connection = null, checking = false, running = false, attempt = null, epoch = 0;
const listeners = new Set();
export const onResolveChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => { for (const fn of listeners) fn(); };
onProjectSwap(() => { epoch++; attempt = null; });

export async function checkResolve() {
  if (checking) return;
  checking = true; emit();
  try { connection = await api.resolveStatus(); }
  catch (err) { connection = { ready: false, connected: false, message: err.message }; }
  finally { checking = false; emit(); }
  return connection;
}

export function transferBody(project) {
  const body = exportBody(project);
  return {
    ...body,
    clips: body.clips.map((c, i) => ({ ...c, name: project.edit.clips[i].name || `Clip ${i + 1}` })),
    audio: body.audio.map((a, i) => ({ ...a, name: project.edit.audio[i].name || `Audio ${i + 1}` })),
  };
}

export async function sendEditToResolve(project) {
  if (running || !SERVER_BACKED) return;
  const plan = editPlan(project);
  if (!plan.ok) return toast("Not ready to send", plan.problems[0], "warn");
  const body = transferBody(project), fingerprint = JSON.stringify(body), currentEpoch = epoch;
  // A retry of an unconfirmed request keeps its ID; the backend receipt
  // prevents duplicate imports even after the browser loses its response.
  const run = attempt?.fingerprint === fingerprint && !attempt.result ? attempt
    : { requestId: uid(), fingerprint, result: null };
  attempt = run; running = true; run.error = null; run.message = "Checking Resolve…"; emit();
  try {
    connection = await api.resolveStatus();
    if (!connection.ready) throw new Error(connection.message);
    const ids = [...new Set([...body.clips.map(c => c.source.mediaId), ...body.audio.map(a => a.mediaId)].filter(Boolean))];
    if (ids.length) {
      const have = new Set((await api.mediaHave(ids)).have || []);
      for (const [i, id] of ids.entries()) {
        if (have.has(id)) continue;
        run.message = `Preparing media ${i + 1} of ${ids.length}…`; emit();
        const data = await getBlob(id);
        if (!data) throw new Error("A timeline file is missing from this browser. Import it again before sending.");
        await api.mediaPut(id, data);
      }
    }
    run.message = "Preparing media and importing the timeline…"; emit();
    run.result = await api.resolveSend({ ...body, requestId: run.requestId });
    run.message = `Sent ${run.result.clips} clip${run.result.clips === 1 ? "" : "s"} to ${run.result.project} → ${run.result.timeline}.`;
    if (currentEpoch === epoch) {
      const warnings = run.result.warnings || [];
      toast(warnings.length ? "Imported — review in Resolve" : "Sent to Resolve",
        warnings.length ? `${run.message} ${warnings.join(" ")}` : run.message, warnings.length ? "warn" : "ok");
    }
  } catch (err) {
    run.error = err.message; run.message = "";
    if (currentEpoch === epoch) toast("Could not send to Resolve", err.message, "err");
  } finally { running = false; emit(); }
}

export function resolveButton(project, { compact = false } = {}) {
  const plan = editPlan(project);
  return h(`button.btn.${compact ? "sm" : "primary"}.resolve-send`, {
    type: "button", disabled: running || !SERVER_BACKED || !plan.ok,
    title: !SERVER_BACKED ? "Open this project in the local Cut app to send to Resolve."
      : !plan.ok ? plan.problems[0] : "Create an editable timeline in the project open in DaVinci Resolve",
    onclick: () => sendEditToResolve(project),
  }, running ? "Sending to Resolve…" : "Send to Resolve");
}

export function resolveGroup(project) {
  return group("DaVinci Resolve", { id: "e-resolve", accordion: false, open: true },
    h("div.hint", "Continue editing in Resolve with separate clips, trims, muted clip sound and audio tracks. Each send creates a new timeline in the open project."),
    h("div.resolve-actions", { style: { marginTop: "8px" } }, resolveButton(project),
      h("button.btn.sm", { disabled: checking || running, onclick: checkResolve }, checking ? "Checking…" : "Check connection"),
      h("button.btn.sm.ghost", { onclick: () => window.dispatchEvent(new CustomEvent("mscut:page", { detail: "setup" })) }, "Connection settings")),
    h("div.resolve-status", { role: "status", "aria-live": "polite" },
      attempt?.error ? h("div.note.bad", attempt.error)
        : attempt?.message ? h("div.note.info", attempt.message)
          : h("div.hint", connection?.message || (SERVER_BACKED ? "Start Resolve and open a project, then send your edit." : "Available in the local Cut app with server saving enabled.")),
      attempt?.result?.warnings?.length ? h("div.note.warn", attempt.result.warnings.join(" ")) : null,
      attempt?.error ? h("button.btn.sm.ghost", {
        title: "Use only after checking Resolve for a timeline from the previous attempt",
        onclick: () => { attempt = null; emit(); },
      }, "I've checked Resolve — start a new transfer") : null),
  );
}

export function resolveSettings() {
  const s = getSettings()?.resolve || {};
  async function save(patch) {
    try { await saveSettings({ resolve: patch }); connection = null; emit(); }
    catch (err) { toast("Could not save Resolve settings", err.message, "err"); }
  }
  return group("DaVinci Resolve", { id: "setup-resolve", accordion: false, open: true },
    !SERVER_BACKED ? h("div.note.info", "Connect Resolve from the local Cut app with server saving enabled.") : h("div",
      row("MCP endpoint", h("input", { type: "url", value: s.url || "http://127.0.0.1:8765/mcp", "aria-label": "Resolve MCP endpoint",
        onchange: e => save({ url: e.target.value.trim() }) }), "The HTTP endpoint on the same host as Resolve. Its server and Resolve must both be running."),
      row("Access token", h("input", { type: "password", autocomplete: "new-password", value: "", "aria-label": "Resolve MCP access token", placeholder: s.hasApiKey ? "Token saved — enter to replace" : "Optional",
        onchange: e => { if (e.target.value) { save({ apiKey: e.target.value }); e.target.value = ""; } } })),
      s.hasApiKey ? h("button.btn.sm.ghost", { onclick: () => save({ apiKey: "" }) }, "Clear access token") : null,
      row("ComfyUI output folder", h("input", { value: s.comfyOutputDir || "", placeholder: "/opt/ComfyUI/output", "aria-label": "Local ComfyUI output folder",
        onchange: e => save({ comfyOutputDir: e.target.value.trim() }) }), "Optional local folder to avoid downloading rendered clips. Leave empty when ComfyUI is on another host."),
      checkbox("Prepare media for Resolve on Linux", !!s.prepareAudio, v => save({ prepareAudio: v })),
      h("div.hint", "Preserves supported video streams and converts sound to PCM. Other video formats become ProRes. Prepared media stays beside the saved project data."),
      h("div.resolve-actions", { style: { marginTop: "8px" } },
        h("button.btn.sm", { disabled: checking || running, onclick: checkResolve }, checking ? "Checking…" : "Test Resolve connection")),
      h("div.resolve-status", { role: "status" }, connection
        ? h(`div.note.${connection.ready ? "info" : "warn"}`, connection.message,
            connection.connected ? h("div.hint", `${connection.product || connection.server} · ${connection.tools} MCP tools${connection.timeline ? ` · ${connection.timeline}` : ""}`) : null)
        : h("div.hint", "Tests the MCP tools and the project open in Resolve."))),
  );
}
