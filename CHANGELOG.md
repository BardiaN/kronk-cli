# Changelog

Generated from the commit history by `npm run changelog` — do not edit by hand.

Every entry is one squash-merged pull request, grouped by its [Conventional Commits](https://www.conventionalcommits.org) type. A commit whose subject does not parse as one is not dropped; it appears under **Other changes**.

Releases before `v0.2.0` predate the convention (#15) and are deliberately not back-filled — see the [releases page](https://github.com/BardiaN/kronk-cli/releases) for those.

## 0.5.0 — 2026-09-05

### Features

- **ui**: render the model's markdown for the terminal as it streams ([`354acd2`](https://github.com/BardiaN/kronk-cli/commit/354acd2135f857f202ff5738bd9fe62e7602c51c))

### Fixes

- **repl**: keep the lines typed before the first prompt ([`faa5490`](https://github.com/BardiaN/kronk-cli/commit/faa5490049387122a6dd44d4ed5ed3218152cf76))
- **ui**: hand back what was typed while the background query was in flight ([`9e7b758`](https://github.com/BardiaN/kronk-cli/commit/9e7b75816b7b03f8c29f139a6e1af180cecc7f21))
- **ui**: pick the palette from the terminal's background, not from bright black ([`0a23134`](https://github.com/BardiaN/kronk-cli/commit/0a23134e7da77f9d2b91e4aa1bc010ab3cfda9e7))

### Chores

- **release**: 0.5.0 — a readable status line, rendered answers, and typing that survives startup ([`d2b042c`](https://github.com/BardiaN/kronk-cli/commit/d2b042cb7509e02d2da47cfcc01d7e9df5e64939))

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
