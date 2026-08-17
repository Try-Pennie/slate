// #1261: the calendar hydration rotation's pure logic.
//
// WHY THE LANE EXISTS. Google's incremental delta is NOT scoped to the window a bootstrap
// asked for (measured, #1252), and an unchanged event is delivered exactly ONCE. So once
// anything filters or prunes the cache by window, a far future event created and never
// touched again would be dropped and never re-added when the horizon slid up to it. Only a
// periodic re-bootstrap puts it back, which is why hydration ships BEFORE the filter (#1264)
// and runs alone for a full cycle first.
//
// Run: node --experimental-strip-types scripts/test-calendar-hydration.ts
import { assert, eq, finish } from "./lib/harness.ts";
import {
  HYDRATION_TICKS_PER_DAY,
  HYDRATION_MIN_BATCH,
  hydrationBatchSize,
  hydrationWindow,
  calendarsDueForHydration,
} from "@/lib/google/hydration";
import { BOOTSTRAP_LOOKBACK_MS, BUSY_WINDOW_AHEAD_DAYS } from "@/lib/google/sync-coalesce";
import { HORIZON_MAX } from "@/lib/booking/settings";

// --- the window has to be wider than anything the booker can offer ------------
{
  // Asserted rather than left in a comment, because this is the whole safety margin: the
  // cache is only allowed to be bounded because the bound sits comfortably past the
  // furthest slot a lead can be shown. If the horizon were ever raised past the window,
  // the booker would offer times the cache had deliberately stopped covering, and every
  // one of them would look free.
  const graceDays = 7;
  assert(
    HORIZON_MAX + graceDays < BUSY_WINDOW_AHEAD_DAYS,
    `the cached window (${BUSY_WINDOW_AHEAD_DAYS}d) clears the furthest bookable day ` +
      `(${HORIZON_MAX}d) by more than a week of grace`,
  );
}

// --- batch size is DERIVED, so it cannot be right today and wrong next year ---
{
  // A fixed number is the failure this replaces. Five per hour is 120 a day, which clears
  // 119 calendars with no slack at all, and at the design target of 100 to 200 agents
  // (roughly double the calendars) it silently drops to a refresh every OTHER day while
  // the safety margin erodes with nothing reporting it.
  eq(hydrationBatchSize(0), HYDRATION_MIN_BATCH, "an empty roster still uses the floor");
  eq(hydrationBatchSize(1), HYDRATION_MIN_BATCH, "one calendar uses the floor");

  // The requirement, stated as arithmetic anyone can check: at every size, one day of
  // ticks must cover the whole roster.
  for (const count of [1, 50, 121, 200, 250, 400]) {
    const perTick = hydrationBatchSize(count);
    assert(
      perTick * HYDRATION_TICKS_PER_DAY >= count,
      `${count} calendars are all refreshed within a day (${perTick} per tick x ` +
        `${HYDRATION_TICKS_PER_DAY} ticks = ${perTick * HYDRATION_TICKS_PER_DAY})`,
    );
  }

  // The size the issue names explicitly, so a change to the cadence that breaks it fails
  // here with the number in the message rather than in a general loop.
  assert(
    hydrationBatchSize(250) * HYDRATION_TICKS_PER_DAY >= 250,
    "a 250 calendar roster is fully refreshed within one day",
  );

  // And it must not be wildly over-sized either: a batch far larger than needed spends
  // Google quota and budget on work the cadence did not ask for.
  assert(
    hydrationBatchSize(250) <= Math.ceil(250 / HYDRATION_TICKS_PER_DAY) + HYDRATION_MIN_BATCH,
    "and does not massively over-fetch to get there",
  );
}

// --- the window sent to Google ------------------------------------------------
{
  const now = Date.UTC(2026, 7, 17, 12, 0, 0);
  const w = hydrationWindow(now);
  eq(w.timeMinIso, new Date(now - BOOTSTRAP_LOOKBACK_MS).toISOString(), "timeMin is the shared lookback");
  eq(
    w.timeMaxIso,
    new Date(now + BUSY_WINDOW_AHEAD_DAYS * 24 * 60 * 60_000).toISOString(),
    "timeMax is the cached window ahead",
  );
  assert(Date.parse(w.timeMinIso) < Date.parse(w.timeMaxIso), "and the bounds are the right way round");
}

// --- who gets refreshed, and in what order ------------------------------------
const cal = (
  id: string,
  attempt: string | null,
  extra: Partial<{ last_failure_kind: string | null; consecutive_failures: number }> = {},
) => ({
  id,
  sync_token: "tok",
  last_failure_kind: (extra.last_failure_kind ?? null) as never,
  consecutive_failures: extra.consecutive_failures ?? 0,
  last_bootstrap_attempt_at: attempt,
});

const NOW = Date.UTC(2026, 7, 17, 12, 0, 0);
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

{
  // Never attempted comes FIRST. Null is mapped to due rather than to "recently done",
  // which is the fail-safe side: a calendar nobody has ever bootstrapped is the one with
  // no coverage at all.
  const picked = calendarsDueForHydration(
    [cal("recent", hoursAgo(1)), cal("never", null), cal("old", hoursAgo(30))],
    NOW,
    2,
  );
  eq(picked.map((c) => c.id), ["never", "old"], "never-attempted first, then oldest attempt");
}

{
  // An UNPARSEABLE stamp is treated as never attempted, not as now. Date.parse returns NaN
  // for a value it cannot read, and NaN compares false against every threshold, so the
  // careless version of this silently parks the calendar at the back of the queue forever
  // (L50).
  const picked = calendarsDueForHydration(
    [cal("fresh", hoursAgo(1)), cal("garbage", "not-a-date")],
    NOW,
    1,
  );
  eq(picked.map((c) => c.id), ["garbage"], "an unreadable stamp reads as due, not as done");
}

{
  const picked = calendarsDueForHydration(
    [cal("a", hoursAgo(5)), cal("b", hoursAgo(9)), cal("c", hoursAgo(2))],
    NOW,
    2,
  );
  eq(picked.map((c) => c.id), ["b", "a"], "the batch is the oldest N, in oldest-first order");
  eq(picked.length, 2, "and it is capped at the batch size");
}

{
  // An established-gone calendar must not be able to hold the front of the queue. It can
  // never succeed, so ordering by coverage alone would leave it permanently the oldest and
  // selected on every single tick, starving every healthy calendar behind it. That is the
  // exact reason last_bootstrap_attempt_at stamps on ATTEMPT rather than on success, and
  // the reason the shared eligibility predicate is applied here too.
  const gone = cal("gone", null, { last_failure_kind: "gone", consecutive_failures: 5 });
  const healthy = cal("healthy", hoursAgo(20));
  // At a minute where the gone calendar's retry slot is not open, it is skipped entirely
  // and the healthy one is served instead of sitting behind it.
  let servedHealthy = false;
  for (let minute = 0; minute < 10; minute++) {
    const picked = calendarsDueForHydration([gone, healthy], NOW + minute * 60_000, 1);
    if (picked.length === 1 && picked[0]?.id === "healthy") servedHealthy = true;
  }
  assert(servedHealthy, "a dead calendar does not starve a healthy one behind it");

  // And it is not excluded forever: it still gets its periodic attempt, or a human's fix
  // would never be noticed.
  let servedGone = false;
  for (let minute = 0; minute < 60; minute++) {
    const picked = calendarsDueForHydration([gone], NOW + minute * 60_000, 5);
    if (picked.some((c) => c.id === "gone")) servedGone = true;
  }
  assert(servedGone, "but it is still attempted periodically, so a fix is noticed");
}

{
  eq(calendarsDueForHydration([], NOW, 5).length, 0, "an empty roster picks nothing");
  eq(
    calendarsDueForHydration([cal("a", null)], NOW, 0).length,
    0,
    "a zero batch picks nothing rather than everything",
  );
}

finish();
