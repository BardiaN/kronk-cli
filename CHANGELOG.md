# Changelog

Generated from the commit history by `npm run changelog` — do not edit by hand.

Every entry is one squash-merged pull request, grouped by its [Conventional Commits](https://www.conventionalcommits.org) type. A commit whose subject does not parse as one is not dropped; it appears under **Other changes**.

Releases before `v0.2.0` predate the convention (#15) and are deliberately not back-filled — see the [releases page](https://github.com/BardiaN/kronk-cli/releases) for those.

## 0.9.0 — 2026-11-11

### Features

- **repl**: steer a running task by typing while it works ([#130](https://github.com/BardiaN/kronk-cli/pull/130))
- **session**: resume a previous REPL session with --resume, --sessions and /resume ([#132](https://github.com/BardiaN/kronk-cli/pull/132))
- **repl**: attach images to a message with /file ([#123](https://github.com/BardiaN/kronk-cli/pull/123))
- **hooks**: run user commands before and after a tool call ([#128](https://github.com/BardiaN/kronk-cli/pull/128))
- **tools**: keep a bash command running in the background when it hits its timeout ([#126](https://github.com/BardiaN/kronk-cli/pull/126))
- **approval**: add --deny to refuse tools that need approval ([#127](https://github.com/BardiaN/kronk-cli/pull/127))
- **ui**: report working, needs approval and ready to the terminal ([#133](https://github.com/BardiaN/kronk-cli/pull/133))
- **repl**: saved prompt presets invoked as /<name> ([#117](https://github.com/BardiaN/kronk-cli/pull/117))
- **agent**: run read-only tool calls concurrently ([#114](https://github.com/BardiaN/kronk-cli/pull/114))
- **tools**: add edit_file for exact string replacement ([#112](https://github.com/BardiaN/kronk-cli/pull/112))

### Fixes

- **tools**: make bash_output wait on a quiet running job ([#139](https://github.com/BardiaN/kronk-cli/pull/139))
- **tools**: keep the cwd marker out of live bash progress ([#137](https://github.com/BardiaN/kronk-cli/pull/137))
- **agent**: honour --no-compact when the server reports an overflow ([#135](https://github.com/BardiaN/kronk-cli/pull/135))
- **client**: count the usage a failed request carries ([#121](https://github.com/BardiaN/kronk-cli/pull/121))

## 0.8.5 — 2026-11-10

### Fixes

- refuse a transcript or rescue directory that another user owns ([#109](https://github.com/BardiaN/kronk-cli/pull/109))

### CI

- allow the security workflow to be run by hand ([#108](https://github.com/BardiaN/kronk-cli/pull/108))

## 0.8.4 — 2026-11-09

### Build

- bump eslint to 10.14.0 and lift minimatch past GHSA-g3hv-75wg-m249 ([#106](https://github.com/BardiaN/kronk-cli/pull/106))

### CI

- bump the codeql-action group with 3 updates ([#104](https://github.com/BardiaN/kronk-cli/pull/104))

## 0.8.3 — 2026-10-16

### Build

- bump eslint from 10.11.0 to 10.12.0 ([#98](https://github.com/BardiaN/kronk-cli/pull/98))
- write the bin path the way npm normalises it ([#96](https://github.com/BardiaN/kronk-cli/pull/96))

### CI

- bump ossf/scorecard-action from 2.4.4 to 2.5.0 ([#101](https://github.com/BardiaN/kronk-cli/pull/101))
- bump actions/setup-node from 7.0.0 to 7.1.0 ([#100](https://github.com/BardiaN/kronk-cli/pull/100))
- bump the codeql-action group with 3 updates ([#99](https://github.com/BardiaN/kronk-cli/pull/99))

## 0.8.2 — 2026-10-02

### Fixes

- **update**: resolve the bin symlink before detecting how kronk-cli was installed ([#94](https://github.com/BardiaN/kronk-cli/pull/94))

## 0.8.1 — 2026-10-01

### Tests

- **smoke**: a local smoke suite that drives the real CLI against a real server ([#91](https://github.com/BardiaN/kronk-cli/pull/91))

### CI

- bump the codeql-action group with 3 updates ([#92](https://github.com/BardiaN/kronk-cli/pull/92))

## 0.8.0 — 2026-09-28

### Features

- **rescue**: a job queue an external caller can submit to, follow up on, and collect from ([#89](https://github.com/BardiaN/kronk-cli/pull/89))
- **version**: report the running version and say when a newer one is available ([#87](https://github.com/BardiaN/kronk-cli/pull/87))
- **subagent**: let a delegated task name the model it runs on ([#88](https://github.com/BardiaN/kronk-cli/pull/88))

## 0.7.0 — 2026-09-24

### Features

- draw a sub-agent run in a pane that erases itself when it ends ([#82](https://github.com/BardiaN/kronk-cli/pull/82))

### Build

- bump eslint from 10.10.0 to 10.11.0 ([#80](https://github.com/BardiaN/kronk-cli/pull/80))

### CI

- bump the codeql-action group with 3 updates ([#81](https://github.com/BardiaN/kronk-cli/pull/81))

## 0.6.1 — 2026-09-16

### Fixes

- a search that matches nothing is an answer, not a failed command ([#77](https://github.com/BardiaN/kronk-cli/pull/77))

## 0.6.0 — 2026-09-16

### Features

- keep a transcript of every sub-agent run, and a /tasks to read it ([#74](https://github.com/BardiaN/kronk-cli/pull/74))

### CI

- bump the codeql-action group with 3 updates ([#73](https://github.com/BardiaN/kronk-cli/pull/73))
- give dependabot's npm bumps a conventional type the changelog knows ([#72](https://github.com/BardiaN/kronk-cli/pull/72))

## 0.5.1 — 2026-09-16

### Other changes

- deps: bump eslint from 10.9.1 to 10.10.0 ([#69](https://github.com/BardiaN/kronk-cli/pull/69))

## 0.5.0 — 2026-09-06

### Fixes

- **ui**: pick the palette from the terminal's background, and render what the model writes ([#65](https://github.com/BardiaN/kronk-cli/pull/65))

## 0.4.0 — 2026-09-04

### Features

- delegate a task to a sub-agent that runs in its own context ([#61](https://github.com/BardiaN/kronk-cli/pull/61))

### Fixes

- take every model limit from the selected model, not from boot ([#62](https://github.com/BardiaN/kronk-cli/pull/62))

## 0.3.1 — 2026-09-03

### CI

- move scorecard-action to 2.4.4, off the GCR image that stopped serving ([#58](https://github.com/BardiaN/kronk-cli/pull/58))
- bump softprops/action-gh-release from 3.0.2 to 3.0.3 ([#57](https://github.com/BardiaN/kronk-cli/pull/57))
- bump the codeql-action group with 3 updates ([#56](https://github.com/BardiaN/kronk-cli/pull/56))

### Chores

- **release**: 0.3.1 — action pins forward, and scorecard off a registry that went dark ([`0cf663a`](https://github.com/BardiaN/kronk-cli/commit/0cf663a178bf013773dfc56419fb16b2ca72286c))

## 0.3.0 — 2026-08-27

### Features

- ask before denying credential stores, so a logged-in gh keeps working ([#54](https://github.com/BardiaN/kronk-cli/pull/54))

### CI

- generate the changelog from the conventional commits we already write ([#53](https://github.com/BardiaN/kronk-cli/pull/53))

### Chores

- **release**: 0.3.0 ([`350d6b0`](https://github.com/BardiaN/kronk-cli/commit/350d6b05c9c131daf92bb4960dbc9c786ea2e822))

## 0.2.1 — 2026-08-27

### Other changes

- Release 0.2.1 — move every pinned action onto node24, and pin the publish job's cache off ([#51](https://github.com/BardiaN/kronk-cli/pull/51))

## 0.2.0 — 2026-08-23

### Documentation

- stop recommending explicit sampling parameters in the /AGENT profile ([#17](https://github.com/BardiaN/kronk-cli/pull/17))

### Other changes

- Release 0.2.0 — setup subcommand, a task checklist, and a prompt cache that holds ([#44](https://github.com/BardiaN/kronk-cli/pull/44))
