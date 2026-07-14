import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Cloudflare / OpenNext build artifacts (huge generated bundles).
    ".open-next/**",
    ".wrangler/**",
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
