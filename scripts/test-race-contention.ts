// #2838: confirms losing the overlap race (#2274), counted once a day and
// whispered when the share of confirms that lost one is above what ordinary
// traffic can produce. Since #2281 a lost race is handed to the next free advisor
// in the same rung, up to MAX_RACE_REASSIGNS, and nothing counted it anywhere a
// person would read.
//
// #2867: a cross bucket move rescued after a lost race records its own row, so
// the verdict counts it as a confirm AND a loser without a `created` behind it.
// #2877: the threshold is derived from the busiest tier Slate actually carries,
// measured from its own bookings, and falls back to the Low constant out loud.
//
// Run: node --experimental-strip-types scripts/test-race-contention.ts
import {
  FALLBACK_RACE_MIN_CONFIRMS,
  FALLBACK_RACE_SHARE_THRESHOLD,
  MEASURED_CONFIRM_P95_MS,
  MEASURED_TIER_LEADS_PER_HOUR,
  RACE_BOUND_HIT_ALERT_KEY,
  RACE_BOUND_HIT_COOLDOWN_MS,
  RACE_CONTENTION_COOLDOWN_MS,
  RACE_CONTENTION_NOTICE_KEY,
  RACE_MIN_LOSERS,
  RACE_RATE_LOOKBACK_DAYS,
  RACE_RATE_MIN_ACTIVE_HOURS,
  RACE_SATURATION_SHARE,
  RACE_TALLY_OUTCOMES,
  fallbackRaceThreshold,
  createRaceThresholdCache,
  judgeRaceContention,
  measuredRaceThreshold,
  raceBoundHitPage,
  raceBoundHitPageText,
  raceContentionNoticeText,
  raceContentionVerdict,
  raceOutcomeForBooking,
  raceOutcomeForConfirm,
  raceOutcomeForMove,
  raceOutcomeForRefusal,
  raceRateWindow,
  raceThresholdFor,
  raceThresholdForRate,
  raceThresholdNeeded,
  raceWindowFromMix,
  type RaceContentionWindow,
  type RaceThreshold,
  type TierBooking,
} from "../src/lib/monitor/race-contention.ts";
import { OUTCOME_ORDER, SELF_INFLICTED_REFUSALS, normalizeMix } from "../src/lib/monitor/booking-api-outcome.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const HOUR = 3_600_000;

// --- the keys and cooldowns ---------------------------------------------------
eq(RACE_CONTENTION_NOTICE_KEY, "booking_race_contention", "one constant for the whisper key");
eq(RACE_BOUND_HIT_ALERT_KEY, "booking_race_bound_hit", "one constant for the bound hit key");
assert(RACE_CONTENTION_NOTICE_KEY !== RACE_BOUND_HIT_ALERT_KEY, "the two treatments throttle apart");
eq(RACE_CONTENTION_COOLDOWN_MS, 24 * 60 * 60 * 1000, "the whisper speaks at most once a day, the window it reads");
assert(
  RACE_BOUND_HIT_COOLDOWN_MS > 0 && RACE_BOUND_HIT_COOLDOWN_MS <= 60 * 60 * 1000,
  "a burst of bound hits sends one page, and a later burst is not held back a whole day",
);

// --- the threshold is DERIVED from a measured rate, never typed ----------------
{
  const derived = (MEASURED_TIER_LEADS_PER_HOUR / 3_600_000) * MEASURED_CONFIRM_P95_MS;
  eq(FALLBACK_RACE_SHARE_THRESHOLD, derived, "the fallback share is the measured Low lead rate times the measured race window");
  assert(
    FALLBACK_RACE_SHARE_THRESHOLD > 0.01 && FALLBACK_RACE_SHARE_THRESHOLD < 0.03,
    `the fallback share is about 1.8% (got ${FALLBACK_RACE_SHARE_THRESHOLD})`,
  );
  eq(FALLBACK_RACE_MIN_CONFIRMS, Math.ceil(1 / FALLBACK_RACE_SHARE_THRESHOLD), "the floor is where one coincidence stops carrying the share alone");
  assert(RACE_MIN_LOSERS >= 2, "one lost race can never report on its own");
  const t = raceThresholdForRate(58);
  eq(t.share, (58 / 3_600_000) * MEASURED_CONFIRM_P95_MS, "any rate becomes a share through the same race window");
  eq(t.minConfirms, Math.ceil(1 / t.share), "and its floor through the same rule");
}

// --- the tally names stay out of the failure share -----------------------------
{
  assert((RACE_TALLY_OUTCOMES as readonly string[]).includes("race_reassigned_move"), "#2867: a rescued move has its own row");
  for (const name of RACE_TALLY_OUTCOMES) {
    assert(!(OUTCOME_ORDER as readonly string[]).includes(name), `${name} is not an outcome the failure share divides by`);
    assert(!(SELF_INFLICTED_REFUSALS as readonly string[]).includes(name), `${name} is not a self inflicted refusal`);
  }
  // Positive control: the real normalizer leaves the total untouched by them.
  const mix = normalizeMix({
    by_outcome: { created: 10, error: 2, race_reassigned: 3, race_reassigned_move: 2, race_refused: 1, race_refused_bound: 1 },
  });
  eq(mix.total, 12, "a race tally row never enters the denominator of the failure share");
}

// --- which tally row a confirm records ------------------------------------------
eq(raceOutcomeForBooking(null), null, "no trace, nothing extra recorded");
eq(raceOutcomeForBooking({}), null, "an uncontested booking records nothing extra");
eq(raceOutcomeForBooking({ race_lost: [] }), null, "an empty loss list is not a race");
eq(raceOutcomeForBooking({ race_lost: ["a"] }), "race_reassigned", "a booking that lost first and was handed on");
eq(raceOutcomeForRefusal({ boundHit: false }), "race_refused", "refused with nobody left free after the loser");
eq(raceOutcomeForRefusal({ boundHit: true }), "race_refused_bound", "refused at the reassign bound");
{
  const raced = { booking: { routing_trace: { race_lost: ["a"] } }, newlyInserted: true as const };
  eq(raceOutcomeForConfirm(raced), "race_reassigned", "a create arm rescue counts against its own created row");
  eq(raceOutcomeForMove(raced), "race_reassigned_move", "#2867: a rescued move, whose outcome row is never created, has its own row");
  eq(raceOutcomeForMove({ booking: raced.booking }), null, "a replayed move counted nothing new");
  eq(raceOutcomeForMove({ booking: { routing_trace: {} }, newlyInserted: true }), null, "an uncontested move records nothing extra");
}

// --- reading the mix -------------------------------------------------------------
eq(raceWindowFromMix(null, "2026-09-28"), null, "no mix is not a quiet day");
eq(raceWindowFromMix({ by_outcome: null }, "2026-09-28"), null, "a mix with no outcome map could not be read");
eq(
  raceWindowFromMix({ by_outcome: { created: 40, race_reassigned: 2, race_refused: 1 } }, "2026-09-28"),
  { day: "2026-09-28", created: 40, reassigned: 2, reassignedMoves: 0, refused: 1, refusedAtBound: 0 },
  "absent keys are zero rows, present ones are read",
);
eq(
  raceWindowFromMix({ by_outcome: { created: 40, race_reassigned_move: 3 } }, "2026-09-28"),
  { day: "2026-09-28", created: 40, reassigned: 0, reassignedMoves: 3, refused: 0, refusedAtBound: 0 },
  "#2867: a rescued move is read from its own key",
);
eq(
  raceWindowFromMix({ by_outcome: { created: "40" as unknown as number } }, "2026-09-28"),
  null,
  "a count that is not a number is a broken read, not a zero",
);
eq(
  raceWindowFromMix({ by_outcome: { created: 4, race_reassigned_move: "x" as unknown as number } }, "2026-09-28"),
  null,
  "a rescued move count that is not a number is a broken read too",
);

// --- the verdict, against the fallback threshold ------------------------------------
const w = (o: Partial<RaceContentionWindow>): RaceContentionWindow => ({
  day: "2026-09-28", created: 0, reassigned: 0, reassignedMoves: 0, refused: 0, refusedAtBound: 0, ...o,
});
const FB: RaceThreshold = fallbackRaceThreshold("a fixture");
const verdict = (win: RaceContentionWindow | null) => raceContentionVerdict(win, FB);

eq(verdict(null).kind, "unmeasured", "an unreadable tally is unmeasured");
{
  const v = verdict(w({}));
  eq(v.kind, "unmeasured", "zero confirms is unmeasured, never quiet (L98)");
}
{
  const v = verdict(w({ created: 20, reassigned: 2 }));
  eq(v.kind, "unmeasured", `a thin sample below ${FALLBACK_RACE_MIN_CONFIRMS} confirms is unmeasured rather than alarming`);
  assert(v.kind === "unmeasured" && v.reason.includes(String(FALLBACK_RACE_MIN_CONFIRMS)), "the thin reason names the floor");
  assert(v.kind === "unmeasured" && v.reason.includes("a fixture"), "and says the floor came from the fallback, and why");
}
eq(
  verdict(w({ created: 3, reassigned: 4 })).kind,
  "unmeasured",
  "more reassigned bookings than bookings is a broken read, not a very high rate",
);
eq(verdict(w({ created: 200 })).kind, "quiet", "measured, and nobody lost a race");
{
  const v = verdict(w({ created: 200 }));
  assert(v.kind === "quiet" && v.threshold === FB, "a quiet verdict carries the threshold it was judged against");
}
eq(
  verdict(w({ created: 200, reassigned: 2 })).kind,
  "quiet",
  "two losers is ordinary coincidence however the share falls",
);
{
  // 3 of 203 is 1.5%, under the derived share.
  const v = verdict(w({ created: 200, reassigned: 2, refused: 1 }));
  eq(v.kind, "quiet", "at or above the loser floor and under the share stays quiet");
}
{
  // 6 of 202 is 3.0%, over.
  const v = verdict(w({ created: 200, reassigned: 4, refused: 1, refusedAtBound: 1 }));
  eq(v.kind, "report", "over the derived share with enough losers reports");
  if (v.kind === "report") {
    eq(v.confirms, 202, "the denominator is bookings made plus confirms refused after a race");
    eq(v.losers, 6, "the numerator is every confirm that lost at least one race");
    eq(v.trigger, "rate", "which rule fired");
  }
}
{
  // Saturation under the floor: 4 of 6 lost. A proportion floor must not hide this (L139).
  const v = verdict(w({ created: 4, reassigned: 2, refused: 2 }));
  eq(v.kind, "report", "half or more losing is reported below the floor");
  if (v.kind === "report") eq(v.trigger, "saturation", "and says it was saturation");
  assert(RACE_SATURATION_SHARE >= 0.5, "saturation means at least half");
}
eq(
  verdict(w({ created: 1, refused: 1 })).kind,
  "unmeasured",
  "saturation still needs the loser floor, so one unlucky pair is not a report",
);

// --- #2867: a day mixing rescued moves with creates ----------------------------------
{
  // 100 bookings made on the create arm (2 of them rescued), and 5 cross bucket
  // moves rescued after a lost race, whose outcome rows are `rescheduled` or
  // `deduped` and never `created`. Every move is a confirm AND a loser.
  const v = verdict(w({ created: 100, reassigned: 2, reassignedMoves: 5 }));
  eq(v.kind, "report", "7 of 105 losing is over the share");
  if (v.kind === "report") {
    eq(v.confirms, 105, "a rescued move is a confirm, though it made no created row");
    eq(v.losers, 7, "and a loser");
  }
}
{
  // More rescued moves than creates is ordinary, not a broken read: the invariant
  // belongs to the create arm alone.
  const v = verdict(w({ created: 3, reassigned: 1, reassignedMoves: 4 }));
  assert(v.kind !== "unmeasured" || !/cannot be right/.test(v.reason), "rescued moves never trip the created invariant");
  eq(v.kind, "report", "5 of 7 losing is saturation");
  if (v.kind === "report") eq(v.confirms, 7, "3 created plus 4 moves");
}
eq(
  verdict(w({ created: 2, reassigned: 3, reassignedMoves: 10 })).kind,
  "unmeasured",
  "the create arm's own invariant still holds when moves are present",
);
{
  const v = verdict(w({ created: 200, reassigned: 2, reassignedMoves: 3, refused: 1 }));
  if (v.kind !== "report") throw new Error("fixture");
  const text = raceContentionNoticeText(v);
  assert(text.includes("5 were booked with the next free advisor"), "the copy counts rescued moves among those rebooked");
  assert(!/same bucket/.test(text), "and does not claim a cross bucket move stayed in the same bucket");
}

// --- whether the verdict needs a measured threshold at all ---------------------------
eq(raceThresholdNeeded(null), false, "an unreadable tally needs no threshold");
eq(raceThresholdNeeded(w({ created: 200, reassigned: 2 })), false, "below the loser floor nothing can report, so nothing is read");
eq(raceThresholdNeeded(w({ created: 200, reassigned: 2, reassignedMoves: 1 })), true, "three losers, a rescued move among them, need it");
eq(raceThresholdNeeded(w({ created: 4, reassigned: 2, refused: 2 })), false, "saturation reports whatever the threshold");
eq(raceThresholdNeeded(w({ created: 3, reassigned: 4 })), false, "a broken read needs none");

// --- the lane's one call: read the bookings only when the verdict needs them --------
{
  let reads = 0;
  const reader = (rows: TierBooking[]) => async () => {
    reads++;
    return rows;
  };
  const NOW_A = Date.UTC(2026, 8, 29, 16, 30, 0);
  const t0 = await raceThresholdFor(w({ created: 200, reassigned: 2 }), reader([]), NOW_A);
  eq(reads, 0, "a day that cannot report reads no bookings");
  assert(t0.basis.source === "fallback" && /not measured/.test(t0.basis.reason), "and says the rate was not measured, and why");
  await raceThresholdFor(null, reader([]), NOW_A);
  eq(reads, 0, "nor does an unreadable tally");
  const t1 = await raceThresholdFor(w({ created: 200, reassigned: 4 }), reader([]), NOW_A);
  eq(reads, 1, "a day that can turn on the threshold reads them once");
  eq(t1.basis.source, "fallback", "and an empty fortnight falls back");
  let threw = false;
  try {
    await raceThresholdFor(w({ created: 200, reassigned: 4 }), async () => {
      throw new Error("read failed");
    }, NOW_A);
  } catch (e) {
    threw = e instanceof Error && e.message === "read failed";
  }
  assert(threw, "a failed read reaches the step boundary, never a silent fallback");
}

// --- PR #2883: at most one bookings read per whisper decision ------------------------
{
  const NOW_B = Date.UTC(2026, 8, 29, 16, 30, 0);
  const counting = () => {
    const c = { reads: 0, dueAsks: 0 };
    return {
      c,
      deps: (due: boolean, cache = createRaceThresholdCache()) => ({
        cache,
        readBookings: async () => {
          c.reads++;
          return [] as TierBooking[];
        },
        whisperDue: async () => {
          c.dueAsks++;
          return due;
        },
      }),
    };
  };
  const needed = w({ created: 200, reassigned: 4 });
  assert(raceThresholdNeeded(needed), "fixture: a day that can turn on the threshold");

  {
    const { c, deps } = counting();
    const r = await judgeRaceContention(needed, NOW_B, deps(false));
    eq(c.reads, 0, "the whisper already went out today: the next tick reads no bookings");
    eq(r.kind, "cooling-down", "and says it skipped the day because the whisper is cooling down");
  }
  {
    const { c, deps } = counting();
    const r = await judgeRaceContention(needed, NOW_B, deps(true));
    eq(c.reads, 1, "the whisper has not gone out: the day reads the bookings once");
    assert(r.kind === "judged" && r.threshold.basis.source === "fallback", "and judges against what it read");
  }
  {
    const { c, deps } = counting();
    const r = await judgeRaceContention(w({ created: 200, reassigned: 2 }), NOW_B, deps(true));
    eq(c.dueAsks, 0, "a day that cannot report does not even ask about the cooldown");
    eq(c.reads, 0, "nor read bookings");
    assert(r.kind === "judged" && r.verdict.kind === "quiet", "and is still judged");
  }
  {
    const { c, deps } = counting();
    const r = await judgeRaceContention(w({ created: 4, reassigned: 2, refused: 2 }), NOW_B, deps(true));
    eq(c.reads, 0, "a saturated day reports without the bookings");
    assert(r.kind === "judged" && r.verdict.kind === "report", "and reports");
  }
  {
    let threw = false;
    try {
      await judgeRaceContention(needed, NOW_B, {
        readBookings: async () => {
          throw new Error("read failed");
        },
        whisperDue: async () => true,
        cache: createRaceThresholdCache(),
      });
    } catch (e) {
      threw = e instanceof Error && e.message === "read failed";
    }
    assert(threw, "a failed bookings read still fails loud through the step boundary");
  }
  {
    // A qualifying day that stays under the share never sends, so the cooldown
    // never starts: the threshold must be measured once for the day, not per tick.
    const cache = createRaceThresholdCache();
    const { c, deps } = counting();
    const r1 = await judgeRaceContention(needed, NOW_B, deps(true, cache));
    const r2 = await judgeRaceContention(needed, NOW_B + 5 * 60_000, deps(true, cache));
    eq(c.reads, 1, "two ticks on the same qualifying quiet day make one bookings read");
    assert(r1.kind === "judged" && r2.kind === "judged" && r2.threshold === r1.threshold, "and judge against the same threshold");
    await judgeRaceContention({ ...needed, day: "2026-09-30" }, NOW_B + 86_400_000, deps(true, cache));
    eq(c.reads, 2, "the next Eastern day measures again");
  }
  {
    // A failed read caches nothing, so the next tick tries again rather than
    // judging on a threshold nobody measured.
    const cache = createRaceThresholdCache();
    let reads = 0;
    const failing = {
      cache,
      whisperDue: async () => true,
      readBookings: async (): Promise<TierBooking[]> => {
        reads++;
        throw new Error("read failed");
      },
    };
    for (let i = 0; i < 2; i++) {
      try {
        await judgeRaceContention(needed, NOW_B, failing);
      } catch {
        // expected
      }
    }
    eq(reads, 2, "a failed read is retried next tick, never remembered");
  }
}

// --- the lookback is clipped at BOTH ends, on whole hours -------------------------
{
  const NOW_C = Date.UTC(2026, 8, 29, 16, 30, 0);
  const win = raceRateWindow(NOW_C);
  eq(win.untilMs, Date.UTC(2026, 8, 29, 16, 0, 0), "the window ends where the hour still under way begins");
  eq(win.sinceMs % 3_600_000, 0, "and starts on a whole hour");
  eq(win.untilMs - win.sinceMs, RACE_RATE_LOOKBACK_DAYS * 86_400_000, "and spans exactly the lookback");

  // 25 hours of one tier: 12 hours of 3 and 13 of 5, the oldest being a 5 whose
  // bookings sit at minutes 0 to 50. Read from exactly now minus 14 days (16:30),
  // the oldest hour keeps only its last two and drags the median to 3.
  const rows: TierBooking[] = [];
  for (let h = 0; h < 25; h++) {
    const hourStart = win.sinceMs + h * 3_600_000;
    const n = h === 0 || h > 12 ? 5 : 3;
    for (let i = 0; i < n; i++) rows.push({ createdMs: hourStart + i * 10 * 60_000, bucketCode: "111" });
  }
  const read = (since: number, until: number) => rows.filter((r) => r.createdMs >= since && r.createdMs < until);
  const partial = measuredRaceThreshold(read(NOW_C - RACE_RATE_LOOKBACK_DAYS * 86_400_000, NOW_C), NOW_C);
  const whole = measuredRaceThreshold(read(win.sinceMs, win.untilMs), NOW_C);
  eq(partial.perHour, 3, "control: a read starting mid hour counts a partial hour and moves the median");
  eq(whole.perHour, 5, "the whole hour window measures the median the traffic really had");
}

// --- #2877: the threshold measured from Slate's own bookings ------------------------
const NOW = Date.UTC(2026, 8, 29, 16, 30, 0);
/** `perHour` bookings in each of `hours` whole hours ending before the current one. */
function traffic(code: string, perHour: number, hours: number, startHoursAgo = 1): TierBooking[] {
  const out: TierBooking[] = [];
  const currentHour = Math.floor(NOW / HOUR) * HOUR;
  for (let h = 0; h < hours; h++) {
    const hourStart = currentHour - (startHoursAgo + h) * HOUR;
    for (let i = 0; i < perHour; i++) out.push({ createdMs: hourStart + i * 1000, bucketCode: code });
  }
  return out;
}
{
  eq(RACE_RATE_LOOKBACK_DAYS, 14, "the lookback matches the #2484 measurement it replaces");
  assert(RACE_RATE_MIN_ACTIVE_HOURS >= 12, "a median needs enough separate hours to not be one burst");

  const t = measuredRaceThreshold([...traffic("111", 6, 30), ...traffic("412", 2, 30)], NOW);
  eq(t.basis.source, "measured", "enough hours of real bookings are measured");
  if (t.basis.source === "measured") {
    eq(t.basis.tier, "1", "the busiest tier is the one with the higher median hour");
    eq(t.basis.tierLabel, "Low", "named in words");
    eq(t.basis.activeHours, 30, "counted over the hours that held a booking");
    eq(t.basis.bookings, 180, "and says how many bookings it rests on");
  }
  eq(t.perHour, 6, "the median busy hour of the busiest tier");
  eq(t.share, raceThresholdForRate(6).share, "the share comes from the measured rate");

  // Widening: another tier overtakes Low, and nobody edits a constant.
  const wide = measuredRaceThreshold([...traffic("111", 6, 30), ...traffic("512", 40, 30)], NOW);
  eq(wide.perHour, 40, "the threshold follows the busiest tier, whichever it is");
  assert(wide.basis.source === "measured" && wide.basis.tierLabel === "Ultra High", "and names it");
  assert(wide.share > t.share, "busier traffic tolerates a higher share");

  // A tier with a high median but too few hours is noise, not the busiest tier.
  const burst = measuredRaceThreshold([...traffic("111", 6, 30), ...traffic("311", 50, 3)], NOW);
  eq(burst.perHour, 6, "a tier below the hour floor is not judged the busiest");

  // Hours with no booking are not counted, so nights do not halve the rate.
  const sparse = measuredRaceThreshold([...traffic("111", 4, 15, 1), ...traffic("111", 4, 15, 40)], NOW);
  eq(sparse.perHour, 4, "empty hours are not zeros in the median");
}
{
  // Too few to measure: the fallback, and it SAYS so.
  const none = measuredRaceThreshold([], NOW);
  eq(none.basis.source, "fallback", "no bookings at all falls back");
  eq(none.share, FALLBACK_RACE_SHARE_THRESHOLD, "to the measured Low constant");
  assert(none.basis.source === "fallback" && /no routed bookings/.test(none.basis.reason), "and says there were none");

  const thin = measuredRaceThreshold(traffic("111", 9, RACE_RATE_MIN_ACTIVE_HOURS - 1), NOW);
  eq(thin.basis.source, "fallback", "one hour short of the floor falls back");
  assert(
    thin.basis.source === "fallback" &&
      thin.basis.reason.includes(String(RACE_RATE_MIN_ACTIVE_HOURS - 1)) &&
      thin.basis.reason.includes(String(RACE_RATE_MIN_ACTIVE_HOURS)),
    "naming how many hours it had and how many it needs",
  );
  eq(
    measuredRaceThreshold(traffic("111", 9, RACE_RATE_MIN_ACTIVE_HOURS), NOW).basis.source,
    "measured",
    "at the floor it measures",
  );
}
{
  // The clock is injected, and it bounds both ends.
  const current = Math.floor(NOW / HOUR) * HOUR;
  const inCurrentHour: TierBooking[] = Array.from({ length: 50 }, (_, i) => ({ createdMs: current + i, bucketCode: "111" }));
  const t = measuredRaceThreshold([...traffic("111", 5, 30), ...inCurrentHour], NOW);
  eq(t.perHour, 5, "the hour still under way is not judged (L696)");
  eq(t.basis.source === "measured" ? t.basis.activeHours : -1, 30, "and is not counted as an active hour");

  const old = traffic("111", 20, 30, RACE_RATE_LOOKBACK_DAYS * 24 + 1);
  eq(measuredRaceThreshold(old, NOW).basis.source, "fallback", "bookings older than the lookback are not read as today's traffic");
  // The same rows read from a clock a lookback earlier are measured, so the
  // window moves with the clock handed in rather than the machine's own.
  eq(
    measuredRaceThreshold(old, NOW - RACE_RATE_LOOKBACK_DAYS * 24 * HOUR).basis.source,
    "measured",
    "the window is the injected clock's",
  );
}
{
  // Codes that name no tier, and unreadable stamps, are left out rather than guessed.
  const junk: TierBooking[] = [
    ...traffic("ABC", 30, 30),
    ...traffic("", 30, 30),
    ...Array.from({ length: 30 }, () => ({ createdMs: Number.NaN, bucketCode: "111" })),
    ...traffic("111", 3, 30),
  ];
  const t = measuredRaceThreshold(junk, NOW);
  eq(t.perHour, 3, "only codes whose first digit is a tier are counted");
  assert(t.basis.source === "measured" && t.basis.bookings === 90, "and unreadable stamps are not counted");
}

// --- the verdict names what it was judged against -------------------------------
{
  const measured = measuredRaceThreshold(traffic("111", 58, 30), NOW);
  const v = raceContentionVerdict(w({ created: 200, reassigned: 4, refused: 1, refusedAtBound: 1 }), measured);
  // At 58 an hour the share is about 3.7%, so 6 of 202 (3.0%) is quiet.
  eq(v.kind, "quiet", "the same day is judged against the measured share, not the constant");
  const thin = measuredRaceThreshold(traffic("111", 2, 30), NOW);
  const floor = raceContentionVerdict(w({ created: 200, reassigned: 3 }), thin);
  eq(floor.kind, "unmeasured", "a lower measured rate raises the confirm floor with it");
  assert(floor.kind === "unmeasured" && floor.reason.includes(String(thin.minConfirms)), "and names the floor it used");
}

// --- the copy --------------------------------------------------------------------
{
  const v = verdict(w({ created: 200, reassigned: 4, refused: 1, refusedAtBound: 1 }));
  if (v.kind !== "report") throw new Error("fixture");
  const text = raceContentionNoticeText(v);
  assert(text.includes("6 of 202"), "names the count and the denominator");
  assert(text.includes("3.0%"), "names the share");
  assert(text.includes("1.8%"), "names the threshold it is judged against");
  assert(text.includes("a fixture"), "a fallback threshold says why it was used");
  assert(text.includes("4 were booked with the next free advisor"), "says how many were rescued");
  assert(text.includes("2 were refused"), "says how many leads were turned away");
  assert(text.includes("1 of them"), "separates the bound hits");
  assert(/race_lost/.test(text), "points at where the rescued ones are recorded");
  assert(text.includes("tag=booking"), "and at where the refused ones are, since they made no booking");
  assert(/What to do/.test(text), "names what a reader should do");
  assert(!/[\u2014\u2013]/.test(text), "no dashes");
  assert(!/undefined|NaN|null/.test(text), "no leaked values");
}
{
  const measured = measuredRaceThreshold(traffic("111", 6, 30), NOW);
  const v = raceContentionVerdict(w({ created: 400, reassigned: 6 }), measured);
  if (v.kind !== "report") throw new Error(`fixture (${v.kind})`);
  const text = raceContentionNoticeText(v);
  assert(text.includes("Low"), "a measured threshold names the tier it came from");
  assert(text.includes("6 bookings an hour"), "and its rate");
  assert(text.includes(`${RACE_RATE_LOOKBACK_DAYS} days`), "and the window it was measured over");
  assert(!/fallback/.test(text), "and does not call itself a fallback");
  const one = raceContentionVerdict(w({ created: 400, reassigned: 1, reassignedMoves: 0, refused: 1, refusedAtBound: 1 }), measured);
  if (one.kind !== "report") throw new Error(`fixture (${one.kind})`);
  const oneText = raceContentionNoticeText(one);
  assert(oneText.includes("1 was booked with the next free advisor"), "one rescued reads in the singular");
  assert(oneText.includes("2 were refused"), "two refused in the plural");
  const soleRefusal = raceContentionVerdict(w({ created: 400, reassigned: 2, refused: 1 }), measured);
  if (soleRefusal.kind !== "report") throw new Error(`fixture (${soleRefusal.kind})`);
  assert(raceContentionNoticeText(soleRefusal).includes("1 was refused"), "one refused reads in the singular");
  assert(!/[\u2014\u2013]/.test(text), "no dashes");
  assert(!/undefined|NaN|null/.test(text), "no leaked values");
}
{
  const v = verdict(w({ created: 200, reassigned: 5, refused: 0 }));
  if (v.kind !== "report") throw new Error("fixture");
  const text = raceContentionNoticeText(v);
  assert(text.includes("None were refused"), "a day where every loser was rescued says so rather than '0 were refused'");
  assert(!text.includes("The refused ones"), "and does not then point at refusals that did not happen");
}
{
  const text = raceBoundHitPageText({ bucketCode: "311", startIso: "2026-09-28T18:00:00.000Z", lostRaces: 4 });
  assert(text.includes("311"), "the page names the bucket");
  assert(text.includes("2026-09-28 18:00 UTC"), "and the time, readably");
  assert(text.includes("4 advisors"), "and how many were tried");
  assert(/What to do/.test(text), "names what a reader should do");
  assert(!/[\u2014\u2013]/.test(text), "no dashes in the page");
  const raw = raceBoundHitPageText({ bucketCode: "311", startIso: "not a time", lostRaces: 4 });
  assert(raw.includes("not a time"), "an unreadable time is shown as given rather than as Invalid Date");
}

// --- whether the confirm path pages a refusal ---------------------------------
{
  const base = { boundHit: true, isTest: false, loadtest: false, bucketCode: "311", startIso: "2026-09-28T18:00:00.000Z", lostRaces: 4 };
  const page = raceBoundHitPage(base);
  assert(page !== null, "a real lead refused at the bound is paged");
  if (page) {
    eq(page.key, RACE_BOUND_HIT_ALERT_KEY, "on the bound hit key, never the whisper's");
    eq(page.cooldownMs, RACE_BOUND_HIT_COOLDOWN_MS, "on its own cooldown");
    eq(page.text, raceBoundHitPageText(base), "with the copy the preview renders");
  }
  eq(raceBoundHitPage({ ...base, boundHit: false }), null, "a refusal below the bound is counted, not paged");
  eq(raceBoundHitPage({ ...base, isTest: true }), null, "the smoke canary's buckets never page");
  eq(raceBoundHitPage({ ...base, loadtest: true }), null, "a load run's deliberate burst never pages");
}

finish();
