// Reading the Supabase CLI for the migration drift gate, with a bounded retry
// (#1437).
//
// On 2026-08-12 the gate failed twice in one afternoon on the Supabase side
// rather than on anything in the change under test: `supabase link` came back
// "Unexpected error retrieving remote project status: error code: 502", and the
// CLI download hung up its socket. `deploy` needs `migration-drift`, so each of
// those skipped the deploy for a commit that was perfectly good, and one of them
// paged "Slate deploy failed on main" for a fault nobody could act on.
//
// The hazard in fixing it is obvious: a retry that swallows a REAL answer would
// turn this gate back into the thing #766 and #1433 each rewrote it for. So the
// line drawn here is between the CLI failing to answer (retry) and the CLI
// answering something we do not like (never retry, that is the finding).
//
// Run: node --experimental-strip-types scripts/test-migration-drift-cli.ts
import { assert, eq, finish } from "./lib/harness.ts";
import { migrationDriftVerdict } from "./lib/migration-drift.ts";
import {
  type CliResult,
  cliResultFromExec,
  readMigrationListWithRetry,
} from "./lib/migration-drift-cli.ts";

const REF = "drukfvgaynzrralbzkzj";

const APPLIED_TABLE = [
  "A new version of Supabase CLI is available: v2.114.0 (currently installed v2.84.2)",
  "",
  "        LOCAL      |     REMOTE     | TIME (UTC)",
  "  -----------------|----------------|---------------------",
  "   20260101000000  | 20260101000000 | 2026-01-01 00:00:00",
  "   20260102000000  | 20260102000000 | 2026-01-02 00:00:00",
].join("\n");

const DRIFTED_TABLE = [
  "        LOCAL      |     REMOTE     | TIME (UTC)",
  "  -----------------|----------------|---------------------",
  "   20260101000000  | 20260101000000 | 2026-01-01 00:00:00",
  "   20260102000000  |                | 2026-01-02 00:00:00",
].join("\n");

const exitZero = (stdout = ""): CliResult => ({ code: 0, stdout, stderr: "" });
const exitNonZero = (stderr: string, code = 1): CliResult => ({ code, stdout: "", stderr });

/** A fake CLI that records every invocation, so the suite can count real calls. */
function fakeCli(handler: (args: string[], call: number) => CliResult) {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args: string[]) => {
      calls.push(args);
      return handler(args, calls.length);
    },
  };
}

const noSleep = async () => {};

// --- the happy path reads the table once ---------------------------------
{
  const cli = fakeCli((args) => (args[0] === "link" ? exitZero() : exitZero(APPLIED_TABLE)));
  const r = await readMigrationListWithRetry({ projectRef: REF, run: cli.run, sleep: noSleep });
  assert(r.ok, "a working CLI returns the output");
  eq(r.attempts, 1, "and takes one attempt");
  eq(cli.calls.length, 2, "which is link plus migration list, nothing more");
  eq(cli.calls[0], ["link", "--project-ref", REF], "link is called with the pinned project ref");
  eq(
    cli.calls[1],
    ["migration", "list", "--linked"],
    "the list is read against the linked project",
  );
  assert(
    migrationDriftVerdict(r.ok ? r.output : "").ok,
    "and the output it hands on is what the parse reads as applied",
  );
}

// --- a 502 on link clears on the retry ----------------------------------
// The exact 2026-08-12 failure.
{
  const cli = fakeCli((args, call) => {
    if (args[0] === "link" && call === 1) {
      return exitNonZero("Unexpected error retrieving remote project status: error code: 502");
    }
    return args[0] === "link" ? exitZero() : exitZero(APPLIED_TABLE);
  });
  const retried: string[] = [];
  const r = await readMigrationListWithRetry({
    projectRef: REF,
    run: cli.run,
    sleep: noSleep,
    onRetry: (info) => retried.push(info.reason),
  });
  assert(r.ok, "#1437: a 502 on link no longer fails the gate");
  eq(r.attempts, 2, "it took a second attempt");
  eq(cli.calls.length, 3, "the failed link was not followed by a list on that attempt");
  assert(
    retried.length === 1 && retried[0]!.includes("502"),
    "the retry is announced with the upstream reason, so the log explains the extra time",
  );
}

// --- a failing `migration list` retries too -----------------------------
{
  const cli = fakeCli((args, call) => {
    if (args[0] === "link") return exitZero();
    return call === 2 ? exitNonZero("failed to connect to postgres: read tcp: connection reset") : exitZero(APPLIED_TABLE);
  });
  const r = await readMigrationListWithRetry({ projectRef: REF, run: cli.run, sleep: noSleep });
  assert(r.ok, "a blip on the list call also gets a second look");
  eq(cli.calls.length, 4, "the whole link-then-list pair is redone, since the link may be why");
}

// --- exhausting the attempts fails loudly -------------------------------
// The property that keeps the retry from becoming the defect. Three 502s is a
// dead upstream, and the gate must go red rather than reporting a database it
// never read.
{
  const cli = fakeCli((args) => (args[0] === "link" ? exitNonZero("error code: 502") : exitZero(APPLIED_TABLE)));
  const r = await readMigrationListWithRetry({ projectRef: REF, run: cli.run, sleep: noSleep });
  assert(!r.ok, "a persistent upstream failure still fails the gate");
  eq(r.attempts, 3, "after three attempts");
  eq(cli.calls.length, 3, "three link calls, each of which stopped the attempt");
  const reason = r.ok ? "" : r.reason;
  assert(reason.includes("502"), "the reason carries what the CLI actually said");
  assert(/link/.test(reason), "and which of the two commands failed");
  assert(/3 attempt/.test(reason), "and that every attempt was used, so this is not a blip");
}

// --- REAL DRIFT IS NOT A TRANSIENT FAILURE ------------------------------
// The one that would undo #766. `migration list` exits 0 and prints a table with
// a blank remote column: that is the finding this gate exists for. Retrying it
// would cost three round trips and could never change the answer, and a retry
// that eventually gave up would report drift as "could not read the CLI", which
// is a different instruction to the reader.
{
  const cli = fakeCli((args) => (args[0] === "link" ? exitZero() : exitZero(DRIFTED_TABLE)));
  const r = await readMigrationListWithRetry({ projectRef: REF, run: cli.run, sleep: noSleep });
  assert(r.ok, "a successful read is a successful read, even when it shows drift");
  eq(cli.calls.length, 2, "#766: drift is read once and judged, never retried away");
  const verdict = migrationDriftVerdict(r.ok ? r.output : "");
  assert(!verdict.ok, "and the parse still calls it drift");
  eq(verdict.unapplied, ["20260102000000"], "naming the migration that is not applied");
}

// --- an EMPTY successful read is not retried either ---------------------
// It is a real answer from the CLI's point of view, and the parse already fails
// on it with the right message ("an output the gate could not read"). Retrying
// here would relabel a #1433 finding as an upstream outage.
{
  const cli = fakeCli((args) => (args[0] === "link" ? exitZero() : exitZero("")));
  const r = await readMigrationListWithRetry({ projectRef: REF, run: cli.run, sleep: noSleep });
  assert(r.ok, "an exit-0 CLI that printed nothing is handed to the parse");
  eq(cli.calls.length, 2, "and is not retried");
  assert(
    !migrationDriftVerdict(r.ok ? r.output : "").ok,
    "#1433: the parse is still the thing that fails an unreadable output",
  );
}

// --- a spawn that throws is a failure, not a crash ---------------------
// `supabase` missing from PATH (the setup-cli step having failed) rejects rather
// than exiting non-zero. That has to read as an attempt that could not tell,
// with the same fail-after-retries ending, not as an unhandled rejection whose
// stack tells a reader nothing about the gate.
{
  let calls = 0;
  const r = await readMigrationListWithRetry({
    projectRef: REF,
    run: async () => {
      calls++;
      throw new Error("spawn supabase ENOENT");
    },
    sleep: noSleep,
  });
  assert(!r.ok, "an unspawnable CLI fails the gate");
  eq(calls, 3, "having been retried, since a missing binary can also be a slow install");
  assert(
    (r.ok ? "" : r.reason).includes("ENOENT"),
    "and the reason names what went wrong rather than a bare stack",
  );
}

// --- the backoff stays short enough for a CI step ----------------------
{
  const waits: number[] = [];
  const cli = fakeCli(() => exitNonZero("error code: 502"));
  await readMigrationListWithRetry({
    projectRef: REF,
    run: cli.run,
    sleep: async (ms) => void waits.push(ms),
  });
  const total = waits.reduce((a, b) => a + b, 0);
  assert(waits.length === 2, "two waits across three attempts");
  assert(total > 0, "the retry actually backs off rather than hammering a struggling upstream");
  assert(total <= 15_000, `the whole backoff is ${total}ms, which a CI step can afford`);
}

// --- exited, versus never ran at all -------------------------------------
// The mapping from what execFile reports to what the retry sees. `error.code` is a
// NUMBER only when the command ran and exited; it is a string when the binary is
// missing and null when the timeout killed it. Coercing either of those into a
// status gives NaN, which compares false against every check downstream, so a
// command that never ran would arrive looking like one that exited on some unknown
// status (L50).
{
  const clean = cliResultFromExec(null, "the table", "");
  assert(clean.ran, "no error means it ran");
  eq(clean.ran ? clean.result.code : -1, 0, "with exit 0");
  eq(clean.ran ? clean.result.stdout : "", "the table", "and its stdout intact");

  const exited = cliResultFromExec({ message: "Command failed", code: 1 }, "", "error code: 502");
  assert(exited.ran, "a numeric code is a real exit status, so it ran");
  eq(exited.ran ? exited.result.code : -1, 1, "and the status comes through as itself");
  eq(exited.ran ? exited.result.stderr : "", "error code: 502", "with what it said on stderr");

  const missing = cliResultFromExec(
    { message: "spawn supabase ENOENT", code: "ENOENT" },
    "",
    "",
  );
  assert(!missing.ran, "a string code means the binary never ran, not that it exited on NaN");
  assert(
    (missing.ran ? "" : missing.reason).includes("ENOENT"),
    "and the reason names what happened",
  );

  const timedOut = cliResultFromExec(
    { message: "Command failed", code: null, killed: true, signal: "SIGTERM" },
    "",
    "",
  );
  assert(!timedOut.ran, "a killed command never ran to completion");
  assert(
    /killed/.test(timedOut.ran ? "" : timedOut.reason),
    "and says it was killed, so a hung CLI is not read as a status",
  );

  // The property that ties it back: an unrun command is what the retry treats as
  // "could not tell", and after its attempts it must still be a hard failure.
  let calls = 0;
  const r = await readMigrationListWithRetry({
    projectRef: REF,
    sleep: noSleep,
    run: async () => {
      calls++;
      const outcome = cliResultFromExec({ message: "spawn supabase ENOENT", code: "ENOENT" }, "", "");
      if (!outcome.ran) throw new Error(outcome.reason);
      return outcome.result;
    },
  });
  assert(!r.ok, "a CLI that never ran fails the gate rather than reporting a database");
  eq(calls, 3, "after the bounded retry");
}

finish();
