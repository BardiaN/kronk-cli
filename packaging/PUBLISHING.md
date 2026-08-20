# Publishing checklist

Everything here is already written and the placeholders are filled in:
`BardiaN` / `Bardia Navvabian` / `Apache-2.0`. What is left is the parts that need your accounts.

## 1. The repository

| | |
|---|---|
| **You do** | Create `BardiaN/kronk-cli`, public, no README/license (they exist here) |
| **I need** | The GitHub username and the repo name if it differs |

```bash
git init && git add -A && git commit -m "kronk-cli 0.1.0"
git remote add origin git@github.com:BardiaN/kronk-cli.git
git push -u origin main
```

## 2. Reviews and branch protection

Settings the repo owner has to click — a file cannot set these.

*Settings → Rules → Rulesets → New branch ruleset*, target `master`:

- Require a pull request before merging
- Require approvals: **1**
- **Require review from Code Owners** — `.github/CODEOWNERS` points at you, so every PR waits for you
- Require status checks to pass: `check`, `smoke`
- Block force pushes

Then *Settings → Actions → General → Workflow permissions*: **Read repository contents**, and
tick *Allow GitHub Actions to create and approve pull requests* only if you want the tap bump to
open PRs rather than push directly.

## 3. npm publishing

| | |
|---|---|
| **You do** | `npm login`, then create an **Automation** token at npmjs.com → Access Tokens |
| **You do** | Add it as repo secret `NPM_TOKEN` |
| **I need** | Nothing, once the secret exists |

`kronk-cli` is unclaimed on npm as of 2026-08-20. The release workflow publishes with
`--provenance`, which requires the package to be public and the workflow to have `id-token: write`
— both already set.

## 4. Homebrew

Homebrew **core** will not take this: they require a formula to be notable and stable, and they
reject thin wrappers around npm packages. A **personal tap** is the normal route and installs just
as cleanly.

| | |
|---|---|
| **You do** | Create a second public repo named exactly `BardiaN/homebrew-tap` |
| **You do** | Copy `packaging/kronk-cli.rb` to `Formula/kronk-cli.rb` in it |
| **You do** | Create a fine-grained PAT with **Contents: read and write** scoped to *only* that tap repo |
| **You do** | Add it to `kronk-cli` as secret `TAP_TOKEN`, and add repo variable `TAP_REPO` = `BardiaN/homebrew-tap` |
| **I need** | Confirmation of the tap repo name |

Users then install with:

```bash
brew tap BardiaN/tap
brew install kronk-cli
```

The release workflow rewrites `url`, `sha256` and `version` in the formula on every tag, so you
never edit it by hand after the first commit.

## 5. Manual install

Already works with no accounts at all, once the repo is public and has one release:

```bash
curl -fsSL https://raw.githubusercontent.com/BardiaN/kronk-cli/main/packaging/install.sh | bash
```

Installs to `~/.local/lib/kronk-cli` with a launcher in `~/.local/bin`. Override with
`KRONK_CLI_PREFIX`, or pin with `KRONK_CLI_VERSION=v0.2.0`.

## 6. Cutting a release

```bash
npm version minor        # bumps package.json, commits, tags
git push --follow-tags
```

The tag triggers `release.yml`, which refuses to publish if the tag and `package.json` disagree,
then runs npm publish, the GitHub Release, and the tap bump.

---

## Summary

Decided:

| | |
|---|---|
| GitHub | `BardiaN/kronk-cli` |
| npm | `kronk-cli` (unclaimed as of 2026-08-20) |
| Tap | `BardiaN/homebrew-tap` → `brew tap BardiaN/tap` |
| Licence | Apache-2.0, © 2026 Bardia Navvabian |

Left for you: create the two repos, set the branch ruleset, and add three secrets/variables —
`NPM_TOKEN`, `TAP_TOKEN`, `TAP_REPO`.

**Do not paste any token into the chat.** Add them in *Settings → Secrets and variables → Actions*.
I never need to see them; the workflows read them from the environment.
