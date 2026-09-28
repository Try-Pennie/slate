// #2838: confirms losing the overlap race (#2274), counted once a day and
// whispered when the share of confirms that lost one is above what ordinary
// traffic can produce. Since #2281 a lost race is handed to the next free advisor
// in the same rung, up to MAX_RACE_REASSIGNS, and nothing counted it anywhere a
// person would read.
//
// Run: node --experimental-strip-types scripts/test-race-contention.ts
import {
  MEASURED_CONFIRM_P95_MS,
  MEASURED_TIER_LEADS_PER_HOUR,
  RACE_BOUND_HIT_ALERT_KEY,
  RACE_BOUND_HIT_COOLDOWN_MS,
  RACE_CONTENTION_COOLDOWN_MS,
  RACE_CONTENTION_NOTICE_KEY,
  RACE_MIN_CONFIRMS,
  RACE_MIN_LOSERS,
  RACE_SATURATION_SHARE,
  RACE_SHARE_THRESHOLD,
  RACE_TALLY_OUTCOMES,
  raceBoundHitPage,
  raceBoundHitPageText,
  raceContentionNoticeText,
  raceContentionVerdict,
  raceOutcomeForBooking,
  raceOutcomeForRefusal,
  raceWindowFromMix,
  type RaceContentionWindow,
} from "../src/lib/monitor/race-contention.ts";
import { OUTCOME_ORDER, SELF_INFLICTED_REFUSALS, normalizeMix } from "../src/lib/monitor/booking-api-outcome.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- the keys and cooldowns ---------------------------------------------------
eq(RACE_CONTENTION_NOTICE_KEY, "booking_race_contention", "one constant for the whisper key");
eq(RACE_BOUND_HIT_ALERT_KEY, "booking_race_bound_hit", "one constant for the bound hit key");
assert(RACE_CONTENTION_NOTICE_KEY !== RACE_BOUND_HIT_ALERT_KEY, "the two treatments throttle apart");
eq(RACE_CONTENTION_COOLDOWN_MS, 24 * 60 * 60 * 1000, "the whisper speaks at most once a day, the window it reads");
assert(
  RACE_BOUND_HIT_COOLDOWN_MS > 0 && RACE_BOUND_HIT_COOLDOWN_MS <= 60 * 60 * 1000,
  "a burst of bound hits sends one page, and a later burst is not held back a whole day",
);

// --- the threshold is DERIVED from measured volume, never typed ----------------
{
  const derived = (MEASURED_TIER_LEADS_PER_HOUR / 3_600_000) * MEASURED_CONFIRM_P95_MS;
  eq(RACE_SHARE_THRESHOLD, derived, "the share is the measured arrival rate times the measured race window");
  assert(RACE_SHARE_THRESHOLD > 0.01 && RACE_SHARE_THRESHOLD < 0.03, `the derived share is about 1.8% (got ${RACE_SHARE_THRESHOLD})`);
  eq(RACE_MIN_CONFIRMS, Math.ceil(1 / RACE_SHARE_THRESHOLD), "the floor is where one coincidence stops carrying the share alone");
  assert(RACE_MIN_LOSERS >= 2, "one lost race can never report on its own");
}

// --- the tally names stay out of the failure share -----------------------------
{
  for (const name of RACE_TALLY_OUTCOMES) {
    assert(!(OUTCOME_ORDER as readonly string[]).includes(name), `${name} is not an outcome the failure share divides by`);
    assert(!(SELF_INFLICTED_REFUSALS as readonly string[]).includes(name), `${name} is not a self inflicted refusal`);
  }
  // Positive control: the real normalizer leaves the total untouched by them.
  const mix = normalizeMix({ by_outcome: { created: 10, error: 2, race_reassigned: 3, race_refused: 1, race_refused_bound: 1 } });
  eq(mix.total, 12, "a race tally row never enters the denominator of the failure share");
}

// --- which tally row a confirm records ------------------------------------------
eq(raceOutcomeForBooking(null), null, "no trace, nothing extra recorded");
eq(raceOutcomeForBooking({}), null, "an uncontested booking records nothing extra");
eq(raceOutcomeForBooking({ race_lost: [] }), null, "an empty loss list is not a race");
eq(raceOutcomeForBooking({ race_lost: ["a"] }), "race_reassigned", "a booking that lost first and was handed on");
eq(raceOutcomeForRefusal({ boundHit: false }), "race_refused", "refused with nobody left free after the loser");
eq(raceOutcomeForRefusal({ boundHit: true }), "race_refused_bound", "refused at the reassign bound");

// --- reading the mix -------------------------------------------------------------
eq(raceWindowFromMix(null, "2026-09-28"), null, "no mix is not a quiet day");
eq(raceWindowFromMix({ by_outcome: null }, "2026-09-28"), null, "a mix with no outcome map could not be read");
eq(
  raceWindowFromMix({ by_outcome: { created: 40, race_reassigned: 2, race_refused: 1 } }, "2026-09-28"),
  { day: "2026-09-28", created: 40, reassigned: 2, refused: 1, refusedAtBound: 0 },
  "absent keys are zero rows, present ones are read",
);
eq(
  raceWindowFromMix({ by_outcome: { created: "40" as unknown as number } }, "2026-09-28"),
  null,
  "a count that is not a number is a broken read, not a zero",
);

// --- the verdict -----------------------------------------------------------------
const w = (o: Partial<RaceContentionWindow>): RaceContentionWindow => ({
  day: "2026-09-28", created: 0, reassigned: 0, refused: 0, refusedAtBound: 0, ...o,
});

eq(raceContentionVerdict(null).kind, "unmeasured", "an unreadable tally is unmeasured");
{
  const v = raceContentionVerdict(w({}));
  eq(v.kind, "unmeasured", "zero confirms is unmeasured, never quiet (L98)");
}
{
  const v = raceContentionVerdict(w({ created: 20, reassigned: 2 }));
  eq(v.kind, "unmeasured", `a thin sample below ${RACE_MIN_CONFIRMS} confirms is unmeasured rather than alarming`);
  assert(v.kind === "unmeasured" && v.reason.includes(String(RACE_MIN_CONFIRMS)), "the thin reason names the floor");
}
eq(
  raceContentionVerdict(w({ created: 3, reassigned: 4 })).kind,
  "unmeasured",
  "more reassigned bookings than bookings is a broken read, not a very high rate",
);
eq(raceContentionVerdict(w({ created: 200 })).kind, "quiet", "measured, and nobody lost a race");
eq(
  raceContentionVerdict(w({ created: 200, reassigned: 2 })).kind,
  "quiet",
  "two losers is ordinary coincidence however the share falls",
);
{
  // 3 of 203 is 1.5%, under the derived share.
  const v = raceContentionVerdict(w({ created: 200, reassigned: 2, refused: 1 }));
  eq(v.kind, "quiet", "at or above the loser floor and under the share stays quiet");
}
{
  // 6 of 202 is 3.0%, over.
  const v = raceContentionVerdict(w({ created: 200, reassigned: 4, refused: 1, refusedAtBound: 1 }));
  eq(v.kind, "report", "over the derived share with enough losers reports");
  if (v.kind === "report") {
    eq(v.confirms, 202, "the denominator is bookings made plus confirms refused after a race");
    eq(v.losers, 6, "the numerator is every confirm that lost at least one race");
    eq(v.trigger, "rate", "which rule fired");
  }
}
{
  // Saturation under the floor: 4 of 6 lost. A proportion floor must not hide this (L139).
  const v = raceContentionVerdict(w({ created: 4, reassigned: 2, refused: 2 }));
  eq(v.kind, "report", "half or more losing is reported below the floor");
  if (v.kind === "report") eq(v.trigger, "saturation", "and says it was saturation");
  assert(RACE_SATURATION_SHARE >= 0.5, "saturation means at least half");
}
eq(
  raceContentionVerdict(w({ created: 1, refused: 1 })).kind,
  "unmeasured",
  "saturation still needs the loser floor, so one unlucky pair is not a report",
);

// --- the copy --------------------------------------------------------------------
{
  const v = raceContentionVerdict(w({ created: 200, reassigned: 4, refused: 1, refusedAtBound: 1 }));
  if (v.kind !== "report") throw new Error("fixture");
  const text = raceContentionNoticeText(v);
  assert(text.includes("6 of 202"), "names the count and the denominator");
  assert(text.includes("3.0%"), "names the share");
  assert(text.includes("1.8%"), "names the threshold it is judged against");
  assert(text.includes("4 were handed"), "says how many were rescued");
  assert(text.includes("2 were refused"), "says how many leads were turned away");
  assert(text.includes("1 of them"), "separates the bound hits");
  assert(/race_lost/.test(text), "points at where the rescued ones are recorded");
  assert(text.includes("tag=booking"), "and at where the refused ones are, since they made no booking");
  assert(/What to do/.test(text), "names what a reader should do");
  assert(!/[\u2014\u2013]/.test(text), "no dashes");
  assert(!/undefined|NaN|null/.test(text), "no leaked values");
}
{
  const v = raceContentionVerdict(w({ created: 200, reassigned: 5, refused: 0 }));
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
