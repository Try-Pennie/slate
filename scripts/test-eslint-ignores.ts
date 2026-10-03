// Repo invariant: eslint must ignore build artifacts WHEREVER they sit, not only
// at the repo root.
//
// The parallel agent playbook in AGENTS.md creates git worktrees under
// `.claude/worktrees/agent-*`, and each one that runs the gate leaves a built
// OpenNext bundle behind. eslint finds its inputs by a recursive glob, so it
// walks those too (L234).
//
// Measured 2026-08-31: 14 abandoned worktrees held 18 GB of build output, and
// `pnpm lint` reported 734,754 problems, every sample of them inside
// `.claude/worktrees/agent-*/.open-next/`. It OOMed at node's default heap and
// took over ten minutes at 8 GB before failing on other people's artifacts. The
// pre-push gate's lint leg was therefore unusable locally, which matters more
// than the noise: a gate that cannot run cannot refuse anything.
//
// CI could not see it, because a fresh CI checkout has no `.claude/worktrees`.
// So the merge gate stayed green the whole time and the breakage was local only,
// which is exactly the shape that survives a long time.
//
// This guard asks eslint ITSELF whether a path is ignored, rather than matching
// strings in the config file: the question that matters is what eslint does, not
// what the config says (L63).
//
// Run: node --experimental-strip-types scripts/test-eslint-ignores.ts
import { ESLint } from "eslint";
import { assert, finish } from "./lib/harness.ts";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Paths that MUST be ignored. The nested ones are the point of this guard: a
 * root-anchored pattern (`.open-next/**`) matches the first of each pair and
 * misses the second, which is the state that broke the gate.
 */
const MUST_IGNORE = [
  ".open-next/worker.js",
  ".next/static/chunk.js",
  ".wrangler/tmp/bundle.js",
  ".claude/worktrees/agent-abc123/.open-next/worker.js",
  ".claude/worktrees/agent-abc123/.next/static/chunk.js",
  ".claude/worktrees/agent-abc123/.wrangler/tmp/bundle.js",
  ".claude/worktrees/agent-abc123/src/lib/booking/service.ts",
];

/**
 * The positive control, and it is not decoration. A config that ignored
 * EVERYTHING would satisfy every assertion above, so the guard would pass hardest
 * at the moment linting had stopped happening at all (L98, L178). These paths
 * prove eslint is still looking at the tree this repo exists to lint.
 */
const MUST_LINT = [
  "src/lib/booking/service.ts",
  "src/components/BookerStrip.tsx",
  "scripts/test-eslint-ignores.ts",
  "eslint.config.mjs",
];

const eslint = new ESLint({ cwd: ROOT });

for (const rel of MUST_IGNORE) {
  const ignored = await eslint.isPathIgnored(rel);
  assert(ignored, `eslint ignores ${rel}`);
}

for (const rel of MUST_LINT) {
  const ignored = await eslint.isPathIgnored(rel);
  assert(!ignored, `eslint still lints ${rel}`);
}

finish();
