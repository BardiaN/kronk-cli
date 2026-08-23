#!/usr/bin/env bash
# Waits for release.yml's run on this commit to conclude before Scorecard
# scores it, so the Signed-Releases / Packaging checks see the release's
# assets instead of racing it (see scorecard.yml's `gate` job).
#
# This has to be its own script rather than a `run:` step inside the job that
# calls ossf/scorecard-action: that job's steps are restricted to a fixed
# allow-list of `uses:` actions once `publish_results: true` is set — a `run:`
# step there is rejected outright by the publish API's workflow verification
# (github.com/ossf/scorecard-webapp app/server/verify_workflow.go,
# errEmptyStepUses), which would break the badge for every trigger, not just
# push. Keeping the wait in a separate job avoids that.
#
# Release-detection mirrors release.yml's gate job (release.yml:19-44): a push
# is a release only when package.json's version has no tag yet. Scorecard
# cannot read that job's output — it runs as a different workflow, over a
# separate `push` event — so this is a deliberate copy. Keep it in sync with
# release.yml's gate step if that logic changes.
#
# Standalone-testable: put a fake `gh` on PATH, cd to a directory with a
# package.json, and run this file with bash. See test/wait-for-release.test.js.
#
# Reads from the environment (all provided by Actions): GITHUB_EVENT_NAME,
# GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_OUTPUT.
# Test-only overrides: RELEASE_WAIT_TIMEOUT_SECONDS, RELEASE_WAIT_INTERVAL_SECONDS.
set -uo pipefail

timeout_seconds="${RELEASE_WAIT_TIMEOUT_SECONDS:-600}"
interval_seconds="${RELEASE_WAIT_INTERVAL_SECONDS:-15}"

# Default to scoring. Only a confirmed release failure calls `finish false` —
# a timeout or any other uncertainty falls back to today's behaviour, so a bug
# in this script can never be the reason a legitimate scan is dropped.
#
# Written exactly once, on every exit path. Actions resolves a duplicated
# output key to the last one written, so emitting a default up front and
# overriding it later would also work — but this is the decision that stops a
# failed release being scored, and it should not rest on that subtlety.
finish() {
  echo "proceed=$1" >> "$GITHUB_OUTPUT"
  exit 0
}

if [ "${GITHUB_EVENT_NAME:-}" != "push" ]; then
  echo "not a push event (${GITHUB_EVENT_NAME:-unset}) — nothing to wait for"
  finish true
fi

version=$(node -p "require('./package.json').version" 2>/dev/null) || {
  echo "could not read package.json version — scoring current state"
  finish true
}

if gh api "repos/${GITHUB_REPOSITORY}/git/ref/tags/v${version}" >/dev/null 2>&1; then
  echo "v${version} is already tagged — ordinary push, not waiting on a release"
  finish true
fi
echo "v${version} has no tag yet — this push should produce a release; waiting for it"

elapsed=0
conclusion=""
while [ "$elapsed" -lt "$timeout_seconds" ]; do
  line=$(gh run list --workflow release.yml --commit "$GITHUB_SHA" --json status,conclusion 2>/dev/null \
    | jq -r '.[0] | "\(.status) \(.conclusion)"' 2>/dev/null)
  if [ -n "$line" ] && [ "$line" != "null null" ]; then
    status="${line%% *}"
    if [ "$status" = "completed" ]; then
      conclusion="${line#* }"
      break
    fi
  fi
  sleep "$interval_seconds"
  elapsed=$((elapsed + interval_seconds))
done

if [ -z "$conclusion" ]; then
  echo "::warning::timed out after ${timeout_seconds}s waiting for the release workflow — scoring current state anyway"
  finish true
fi

echo "release workflow finished with conclusion: $conclusion"
if [ "$conclusion" != "success" ]; then
  echo "release did not succeed — skipping this scan so it does not score partial artifacts"
  finish false
fi
finish true
