// The recompute headroom page and its all-clear, judged as STREAKS on both
// sides (#2021).
//
// On 2026-09-07 the lane sat at 101 to 123% of its 50s budget with 62 hot
// buckets, so it alternated two behind minutes with one caught-up minute all
// morning. The old rule paged on the SECOND behind cycle and announced recovery
// on the FIRST drained one, and the recovery wiped the two hour cooldown, so
// every flap was a fresh page: eight pages and eight all-clears in under three
// hours while no bucket ever went stale (that alarm is separate and never
// fired). L160: a condition is only over once it has stayed healthy for a
// re-arm window, never on the first healthy sample.
//
// The decision is pure and driven here through an in-memory streak store that
// mirrors the `rate_limit_hit` SQL (a FIXED window from the first hit, reset to
// one once it expires), with an injected clock, so the whole morning replays in
// a few milliseconds and nothing here waits on real time.
import {
  judgeRecomputeCycle,
  RECOMPUTE_BEHIND_CYCLES,
  RECOMPUTE_REARM_CYCLES,
  RECOMPUTE_CADENCE_MS,
  RECOMPUTE_STREAK_WINDOW_S,
  RECOMPUTE_BEHIND_STREAK_KEY,
  RECOMPUTE_DRAINED_STREAK_KEY,
  type StreakStore,
} from "../src/lib/availability/recompute-alert.ts";
import { RECOMPUTE_FRESH_MS } from "../src/lib/availability/precompute-cron.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** Mirrors rate_limit_hit: a fixed window from the first hit, reset once expired. */
function memoryStreaks(clock: { nowMs: number }) {
  const rows = new Map<string, { windowStartMs: number; count: number }>();
  const store: StreakStore = {
    async bump(key, windowSeconds, alertAt) {
      const row = rows.get(key);
      const expired = !row || row.windowStartMs < clock.nowMs - windowSeconds * 1000;
      const next = expired
        ? { windowStartMs: clock.nowMs, count: 1 }
        : { windowStartMs: row.windowStartMs, count: row.count + 1 };
      rows.set(key, next);
      // rate_limit_hit answers `count <= p_max`; the helper passes alertAt - 1 and
      // reports reached when that is false.
      return !(next.count <= alertAt - 1);
    },
    async clear(key) {
      rows.delete(key);
    },
  };
  return { store, rows };
}

/** One lane tick per minute: advance the clock, then judge. */
async function tick(drained: boolean, clock: { nowMs: number }, store: StreakStore) {
  clock.nowMs += RECOMPUTE_CADENCE_MS;
  return judgeRecomputeCycle(drained, store);
}

// --- the thresholds are derived from the freshness window, not declared beside it ---
{
  assert(
    RECOMPUTE_BEHIND_CYCLES * RECOMPUTE_CADENCE_MS > RECOMPUTE_FRESH_MS,
    `${RECOMPUTE_BEHIND_CYCLES} behind cycles outlast the ${RECOMPUTE_FRESH_MS / 60_000}min freshness window, so a lag that cannot make a bucket stale stays silent`,
  );
  assert(
    RECOMPUTE_BEHIND_CYCLES * RECOMPUTE_CADENCE_MS <= RECOMPUTE_FRESH_MS + RECOMPUTE_CADENCE_MS,
    "and only by one cycle, so the page still lands before the staleness alarm has anything to say",
  );
  eq(RECOMPUTE_REARM_CYCLES, RECOMPUTE_BEHIND_CYCLES, "the all-clear waits as long as the page did");
  assert(
    RECOMPUTE_STREAK_WINDOW_S * 1000 >= 2 * RECOMPUTE_BEHIND_CYCLES * RECOMPUTE_CADENCE_MS,
    "the streak window holds the whole behind streak twice over, so a late tick cannot split it",
  );
  assert(
    RECOMPUTE_STREAK_WINDOW_S * 1000 >= 2 * RECOMPUTE_REARM_CYCLES * RECOMPUTE_CADENCE_MS,
    "and the whole re-arm streak too",
  );
  assert(
    RECOMPUTE_BEHIND_STREAK_KEY !== RECOMPUTE_DRAINED_STREAK_KEY,
    "the two streaks live under their own keys, so one cannot reset the other by accident",
  );
}

// --- the fake mirrors the SQL: an expired window starts again at one -----------
{
  const clock = { nowMs: 1_000_000 };
  const { store } = memoryStreaks(clock);
  eq(await store.bump("k", 120, 2), false, "first hit is under a threshold of 2");
  eq(await store.bump("k", 120, 2), true, "second hit inside the window reaches it");
  clock.nowMs += 121_000;
  eq(await store.bump("k", 120, 2), false, "a hit after the window expired counts as the first again");
}

// --- this morning's pattern: two behind, one drained, over and over ---------
{
  const clock = { nowMs: 1_000_000 };
  const { store } = memoryStreaks(clock);
  let pages = 0;
  let recoveries = 0;
  // Ten repetitions is thirty minutes, longer than the screenshot's worst gap.
  for (let i = 0; i < 10; i++) {
    for (const drained of [false, false, true]) {
      const v = await tick(drained, clock, store);
      if (v.page) pages++;
      if (v.recovered) recoveries++;
    }
  }
  eq(pages, 0, "a lane wobbling at its budget edge, two behind then one caught up, never pages");
  eq(recoveries, 0, "and never announces a recovery either, because nothing was ever paged");
}

// --- a sustained fall-behind pages exactly once it outlasts the freshness window ---
{
  const clock = { nowMs: 1_000_000 };
  const { store } = memoryStreaks(clock);
  const verdicts: boolean[] = [];
  for (let i = 0; i < RECOMPUTE_BEHIND_CYCLES; i++) verdicts.push((await tick(false, clock, store)).page);
  eq(
    verdicts.slice(0, -1).every((p) => !p),
    true,
    `the first ${RECOMPUTE_BEHIND_CYCLES - 1} behind cycles stay silent`,
  );
  eq(verdicts.at(-1), true, `the ${RECOMPUTE_BEHIND_CYCLES}th consecutive behind cycle pages`);
  eq((await tick(false, clock, store)).page, true, "and every behind cycle after it keeps reporting (the cooldown throttles the repeats)");
  eq((await tick(false, clock, store)).recovered, false, "a behind cycle never reports a recovery");
}

// --- one drained cycle in the middle resets the behind count -------------------
{
  const clock = { nowMs: 1_000_000 };
  const { store } = memoryStreaks(clock);
  for (let i = 0; i < RECOMPUTE_BEHIND_CYCLES - 1; i++) await tick(false, clock, store);
  await tick(true, clock, store);
  for (let i = 0; i < RECOMPUTE_BEHIND_CYCLES - 1; i++) {
    eq((await tick(false, clock, store)).page, false, `behind cycle ${i + 1} after a caught-up one is counted from scratch`);
  }
  eq((await tick(false, clock, store)).page, true, "and the full streak has to build again before it pages");
}

// --- the all-clear waits for the re-arm window ------------------------------------
{
  const clock = { nowMs: 1_000_000 };
  const { store } = memoryStreaks(clock);
  for (let i = 0; i < RECOMPUTE_BEHIND_CYCLES; i++) await tick(false, clock, store);
  // Firing. One caught-up cycle is the flap the page exists to survive.
  eq((await tick(true, clock, store)).recovered, false, "the first caught-up cycle after a page does not announce recovery");
  eq((await tick(false, clock, store)).recovered, false, "a relapse announces nothing");
  // Re-arm window minus one, then a relapse: the count starts over.
  for (let i = 0; i < RECOMPUTE_REARM_CYCLES - 1; i++) {
    eq((await tick(true, clock, store)).recovered, false, `caught-up cycle ${i + 1} of ${RECOMPUTE_REARM_CYCLES} is not yet a recovery`);
  }
  eq((await tick(false, clock, store)).recovered, false, "a relapse one short of the window resets it");
  for (let i = 0; i < RECOMPUTE_REARM_CYCLES - 1; i++) await tick(true, clock, store);
  const v = await tick(true, clock, store);
  eq(v.recovered, true, `the ${RECOMPUTE_REARM_CYCLES}th consecutive caught-up cycle announces the recovery`);
  eq(v.page, false, "and a caught-up cycle never pages");
}

// --- a relapse during the re-arm window is NOT a fresh page by itself -----------
{
  const clock = { nowMs: 1_000_000 };
  const { store } = memoryStreaks(clock);
  for (let i = 0; i < RECOMPUTE_BEHIND_CYCLES; i++) await tick(false, clock, store);
  await tick(true, clock, store);
  await tick(true, clock, store);
  eq((await tick(false, clock, store)).page, false, "one behind cycle after two caught-up ones is a wobble, not a second incident");
}

// --- the store failing keeps BOTH sides quiet ----------------------------------------
{
  const dead: StreakStore = {
    // recordConsecutiveStreak answers false on a tracking error: never invent a streak.
    async bump() {
      return false;
    },
    async clear() {},
  };
  const behind = await judgeRecomputeCycle(false, dead);
  eq(behind.page, false, "an unreadable behind streak never pages");
  eq(behind.recovered, false, "and never recovers");
  const drained = await judgeRecomputeCycle(true, dead);
  eq(drained.recovered, false, "an unreadable re-arm streak never announces an all-clear it cannot prove");
  eq(drained.page, false, "and a caught-up cycle still never pages");
}

// --- each side resets the OTHER streak, under the right key ------------------------
{
  const clock = { nowMs: 1_000_000 };
  const { store, rows } = memoryStreaks(clock);
  await tick(false, clock, store);
  assert(rows.has(RECOMPUTE_BEHIND_STREAK_KEY), "a behind cycle bumps the behind streak");
  assert(!rows.has(RECOMPUTE_DRAINED_STREAK_KEY), "and clears the re-arm streak");
  await tick(true, clock, store);
  assert(rows.has(RECOMPUTE_DRAINED_STREAK_KEY), "a caught-up cycle bumps the re-arm streak");
  assert(!rows.has(RECOMPUTE_BEHIND_STREAK_KEY), "and clears the behind streak");
}

finish();
