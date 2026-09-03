// One spinner, drawn once, and nothing may draw a second (#1792).
//
// Dan, 2026-09-03, on the sidebar's nav spinner: "this loader is both ugly and
// way too close to the words". Three things, one of them a real defect: the
// spinner carried no spacing of its own and depended on the parent to supply it,
// which the sidebar's Link did not, so it touched the "r" in Roster. That is the
// L550 shape, a component correct only while its callers do something, false at
// the first caller that does not. The component owns its spacing now, so no call
// site can put it flush against text again.
//
// This guard is what keeps the consolidation from eroding. Two identical copies
// existed with no shared component, the third time that pattern appeared in a
// week (the time pickers #1765, the focus rings #1768), and each copy looked like
// a local styling decision at the point it was written.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-spinner-recipe.ts
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { scrubbedGitEnv } from "./lib/git-env.ts";
import { scanSpinners, SPINNER_COMPONENT } from "./lib/scan-spinners.ts";
import { assert, eq, fail, finish } from "./lib/harness.ts";

/** Every source file, from git, so nothing untracked or ignored is scanned. */
function sourceFiles(): string[] {
  // Scrubbed because the pre-push hook exports GIT_DIR and friends, and an
  // inherited GIT_DIR makes this read the real repo rather than its own cwd
  // (#848/#853); scripts/test-git-env-isolation.ts enforces it.
  return execFileSync("git", ["ls-files", "src"], {
    encoding: "utf8",
    env: scrubbedGitEnv(),
  })
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f));
}

// --- the tree itself -------------------------------------------------------
{
  const offenders = sourceFiles()
    // A test file asserts the absence of the old recipe, which means it has to
    // spell it.
    .filter((f) => !/\.test\.tsx?$/.test(f))
    .flatMap((f) => scanSpinners(f, readFileSync(f, "utf8")));

  if (offenders.length === 0) {
    assert(true, "no component in src/ draws its own spinner");
  } else {
    for (const o of offenders) fail(`${o.file}:${o.line} uses ${o.utility}: ${o.why}`);
  }
}

// --- the one component really is there, and really draws the arc -----------
//
// The tree scan above is satisfied by a tree with NO spinner at all, which is
// exactly how a consolidation guard rots into a no-op (L98). So the component's
// own content is asserted, not merely its absence from the offender list.
{
  const src = readFileSync(SPINNER_COMPONENT, "utf8");
  // The NEGATIVE assertions read the CODE, not the prose. This file's docstring
  // explains why it does not use `border-current`, and a whole-file match is
  // answered by a comment ABOUT the thing as readily as by the thing (L103): the
  // first version of this guard failed on its own explanation.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert(/animate-spin/.test(src), "the one spinner actually spins");
  assert(/motion-reduce:animate-none/.test(src), "and stops for prefers-reduced-motion");
  assert(/aria-hidden/.test(src), "it is silent: the wait is announced by the load bar beside it");
  assert(
    /stroke-linecap="round"|strokeLinecap="round"/.test(src),
    "the arc has round caps, which is the whole reason it is an svg rather than a bordered circle",
  );
  assert(
    !/border-t-transparent/.test(code),
    "and it does not keep the broken ring recipe it replaced",
  );
  assert(
    /var\(--cue-line\)/.test(src),
    "its colour comes from the per surface token, not from a literal or from currentColor",
  );
  assert(
    !/border-current/.test(code),
    "border-current is what made the cue change weight with whichever control was clicked",
  );
  // The stripper has to actually strip, or both negatives above pass by reading a
  // file they never looked into properly (L98).
  assert(
    /border-current/.test(src) && !/border-current/.test(code),
    "the comment stripper really removed the prose that names the old recipe",
  );
  // The actual defect from part 1 of the issue: the component, not the caller,
  // owns the gap. Asserted as a class because jsdom cannot compute Tailwind, and
  // a rendered test would have to read a stylesheet that is not built here.
  assert(/\bmx-1\.5\b/.test(src), "it carries its own horizontal spacing");
}

// --- positive controls -----------------------------------------------------
//
// Each of these runs against the REAL tree with one file's content replaced in
// memory, so nothing is written to the repo. Without them a scanner that matched
// nothing at all would pass every assertion above.
{
  // The recipe as it actually shipped, put back under LinkPending's name.
  const OLD_RECIPE = `
    <span
      aria-hidden="true"
      className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
    />`;
  const caught = scanSpinners("src/components/ui/LinkPending.tsx", OLD_RECIPE);
  eq(caught.length, 2, "the shipped recipe is caught, on both of its signatures");
  assert(
    caught.some((c) => c.utility === "animate-spin"),
    "the rotation is named",
  );
  assert(
    caught.some((c) => c.utility === "border-t-transparent"),
    "and so is the broken ring, separately, so a copy that rotates another way is still caught",
  );

  // Each signature ALONE is caught, or a copy carrying only one of them walks.
  eq(scanSpinners("src/x.tsx", `className="animate-spin"`).length, 1, "the rotation alone is caught");
  eq(
    scanSpinners("src/x.tsx", `className="border-t-transparent"`).length,
    1,
    "the broken ring alone is caught",
  );

  // The exemption is by path, and it is the only one.
  eq(
    scanSpinners(SPINNER_COMPONENT, `className="animate-spin border-t-transparent"`).length,
    0,
    "Spinner.tsx itself is not an offender",
  );
  eq(
    scanSpinners("src/components/ui/Spinner2.tsx", `className="animate-spin"`).length,
    1,
    "a near miss on the exempt path is not exempt",
  );

  // The cue the scanner must LEAVE ALONE. BobbingDots is the lead facing signal
  // and a deliberately separate decision; a scanner that refused it would be
  // refusing the thing it exists to protect.
  const bob = "src/components/BobbingDots.tsx";
  eq(
    scanSpinners(bob, readFileSync(bob, "utf8")).length,
    0,
    "BobbingDots is untouched, pn-bob is not a spinner",
  );
  eq(
    scanSpinners("src/x.tsx", `className="pn-bob motion-reduce:animate-none"`).length,
    0,
    "and neither pn-bob nor animate-none is mistaken for the rotation",
  );
  eq(
    scanSpinners("src/x.tsx", `className="animate-spinner-thing"`).length,
    0,
    "nor is a longer class that merely starts the same way",
  );

  // The opt-out works, and needs a reason.
  eq(
    scanSpinners("src/x.tsx", `// spinner-ok: a reason\nclassName="animate-spin"`).length,
    0,
    "an opt-out in the comment block above the line is honoured",
  );
  eq(
    scanSpinners("src/x.tsx", `// spinner-ok:\nclassName="animate-spin"`).length,
    1,
    "an opt-out with no reason is not an opt-out",
  );
}

// --- both call sites really use it ----------------------------------------
{
  for (const f of ["src/components/ui/LinkPending.tsx", "src/components/ui/SubmitButton.tsx"]) {
    assert(
      /<Spinner\b/.test(readFileSync(f, "utf8")),
      `${f} renders the shared Spinner`,
    );
  }
}

finish();
