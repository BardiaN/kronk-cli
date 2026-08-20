# Publishing checklist

Everything here is already written and the placeholders are filled in:
`BardiaN` / `Bardia Navvabian` / `Apache-2.0`. What is left is the parts that need your accounts.

## Already done

| | |
|---|---|
| `BardiaN/kronk-cli` | pushed, CI green on Node 20/22/24 × Linux/macOS |
| `BardiaN/homebrew-tap` | formula in `Formula/`, `brew style` clean, tap CI green |
| Branch ruleset on `kronk-cli` | PR + 1 approval + Code Owner review + `ci-ok`; owner bypass on |
| Branch ruleset on `homebrew-tap` | blocks deletion and force-push only — a PR rule would deadlock the release job |
| `TAP_REPO` variable | `BardiaN/homebrew-tap` |
| `TAP_DEPLOY_KEY` secret | ed25519 deploy key, write access to the tap **only** |

## The one thing left: NPM_TOKEN

Creating an npm token needs a browser session, so it cannot be scripted.

1. `npm login`
2. npmjs.com → *Access Tokens* → **Generate New Token → Granular Access Token**
   - Packages: *Read and write*, scoped to `kronk-cli` once it exists (or all packages for the first publish)
   - Expiry: whatever you are comfortable rotating
3. ```bash
   cd /Users/bardia/Projects/kronk-vs-extension/kronk-cli
   gh secret set NPM_TOKEN
   ```
   Paste when prompted — it never touches your shell history or disk.

If you would rather not publish to npm at all, delete the `npm` job from
`.github/workflows/release.yml` and Homebrew plus the install script still cover everything.

## Cutting the first release

```bash
npm version 0.1.0 --allow-same-version -m "release %s"
git push --follow-tags
```

The tag runs `release.yml`: it refuses to publish if the tag and `package.json` disagree, then
publishes to npm with provenance, creates the GitHub Release, and pushes the formula bump to the
tap over the deploy key.

## Why a deploy key rather than a PAT

A fine-grained PAT is still an account credential: it lives in your user settings, and its blast
radius is whatever you scoped it to at creation. The deploy key is attached to `homebrew-tap`
itself, grants nothing anywhere else, and is revoked from that repository's own settings page —
*Settings → Deploy keys*. The private half exists only as the `TAP_DEPLOY_KEY` secret; it was
written to a temp file, uploaded, and shredded.

---

## Notes on the setup

