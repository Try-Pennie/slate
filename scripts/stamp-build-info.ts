// Write the deploying commit into src/lib/build-info.ts (#1037).
//
// Run immediately BEFORE `pnpm cf:deploy` in the deploy job, so the value is
// compiled into the Worker bundle and the post-deploy probe can confirm the live
// site is serving this commit rather than the previous one.
//
// Run: node --experimental-strip-types scripts/stamp-build-info.ts <sha>
//      (or with GITHUB_SHA set, which is what CI does)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TARGET = join(import.meta.dirname, "..", "src", "lib", "build-info.ts");

/** Replace the BUILD_COMMIT literal, leaving the file's doc comment intact. */
export function stamp(source: string, commit: string): string {
  const next = source.replace(
    /export const BUILD_COMMIT = "[^"]*";/,
    `export const BUILD_COMMIT = "${commit}";`,
  );
  if (next === source) {
    throw new Error(
      "could not find the BUILD_COMMIT declaration to stamp in src/lib/build-info.ts",
    );
  }
  return next;
}

/** A short, filesystem- and log-safe commit id. Rejects anything that is not a
 *  hex sha, so a stray value (a branch name, an injected string) cannot be written
 *  into a source file that is about to be compiled. */
export function normalizeCommit(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!/^[0-9a-f]{7,40}$/.test(trimmed)) {
    throw new Error(
      `refusing to stamp "${trimmed}" as a commit: expected a 7 to 40 character hex sha`,
    );
  }
  return trimmed.slice(0, 12);
}

// Only act when executed directly, so the pure helpers above stay importable by
// the test without it writing to the repo.
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const commit = normalizeCommit(process.argv[2] ?? process.env.GITHUB_SHA);
  const src = readFileSync(TARGET, "utf8");
  writeFileSync(TARGET, stamp(src, commit));
  console.log(`stamped build-info with commit ${commit}`);
}
