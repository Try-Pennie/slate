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
    // #801: in the deployed Worker, `console.log` is the ONE console method
    // Cloudflare captures WITHOUT a `level` field. The line is stored, but it is
    // invisible to every level-filtered or level-grouped query, which reads as
    // "the logs are gone" (that false negative is how #708 concluded console.log
    // was dropped). debug/info/warn/error all carry a level, so `console.info` is
    // the drop-in for a routine operational line. Errors severity, not warn: lint
    // exits 0 on warnings, so a warning here would guard nothing.
    // Covers everything that ships INSIDE the Worker: src/ plus worker/, which is
    // the deployed entry point (wrangler `main`) and drives the cron lanes.
    // scripts/ is exempt: node harnesses printing to a terminal, not the Worker.
    files: ["src/**/*.{ts,tsx}", "worker/**/*.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "console",
          property: "log",
          message:
            "console.log lands in Cloudflare with no `level`, so it never shows up in a level-filtered log query (#801). Use console.info for routine lines, console.warn/error for problems.",
        },
      ],
    },
  },
]);

export default eslintConfig;
