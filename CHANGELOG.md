# Changelog

Generated from the commit history by `npm run changelog` — do not edit by hand.

Every entry is one squash-merged pull request, grouped by its [Conventional Commits](https://www.conventionalcommits.org) type. A commit whose subject does not parse as one is not dropped; it appears under **Other changes**.

Releases before `v0.2.0` predate the convention (#15) and are deliberately not back-filled — see the [releases page](https://github.com/BardiaN/kronk-cli/releases) for those.

## 0.11.0 — 2026-11-12

### Features

- **tools**: ask before reading outside the launch folder ([`9f00aef`](https://github.com/BardiaN/kronk-cli/commit/9f00aefa0435d5c3365ca701acb5b0d70e341184))

### Fixes

- **tools**: read a file through the handle that was checked ([`afa47ce`](https://github.com/BardiaN/kronk-cli/commit/afa47ce331b4f47d0ad92d4c12aae38d8fcfdc0d))
- **repl**: a line typed before a prompt was shown cannot answer it ([`50988d3`](https://github.com/BardiaN/kronk-cli/commit/50988d3984e268ad99b537db117df7273e7d5b12))
- **tools**: make a declined read final in the tool result ([`bd129d2`](https://github.com/BardiaN/kronk-cli/commit/bd129d26b09f66ee6eeda9e41bcbe009ff84473a))
- **tools**: stop search patterns being read as options ([`c94d518`](https://github.com/BardiaN/kronk-cli/commit/c94d518b1377611a0f6b321c1d02c75e0349a240))
- **tools**: never offer the home folder as a folder grant ([`8dc36a8`](https://github.com/BardiaN/kronk-cli/commit/8dc36a86b5f6c28d3df0ac9dda6cabfeafbd3f78))
- **tools**: refuse credential stores inside the launch root too ([`eb1cfe6`](https://github.com/BardiaN/kronk-cli/commit/eb1cfe64d723ce4e984a71a04a08e7c9245a8bea))
- **tools**: match credential stores without regard to case on APFS and NTFS ([`8cdd9f6`](https://github.com/BardiaN/kronk-cli/commit/8cdd9f617be0ca547b8e1119c8de1ad1b9964daa))

### Tests

- **smoke**: drive the REPL without a shell ([`bee759e`](https://github.com/BardiaN/kronk-cli/commit/bee759e860b7eaa45223f88826601cb90a0f6f1a))
- **smoke**: reading outside the launch folder, asked and answered over a pty ([`c58696c`](https://github.com/BardiaN/kronk-cli/commit/c58696c9f8fa6b6527b41cfaf23557dd3242c41f))

### CI

- bump softprops/action-gh-release from 3.0.3 to 3.0.4 ([#145](https://github.com/BardiaN/kronk-cli/pull/145))
- bump the codeql-action group with 3 updates ([#144](https://github.com/BardiaN/kronk-cli/pull/144))

## 0.10.0 — 2026-11-11

### Features

- **repl**: attach files with /file anywhere in a prompt ([`086fb0a`](https://github.com/BardiaN/kronk-cli/commit/086fb0ac79917e788424dacae0d1b7211a72dd50))
- **tools**: let read_file show an image to a vision model ([`152cbb5`](https://github.com/BardiaN/kronk-cli/commit/152cbb5e17680416464d4cfaef27846bbd114123))

### Fixes

- **repl**: /context counts tool schemas and images and labels estimate vs measured ([`db83558`](https://github.com/BardiaN/kronk-cli/commit/db83558d81b60b4460036d84e96220646a3b8e39))
- **session**: --resume names the folder a session belongs to, and reports corrupt files ([`784b46f`](https://github.com/BardiaN/kronk-cli/commit/784b46f1c528f763f8d28fddb168958bbb62b024))
- **image**: warn when an image goes to a model without vision ([`cf95088`](https://github.com/BardiaN/kronk-cli/commit/cf9508869d3e5c28f62350a7a9f79f1c1bde4827))
- **image**: say a 0-byte image path is empty instead of reading it as empty text ([`8d41cad`](https://github.com/BardiaN/kronk-cli/commit/8d41cad22f213cd7381b0dd92670f44d5dfdc1ee))
- **config**: warn about an unreadable config file, bad hooks and skipped presets ([`b69ab6b`](https://github.com/BardiaN/kronk-cli/commit/b69ab6b66a00bfb010eb4d620160389d70d34ce6))
- **tools**: no orphaned foreground command on exit, SIGHUP or SIGTERM ([`e07996e`](https://github.com/BardiaN/kronk-cli/commit/e07996ea94b0846c7098e8887a1d1e6cd210edf7))
- **tools**: Ctrl-C stops a running foreground bash command ([`1546ee1`](https://github.com/BardiaN/kronk-cli/commit/1546ee1faee6c75381ce508a1ce5be5c893fe8e7))
- **tools**: edit_file matches LF text against CRLF files and keeps their endings ([`eb5985f`](https://github.com/BardiaN/kronk-cli/commit/eb5985fd36a620620eba5fe6bb905f3666d667ec))
- **repl**: attach a quoted or extensionless image path with /file ([`1aef7c1`](https://github.com/BardiaN/kronk-cli/commit/1aef7c14c3bcacd02057b42b878c91f82dd5331c))

### Documentation

- correct the source size in the README ([`ab67ec9`](https://github.com/BardiaN/kronk-cli/commit/ab67ec9fa8c39492b4e281e7d914b3dccb49685f))

### Tests

- **smoke**: check /file and read_file against a real vision model ([`264b22b`](https://github.com/BardiaN/kronk-cli/commit/264b22bb2641b6095e1c1aff73097c285024bd17))

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
