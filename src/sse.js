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
