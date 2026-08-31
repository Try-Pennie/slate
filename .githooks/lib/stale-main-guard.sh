#!/usr/bin/env bash
# Refuse a push from a branch that was built on a stale main (#1612).
#
# A branch created from a stale `origin/main` ref silently carries commits that
# are already on main. Its diff against its own merge base then shows another
# change's work as this branch's, its PR conflicts, and the branch tip can even
# carry a different change's commit message. That happened twice on 2026-08-29
# and cost two thrown-away PRs (#1603 rebuilt as #1606, #1605 as #1607).
#
# The symptom appears only at PR time, as a merge conflict, which reads as an
# ordinary rebase rather than as a branch that was wrong from the start. So the
# refusal happens here instead, while the fix is still cheap.
#
# Usage: stale-main-guard.sh "<branch name>"
#
# The branch name is passed IN rather than computed here, and every git call
# goes through PATH, so the whole decision (when to run, when to skip, what each
# outcome says) is driven by scripts/test-stale-main-guard.ts with a stub git and
# no remote at all. The hook computes the branch name.
#
# MATCHING IS BY PATCH ID, not by sha. A squash merge, a rebase or a cherry pick
# gives a commit a new sha and leaves its patch id alone, so a sha comparison
# would miss exactly the case this exists for. `git cherry` marks such a commit
# with a leading "-".
#
# What it cannot see, stated so the coverage is never read as wider than it is: a
# multi-commit PR squashed into main lands as ONE combined patch, whose patch id
# matches none of the individual commits. This catches the single-commit PR,
# which is how nearly every change here merges, and misses the multi-commit one.
#
# Exit 0 = pushed on. Exit 1 = blocked, with the offending commits named.
set -u

branch="${1:-}"

# Deliberate, visible, single-use override, matching ALLOW_MERGED_PUSH beside it.
# Checked FIRST so an intentional push costs no fetch at all.
if [ "${ALLOW_STALE_MAIN:-}" = "1" ]; then
  exit 0
fi

# A detached HEAD has no branch name to reason about, and main cannot be built on
# a stale copy of itself.
if [ -z "$branch" ] || [ "$branch" = "main" ]; then
  exit 0
fi

# One ref, no tags, no working tree change: this is the whole network cost of the
# guard, a few hundred milliseconds against a gate that already takes about 40s.
#
# The low-speed bounds keep a flaky connection from turning the gate into a hang,
# which would be worse than either outcome the guard has (L110). They apply to
# the HTTP transport only; an SSH remote is bounded by SSH's own timeouts.
if ! GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=20 \
  git fetch --quiet --no-tags origin main >/dev/null 2>&1; then
  # Fails OPEN without a network, for the same reason the merge-gap guard fails
  # open without gh: blocking every offline push would be worse than the gap.
  # Said out loud rather than skipped in silence, so a machine that can never
  # reach origin is visible rather than looking like a clean run (L98).
  echo "note: could not reach origin, so nothing checked whether '$branch' was built on a stale main." >&2
  echo "      Check by hand once you are online: git fetch origin && git cherry -v origin/main HEAD" >&2
  exit 0
fi

# FETCH_HEAD is exactly what the fetch above wrote, so the comparison cannot be
# answered by a remote-tracking ref that some other process left behind.
if ! duplicates_raw="$(git cherry -v FETCH_HEAD HEAD 2>/dev/null)"; then
  # A different cause from the one above, so a different message and a different
  # remedy: this reader has a working network and a repository the comparison
  # could not be run in (an unrelated history, a broken FETCH_HEAD).
  echo "note: origin/main was fetched but this branch could not be compared against it, so nothing checked whether '$branch' was built on a stale main." >&2
  echo "      Check by hand: git cherry -v origin/main HEAD" >&2
  exit 0
fi

# `git cherry -v` marks a commit whose patch is already upstream with "-", and a
# genuinely new one with "+". The match is anchored, so a hyphen inside a commit
# subject is not read as a marker.
duplicates="$(printf '%s\n' "$duplicates_raw" | grep '^- ' || true)"

if [ -z "$duplicates" ]; then
  exit 0
fi

echo "" >&2
echo "pre-push blocked: '$branch' looks like it was built on a stale main." >&2
echo "   These commits carry changes that are ALREADY on main, matched by patch id" >&2
echo "   (a squash, rebase or cherry pick gives them a new sha, so the log does not show it):" >&2
while IFS= read -r line; do
  [ -z "$line" ] && continue
  # `git cherry -v` prints the full 40 character sha, which pushes the subject
  # (the part that tells the reader which change this actually is) off the line.
  entry="${line#- }"
  sha="${entry%% *}"
  echo "     ${sha:0:12} ${entry#"$sha" }" >&2
done <<EOF
$duplicates
EOF
echo "   This branch's diff against its own merge base therefore shows another change's" >&2
echo "   work as this branch's, and the PR will conflict." >&2
echo "   Rebuild off current main instead, e.g.:" >&2
echo "     git fetch origin && git checkout -b <new-branch> origin/main && git cherry-pick <your own commits>" >&2
echo "   Or, if intentional: ALLOW_STALE_MAIN=1 git push ..." >&2
echo "" >&2
exit 1
