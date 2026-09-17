// The one enumeration every repo guard scans from (#2421).
//
// A guard's shape is "list the files, run a scanner over each, report the
// offenders". The second half is unit tested everywhere in this tree; the first
// half was six copies of a `git ls-files` call that nothing checked. Both ways
// that can go wrong are silent, and both look exactly like a clean tree:
//
//   NOTHING CAME BACK.  `git ls-files src` answers with an empty string rather
//     than an error when it is pointed at a tree with no `src` in it, which is
//     what an inherited GIT_DIR does under the pre-push hook (#848/#853). Every
//     guard downstream then reported its clean sentence over zero files (L98).
//
//   NOT EVERYTHING CAME BACK.  `ls-files` lists what git TRACKS. The file a
//     design guard exists to judge is usually the one somebody is writing, and it
//     is untracked until it is staged (L456), so the tree read clean locally and
//     the violation was first named by CI or by the isolated pre-push checkout.
//
// So this asks for tracked AND untracked-but-not-ignored paths in one call, and
// it THROWS by name rather than returning a short list. A guard that cannot find
// its subjects has measured nothing and must say so.
//
// Two floors, with two different messages, because "git listed nothing" and
// "your match reached nothing" send somebody to two different places (L11).
import { execFileSync } from "node:child_process";
import { scrubbedGitEnv } from "./git-env.ts";

/**
 * The smallest raw listing that can be believed.
 *
 * Measured rather than guessed: `src` carries 876 tracked paths as of
 * 2026-09-17, and the smallest directory any guard here enumerates is that same
 * one. A run reporting fewer than this is a subprocess pointed somewhere else,
 * not a repo that shrank, and a short listing is as misleading as an empty one.
 */
export const LISTING_FLOOR = 300;

/**
 * The smallest MATCHED subset that can be believed.
 *
 * The narrowest match in use is `.tsx` only, which reaches 226 files. A guard
 * whose match reaches fewer than this has a broken pattern, and a broken pattern
 * reports the same empty offender list a clean tree does.
 */
export const MATCH_FLOOR = 50;

/** Thrown when the enumeration cannot be believed. Never caught in a guard. */
export class EnumerationRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnumerationRefused";
  }
}

export type SelectOptions = {
  /** Which paths this guard reads. */
  match: RegExp;
  /** What it deliberately does not judge (a test fixture, its own file). */
  exclude?: (file: string) => boolean;
};

/**
 * Never scanned, whatever a guard asks for.
 *
 * An agent worktree is a whole second checkout living inside this one, it is not
 * in `.gitignore`, and it carries its own `node_modules` (the root ignore rule is
 * anchored, so a nested one is not covered). Asking git for untracked files
 * across the repo would therefore enumerate every abandoned agent checkout: the
 * measured cost of the same mistake in eslint was 14 worktrees, 18 GB and a lint
 * leg that OOMed before finishing (AGENTS.md). They are other trees, not this
 * one's source, so no guard here has anything to say about them.
 */
const FOREIGN_TREE_RE = /(?:^|\/)\.claude\/worktrees\//;

/** Pure: git's listing text to the set of files a guard will read. */
export function selectFiles(listing: string, opts: SelectOptions): string[] {
  const seen = new Set<string>();
  for (const line of listing.split("\n")) {
    const file = line.trim();
    if (!file) continue;
    if (FOREIGN_TREE_RE.test(file)) continue;
    if (!opts.match.test(file)) continue;
    if (opts.exclude?.(file)) continue;
    seen.add(file);
  }
  return [...seen];
}

export type EnumerateOptions = SelectOptions & {
  /** Defaults to `src`. A guard reading further says so. */
  paths?: string[];
  listingFloor?: number;
  matchFloor?: number;
  /** Injectable so the floors and the refusals can be driven without a repo. */
  run?: (args: string[]) => string;
};

function gitListing(args: string[]): string {
  // Scrubbed because the pre-push hook exports GIT_DIR and friends, and an
  // inherited GIT_DIR makes this read the real repo rather than its own cwd
  // (#848/#853); scripts/test-git-env-isolation.ts enforces it.
  return execFileSync("git", args, { encoding: "utf8", env: scrubbedGitEnv() });
}

/**
 * Every file a guard should scan, or a refusal.
 *
 * Blind to what git cannot see: a file inside an ignored directory is not
 * listed, which is deliberate (a build output is not source), and a path
 * containing a newline would be split (git quotes those, and none exists here).
 */
export function sourceFiles(opts: EnumerateOptions): string[] {
  const paths = opts.paths ?? ["src"];
  const listingFloor = opts.listingFloor ?? LISTING_FLOOR;
  const matchFloor = opts.matchFloor ?? MATCH_FLOOR;
  const args = ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...paths];
  const listing = (opts.run ?? gitListing)(args);

  const listed = listing.split("\n").filter((l) => l.trim().length > 0).length;
  if (listed < listingFloor) {
    throw new EnumerationRefused(
      `git listed ${listed} paths under ${paths.join(", ")}, below the floor of ${listingFloor}. ` +
        `Nothing was scanned, so nothing is vouched for: this is a git subprocess reading the ` +
        `wrong tree, not a clean one (#2421).`,
    );
  }

  const files = selectFiles(listing, { match: opts.match, exclude: opts.exclude });
  if (files.length < matchFloor) {
    throw new EnumerationRefused(
      `the listing of ${listed} paths matched ${files.length} files for ${String(opts.match)}, ` +
        `below the floor of ${matchFloor}. The pattern reaches nothing, and an empty scan reports ` +
        `the same clean tree a real one does (#2421).`,
    );
  }
  return files;
}
