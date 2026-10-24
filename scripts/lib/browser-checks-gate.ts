/**
 * Whether a pull request runs the browser checks (#3079, #3100).
 *
 * The browser leg is part of the `ci` fan-in, so a red run blocks the merge (Dan,
 * 2026-10-03). It costs about six billed minutes, and most of that is wasted on a
 * change that touches nothing the run reads (a doc, a workflow, a node script). A
 * workflow level `paths:` filter cannot be used for a leg: a filtered workflow
 * never starts, and a leg that never reports is a fan-in that waits forever or a
 * skip read as a pass. So the leg always STARTS on a pull request, and its first
 * step decides from the pull request's own diff:
 *
 *   run  -> the change touches an input, or the diff cannot be read (fail toward
 *           running: an unreadable diff is never permission to skip, L42);
 *   skip -> nothing the run reads changed, so the leg reports success in seconds
 *           and says why in a notice and the step summary.
 *
 * The inputs are listed once, here, and `scripts/test-browser-checks-gate.ts`
 * checks them file by file against every tracked file the run reads (L88).
 *
 * Imports nothing outside node built ins and scripts/lib, so the step runs on bare
 * node before the install.
 */

/** Every path the browser run reads: the app the build compiles and serves, the
 *  root configuration and TypeScript `next build` typechecks, the schema the local
 *  stack is built from, the suite itself, the settled designs and the copied design
 *  match score its design test draws and scores (#3954), and the workflow that runs it. */
export const BROWSER_INPUT_PATTERNS: readonly string[] = [
  "src/**",
  "public/**",
  "e2e/**",
  "supabase/migrations/**",
  "docs/design/**",
  "scripts/design-score/**",
  "*.ts",
  "*.mts",
  "*.mjs",
  "*.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".github/workflows/ci.yml",
  "scripts/browser-checks-gate.ts",
  "scripts/lib/browser-checks-gate.ts",
  "scripts/lib/migration-drift-gate.ts",
  // e2e/env.ts reads the live settings rule from here (#3694).
  "scripts/lib/live-env-files.ts",
];

/** GitHub's filter glob, for the two wildcards the list uses. */
export function globMatches(pattern: string, file: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") {
      re += "[^/]*";
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`).test(file);
}

export function isBrowserInput(file: string, patterns: readonly string[] = BROWSER_INPUT_PATTERNS): boolean {
  return patterns.some((p) => globMatches(p, file));
}

export type BrowserGateDecision = { action: "run" | "skip"; reason: string; touched: string[] };

export function decideBrowserGate(input: {
  eventName: string;
  /** The pull request's changed files, or null when they could not be read. */
  changedFiles: string[] | null;
}): BrowserGateDecision {
  if (input.eventName !== "pull_request") {
    return { action: "run", reason: `This is a ${input.eventName || "unknown"} run, not a pull request, so nothing is skipped.`, touched: [] };
  }
  if (input.changedFiles === null) {
    return {
      action: "run",
      reason: "The pull request's changed files could not be read, so the browser checks run rather than being skipped on a guess.",
      touched: [],
    };
  }
  if (input.changedFiles.length === 0) {
    return {
      action: "run",
      reason: "The pull request's diff read as empty, which is not believable for a pull request, so the browser checks run.",
      touched: [],
    };
  }
  const touched = input.changedFiles.filter((f) => isBrowserInput(f));
  if (touched.length > 0) {
    return {
      action: "run",
      reason: `${touched.length} of the ${input.changedFiles.length} changed files are read by the browser run, so it runs.`,
      touched,
    };
  }
  return {
    action: "skip",
    reason:
      `None of the ${input.changedFiles.length} changed files is read by the browser run (the app, its configuration, ` +
      `the schema or the suite), so the leg passes without building. A change to any of them runs it in full.`,
    touched: [],
  };
}
