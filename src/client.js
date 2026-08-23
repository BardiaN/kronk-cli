import { config, headers } from './config.js';
import { createSseParser, accumulateToolCalls } from './sse.js';

async function req(path, init = {}) {
  const res = await fetch(`${config.baseUrl}${path}`, { headers: headers(), ...init });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${path} — ${body.slice(0, 400)}`);
  }
  return res;
}

export async function listModels() {
  const { data } = await (await req('/models')).json();
  return data.map((m) => m.id);
}

// Which model-metadata key names each sampling parameter, and how the same
// value is spelled in `model_config['sampling-parameters']` once the profile
// has been applied.
const SAMPLING_KEYS = [
  { meta: 'general.sampling.temp', effective: 'temperature', label: 'temperature' },
  { meta: 'general.sampling.top_k', effective: 'top_k', label: 'top_k' },
  { meta: 'general.sampling.top_p', effective: 'top_p', label: 'top_p' },
];

// Metadata travels GGUF -> YAML -> JSON before it reaches here, and that chain
// can land a value a few float64 ULPs from where it started — observed on this
// exact pair: Number('0.95') and 0.9500001 differ by ~1.0e-7. The 1e-9 anchor
// suggested for this feature is tighter than that observed noise and would
// misfire on the very case it exists to swallow, so the tolerance here is
// 1e-6: an order of magnitude above the measured round-trip noise, and still
// four-plus orders of magnitude below the smallest override a person would
// plausibly type (e.g. 0.6 vs 1).
const SAMPLING_TOLERANCE = 1e-6;

/**
 * Compare a model's own sampling metadata (GGUF values, always strings) against
 * the effective sampling-parameters Kronk is actually applying (profile-merged,
 * always numbers). Pure — no I/O — so this is the whole testable surface for
 * the startup warning: the boot path just hands it what `/kronk/models/{id}`
 * already returned.
 *
 * A side that is missing, or does not parse to a finite number, is "no
 * opinion" rather than a difference — a model with no sampling metadata, or a
 * profile field this build doesn't recognise, must never produce a warning.
 *
 * Returns null when there is nothing to report, or the list of parameters
 * that disagree — each with the model's own value and the effective one —
 * for the caller to render as a single line.
 */
export function samplingOverride(metadata, sampling) {
  if (!metadata || !sampling) return null;
  const diffs = [];
  for (const { meta, effective, label } of SAMPLING_KEYS) {
    const modelValue = Number(metadata[meta]);
    const effectiveValue = Number(sampling[effective]);
    if (!Number.isFinite(modelValue) || !Number.isFinite(effectiveValue)) continue;
    if (Math.abs(modelValue - effectiveValue) > SAMPLING_TOLERANCE) {
      diffs.push({ param: label, model: modelValue, effective: effectiveValue });
    }
  }
  return diffs.length ? diffs : null;
}

/**
 * Effective context window for a model id, the model's native maximum,
 * whether its chat template understands `preserve_thinking`, and whether the
 * profile is overriding the model's own sampling values.
 * The id contains slashes, so it must be percent-encoded — Kronk's route takes
 * one path segment and 404s on a raw id.
 *
 * The template is the only reliable source for `preserveThinking`: Kronk
 * reports `model_config["chat-template-kwargs"]` as null even when the
 * profile sets the flag, so what the server is already doing cannot be read
 * back. The sampling comparison has no such gap — metadata and the effective
 * values are both in this same response — so it needs no second request.
 *
 * Every failure answers "unknown" / "no warning", which the caller reads as
 * "say nothing and proceed".
 */
export async function modelLimits(id) {
  try {
    const d = await (await req(`/kronk/models/${encodeURIComponent(id)}`)).json();
    const configured = d.model_config?.['context-window'] ?? null;
    const nativeKey = Object.keys(d.metadata ?? {}).find((k) => k.endsWith('.context_length'));
    const native = nativeKey ? Number(d.metadata[nativeKey]) : null;
    const template = d.metadata?.['tokenizer.chat_template'];
    const preserveThinking = typeof template === 'string' && template.includes('preserve_thinking');
    const samplingDiff = samplingOverride(d.metadata, d.model_config?.['sampling-parameters']);
    return {
      configured, native, preserveThinking, samplingDiff,
    };
  } catch {
    return {
      configured: null, native: null, preserveThinking: false, samplingDiff: null,
    };
  }
}

/** Native Kronk model list: size, projector, validation. */
export async function listModelDetails() {
  try {
    const { data } = await (await req('/kronk/models')).json();
    return data ?? [];
  } catch { return []; }
}

/** Which models are resident in the pool right now, and what they cost. */
export async function listLoaded() {
  try {
    return await (await req('/kronk/models/ps')).json();
  } catch { return []; }
}

export async function tokenize(model, input) {
  try {
    const r = await (await req('/tokenize', {
      method: 'POST',
      body: JSON.stringify({ model, input }),
    })).json();
    return r.tokens;
  } catch {
    return Math.ceil(input.length / 4);
  }
}

/**
 * Stream a chat completion. Yields:
 *   {type:'text',      value}
 *   {type:'reasoning', value}
 *   {type:'usage',     value}
 *   {type:'done',      calls, finish}
 */
export async function* streamChat({
  model, messages, tools, signal, maxTokens, noThink, preserveThinking,
}) {
  const res = await req('/chat/completions', {
    method: 'POST',
    signal,
    body: JSON.stringify({
      model,
      messages,
      ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: maxTokens,
      ...(noThink ? { enable_thinking: false } : {}),
      ...(preserveThinking ? { chat_template_kwargs: { preserve_thinking: true } } : {}),
    }),
  });

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const parser = createSseParser();
  const calls = new Map();
  let finish = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    for (const payload of parser.push(dec.decode(value, { stream: true }))) {
      if (payload === '[DONE]') continue;

      let chunk;
      try { chunk = JSON.parse(payload); } catch { continue; }

      if (chunk.usage) yield { type: 'usage', value: chunk.usage };

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;

      const d = choice.delta;
      if (!d) continue;

      if (d.reasoning_content) yield { type: 'reasoning', value: d.reasoning_content };
      if (d.content)           yield { type: 'text',      value: d.content };

      accumulateToolCalls(calls, d.tool_calls);
    }
  }

  yield { type: 'done', calls: [...calls.values()], finish };
}

/**
 * Load a model into the pool.
 *
 * Kronk has no explicit "load" endpoint — admission happens on the first
 * inference request, so the cheapest possible completion *is* the load
 * command. A 23 GB MoE takes ~10–25 s off disk. The reply is discarded;
 * only whether it succeeded matters.
 */
export async function warm(id, signal) {
  const res = await req('/chat/completions', {
    method: 'POST',
    signal,
    body: JSON.stringify({
      model: id,
      messages: [{ role: 'user', content: 'hi' }],
      max_completion_tokens: 1,
      enable_thinking: false,
    }),
  });
  await res.text();
}
