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

## Commits and releases

Every commit, and the PR title, follows [Conventional
Commits](https://www.conventionalcommits.org/): `type(scope): summary`, where `type` is one of
`feat`, `fix`, `docs`, `ci`, `test`, `refactor`, `chore`, `perf`, `build`. Mark a breaking change
with `!` after the type (`feat!: …`) or a `BREAKING CHANGE:` footer.

Versioning is npm [semver](https://semver.org/), and the release mechanism reads it directly:
`release.yml`'s `gate` job tags `v<version>` from `package.json` whenever that version has no tag
yet, and skips otherwise. That makes releasing a two-step flow:

1. A feature or fix PR merges without touching `version` in `package.json`. This is the normal
   case — most PRs stop here.
2. A separate release commit bumps `version`, runs `npm run changelog`, and merges on its own.
   That merge is what trips the `gate` job and cuts the tag, publishes to npm, and creates the
   GitHub Release.

`npm run changelog` regenerates `CHANGELOG.md` from the commit subjects, which is why the
convention above is worth keeping. Run it in the release commit, after the version bump, and
commit what it writes — `release.yml` reads that file for the GitHub Release body and fails the
release before tagging if it has no entry for the version being shipped.

Two things about it worth knowing before you are surprised by them:

- **Already-published sections are frozen.** Regenerating only rewrites the release being
  prepared. A shipped entry lists one line per commit that went into it, and those commits are no
  longer individually reachable once the pull request is squashed — re-rendering would replace the
  list with the squash subject and lose the detail for good.
- **Nothing is filtered.** A subject that is not a conventional commit still appears, under
  *Other changes*. A changelog that silently drops what it cannot classify is worse than one with
  an ugly line in it, because only the second kind tells you it happened.

`CHANGELOG.md` is deliberately **not** in the published npm tarball. `package.json`'s `files`
allowlist decides that, and `security.yml` asserts on the result; the changelog is repository and
release metadata, and it is already on the GitHub Release for anyone who wants it.

Don't bump `version` in a feature or fix PR — it will be rejected. If your change is CI- or
docs-only, its commits use the matching type (`ci:`, `docs:`) and the PR still doesn't touch the
version.

## Review

`master` takes no direct pushes from anyone, maintainers included. Every change arrives as a pull
request, needs a passing CI run and an approving review from a code owner, and must be up to date
with `master` before it merges.

Expect questions — they are about the change, not about you.
