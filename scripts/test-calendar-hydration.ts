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
  HYDRATION_ONBOARDING_MAX,
} from "@/lib/google/hydration";
import { MAX_ONBOARDS_PER_TICK } from "@/lib/google/sync-pace";
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
  //
  // Since #2301 it is also selected IN ADDITION to the maintenance batch rather than out
  // of it, which is why "recent" is here too: with a batch of 2 the old behaviour spent
  // one of the two slots on the new calendar and served only "old" beside it.
  const picked = calendarsDueForHydration(
    [cal("recent", hoursAgo(1)), cal("never", null), cal("old", hoursAgo(30))],
    NOW,
    2,
  );
  eq(picked.map((c) => c.id), ["never", "old", "recent"], "never-attempted first, then the batch oldest-first");
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

// --- #2301: a never covered calendar is onboarding, not maintenance ------------
// hydrationBatchSize is derived so the whole roster is refreshed once a day, which at
// 121 calendars is 2 per fifteen minute tick. That is the right size for a refresh
// rotation and the wrong queue to put a brand new calendar in: never attempted already
// sorts first, so it is at the head, and a wave of four still spans two ticks. Measured
// 2026-09-14, four new calendars took thirty minutes to be covered while the agents
// were already bookable and the booker was already offering their week.
//
// So a never attempted calendar is selected IN ADDITION to the batch, bounded by its
// own allowance, which is derived from the rate the watch lane can admit new calendars
// rather than picked. The lane's own budget check is what bounds the tail beyond that.
{
  const many = [
    cal("m1", hoursAgo(40)),
    cal("m2", hoursAgo(30)),
    cal("m3", hoursAgo(20)),
    cal("m4", hoursAgo(10)),
  ];
  const picked = calendarsDueForHydration([...many, cal("new", null)], NOW, 2);
  assert(picked.some((c) => c.id === "new"), "a new calendar is served on the first tick after its row exists");
  eq(
    picked.filter((c) => c.id !== "new").map((c) => c.id),
    ["m1", "m2"],
    "and the maintenance batch keeps its full size rather than giving up a slot",
  );
  eq(picked[0]?.id, "new", "onboarding is served first");
}

// The allowance is BOUNDED. A mass onboarding must not turn one tick into a run over
// the whole wave: the remainder is taken next tick, which still converges in cadences
// rather than in the fifteen hours a full rotation takes.
{
  const wave = Array.from({ length: HYDRATION_ONBOARDING_MAX + 3 }, (_, i) => cal(`n${i}`, null));
  const picked = calendarsDueForHydration(wave, NOW, 2);
  // Onboarding is served first, so the allowance is the leading slice. The three past it
  // are not dropped, they compete for ordinary maintenance slots like anything else, which
  // is why the total is the allowance plus the batch and not the allowance alone.
  eq(
    picked.slice(0, HYDRATION_ONBOARDING_MAX).length,
    HYDRATION_ONBOARDING_MAX,
    "the onboarding allowance is spent in full when there are new calendars to spend it on",
  );
  eq(
    picked.length,
    HYDRATION_ONBOARDING_MAX + 2,
    "and one tick is bounded at the allowance plus the maintenance batch, never the whole wave",
  );
}

// Derived, not chosen: the watch lane admits at most MAX_ONBOARDS_PER_TICK brand new
// agents per tick, so an allowance below that could never keep up with the lane that
// creates the rows. Asserted as arithmetic rather than left as a comment, so a change
// to either constant has to be a decision about both.
{
  assert(
    HYDRATION_ONBOARDING_MAX >= MAX_ONBOARDS_PER_TICK,
    `the onboarding allowance (${HYDRATION_ONBOARDING_MAX}) clears one watch tick's admissions (${MAX_ONBOARDS_PER_TICK})`,
  );
}

// THE control that keeps this from becoming a starvation bug. last_bootstrap_attempt_at
// is stamped BEFORE the fetch, so a calendar whose bootstrap failed is no longer never
// attempted and cannot consume the allowance on every tick forever. Without this a
// permanently failing calendar would take an onboarding slot 96 times a day.
{
  const failed = cal("failed-once", hoursAgo(0.1), { consecutive_failures: 1 });
  const wave = Array.from({ length: HYDRATION_ONBOARDING_MAX }, (_, i) => cal(`n${i}`, null));
  const picked = calendarsDueForHydration([failed, ...wave], NOW, 2);
  const allowance = picked.slice(0, HYDRATION_ONBOARDING_MAX);
  assert(
    !allowance.some((c) => c.id === "failed-once"),
    "a calendar attempted once is out of the onboarding allowance, however recently it failed",
  );
  eq(
    allowance.filter((c) => c.id.startsWith("n")).length,
    HYDRATION_ONBOARDING_MAX,
    "and the allowance is spent entirely on the genuinely new ones",
  );
}

// An UNREADABLE stamp is not the same fact as never attempted: it can be a calendar
// established for months whose stamp is corrupt. It keeps the head-of-queue maintenance
// treatment it already had (the test above pins that) and must NOT be able to crowd a
// real new calendar out of the onboarding allowance.
{
  const wave = Array.from({ length: HYDRATION_ONBOARDING_MAX }, (_, i) => cal(`n${i}`, null));
  const picked = calendarsDueForHydration([cal("garbage", "not-a-date"), ...wave], NOW, 2);
  eq(
    picked.filter((c) => c.id.startsWith("n")).length,
    HYDRATION_ONBOARDING_MAX,
    "an unreadable stamp does not consume the onboarding allowance",
  );
  assert(picked.some((c) => c.id === "garbage"), "and it is still served, out of the maintenance batch");
}

// The shared eligibility predicate still rules. A never attempted calendar belonging to
// an account established as gone is held back to its retry slot exactly as before: the
// new allowance is a queue change, never a way past the predicate that decides whether a
// calendar is worth attempting at all.
{
  const goneNew = cal("gone-new", null, { last_failure_kind: "gone", consecutive_failures: 5 });
  const picked = calendarsDueForHydration([goneNew, cal("healthy", hoursAgo(20))], NOW, 2);
  eq(
    picked.filter((c) => c.id === "gone-new").length,
    0,
    "an established-gone calendar does not enter the onboarding allowance",
  );
}

// No calendar is hydrated twice in one tick, which the two lists make possible if the
// second is not filtered against the first.
{
  const picked = calendarsDueForHydration([cal("new", null), cal("old", hoursAgo(40))], NOW, 5);
  eq(new Set(picked.map((c) => c.id)).size, picked.length, "the tick never selects one calendar twice");
}


finish();
