#!/usr/bin/env bash
# The main-push guard's association read (#1027), with a bounded retry (#1519).
#
# Asks GitHub which pull requests a commit is associated with, prints the JSON
# array on stdout, and exits non-zero when it could not get a usable answer.
#
# WHY THE RETRY. A single attempt let a momentary GitHub blip blind the guard. On
# 2026-08-17 this endpoint answered `403 Resource not accessible by integration`
# at 13:59 and again at 14:02, then answered 200 at 14:28 from a job carrying the
# guard's exact permissions. Nothing was misconfigured. That blip failed the run
# and posted a Slack page on what was then the only control over main (the ruleset
# that now prevents a direct push came later, #4197),
# and a false page there is worse than none, because it is the alert everybody
# learns to ignore (L36, L77).
#
# WHY IT STILL FAILS CLOSED. The retry is bounded and never converts a read that
# genuinely cannot be made into a pass: exhausting the attempts exits non-zero,
# and the classifier still refuses to vouch for the push. A bounded count also
# means this can never hang, which would be worse than failing (L110).
#
# WHY THE SUCCESS TEST IS THE SHAPE. A good answer is exit zero AND a body that
# parses as a JSON array, never a substring of what was asked for. An error body
# quotes its own target, so a check looking for the repo or the endpoint in the
# output would be satisfied by the failure and stop retrying on the first one
# (L156).
#
# An EMPTY array is a real answer, not a failure: it means GitHub knows of no
# associated PR, which is a finding the classifier judges (and which #1447's
# claim route exists to second-guess). Retrying it would spend attempts on a
# question already answered.
#
# Lives here rather than inline in the workflow so it can be driven by
# scripts/test-commit-pulls-retry.ts with a fake `gh` on PATH, with no remote and
# no push to main.
set -uo pipefail

repo="${1:?usage: read-commit-pulls.sh <owner/repo> <sha>}"
sha="${2:?usage: read-commit-pulls.sh <owner/repo> <sha>}"

attempts="${COMMIT_PULLS_ATTEMPTS:-3}"
# Overridden to 0 by the test suite; left unset in CI so real backoff applies.
base_sleep="${COMMIT_PULLS_RETRY_SLEEP:-4}"

for attempt in $(seq 1 "$attempts"); do
  if out="$(gh api "/repos/$repo/commits/$sha/pulls" 2>&1)" \
     && jq -e 'type == "array"' >/dev/null 2>&1 <<<"$out"; then
    printf '%s\n' "$out"
    exit 0
  fi
  # Only ever to stderr: the error body must never reach stdout, where the caller
  # would read it as the association itself.
  printf 'read-commit-pulls: attempt %s/%s failed: %s\n' \
    "$attempt" "$attempts" "$(head -n 1 <<<"$out")" >&2
  if [ "$attempt" -lt "$attempts" ] && [ "$base_sleep" != "0" ]; then
    sleep "$((attempt * base_sleep))"
  fi
done

exit 1
