#!/usr/bin/env bash
# Refuse a push whose workflows reference a repo setting that does not exist (#1500).
#
# GitHub does NOT fail on `${{ vars.X }}` for a variable nobody created: it
# interpolates the EMPTY STRING, so the step runs misconfigured while the file
# reads as configured. That took the production canary down on 2026-08-14,
# eleven minutes after the merge that introduced it.
#
# Usage: workflow-settings-guard.sh "<newline separated changed paths>"
#
# The changed-path list is passed IN rather than computed here, so the decision
# (when to run, when to skip, what to do with each outcome) is testable without a
# git remote. The hook computes it.
#
# Exit 0 = pushed on. Exit 1 = blocked, with the checker's own output on stderr.
set -u

changed="${1:-}"

# Deliberate, visible override, matching the other gates.
if [ "${SKIP_WORKFLOW_SETTINGS_CHECK:-}" = "1" ]; then
  exit 0
fi

# Nothing to check: this push does not touch a workflow, so an unrelated push
# pays nothing for a guard that could not find anything anyway.
#
# "UNKNOWN" means the caller COULD NOT READ the diff, which is not the same thing
# and must never take the skip: an unreadable diff and a push that touched no
# workflow would otherwise be indistinguishable, and the skip would be silent
# (L98). Running the check on an unknown diff costs one round trip.
if [ "$changed" != "UNKNOWN" ] && ! printf '%s\n' "$changed" | grep -q '^\.github/workflows/'; then
  exit 0
fi

# Fails OPEN without gh, for the same reason the merge-gap guard does: blocking
# every push made without gh auth would be worse than the gap, and the reference
# stays findable with `pnpm check:workflow-settings`. Said out loud rather than
# skipped in silence, so a permanently unauthenticated machine is visible rather
# than looking like a clean run (L98).
if ! command -v gh >/dev/null 2>&1; then
  echo "note: skipping the workflow settings check (gh not found), so nothing verified the vars and secrets this push references." >&2
  exit 0
fi

output="$(pnpm --silent check:workflow-settings 2>&1)"
status=$?
if [ "$status" -ne 0 ]; then
  echo "" >&2
  echo "$output" >&2
  echo "" >&2
  echo "   A referenced setting that does not exist is NOT an error to GitHub:" >&2
  echo "   it substitutes an empty string and the step runs misconfigured." >&2
  echo "   Create it, drop the reference, or SKIP_WORKFLOW_SETTINGS_CHECK=1 git push ..." >&2
  echo "" >&2
  exit 1
fi

# A PASS that judged less than every reference says so (#2293). The checker lets a
# setting a workflow declares is provisioned per run be absent, and on a pass this
# hook captures its output and throws it away, so the narrowing would be invisible
# in the one place it matters: the push it let through. A clean pass stays quiet, so
# the note means something when it appears (L98).
if printf '%s\n' "$output" | grep -q '^note:'; then
  echo "" >&2
  printf '%s\n' "$output" >&2
  echo "" >&2
fi
exit 0
