/**
 * Incremental Server-Sent Events parser.
 *
 * Kept separate from the HTTP call so the protocol logic can be tested without
 * a server: chunk boundaries fall in arbitrary places, and a parser that only
 * works when each read lands on a line boundary will fail in production and
 * pass every naive test.
 */
export function createSseParser() {
  let buf = '';
  return {
    /** Feed a chunk; get back the complete `data:` payloads it completed. */
    push(chunk) {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      const out = [];
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload) out.push(payload);
      }
      return out;
    },
    /** Anything left in the buffer that never saw a newline. */
    flush() {
      const rest = buf;
      buf = '';
      return rest.startsWith('data: ') ? [rest.slice(6).trim()].filter(Boolean) : [];
    },
  };
}

/** Merge streamed tool-call deltas, accumulating arguments by index. */
export function accumulateToolCalls(calls, deltas) {
  for (const tc of deltas ?? []) {
    const idx = tc.index ?? 0;
    const cur = calls.get(idx) ?? { id: '', name: '', args: '' };
    if (tc.id) cur.id = tc.id;
    if (tc.function?.name) cur.name = tc.function.name;
    if (tc.function?.arguments) cur.args += tc.function.arguments;
    calls.set(idx, cur);
  }
  return calls;
}

/**
 * Token usage that a failed request carries. Kronk 1.32.8 puts it beside the
 * error (`{"error":{...},"usage":{...}}`), so tokens spent before the failure
 * are not lost; the nested spelling is accepted too in case a route wraps it.
 * Older servers send neither, which is `null` here, never an error.
 */
export function errorUsage(body) {
  const u = body?.usage ?? body?.error?.usage;
  return u && typeof u === 'object' ? u : null;
}

/**
 * If an SSE chunk is an error frame, the Error to throw for it, carrying any
 * usage. Before this the frame was skipped (it has no `choices`), so a failed
 * stream looked like an empty, successful one.
 */
export function errorFrame(chunk) {
  if (!chunk || chunk.error == null) return null;
  const msg = typeof chunk.error === 'string' ? chunk.error : chunk.error.message;
  const err = new Error(`stream error — ${String(msg ?? 'unknown error').slice(0, 400)}`);
  err.usage = errorUsage(chunk);
  return err;
}
