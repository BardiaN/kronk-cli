# AGENTS.md

Instructions for an automated contributor working in this repository. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full human-facing version of the same rules.

## Before you push

```bash
npm run check
```

This is lint plus the full test suite. It must be green.

## Zero runtime dependencies

`package.json` must not gain a `dependencies` key. `devDependencies` are fine. A change that
needs a runtime dependency, of any size, needs an issue discussed first, not just a PR.

## Commits and releases

Commits, and the PR title, follow [Conventional
Commits](https://www.conventionalcommits.org/): `type(scope): summary`, using `feat`, `fix`,
`docs`, `ci`, `test`, `refactor`, `chore`, `perf`, or `build`. Mark a breaking change with `!`
after the type or a `BREAKING CHANGE:` footer.

Versioning is npm [semver](https://semver.org/). Do not bump `version` in `package.json` as part
of a feature or fix change — that field is touched only by a separate release commit, which is
what triggers the tag, the npm publish, and the GitHub Release.

## Attribution

Everything you produce here — commits, PR titles and bodies, code comments, tests, documentation
— carries only the human contributor's identity. Do not add a co-authorship trailer for a tool,
an attribution notice or badge for how the change was produced, or any mention of the assistant,
vendor, or product involved.

## GitHub account

The maintainer's machine has more than one account logged in to the `gh` CLI, and the active one
is often not the one this repository belongs to. Every `gh` call for this repository — opening,
reviewing or merging a PR, reading checks, querying the API — must act as **BardiaN**, the
repository owner. Pick the account per command rather than running `gh auth switch`, which
changes the active account for every other repository on the machine too:

```bash
GH_TOKEN="$(gh auth token --user BardiaN)" gh pr create ...
```

Check before the first write of a session: `GH_TOKEN="$(gh auth token --user BardiaN)" gh api
user --jq .login` must print `BardiaN`. If the token is missing, stop and ask; do not fall back to
whichever account happens to be active.
