/* MOTIONSTILL CUT — the LLM call every prompt feature goes through.
 *
 * One place that claims the GPU, talks OpenAI-compatible, and unwraps the
 * answer — so the VRAM arbiter cannot be bypassed by a new feature calling
 * the model directly. Ported from the Cut server's router; the browser is the
 * caller now, but the backends and their dialects are the same.
 */

import { loadSettings } from "./settings.js";
import { claim, llmFetch } from "./engine.js";
import * as store from "./store.js";
import { stripReasoning } from "./parse.js";

/* What each backend accepted, remembered per address+model rather than per
 * tab-lifetime global: one failed probe instead of one per call, but pointing
 * Setup at a different server — or loading a different model into the same
 * one — starts over, because the answer genuinely may have changed. */
const probes = new Map();   // "url::model" → { json: bool|null, quiet: bool|null }

function probeFor(url, model) {
  const key = `${url}::${model}`;
  if (!probes.has(key)) {
    if (probes.size > 20) probes.delete(probes.keys().next().value);
    probes.set(key, { json: null, quiet: null, strength: null });
  }
  return probes.get(key);
}

/** `auto` (probe once) · `off` (never ask, never mind) — from settings. */
const jsonMode = (llm) => String(llm?.jsonMode || "auto").toLowerCase();

/** The shapes a backend uses to say "I do not know that key". */
const COMPLAINT = /unsupported|not supported|unrecognized|unknown (?:field|parameter|argument|key)|invalid (?:field|parameter|argument|key)|extra inputs|unexpected keyword|no such/;

/** Does this failure name THIS extra? The matchers have to be precise about
 *  which key was complained about. */
function rejectsJsonMode(status, data, text) {
  if (![400, 422, 500, 501].includes(status)) return false;
  const msg = String(data?.error?.message || data?.error || text || "").toLowerCase();
  if (/chat_template_kwargs|enable_thinking|reasoning_effort|\bthink\b/.test(msg)) return false;   // not ours
  return /response_format|json_object|json_schema|json[ _-]?mode|structured output|guided/.test(msg);
}

/** A 400 that names one of the keys we add to quieten a reasoning model. */
function rejectsUnknownField(status, data, text) {
  if (![400, 422, 500, 501].includes(status)) return false;
  const msg = String(data?.error?.message || data?.error || text || "").toLowerCase();
  if (/response_format|json_object|json_schema/.test(msg)) return false;           // not ours
  return /chat_template_kwargs|enable_thinking|\bthink(?:ing)?\b/.test(msg) && COMPLAINT.test(msg);
}

/** A 400 that names the reasoning-strength key. */
function rejectsStrength(status, data, text) {
  if (![400, 422, 500, 501].includes(status)) return false;
  const msg = String(data?.error?.message || data?.error || text || "").toLowerCase();
  return /reasoning_effort|reasoning_strength/.test(msg) && COMPLAINT.test(msg);
}

/** Reasoning strength, only while thinking is on. gpt-oss reads
 *  reasoning_effort natively; llama.cpp binds it — and reasoning_strength —
 *  into any chat template that reads either ("none" is its off switch, which
 *  is why this is never sent with thinking off: to a model that treats it as
 *  a floor, "low" asks for MORE thinking than saying nothing). Other runtimes
 *  ignore an unknown key, and one that objects gets it dropped on retry. */
function strengthFor(llm, suppress) {
  const v = String(llm.reasoning || "default").toLowerCase();
  return !suppress && ["low", "medium", "high"].includes(v) ? v : "";
}

/** The extras a backend might not recognise, dropped as one set on rejection. */
const QUIET_KEYS = ["chat_template_kwargs", "think"];

export async function llmChat(body) {
  const { llm } = loadSettings();
  await claim("llm");
  // Whatever the user has learned on this box rides along with every rewrite.
  await store.ready("rulebook");
  const house = body.useRulebook === false ? "" : store.rulebookPrompt(body.mode || "");
  const system = house && body.system ? `${body.system}\n\n${house}` : (body.system || house);
  const messages = Array.isArray(body.messages) && body.messages.length
    ? body.messages
    : [
        ...(system ? [{ role: "system", content: system }] : []),
        {
          role: "user",
          content: body.images?.length
            ? [
                { type: "text", text: String(body.prompt || "") },
                ...body.images.map(url => ({ type: "image_url", image_url: { url } })),
              ]
            : String(body.prompt || ""),
        },
      ];
  const model = body.model || (body.images?.length && llm.visionModel) || llm.model || "local-model";

  /* Reasoning models are the single biggest cause of "the model did not answer
   * with JSON", and the cause is almost never that thinking is switched OFF —
   * it is that thinking eats the whole token budget before the answer starts.
   * So for a structured call we ask the model NOT to think, in every backend's
   * spelling at once, and let each ignore the others'. */
  const think = String(llm.thinking || "off").toLowerCase();
  const suppress = think === "off";

  const quiet = suppress ? {
    chat_template_kwargs: {
      enable_thinking: false,   // Qwen3 via vLLM / SGLang / llama.cpp
      thinking: false,          // DeepSeek-V3.x's spelling of the same switch
    },
    think: false,               // Ollama's native flag
  } : {};

  const base = {
    model, messages,
    temperature: body.temperature ?? llm.temperature ?? 0.7,
    max_tokens: body.maxTokens ?? llm.maxTokens ?? 1600,
    stream: false,
    ...quiet,
  };
  const probe = probeFor(llm.url || "", model);
  let useQuiet = suppress && probe.quiet !== false;
  const effort = strengthFor(llm, suppress);
  let useStrength = !!effort && probe.strength !== false;

  /* Qwen3's soft switch — inert to every other model. */
  if (suppress && String(llm.noThinkTag ?? "on") !== "off") {
    const last = base.messages[base.messages.length - 1];
    if (last && typeof last.content === "string") last.content = `${last.content}\n/no_think`;
    else if (last && Array.isArray(last.content)) {
      const t = last.content.find(part => part?.type === "text");
      if (t) t.text = `${t.text}\n/no_think`;
    }
  }

  /* JSON mode is optional, everywhere: ask for it, and if the backend says no,
   * ask again without it and remember that for the rest of the session. */
  const wantJson = !!body.json && jsonMode(llm) !== "off";
  let useFlag = wantJson && probe.json !== false;

  const build = () => {
    const out = { ...base };
    if (!useQuiet) for (const k of QUIET_KEYS) delete out[k];
    if (useStrength) {
      out.reasoning_effort = effort;
      out.chat_template_kwargs = { ...(out.chat_template_kwargs || {}), reasoning_effort: effort, reasoning_strength: effort };
    }
    if (useFlag) out.response_format = { type: "json_object" };
    return out;
  };

  const t0 = Date.now();
  let r, text, data;
  const send = async () => {
    r = await llmFetch("/v1/chat/completions", { method: "POST", body: build(), timeout: body.timeout ?? 600000 });
    text = await r.text();
    data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
  };
  await send();

  // Up to two retries, each dropping exactly the extra the backend named.
  for (let attempt = 0; attempt < 2 && !r.ok; attempt++) {
    if (useFlag && rejectsJsonMode(r.status, data, text)) { probe.json = false; useFlag = false; }
    else if (useQuiet && rejectsUnknownField(r.status, data, text)) { probe.quiet = false; useQuiet = false; }
    else if (useStrength && (rejectsStrength(r.status, data, text) || rejectsUnknownField(r.status, data, text))) { probe.strength = false; useStrength = false; }
    else break;
    await send();
  }
  if (r.ok && useFlag) probe.json = true;
  if (r.ok && useQuiet) probe.quiet = true;
  if (r.ok && useStrength) probe.strength = true;

  if (!r.ok) {
    throw Object.assign(new Error(data?.error?.message || data?.error || text.slice(0, 400) || `LLM ${r.status}`), { status: r.status === 404 ? 502 : r.status });
  }

  const out = readChoice(data, { allowReasoningFallback: !!body.json });
  return {
    text: out.text,
    model: data?.model || model,
    usage: data?.usage || null,
    ms: Date.now() - t0,
    finish: out.finish,
    reasoned: out.reasoned,
    fromReasoning: out.fromReasoning,
    jsonMode: useFlag,
    truncated: out.finish === "length",
  };
}

/**
 * The assistant's text, wherever this runtime decided to put it.
 *
 * vLLM, SGLang, LM Studio, Ollama and OpenRouter all ship the chain of thought
 * in a field of their own, and several of them will leave `content` EMPTY when
 * the model only thought or the answer never arrived.
 */
function readChoice(data, { allowReasoningFallback = true } = {}) {
  const choice = data?.choices?.[0];
  const msg = choice?.message || {};
  const asText = (v) => typeof v === "string" ? v
    : Array.isArray(v) ? v.map(p => (typeof p === "string" ? p : p?.text || "")).join("")
    : "";
  const content = asText(msg.content).trim();
  const reasoning = [msg.reasoning_content, msg.reasoning, msg.thinking]
    .map(asText).find(v => v.trim()) || "";
  // Chain-of-thought is a fallback only where something will try to parse an
  // object out of it — for a prose call, falling back would paste the model's
  // private deliberation straight into the project.
  const useReasoning = allowReasoningFallback && !content && !!reasoning.trim();
  const source = useReasoning ? reasoning : content;
  const { outside } = stripReasoning(source);
  return {
    text: (allowReasoningFallback ? source : outside).trim(),
    fromReasoning: useReasoning,
    reasoned: !!reasoning.trim()
      || Number(data?.usage?.completion_tokens_details?.reasoning_tokens || 0) > 0,
    finish: choice?.finish_reason || "",
  };
}
