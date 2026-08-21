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

/**
 * Effective context window for a model id, plus the model's native maximum.
 * The id contains slashes, so it must be percent-encoded — Kronk's route takes
 * one path segment and 404s on a raw id.
 */
export async function modelLimits(id) {
  try {
    const d = await (await req(`/kronk/models/${encodeURIComponent(id)}`)).json();
    const configured = d.model_config?.['context-window'] ?? null;
    const nativeKey = Object.keys(d.metadata ?? {}).find((k) => k.endsWith('.context_length'));
    const native = nativeKey ? Number(d.metadata[nativeKey]) : null;
    return { configured, native };
  } catch { return { configured: null, native: null }; }
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
export async function* streamChat({ model, messages, tools, signal, maxTokens, noThink }) {
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
