# Contributing

Thanks for helping out. This project stays deliberately small: **zero runtime
dependencies**, plain ESM, no build step. Changes that hold that line are easiest to merge.

## Getting set up

```bash
git clone https://github.com/BardiaN/kronk-cli && cd kronk-cli
npm install          # dev tooling only — the CLI itself has no dependencies
npm link             # `kronk-cli` now runs your working tree
npm run check        # lint + tests
```

You need a running Kronk server to exercise it end to end:

```bash
kronk model pull unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M
kronk server start --detach
```

## Before you open a PR

```bash
npm run check
```

CI runs the same thing on Node 20, 22 and 24, on Linux and macOS. The test script uses an
unquoted glob on purpose: Node 20's `--test` cannot expand glob patterns itself, and Node 24
mishandles a bare directory, so the shell has to do the expanding. It also checks that the CLI
starts and fails cleanly with no server running.

## What gets merged quickly

- A test that fails before your change and passes after it.
- One concern per PR.
- No new runtime dependencies. `devDependencies` are fine.
- Comments that explain *why*, not *what*. Existing ones are the house style.

## What needs discussion first

Open an issue before starting on:

- a new runtime dependency, of any size
- a new tool the agent can call, especially one that writes or executes
- changes to the approval prompts or the sandbox root
- anything that sends data anywhere other than the configured Kronk server

This is a tool that runs shell commands on people's machines. Changes near that boundary get
looked at carefully, and that is not a comment on you.

## Testing notes

Tests use the built-in `node:test` runner — no framework, no config.

```bash
npm test                            # everything
node --test test/tools.test.js      # one file
```

Prefer testing pure functions. Protocol code (`src/sse.js`) and text handling
(`src/distill.js`) are the parts most worth covering, because they fail in ways that are quiet.

## Review

Every PR needs an approving review from a maintainer before it can merge. Expect
questions — they are about the change, not about you.
