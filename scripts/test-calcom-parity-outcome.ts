// The one ordering across both halves of `pnpm verify:calcom-parity` (#1911). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-calcom-parity-outcome.ts
//
// The command answers two questions, "do the two systems hold the same roster"
// and "do they hold the same hours for it", and each half has its own verdicts.
// A run exits once, so the two families need ONE order and ONE code per outcome.
//
// Written as a table rather than as a comparison between two rank scales, because
// the interesting judgements are the cross-family ones and they should be legible:
// an agent who has left and can still be booked outranks any hours difference, and
// an hours difference outranks Slate offering somebody cal.com does not route to.
import { OUTCOME_ORDER, EXIT_CODE, worstOutcome, DELIBERATELY_QUIET } from "./lib/calcom-parity-outcome.ts";
import { ROSTER_VERDICT_RANK } from "./lib/roster-parity.ts";
import { VERDICT_RANK } from "./lib/schedule-parity.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- completeness, both ways ----------------------------------------------------
// A verdict missing from the table falls through to agreement, and the run then
// exits zero on a finding nobody sees. A code in the table for a verdict nothing
// produces is an exit nobody can ever meet, which reads as coverage (L113).
{
  const produced = [
    ...Object.keys(ROSTER_VERDICT_RANK),
    ...Object.keys(VERDICT_RANK),
  ].filter((v) => v !== "agree");
  const ordered = new Set(OUTCOME_ORDER);
  const quiet = new Set(DELIBERATELY_QUIET);
  for (const v of produced) {
    // Either it can fail a run, or it is on the list of things that deliberately
    // cannot. What is not allowed is being on neither, which is how a real finding
    // silently exits zero.
    assert(
      ordered.has(v as never) !== quiet.has(v as never),
      `${v} is either an outcome or deliberately quiet, and exactly one of the two`,
    );
    if (ordered.has(v as never)) assert(v in EXIT_CODE, `${v} has an exit code`);
  }
  for (const v of OUTCOME_ORDER) {
    assert(produced.includes(v), `${v} is a verdict something actually produces`);
  }
  for (const v of DELIBERATELY_QUIET) {
    assert(produced.includes(v as string), `${v} is exempted from something that actually exists`);
    assert(!(v in EXIT_CODE), `${v} carries no exit code, so it can never fail a run`);
  }
  eq(new Set(OUTCOME_ORDER).size, OUTCOME_ORDER.length, "no outcome appears twice in the order");
  const codes = OUTCOME_ORDER.map((v) => EXIT_CODE[v]);
  eq(new Set(codes).size, codes.length, "no two outcomes share an exit code, so a caller can branch on it");
  assert(!codes.includes(0), "no finding maps to zero, because zero is reserved for agreement");
  assert(
    codes.every((c) => c > 0 && c < 126),
    "every code is a real exit status, since 126 and up are the shell's own",
  );
}

// --- the cross-family judgements, stated ------------------------------------------
{
  const beats = (a: string, b: string) => OUTCOME_ORDER.indexOf(a as never) < OUTCOME_ORDER.indexOf(b as never);
  assert(
    beats("departed-still-hosting", "timezone-differs"),
    "somebody who has left and can still be booked outranks any hours difference",
  );
  assert(
    beats("held-back-still-hosting", "timezone-differs"),
    "so does an agent cal.com can route who Slate will not",
  );
  assert(
    beats("timezone-differs", "bookable-not-hosting"),
    "a zone that moves every window outranks Slate offering somebody cal.com does not route to",
  );
  // #3963: somebody bookable whom no pool reaches is offered by NEITHER system, so
  // nothing is mis-offered today; it ranks below Slate offering somebody cal.com
  // does not route, and above the states where nothing could be compared.
  assert(
    beats("bookable-not-hosting", "bookable-in-no-pool"),
    "Slate offering somebody cal.com does not route outranks an agent neither system offers",
  );
  assert(
    beats("bookable-in-no-pool", "calcom-unreachable"),
    "and a measured gap in the pools outranks an agent who could not be read",
  );
  eq(EXIT_CODE["bookable-in-no-pool" as never], 28, "it exits on its own code, the next free one");
  assert(
    beats("hours-differ", "no-calcom-user"),
    "a measured difference outranks an agent who could not be compared",
  );
  eq(
    OUTCOME_ORDER[OUTCOME_ORDER.length - 1],
    "hours-set-by-agent",
    "the quietest outcome is a week the agent set, which no automatic run will clear",
  );
  // #2030 retired exit 9 (a zone name that keeps the same clock), which is now
  // agreement. A retired code is never handed to a different outcome: a shell
  // caller that branched on 9 would silently start reading it as something else.
  assert(
    !Object.values(EXIT_CODE).includes(9),
    "exit 9 is retired with the zone alias verdict and is not reused",
  );
  assert(
    !(OUTCOME_ORDER as readonly string[]).includes("timezone-name-differs"),
    "and a zone alias is no longer an outcome a run can exit on",
  );
}

// --- picking the run's outcome -----------------------------------------------------
{
  eq(
    worstOutcome(["agree", "hours-differ", "staff-not-bookable", "departed-still-hosting"]),
    "departed-still-hosting",
    "the run is named by its worst outcome across both halves",
  );
  eq(worstOutcome(["agree", "staff-not-bookable"]), null, "nothing but agreement and expected staff is a pass");
  eq(worstOutcome([]), null, "and an empty run reports no outcome, which the caller must refuse (L98)");

}

finish();
