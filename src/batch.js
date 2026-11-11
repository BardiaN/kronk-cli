/**
 * Scheduling for the tool calls of one assistant message.
 *
 * Only tools that cannot change anything may overlap, and only with each
 * other: a gated call (write_file, bash), `task`, `set_plan` and every MCP
 * tool — whose side effects we cannot know — stay alone, in the order the
 * model wrote them. Pure so the grouping can be tested without a model.
 */

/** Tools that read the working tree and nothing else. */
export const READ_ONLY = new Set(['read_file', 'list_dir', 'search']);

/** More than this at once buys little on a local disk and floods the output. */
export const MAX_PARALLEL = 4;

/**
 * Group `calls` into batches that run one after another. A batch of several
 * calls runs concurrently; a batch of one runs on its own. Concatenating the
 * batches gives back `calls` in its original order.
 *
 * `parallelOk(call)` says whether a call may overlap with others — the caller
 * decides, because it alone knows which tools were really offered and which
 * arguments parsed.
 */
export function planBatches(calls, parallelOk, cap = MAX_PARALLEL) {
  const batches = [];
  let run = [];
  const flush = () => {
    for (let i = 0; i < run.length; i += cap) batches.push(run.slice(i, i + cap));
    run = [];
  };
  for (const call of calls) {
    if (parallelOk(call)) { run.push(call); continue; }
    flush();
    batches.push([call]);
  }
  flush();
  return batches;
}

/** `Promise.all` over `fn`, resolving in input order whatever order they finish in. */
export function runConcurrently(items, fn) {
  return Promise.all(items.map((item) => fn(item)));
}
