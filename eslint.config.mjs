import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Every pattern here is `**/`-prefixed rather than root anchored, because
    // eslint finds its inputs by a recursive glob and this repo routinely holds
    // nested checkouts: the parallel agent playbook in AGENTS.md creates git
    // worktrees under `.claude/worktrees/agent-*`, and each one that runs the
    // gate leaves its own build output behind (L234).
    //
    // Root anchored patterns matched `<root>/.open-next/**` and missed
    // `.claude/worktrees/agent-*/.open-next/**`. On 2026-08-31 that made
    // `pnpm lint` report 734,754 problems from 14 abandoned worktrees and OOM at
    // node's default heap, so the pre-push gate's lint leg could not run at all.
    // CI never saw it, because a fresh checkout has no worktrees.
    //
    // `scripts/test-eslint-ignores.ts` asks eslint itself whether each path is
    // ignored, and carries a positive control so a config that ignored
    // everything cannot pass.
    //
    // Default ignores of eslint-config-next:
    "**/.next/**",
    "**/out/**",
    "**/build/**",
    "**/next-env.d.ts",
    // Cloudflare / OpenNext build artifacts (huge generated bundles).
    "**/.open-next/**",
    "**/.wrangler/**",
    // Nested agent checkouts in full: their sources are already linted on their
    // own branch, and linting them here reports another branch's code as this
    // one's.
    ".claude/worktrees/**",
  ]),
  {
    // A leading underscore marks an intentionally-unused binding (positional
    // mock params, deliberately-ignored destructured fields, caught errors we
    // don't inspect). Treat that prefix as the opt-out so those don't warn.
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // #808: every server log line goes through `src/lib/log.ts`, so the two things
    // that kept getting decided wrongly per call site are decided once: the LEVEL
    // (console.log is unreachable from the helper, and it is the one method
    // Cloudflare stores with no `level`, which is how #801's lines went unreadable)
    // and a searchable `tag=`.
    //
    // Error severity, not warn: `pnpm lint` exits 0 on warnings, so a warning here
    // would guard nothing. Covers everything that ships INSIDE the Worker: src/ plus
    // worker/ (the wrangler entry point). scripts/ is exempt: node harnesses
    // printing to a terminal, not the Worker.
    files: ["src/**/*.{ts,tsx}", "worker/**/*.ts"],
    ignores: ["src/lib/log.ts", "**/*.test.ts", "**/*.test.tsx"],
    rules: {
      // No allow-list: even console.error goes through the helper, so every line
      // gets a tag. src/lib/log.ts is the one file exempt (it IS the console call).
      "no-console": "error",
    },
  },
]);

export default eslintConfig;
