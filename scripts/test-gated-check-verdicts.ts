// The five gated monitor checks that swallowed an unreadable state (#2798).
//
// Each of these checks answers a failed read with a status of its own
// (`unreadable` or `unmeasured`) that pages nothing and throws nothing, so the
// step failure page cannot see it, and until this change no verdict lane did
// either: a read failing on every tick for a week looked exactly like a quiet,
// healthy week (#1394). Each now stamps a verdict lane, and the predicate that
// decides whether a tick stamps is what this suite pins, in BOTH directions:
// every measured outcome stamps, and every non verdict state does not (L1).
//
// Where the check's own runner can be driven with hand written fakes, it is, so
// the predicate is judged against what the runner really returns rather than
// against a result object shaped the way this file assumes it looks (L52). The
// calendar window runner reaches the database for its streak, so its results are
// constructed here and its `judged` count is pinned in its own vitest suite.
//
// The sixth check in the issue, the availability scan, is pinned beside its own
// harness in scripts/test-monitor-availability-scan.ts.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-gated-check-verdicts.ts
import {
  calendarWindowReachedVerdict,
  offsiteOriginReachedVerdict,
  awaitingActivationReachedVerdict,
  regalCallFeedReachedVerdict,
  GATED_CHECK_VERDICT_COVERAGE,
  AVAILABILITY_SCAN_VERDICT_LANE,
  CALENDAR_WINDOW_VERDICT_LANE,
  OFFSITE_ORIGIN_VERDICT_LANE,
  AWAITING_ACTIVATION_VERDICT_LANE,
  REGAL_CALL_FEED_VERDICT_LANE,
  REGAL_CALL_OUTCOMES_VERDICT_LANE,
  type DetectorVerdictCoverage,
} from "@/lib/monitor/verdict-freshness";
import { VERDICT_STALE_BOUNDS_MS } from "@/lib/monitor/health";
import { runAwaitingActivationCheck } from "@/lib/monitor/awaiting-activation";
import { runOffsiteOriginCheck, type OriginBucket } from "@/lib/monitor/offsite-origin";
import {
  runRegalFeedQuietCheck,
  runRegalFeedUnreadableCheck,
  type RegalReasonCounts,
} from "@/lib/monitor/regal-call-feed";
import type { BusinessWindow } from "@/lib/booking/business-hours";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.UTC(2026, 8, 24, 14, 0, 0); // a Thursday, 10:00 ET
const HOUR = 60 * 60_000;
const quiet = async () => {};

// --- calendar window ---------------------------------------------------------
{
  assert(
    calendarWindowReachedVerdict({ status: "clear", uncovered: 0, graced: 0, judged: 97 }),
    "calendar window: every judged calendar covered IS a verdict",
  );
  assert(
    calendarWindowReachedVerdict({ status: "uncovered", uncovered: 2, graced: 0, judged: 97 }),
    "calendar window: finding uncovered calendars IS a verdict",
  );
  assert(
    !calendarWindowReachedVerdict({ status: "unreadable", uncovered: 0, graced: 0, judged: 0 }),
    "calendar window: an unreadable calendar read is NOT a verdict",
  );
  assert(
    !calendarWindowReachedVerdict({ status: "clear", uncovered: 0, graced: 0, judged: 0 }),
    "calendar window: a clear over zero calendars judged nothing and is NOT a verdict (L98)",
  );
  assert(
    !calendarWindowReachedVerdict({ status: "clear", uncovered: 0, graced: 4, judged: 0 }),
    "calendar window: a pass that graced every calendar judged nothing and is NOT a verdict",
  );
  assert(!calendarWindowReachedVerdict(null), "calendar window: a skipped or thrown step is NOT a verdict");
}

// --- off site origin -----------------------------------------------------------
{
  const REAL: OriginBucket = { id: "b-100", code: "100", name: "Low", is_test: false };
  const run = (bookings: Error | []) =>
    runOffsiteOriginCheck({
      loadBookings: async () => {
        if (bookings instanceof Error) throw bookings;
        return bookings;
      },
      buckets: [REAL],
      alreadyPaged: async () => new Set(),
      notify: quiet,
      bookingUrl: (id) => `https://example.test/${id}`,
    });

  const read = await run([]);
  eq(read.status, "checked", "off site origin: a successful read with no bookings reports checked");
  assert(
    offsiteOriginReachedVerdict(read),
    "off site origin: a successful read IS a verdict, including one that found no recent bookings",
  );
  const failed = await run(new Error("bookings unreadable"));
  eq(failed.status, "unreadable", "off site origin: a failed read reports unreadable");
  assert(!offsiteOriginReachedVerdict(failed), "off site origin: an unreadable read is NOT a verdict");
  assert(!offsiteOriginReachedVerdict(null), "off site origin: a skipped or thrown step is NOT a verdict");
}

// --- waiting to become bookable -------------------------------------------------
{
  const run = (rows: Error | { pendingSinceIso: string | null }[]) =>
    runAwaitingActivationCheck({
      load: async () => {
        if (rows instanceof Error) throw rows;
        return rows.map((r, i) => ({
          id: `u${i}`,
          name: `Agent ${i}`,
          email: `a${i}@example.test`,
          bookable: false,
          deactivated_at: null,
          bookable_pending_since: r.pendingSinceIso,
        }));
      },
      armed: false,
      notify: quiet,
      resolve: async () => true,
      cooldownMs: HOUR,
      nowMs: NOW,
    });

  const clear = await run([]);
  eq(clear.status, "clear", "awaiting activation: an empty queue reads as clear");
  assert(
    awaitingActivationReachedVerdict(clear),
    "awaiting activation: a measured empty queue IS a verdict, since nobody waiting is an answer",
  );
  const waiting = await run([{ pendingSinceIso: new Date(NOW - 30 * 24 * HOUR).toISOString() }]);
  eq(waiting.status, "waiting", "awaiting activation: somebody a month past the grace is waiting");
  assert(awaitingActivationReachedVerdict(waiting), "awaiting activation: a measured queue IS a verdict");
  const failed = await run(new Error("roster unreadable"));
  eq(failed.status, "unreadable", "awaiting activation: a failed read reports unreadable");
  assert(!awaitingActivationReachedVerdict(failed), "awaiting activation: an unreadable roster is NOT a verdict");
  assert(!awaitingActivationReachedVerdict(null), "awaiting activation: a skipped or thrown step is NOT a verdict");
}

// --- the Regal feed: one lane, both checks must conclude -------------------------
{
  const RULES: BusinessWindow[] = [1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    start_minute: 480,
    end_minute: 1200,
  }));
  const hours = { zone: "America/New_York", rules: RULES, exceptions: [] };
  const load = (counts: RegalReasonCounts | Error) => async () => {
    if (counts instanceof Error) throw counts;
    return counts;
  };
  const quietCheck = (counts: RegalReasonCounts | Error, rules = RULES) =>
    runRegalFeedQuietCheck({
      hours: { ...hours, rules },
      loadCounts: load(counts),
      armed: false,
      notify: quiet,
      resolve: async () => true,
      cooldownMs: HOUR,
      nowMs: NOW,
    });
  const unreadableCheck = (counts: RegalReasonCounts | Error) =>
    runRegalFeedUnreadableCheck({
      loadCounts: load(counts),
      armed: false,
      notify: quiet,
      resolve: async () => true,
      cooldownMs: HOUR,
      nowMs: NOW,
    });

  const flowing = await quietCheck({ candidate: 5 });
  const quietDay = await quietCheck({});
  const clean = await unreadableCheck({ candidate: 5 });
  const badEvents = await unreadableCheck({ candidate: 5, body_unreadable: 2 });
  eq(badEvents.status, "unreadable-events", "regal feed: an unreadable body reads as unreadable events");
  const rpcDown = new Error("regal_call_reason_counts failed");
  const quietUnmeasured = await quietCheck(rpcDown);
  const unreadableUnmeasured = await unreadableCheck(rpcDown);
  const noBusinessDay = await quietCheck({ candidate: 5 }, []);

  eq(flowing.status, "flowing", "regal feed: a call from a Slate user reads as flowing");
  eq(quietDay.status, "quiet", "regal feed: nothing at all reads as quiet");
  eq(clean.status, "clean", "regal feed: no unreadable events reads as clean");
  eq(quietUnmeasured.status, "unmeasured", "regal feed: a failed RPC leaves the quiet check unmeasured");
  eq(unreadableUnmeasured.status, "unmeasured", "regal feed: and the unreadable check too");
  eq(noBusinessDay.status, "unmeasured", "regal feed: an org with no open day leaves the quiet check unmeasured");

  for (const [q, u, label] of [
    [flowing, clean, "flowing and clean"],
    [quietDay, clean, "quiet and clean"],
    [flowing, badEvents, "flowing with unreadable events"],
    [quietDay, badEvents, "quiet with unreadable events"],
  ] as const) {
    assert(regalCallFeedReachedVerdict(q, u), `regal feed: ${label} IS a verdict: both counts were read and judged`);
  }
  assert(
    !regalCallFeedReachedVerdict(quietUnmeasured, unreadableUnmeasured),
    "regal feed: a reason count RPC failing for both checks is NOT a verdict",
  );
  assert(
    !regalCallFeedReachedVerdict(quietUnmeasured, clean),
    "regal feed: the quiet check unmeasured is NOT a verdict, even when the other one concluded",
  );
  assert(
    !regalCallFeedReachedVerdict(flowing, unreadableUnmeasured),
    "regal feed: the unreadable check unmeasured is NOT a verdict, even when the other one concluded",
  );
  assert(
    !regalCallFeedReachedVerdict(noBusinessDay, clean),
    "regal feed: a quiet check with no business day to judge is NOT a verdict",
  );
  assert(!regalCallFeedReachedVerdict(null, clean), "regal feed: a skipped quiet check is NOT a verdict");
  assert(!regalCallFeedReachedVerdict(flowing, null), "regal feed: a skipped unreadable check is NOT a verdict");
}

// --- the registry: every check the issue named is now watched ----------------------
{
  const expected: Record<string, string> = {
    availabilityScan: AVAILABILITY_SCAN_VERDICT_LANE,
    calendarWindow: CALENDAR_WINDOW_VERDICT_LANE,
    offsiteOrigin: OFFSITE_ORIGIN_VERDICT_LANE,
    awaitingActivation: AWAITING_ACTIVATION_VERDICT_LANE,
    regalCallsQuiet: REGAL_CALL_FEED_VERDICT_LANE,
    regalCallsUnreadable: REGAL_CALL_FEED_VERDICT_LANE,
    // #2944: its own lane, since it reads a second count the feed pair does not.
    regalCallOutcomes: REGAL_CALL_OUTCOMES_VERDICT_LANE,
  };
  const coverage = GATED_CHECK_VERDICT_COVERAGE as Record<string, DetectorVerdictCoverage>;
  for (const [check, lane] of Object.entries(expected)) {
    const entry = coverage[check];
    assert(entry !== undefined && "lane" in entry && entry.lane === lane, `${check} is watched by ${lane}`);
    assert(typeof VERDICT_STALE_BOUNDS_MS[lane] === "number", `${lane} has a blindness bound`);
  }
  const pending = Object.entries(coverage).filter(([, e]) => "pending" in e);
  eq(pending.map(([k]) => k), [], "no gated check is left pending a lane");
}

finish();
