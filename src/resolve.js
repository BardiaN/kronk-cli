/**
 * Resolve a wanted model id against the ids Kronk is actually serving.
 *
 * This exact three-step fallback — exact id wins, else the closest substring,
 * preferring an /AGENT profile — used to be written out three times: the main
 * model pick and the sub-agent model pick in src/index.js's boot(), and
 * `/model` in the REPL. None of the three needed a copy of their own; they
 * needed this. Now a fourth site has the same problem — a delegated task
 * naming a model by a short id — and it calls this instead of becoming a
 * fourth copy.
 *
 * Exact match wins outright: a caller who already typed the whole id gets
 * exactly that id, never a substring guess. Among the substring matches, an
 * /AGENT profile wins over the bare id, because Kronk holds each as a
 * separate resident copy in the pool — picking the wrong one silently loads
 * a second one.
 *
 * Returns null rather than throwing. Every caller already has its own way of
 * saying "nothing matched" — a console warning that falls back to a default,
 * or a tool result a small local model can act on — and none of them is this
 * function's business.
 */
export function resolveModel(want, ids) {
  if (!want || !Array.isArray(ids) || !ids.length) return null;
  const subs = ids.filter((id) => id.includes(want));
  return ids.find((id) => id === want) ?? subs.find((id) => id.endsWith('/AGENT')) ?? subs[0] ?? null;
}
