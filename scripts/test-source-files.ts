// A guard that enumerated nothing must REFUSE, not report a clean tree (#2421).
//
// Six design guards each built their own subject list with
// `execFileSync("git", ["ls-files", "src"])` and then flat-mapped a scanner over
// it. Neither half of that is safe on its own:
//
//   the enumeration can be EMPTY.  `git ls-files` answers with an empty string in
//     a checkout where `src` is not tracked, and, more likely here, when the
//     pre-push hook's GIT_DIR points the subprocess at a different tree
//     (#848/#853 is the same root cause from the write side). Every one of the
//     six then printed its clean sentence over zero files, because an empty
//     offender list is what a healthy tree produces too (L98).
//
//   the enumeration can be INCOMPLETE.  `ls-files` lists what git TRACKS, and the
//     file a guard exists to judge is the one being written, which is untracked
//     until it is staged (L456). The tree read clean locally and the violation
//     was first named by the isolated pre-push checkout or by CI.
//
// So the enumeration lives in one place now (`scripts/lib/source-files.ts`): it
// asks for tracked AND untracked-but-not-ignored paths, and it throws by name
// when either the raw listing or the matched subset comes back below its floor.
//
// This file holds the unit tests for that helper plus the tree scan that keeps
// the six from growing a seventh sibling with its own hand rolled listing.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-source-files.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EnumerationRefused,
  LISTING_FLOOR,
  MATCH_FLOOR,
  selectFiles,
  sourceFiles,
} from "./lib/source-files.ts";
import { handRolledEnumeration } from "./lib/scan-source-enumeration.ts";
import { assert, eq, fail, finish } from "./lib/harness.ts";

// --- the selection itself --------------------------------------------------
{
  const listing = ["src/a.tsx", "src/b.ts", "src/c.css", "src/d.test.tsx", "src/e.png", ""].join("\n");

  eq(
    selectFiles(listing, { match: /\.tsx?$/ }).join(","),
    "src/a.tsx,src/b.ts,src/d.test.tsx",
    "the match picks the extensions a guard reads",
  );
  eq(
    selectFiles(listing, { match: /\.tsx?$/, exclude: (f) => /\.test\.tsx?$/.test(f) }).join(","),
    "src/a.tsx,src/b.ts",
    "and the exclude drops what it deliberately does not judge",
  );
  eq(selectFiles("", { match: /\./ }).length, 0, "an empty listing selects nothing");
  eq(
    selectFiles("src/a.tsx\nsrc/a.tsx\n", { match: /\.tsx$/ }).length,
    1,
    "a path listed twice is read once, since --cached and --others can both name a path mid stage",
  );

  // Another agent's checkout is another tree. It is not in .gitignore and carries
  // its own node_modules, so an untracked listing across the repo would walk every
  // abandoned worktree.
  eq(
    selectFiles(".claude/worktrees/agent-1/src/a.tsx\nsrc/a.tsx", { match: /\.tsx$/ }).join(","),
    "src/a.tsx",
    "a nested agent worktree is never scanned",
  );
}

// --- the refusal, which is the whole point ---------------------------------
//
// Each way of learning nothing gets its own message, because "git answered with
// nothing" and "your regex matched nothing" send somebody to two different
// places (L11).
{
  const empty = () => "";
  let refused: unknown = null;
  try {
    sourceFiles({ match: /\.tsx$/, run: empty });
  } catch (e) {
    refused = e;
  }
  assert(refused instanceof EnumerationRefused, "an empty listing REFUSES rather than returning []");
  assert(
    String((refused as Error).message).includes("listed 0"),
    `the refusal says how many paths git listed (saw ${String((refused as Error).message)})`,
  );

  // A listing that is plainly there, and a match that reaches none of it.
  const many = () => Array.from({ length: LISTING_FLOOR + 10 }, (_, i) => `src/f${i}.ts`).join("\n");
  let matchRefused: unknown = null;
  try {
    sourceFiles({ match: /\.vue$/, run: many });
  } catch (e) {
    matchRefused = e;
  }
  assert(
    matchRefused instanceof EnumerationRefused,
    "a listing that matched nothing REFUSES too, rather than scanning an empty set",
  );
  assert(
    String((matchRefused as Error).message).includes("matched 0"),
    "and it says the MATCH found nothing, not that git did",
  );
  assert(
    String((matchRefused as Error).message) !== String((refused as Error).message),
    "the two refusals do not share a message, so one cannot be mistaken for the other",
  );

  // A listing just under the floor is refused as well: the fault this exists to
  // catch is a subprocess pointed at the wrong tree, which answers with a short
  // list rather than always with an empty one.
  const short = () => Array.from({ length: LISTING_FLOOR - 1 }, (_, i) => `src/f${i}.ts`).join("\n");
  let shortRefused = false;
  try {
    sourceFiles({ match: /\.ts$/, run: short });
  } catch {
    shortRefused = true;
  }
  assert(shortRefused, `a listing under the floor of ${LISTING_FLOOR} is refused, not merely an empty one`);

  // And the healthy case really does come back, or the floors would be a way of
  // failing always rather than a way of failing honestly (L1 in both directions).
  const healthy = () =>
    Array.from({ length: LISTING_FLOOR + MATCH_FLOOR }, (_, i) => `src/f${i}.tsx`).join("\n");
  eq(
    sourceFiles({ match: /\.tsx$/, run: healthy }).length,
    LISTING_FLOOR + MATCH_FLOOR,
    "a full listing is returned unchanged",
  );
}

// --- it asks git for the untracked files too --------------------------------
//
// The half of #2421 that is about coverage rather than about emptiness: a
// component being written is untracked, and it is exactly the file the design
// guards exist to judge (L456).
{
  let asked: string[] = [];
  const spy = (args: string[]) => {
    asked = args;
    return Array.from({ length: LISTING_FLOOR + 1 }, (_, i) => `src/f${i}.ts`).join("\n");
  };
  sourceFiles({ match: /\.ts$/, run: spy });
  assert(asked.includes("--others"), "the listing includes untracked files");
  assert(
    asked.includes("--exclude-standard"),
    "and honours the ignore files, so a build directory is not scanned",
  );
  assert(asked.includes("--cached"), "alongside the tracked ones");
  assert(asked.includes("src"), "scoped to src by default");

  let scoped: string[] = [];
  sourceFiles({
    paths: ["src", "DESIGN.md"],
    match: /\.(ts|md)$/,
    run: (args) => {
      scoped = args;
      return Array.from({ length: LISTING_FLOOR + 1 }, (_, i) => `src/f${i}.ts`).join("\n");
    },
  });
  assert(scoped.includes("DESIGN.md"), "a guard reading more than src says so and gets it");
}

// --- the scrub came with it -------------------------------------------------
//
// `scripts/test-git-env-isolation.ts` only reads `test-*.ts`, so moving the git
// call into `lib/` moved it out of that guard's reach. An inherited GIT_DIR under
// the pre-push hook makes the listing describe the real repo rather than this
// checkout (#848/#853), which is one of the two ways #2421 said the enumeration
// can lie, so the scrub is asserted here instead of quietly losing its watcher.
{
  const helper = readFileSync(join(import.meta.dirname, "lib", "source-files.ts"), "utf8");
  assert(
    /execFileSync\([\s\S]{0,200}env:\s*scrubbedGitEnv\(\)/.test(helper),
    "the one remaining enumeration spawn routes its env through scrubbedGitEnv",
  );
}

// --- the real tree ----------------------------------------------------------
//
// The floors are worth nothing if the numbers behind them are imaginary, so the
// helper is run for real here. This is also the one assertion that would have
// caught the original fault: it reads the count rather than the offender list.
{
  const real = sourceFiles({ match: /\.(tsx?|css)$/ });
  assert(real.length > 400, `the shared enumeration really reads src (${real.length} files)`);
  assert(
    real.some((f) => f === "src/app/globals.css"),
    "and it reaches a file every design guard depends on",
  );
}

// --- nothing rolls its own listing any more ---------------------------------
{
  const dir = import.meta.dirname;
  const tests = readdirSync(dir).filter((f) => /^test-.*\.ts$/.test(f));
  assert(tests.length > 100, `the scripts tree was really read (${tests.length} suites)`);

  let offenders = 0;
  for (const f of tests) {
    const why = handRolledEnumeration(f, readFileSync(join(dir, f), "utf8"));
    if (why) {
      fail(why);
      offenders++;
    }
  }
  if (offenders === 0) assert(true, "every suite that enumerates from git goes through the shared helper");
}

// --- positive controls for the scanner --------------------------------------
{
  const caught = (code: string, what: string) =>
    assert(handRolledEnumeration("fixture.ts", code) !== null, `caught: ${what}`);
  const allowed = (code: string, what: string) => {
    const why = handRolledEnumeration("fixture.ts", code);
    assert(why === null, `allowed: ${what}${why ? ` (wrongly flagged: ${why})` : ""}`);
  };

  // The exact shape all six carried.
  caught(
    'const files = execFileSync("git", ["ls-files", "src"], { env: scrubbedGitEnv() }).split("\\n");',
    "the hand rolled listing that shipped six times",
  );
  caught('spawnSync("git", ["ls-files", "--cached", "src"]);', "the same thing spawned another way");
  caught(
    'const out = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "src"]);',
    "an untracked listing rolled by hand is still a hand rolled listing",
  );
  allowed(
    'import { sourceFiles } from "./lib/source-files.ts";\nconst files = sourceFiles({ match: /\\.tsx$/ });',
    "the shared helper",
  );
  allowed('execFileSync("git", ["rev-parse", "HEAD"]);', "a git call that is not an enumeration");
  allowed("const files = readdirSync(dir);", "a suite that reads a directory instead");

  // The opt-out, which must carry a reason or it is a magic word (L675).
  allowed(
    '// enumeration-ok: this suite asserts on the listing itself\nexecFileSync("git", ["ls-files", "src"]);',
    "an opt-out with a reason",
  );
  caught(
    '// enumeration-ok:\nexecFileSync("git", ["ls-files", "src"]);',
    "an opt-out carrying no reason",
  );
}

finish();
