// Unit test (#418) for the booking-API outcome-mix core.
//
// #375 emits a per-call outcome log line (created/deduped/rescheduled/
// confirm_required/error) but nothing consumed it. #418 persists a daily tally
// (bump_booking_api_outcome) and surfaces the mix in an admin panel. This covers
// the two pure pieces: building the tally args (the day bucketed in the roster's
// ET zone, matching the daily-cap convention) and normalizing the mix RPC's jsonb
// into an ordered, percentage-carrying view for the panel.
//
// Run: node --experimental-strip-types scripts/test-booking-api-outcome.ts
import {
  outcomeTallyArgs,
  normalizeMix,
  excludedTestTrafficNote,
  OUTCOME_ORDER,
} from "@/lib/monitor/booking-api-outcome";
import { assert, eq, finish } from "./lib/harness.ts";

// --- tally args: day bucketed in ET -------------------------------------------

// 2026-07-17T14:00:00Z is 10:00 ET on the 17th.
const midday = Date.parse("2026-07-17T14:00:00Z");
const a = outcomeTallyArgs({
  outcome: "created",
  bucketCode: "DEBT1",
  errorCode: null,
  isTest: false,
  atMs: midday,
});
eq(a.p_day, "2026-07-17", "a midday UTC time buckets to the same ET calendar day");
eq(a.p_outcome, "created", "outcome carried through");
eq(a.p_bucket, "DEBT1", "bucket code carried through");
eq(a.p_error_code, "", "no error code becomes empty string (so it fits a non-null unique key)");

// 2026-07-17T02:00:00Z is 22:00 ET on the 16th, so the ET day is the PREVIOUS date.
const lateNight = Date.parse("2026-07-17T02:00:00Z");
const late = outcomeTallyArgs({
  outcome: "error",
  bucketCode: "DEBT1",
  errorCode: "NO_ELIGIBLE_AGENTS",
  isTest: false,
  atMs: lateNight,
});
eq(late.p_day, "2026-07-16", "an after-midnight-UTC time buckets to the prior ET day");
eq(
  late.p_error_code,
  "NO_ELIGIBLE_AGENTS",
  "an error outcome carries its error code into the tally",
);

// --- the test marker (#1616) --------------------------------------------------
//
// The marker rides on the tally row rather than being inferred later, because the
// one thing that could infer it (bucket_code) is EMPTY on the manage-token
// reschedule path, which is exactly where the canary's deliberate
// reschedule_conflict lands. Both directions are pinned: a builder hard-wired to
// either answer would satisfy a one-sided check (L1).
eq(a.p_is_test, false, "an attempt that is not test traffic is marked false");
eq(
  outcomeTallyArgs({
    outcome: "error",
    bucketCode: "",
    errorCode: "reschedule_conflict",
    isTest: true,
    atMs: midday,
  }).p_is_test,
  true,
  "a test attempt is marked true even with no bucket code (the reschedule path)",
);

// --- mix normalization --------------------------------------------------------

const raw = {
  by_outcome: { created: 12, deduped: 3, rescheduled: 4, confirm_required: 1, error: 5 },
  by_error: { NO_ELIGIBLE_AGENTS: 3, UNKNOWN_BUCKET: 2 },
};
const mix = normalizeMix(raw);
eq(mix.total, 25, "total sums every outcome");
eq(mix.outcomes.map((o) => o.outcome).join(","), OUTCOME_ORDER.join(","), "outcomes render in the fixed canonical order");
const created = mix.outcomes.find((o) => o.outcome === "created")!;
eq(created.count, 12, "created count carried through");
eq(created.pct, 48, "percentage is count/total rounded (12/25 = 48%)");
eq(mix.errors.map((e) => e.code).join(","), "NO_ELIGIBLE_AGENTS,UNKNOWN_BUCKET", "error codes sorted by count desc");
eq(mix.errors[0].count, 3, "top error count carried through");

// --- empty window -------------------------------------------------------------

const empty = normalizeMix({ by_outcome: {}, by_error: {} });
eq(empty.total, 0, "empty window totals zero");
eq(empty.outcomes.length, OUTCOME_ORDER.length, "every outcome row is still present at zero");
assert(empty.outcomes.every((o) => o.count === 0 && o.pct === 0), "all counts and percentages are zero on an empty window");
eq(empty.errors.length, 0, "no error rows on an empty window");

// A null/absent RPC result (e.g. table empty) normalizes like an empty window.
const nulled = normalizeMix(null);
eq(nulled.total, 0, "a null RPC result normalizes to an empty mix (no crash)");

// --- how much test traffic was hidden (#1616) ---------------------------------
//
// The panel EXCLUDES test traffic so it measures the same population the
// failure-rate page does. That is only honest if the reader can tell an excluded
// canary pass from a genuinely quiet week, so the count of what was hidden comes
// back with the mix.
eq(
  normalizeMix({ by_outcome: { created: 3 }, by_error: {}, test_total: 16 }).testTotal,
  16,
  "the mix reports how many test attempts were excluded",
);
eq(
  normalizeMix({ by_outcome: { created: 3 }, by_error: {}, test_total: 0 }).testTotal,
  0,
  "a window with no test traffic reports zero, which is a real measurement",
);
// A count that could not be measured must be NULL, never 0: an unreadable RPC and
// a week with no canary traffic must not render the same sentence.
eq(
  normalizeMix(null).testTotal,
  null,
  "a mix that could not be read reports an UNKNOWN test count, not zero",
);
eq(
  normalizeMix({ by_outcome: {}, by_error: {} }).testTotal,
  null,
  "a result carrying no test_total at all reports unknown rather than zero",
);

assert(
  excludedTestTrafficNote(16).includes("16"),
  "the panel note names how many test calls were excluded",
);
assert(
  !/[^\d]0[^\d]|^0|0$/.test(excludedTestTrafficNote(null)),
  "an unknown test count is never rendered as the number zero",
);
assert(
  excludedTestTrafficNote(null) !== excludedTestTrafficNote(0),
  "could not count and counted none read as different sentences (L11)",
);

finish();
