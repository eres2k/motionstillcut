/* WHAT A COMFYUI FAILURE MEANS — the raw exception, read for the user.
 *
 * ComfyUI reports a failed job as the node's Python exception, verbatim.
 * "PermissionError: [Errno 13] Permission denied: '/opt/ComfyUI/output/
 * MotionstillCut/T2V_x_00001_.mp4'" is a complete diagnosis to someone who
 * runs servers and a dead end to everyone else — and it arrives after the
 * whole clip has rendered. This is a web app: it cannot fix a folder on the
 * user's machine, but it can say what happened in plain words, name the
 * fix, and offer the one workaround it does control (where it asks ComfyUI
 * to save). Pure — no DOM — so it is tested.
 */

const PERMISSION = /permission denied|errno 13|eacces|permissionerror|operation not permitted/i;
const NO_SPACE = /no space left|errno 28|enospc/i;

/** The folder, if the exception names a path. */
function pathIn(raw) {
  const m = /['"]([^'"]*[\\/][^'"]*)['"]/.exec(raw || "");
  if (!m) return null;
  return m[1].replace(/[\\/][^\\/]*$/, "");   // the file's folder
}

/**
 * @param {string} raw   the node's exception message
 * @param {object} ctx   { nodeType, saveNode:boolean } — whether the failing node is the one that writes the file
 * @returns {{ kind: string, title: string, message: string, folder?: string, fix?: string, fallback?: string }}
 */
export function explainRenderError(raw, ctx = {}) {
  const text = String(raw || "");
  const node = ctx.nodeType || "";
  const saving = ctx.saveNode || /^(SaveVideo|SaveImage|SaveAudio|VHS_VideoCombine|SaveAnimated)/.test(node);

  if (PERMISSION.test(text)) {
    const folder = pathIn(text);
    if (saving || folder) {
      return {
        kind: "save-permission",
        title: "The clip rendered, but ComfyUI could not save it",
        message: `ComfyUI is not allowed to write into ${folder ? `"${folder}"` : "its output folder"}. That folder belongs to another user (usually root, from a run under sudo), and ComfyUI runs as you.`,
        folder,
        fix: folder ? `sudo chown -R $USER "${folder}"` : "sudo chown -R $USER <ComfyUI>/output",
        fallback: "Save at the top of ComfyUI's output folder instead (no subfolder) — that folder is yours, and every later render goes there too.",
      };
    }
    return {
      kind: "permission",
      title: "ComfyUI was refused by the operating system",
      message: `${node || "A node"} hit a permission error: ${text}`,
    };
  }
  if (NO_SPACE.test(text)) {
    return { kind: "disk-full", title: "The disk ComfyUI saves to is full", message: text };
  }
  return { kind: "other", title: "ComfyUI reported an execution error", message: `${node || "node"} — ${text || "failed"}` };
}
