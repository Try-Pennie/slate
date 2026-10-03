#!/usr/bin/env bash
# Seed a parallel-dispatch Agent worktree's node_modules from the main checkout,
# fast, instead of a slow sandboxed network install (#852).
#
# A fresh git worktree (isolation: "worktree", created under .claude/worktrees/)
# inherits no node_modules, so before the pre-push gate (tsc/lint/test/cf:build)
# or any pnpm command can run, the agent otherwise pays a full `pnpm install`
# through the sandbox network override, which is the single most common reason a
# parallel-dispatch wave stalls (minutes per agent, 7-8 agents per wave).
#
# The repo lives on APFS, so `cp -c` (clonefile) copies node_modules copy-on-write:
# a real directory (not a symlink, which Turbopack's `next build` rejects, see
# .githooks/pre-push), functional immediately, in a few seconds with no extra disk.
#
# Usage:
#   bash scripts/seed-worktree-node-modules.sh [TARGET_DIR] [SOURCE_DIR]
#     TARGET_DIR  worktree to seed              (default: $PWD)
#     SOURCE_DIR  checkout to clone from        (default: the main git worktree)
#
# Exit codes:
#   0  node_modules is ready (freshly seeded, or already present)
#   2  usage / resolution error
#   3  source has no node_modules to clone      -> run `pnpm install`
#   4  target lockfile differs from source's     -> run `pnpm install` to reconcile
set -euo pipefail

target="${1:-$PWD}"
source="${2:-}"

# Resolve the source checkout: the main git worktree (listed first by git) unless
# one was given explicitly. Only touch git when we have to, so the helper is usable
# (and testable) outside a repo when both dirs are passed.
if [ -z "$source" ]; then
  # The path is the WHOLE rest of the line, not its first word: Slate lives under
  # `Documents - Dan’s MacBook Pro`, and `print $2` kept only `.../Documents` (#3050).
  source="$(git -C "$target" worktree list --porcelain 2>/dev/null | awk '/^worktree /{sub(/^worktree /, ""); print; exit}')"
  if [ -z "$source" ]; then
    echo "seed-worktree: could not resolve the source checkout (not a git worktree?); pass SOURCE_DIR." >&2
    exit 2
  fi
fi

[ -d "$target" ] || { echo "seed-worktree: target dir '$target' does not exist." >&2; exit 2; }

# Normalise to absolute paths so the target==source self-check is reliable.
target="$(cd "$target" && pwd -P)"
source="$(cd "$source" && pwd -P)"

# Already populated? Leave it alone (idempotent: safe to re-run in a resumed wave).
if [ -d "$target/node_modules" ] && [ -n "$(ls -A "$target/node_modules" 2>/dev/null)" ]; then
  echo "seed-worktree: $target/node_modules already present; skipping."
  exit 0
fi

# Seeding from yourself is a no-op: the main checkout should already have modules
# (handled by the skip above); if it somehow doesn't, an install is the only cure.
if [ "$target" = "$source" ]; then
  echo "seed-worktree: target is the source checkout and has no node_modules; run 'pnpm install'." >&2
  exit 3
fi

# Nothing to clone from -> refuse loudly rather than leave an empty target that
# looks seeded (fail loud, not silent).
if [ ! -d "$source/node_modules" ] || [ -z "$(ls -A "$source/node_modules" 2>/dev/null)" ]; then
  echo "seed-worktree: source '$source' has no node_modules to clone; run 'pnpm install' in $target." >&2
  exit 3
fi

# Lockfiles must match, or the cloned deps are stale for this target. Refuse and
# send the caller to `pnpm install` (which reconciles the delta) rather than seed
# wrong dependencies that would pass locally and diverge from CI.
src_lock="$source/pnpm-lock.yaml"
tgt_lock="$target/pnpm-lock.yaml"
if [ -f "$src_lock" ] && [ -f "$tgt_lock" ] && ! cmp -s "$src_lock" "$tgt_lock"; then
  echo "seed-worktree: pnpm-lock.yaml differs between target and source; run 'pnpm install' in $target to reconcile." >&2
  exit 4
fi

# Clone into a temp sibling then atomically rename in, so a crashed copy never
# leaves a half-populated node_modules that the idempotency skip would trust.
staging="$target/.node_modules.seeding.$$"
rm -rf "$staging"
cleanup() { rm -rf "$staging" 2>/dev/null || true; }
trap cleanup EXIT

start=$(date +%s)
# -c = clonefile (copy-on-write on APFS); best-effort, falls back to a normal copy
# off-APFS or across volumes. If -c is unsupported, retry without it.
if ! cp -cR "$source/node_modules" "$staging" 2>/dev/null; then
  cp -R "$source/node_modules" "$staging"
fi
mv "$staging" "$target/node_modules"
trap - EXIT
echo "seed-worktree: cloned node_modules from $source in $(( $(date +%s) - start ))s."
exit 0
