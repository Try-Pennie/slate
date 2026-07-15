#!/usr/bin/env bash
# isolate-pushed-tree.sh <commit-ish> <dest-dir>
#
# Materialize <commit-ish> at <dest-dir> as a detached `git worktree` containing
# ONLY committed files (no working-tree / untracked / staged-but-uncommitted
# files). The pre-push hook runs the CI-parity checks in this tree so the checks
# see exactly what CI checks out, not whatever happens to be on disk.
#
# Why: an untracked file a committed file imports (or a staged-but-uncommitted /
# bad-amend file) otherwise makes tsc/lint/test pass locally yet fail CI, which
# only ever sees the committed tree (#490; the case that broke #489).
#
# Dependencies are (re)installed by the caller inside this tree, mirroring CI's
# clean `pnpm install`. A symlinked node_modules is deliberately NOT used: it
# escapes the worktree root and Turbopack (next build) rejects it.
#
# --detach: no branch ref, so this never collides with the branch being pushed.
# dest must not already exist (git worktree add requires that).
set -euo pipefail

commitish="${1:?usage: isolate-pushed-tree.sh <commit-ish> <dest-dir>}"
dest="${2:?usage: isolate-pushed-tree.sh <commit-ish> <dest-dir>}"

git worktree add --detach --quiet "$dest" "$commitish"
