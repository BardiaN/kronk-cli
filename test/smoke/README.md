# Local smoke tests

```bash
npm run smoke
```

That is the whole thing to remember. It drives the real CLI, as real processes, against a real
Kronk server and a real model.

## What it is for

`npm test` proves the pieces in isolation and runs in seconds with no server. This suite proves
the program, and only catches what needs a model, a terminal or a second process to go wrong:
that a delegated task really lands on the model it asked for, that the pane and the banner really
render, that a rescue job really outlives the command that submitted it, and above all that a
write is really refused when nobody said `--yes`.

It is slow — minutes — because a real model answers every prompt in it. That is the cost of it
being worth anything.

## What it needs, and what it works out for itself

Nothing configured. It discovers everything:

- **A server.** If Kronk is not answering at `KRONK_URL`, it starts one with
  `kronk server start --detach` and waits for it. If there is no `kronk` binary on `PATH` it
  **skips the whole suite** and tells you to install Kronk. A missing server is "cannot run
  here", not "the code is broken".
- **Models.** It asks Kronk what it is serving and takes the largest chat model as the
  orchestrator and the smallest as the second, lighter one, then warms both — a cold 20 GB model
  takes 10-30 seconds and would otherwise look like a hang inside the first check.
- **One model only?** The checks that need somewhere to delegate *to* skip with a message. The
  rest run.

## Why there are no model ids in these files

So that this directory can live in git without carrying anything about the machine it runs on.
No model ids, no home directory, no paths, no MCP server names. If you want to pin a particular
pair of models on your own machine, do it outside the repository's tracked files:

```bash
SMOKE_MODEL=<part-of-a-served-id> SMOKE_LIGHT_MODEL=<part-of-another-one> npm run smoke
```

or `test/smoke/smoke.local.json`, which is gitignored:

```json
{ "model": "<part of a served id>", "lightModel": "<part of another one>" }
```

Both keys take a full model id or any substring of one, resolved exactly the way `-m` already
resolves on the real CLI.

## Why it never runs in CI

Two independent reasons, because one would be a decision waiting to be undone:

1. `npm test` is `node --test test/*.test.js`. That glob cannot reach a subdirectory, so these
   files are invisible to it, and CI runs `npm run check`, which is lint plus that.
2. The suite skips every check when `CI` is set in the environment, whatever glob is pointed at
   it.

A CI runner has no Kronk server, no model, and no twenty minutes to spare.

## When to run it

Before a release, and after any change to `src/pane.js`, `src/ui.js`, `src/theme.js` or
`src/prompt.js` — the terminal behaviour is exactly what a piped test cannot see.

## Reading a failure

Each check puts the actual output in its assertion message, because a rerun costs minutes. Start
there rather than rerunning. One caveat worth knowing: a check that asserts the model said a
particular word depends on a local model following an instruction, so a failure there may be the
model having a bad day rather than a regression. Everything about exit codes, files on disk, job
states and rendered output is deterministic and a failure in those is real.

## A note on portability

`repl()` in `harness.js` drives the interactive REPL through `script -q /dev/null <cmd>`, which
is the BSD calling convention. GNU `script`, the one Linux ships, wants `-c "<command string>"`
instead. Nothing detects the difference, because every machine this has run on is a Mac; that is
the reason it is unhandled, not a decision that it should stay that way.
