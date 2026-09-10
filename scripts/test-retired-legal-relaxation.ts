// The legal RELAXATION is retired, and nothing may reference it again (#2218).
//
// #2158 widened a legal bucket that matched nobody: it dropped the
// `legal_eligible!` clause at request time, offered the tier's whole pool, and
// sent a Slack notice on every booking that took it. #2218 removed that criterion
// from all sixty buckets instead, so there is nothing left to widen and the
// widening, its alert, its catalog entry and the `legal_relaxed` flag on the
// routing trace all go.
//
// THE REASON THIS IS A GUARD AND NOT JUST A DELETION. The relaxation was threaded
// through the whole booking path as a boolean, from the pool resolver out to the
// alert, and a value carried that far comes back the moment somebody restores one
// link of it. Nothing would fail: a `false` that nobody sets is invisible.
//
// The ATTRIBUTE itself (`legal_eligible`) is still written by the Twilio roster
// sync and read by the admin agent page, and goes in the next change. This guard
// widens to cover it then; scoping it to what is actually gone keeps it honest
// today rather than green because it was told to ignore things (L324).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-retired-legal-relaxation.ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { scrubbedGitEnv } from "./lib/git-env.ts";
import { assert, fail, finish } from "./lib/harness.ts";

/** The retired name, in both spellings the tree used. */
const RETIRED = /\blegalRelaxed\b|\blegal_relaxed\b/;

/**
 * Where the name is still allowed to appear.
 *
 * `supabase/migrations` is the schema's own history, and rewriting it to hide a
 * retired name would make the record wrong. This guard's own file has to name
 * what it forbids in order to forbid it (L245).
 */
const ALLOWED = [/^supabase\/migrations\//, /^scripts\/test-retired-legal-relaxation\.ts$/];

function trackedFiles(): string[] {
  // The env is scrubbed because the pre-push hook exports GIT_DIR and friends,
  // and an inherited GIT_DIR makes this read the real repo rather than its own
  // cwd (#848/#853).
  return execFileSync("git", ["ls-files"], { encoding: "utf8", env: scrubbedGitEnv() })
    .split("\n")
    .filter(Boolean)
    .filter((f) => /\.(ts|tsx|sql|md|json|jsonc)$/.test(f))
    .filter((f) => !ALLOWED.some((re) => re.test(f)));
}

const files = trackedFiles();

// A scan of nothing reports the same empty list a clean tree does (L98).
assert(files.length > 200, `the scan really read the tree (${files.length} files)`);

// The positive control: the name must be FINDABLE by this scanner where it really
// exists, or a regex that matched nothing would pass over a tree full of it.
{
  const planted = [
    "  const { ids, legalRelaxed } = await resolveEligible(bucket);",
    "      legal_relaxed: tier.legalRelaxed,",
  ];
  for (const line of planted) {
    assert(RETIRED.test(line), `the scanner still matches a real removed line: ${line.trim()}`);
  }
  // And it does not match a word that merely contains it, which is what would make
  // the guard fire on unrelated code and get switched off.
  for (const line of ["const legalRelaxationNotes = 1;", "// legal advice"]) {
    assert(!RETIRED.test(line), `the scanner leaves unrelated text alone: ${line}`);
  }
}

// A file git still tracks but the working tree no longer has (a deletion not yet
// staged) makes `readFileSync` throw, and a throw here ABORTS the scan partway
// through: it then reports the offenders it happened to reach and reads as
// progress. Measured while writing this, that took the count from 197 to 13 and
// dropped every Twilio file the scan had not reached yet, which read as the
// removal being nearly done. That is the same shape as a scanner blind to a
// pattern (L98).
//
// So an unreadable file ends this run rather than the scan: it is named, counted
// and skipped, and the run fails on it, because a file that was not scanned
// cannot be reported as carrying nothing.
let offenders = 0;
let unreadable = 0;
for (const file of files) {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    // NAMED, not just counted. A skipped file could be the one carrying the
    // reference, so a reader has to be able to see which was skipped rather than
    // read a smaller offender count as a cleaner tree (L11).
    unreadable++;
    fail(`${file} is tracked but could not be read, so it was NOT scanned`);
    continue;
  }
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (!RETIRED.test(line)) return;
    offenders++;
    fail(`${file}:${i + 1} references the retired legal relaxation: ${line.trim()}`);
  });
}
if (offenders === 0) {
  assert(true, "nothing references the retired legal relaxation");
}
assert(unreadable === 0, `every tracked file was scanned (${files.length} read, ${unreadable} not)`);

finish();
