#!/usr/bin/env bash
# Print the files this branch changes, one per line, for the pre-push guards that
# decide what to run from them (#3898, lesson L784).
#
# The list is the diff from the branch's MERGE BASE with origin/main to HEAD, which is
# what its pull request shows. It is never a two dot diff from the tip of anything
# upstream: the hook used to read `git diff @{push}..HEAD`, and once a pushed branch is
# rebased onto, or merges in, a main that has moved, that diff names every file main
# changed in between, so the security review reminder blamed main's files on the
# branch. scripts/test-prepush-changed-paths.ts builds that history with real git.
#
# Prints the literal UNKNOWN when the merge base or the diff cannot be read (no
# origin/main, a shallow clone): the guards then run rather than skip, because an
# unreadable diff and a push that touched nothing would otherwise both be the empty
# string and the skip would be silent (#1436). Always exits 0.
set -u

if ! base="$(git merge-base origin/main HEAD 2>/dev/null)" || [ -z "$base" ]; then
  echo "UNKNOWN"
  exit 0
fi

if ! paths="$(git diff --name-only "$base" HEAD 2>/dev/null)"; then
  echo "UNKNOWN"
  exit 0
fi

printf '%s\n' "$paths"
exit 0
