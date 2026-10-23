// Applying each tier's cal.com measurement in proportion to the share of it Slate
// carries (#2893). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-carried-share.ts
//
// What this pins:
// - a floor thinned to a share is a floor the thinned traffic clears as reliably as
//   the whole traffic cleared the original: exactly the original at a share of 1,
//   zero at a share of 0, never above the original, and never above what a binomial
//   thinning of it clears at the fit's own chance tolerance;
// - the measurement thinned is the narrowest one that covers what Slate carries, so
//   Low's two page measurement stays exactly in force while Slate carries those two
//   pages, and the whole tier's is thinned once Slate carries less or more;
// - a day's share is APPLIED only when the tier's whole traffic held up, because a
//   share that fell with the total is bookings LOST, not moved to cal.com, and
//   applying it would lower the floors of an alarm that is watching an outage;
// - a held share is held for a bounded time, never for ever (L523);
// - too few bookings, a closed day and cal.com being switched off each have their
//   own outcome, and none of them is read as a share.
import {
  CARRIED_SHARE,
  anchorFor,
  binomialFloor,
  carriedAnchor,
  expectedBookings,
  isStoredCarriedShare,
  judgeTierShare,
  thinBaseline,
  type AnchorSource,
  type StoredTierShare,
} from "../src/lib/monitor/carried-share.ts";
import { FLOOR_FIT, type FloorCell, type VolumeBaseline } from "../src/lib/monitor/volume-floors.ts";
import { ROUTING_API_VERSION, bookedByTier, readRoutingResponses, tierOf, type RoutingResponse } from "../src/lib/calcom/routing-responses.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** A baseline with the same cell at every weekday and hour. */
function flat(floor30: number, floor120: number, typical120: number, tierShare: number | null, scope = "test scope"): VolumeBaseline {
  const cell: FloorCell = { floor30, floor120, typical120 };
  return {
    source: "calcom",
    measuredOn: "2026-09-25",
    fromDate: "2026-07-24",
    toDate: "2026-09-25",
    zone: "America/New_York",
    scope,
    tierShare,
    bookings: 1000,
    cells: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ ...cell }))),
  };
}

// --- binomialFloor: the thinning bound ---
eq(binomialFloor(15, 1, FLOOR_FIT.poissonAlpha), 15, "a share of 1 keeps the floor exactly");
eq(binomialFloor(15, 0, FLOOR_FIT.poissonAlpha), 0, "a share of 0 leaves no floor");
eq(binomialFloor(0, 0.5, FLOOR_FIT.poissonAlpha), 0, "a floor of 0 stays 0");
// Worked by hand: Bin(15, 0.5). P(X<2) = (1 + 15) / 32768 = 0.00049, within 0.001;
// P(X<3) adds 105 / 32768 to reach 0.0037, over it. So the floor is 2.
eq(binomialFloor(15, 0.5, 0.001), 2, "Bin(15, 0.5) at 0.001 is 2, worked by hand");
// And at the fit's looser tail tolerance: P(X<4) = 576 / 32768 = 0.0176, P(X<5) = 0.059.
eq(binomialFloor(15, 0.5, 0.02), 4, "Bin(15, 0.5) at 0.02 is 4, worked by hand");
for (const n of [1, 5, 12, 30, 60]) {
  let last = -1;
  for (const p of [0, 0.1, 0.25, 0.33, 0.5, 0.66, 0.8, 0.95, 1]) {
    const k = binomialFloor(n, p, FLOOR_FIT.poissonAlpha);
    assert(k >= 0 && k <= n, `floor ${n} at ${p} stays within 0 and ${n} (got ${k})`);
    assert(k >= last, `floor ${n} never falls as the share rises (${p} gave ${k} after ${last})`);
    last = k;
  }
}

// --- thinBaseline ---
const whole = flat(3, 20, 35, null, "Every Low debt booking from every landing page, the whole tier");
const half = thinBaseline(whole, 0.5);
eq(half.cells[0]![9]!.floor120, binomialFloor(20, 0.5, FLOOR_FIT.poissonAlpha), "each floor is the binomial bound of the original");
eq(half.cells[0]![9]!.typical120, 18, "the typical count scales with the share, rounded (35 x 0.5 = 17.5)");
eq(half.tierShare, 0.5, "the thinned baseline covers half the tier");
assert(half.scope.includes("50%"), `the scope says the share it was thinned to: ${half.scope}`);
eq(thinBaseline(whole, 1).cells, whole.cells, "thinning to 1 changes no cell");
assert(thinBaseline(whole, 0).cells.every((d) => d.every((c) => c.floor30 === 0 && c.floor120 === 0)), "thinning to 0 zeroes every floor");
let threw = false;
try {
  thinBaseline(whole, 1.2);
} catch {
  threw = true;
}
assert(threw, "a factor above 1 is refused: a measurement is never scaled UP past what was measured");
threw = false;
try {
  thinBaseline(whole, Number.NaN);
} catch {
  threw = true;
}
assert(threw, "a factor that is not a number is refused rather than compared into a floor of 0 (L50)");

// --- which measurement is thinned ---
const twoPages = flat(2, 15, 30, 0.66, "Low debt bookings from the two pages on Slate");
const lowMeasurements = [twoPages, whole];
eq(carriedAnchor(lowMeasurements, 0.66), twoPages, "Slate carrying the two pages' share keeps the two page measurement, untouched");
eq(carriedAnchor(lowMeasurements, 0.69), twoPages, "within the tolerance above it, still the two page measurement, never scaled up");
const splitHalf = carriedAnchor(lowMeasurements, 0.33)!;
eq(splitHalf.cells[1]![10]!.floor120, binomialFloor(15, 0.5, FLOOR_FIT.poissonAlpha), "a 50% split of those pages thins the two page measurement by half");
const widened = carriedAnchor(lowMeasurements, 0.85)!;
eq(widened.cells[1]![10]!.floor120, binomialFloor(20, 0.85, FLOOR_FIT.poissonAlpha), "carrying more than the two pages thins the WHOLE tier's measurement");
eq(carriedAnchor(lowMeasurements, 1), whole, "carrying all of it is the whole tier's measurement");
eq(carriedAnchor([whole], 0.4)!.tierShare, 0.4, "a tier with one measurement thins it by the share itself");
eq(carriedAnchor(undefined, 0.5), null, "a tier nobody measured has no anchor at any share");
eq(carriedAnchor([], 0.5), null, "nor with an empty list");
assert(carriedAnchor(lowMeasurements, 0)!.cells.every((d) => d.every((c) => c.floor120 === 0)), "carrying none leaves floors of zero, stated rather than absent");

const source: AnchorSource = { unmeasured: { "1": twoPages }, measurements: { "1": lowMeasurements, "2": [whole] } };
eq(anchorFor("1", null, source), twoPages, "no measured share: Low keeps the anchor it has always had");
eq(anchorFor("2", null, source), null, "no measured share: a tier beside Low keeps having none");
eq(anchorFor("2", 1, source), whole, "a measured share puts a tier beside Low's measurement under it");
eq(anchorFor("5", 0.5, source), null, "a measured share for a tier nobody measured still gives none");

// --- expectedBookings: the whole tier's usual traffic over a window ---
// typical120 of 24 at every hour is 12 bookings an hour, 1 per 5 minute bucket.
const steady = flat(0, 0, 24, null);
const monday9 = Date.UTC(2026, 9, 5, 13, 0); // Monday 9:00am Eastern
eq(expectedBookings(steady, monday9, monday9 + DAY), 288, "a day of a steady 12 an hour is 288");
eq(expectedBookings(steady, monday9, monday9 + HOUR), 12, "an hour is 12");

// --- judgeTierShare ---
const NOW = monday9 + DAY;
const from = new Date(monday9).toISOString();
const to = new Date(NOW).toISOString();
const judge = (previous: StoredTierShare | null, slate: number, calcom: number | null, level: number | null, extra: Partial<{ touchesClosed: boolean; nowMs: number }> = {}) =>
  judgeTierShare({ previous, slate, calcom, level, touchesClosed: extra.touchesClosed ?? false, fromIso: from, toIso: to, nowMs: extra.nowMs ?? NOW });

const first = judge(null, 200, 100, 1);
eq(first.last.outcome, "applied", "a first reading is applied: there is nothing to protect yet");
eq(first.applied?.share, 0.67, "the share is Slate's bookings over both systems', to two places (200 of 300)");
eq(first.heldSince, null, "and nothing is held");

// The split moved leads to cal.com: Slate halves, cal.com takes the other half, the total holds.
const moved = judge(first, 100, 200, 0.98);
eq(moved.last.outcome, "applied", "a share that fell while the whole tier held up is applied: the leads MOVED");
eq(moved.applied?.share, 0.33, "to the new share");

// Slate broke: its bookings fell and cal.com did not take them, so the whole tier fell.
const lost = judge(first, 40, 100, 0.47);
eq(lost.last.outcome, "held", "a share that fell WITH the whole tier is held: the bookings were LOST, not moved");
eq(lost.applied, first.applied, "the share in force stays the one before");
eq(lost.heldSince, to, "and the hold records when it started");
const stillLost = judge(lost, 40, 100, 0.47, { nowMs: NOW + DAY });
eq(stillLost.heldSince, to, "a hold keeps its original start, so it cannot be extended by holding again");
const expiry = CARRIED_SHARE.holdExpiryDays * DAY;
const expired = judge(lost, 40, 100, 0.47, { nowMs: Date.parse(to) + expiry });
eq(expired.last.outcome, "hold-expired", `after ${CARRIED_SHARE.holdExpiryDays} days a hold gives way (L523)`);
eq(expired.applied?.share, 0.29, "and the share measured that day is applied");
eq(expired.heldSince, null, "clearing the hold");
const recovered = judge(lost, 200, 100, 0.99);
eq(recovered.last.outcome, "applied", "once the tier recovers the reading is applied again");
eq(recovered.heldSince, null, "and the hold is over");

// cal.com broke: its bookings fell, Slate's share rose with the total falling.
const calcomLost = judge(first, 200, 10, 0.7);
eq(calcomLost.last.outcome, "held", "a share that ROSE because cal.com lost bookings is held too, or Slate's floors rise to traffic it never gets");

// A small move is noise, applied even on a thin day.
const noise = judge(first, 190, 100, 0.5);
eq(noise.last.outcome, "applied", `a move within ${CARRIED_SHARE.shareNoise} is applied whatever the total did`);

// A traffic wide dip moves nothing: both halves fall together, the share barely moves.
const dip = judge(first, 120, 60, 0.6);
eq(dip.last.outcome, "applied", "a quiet day for the whole tier leaves the share where it was, and is applied");

const thin = judge(first, 10, 5, 1);
eq(thin.last.outcome, "too-few", `under ${CARRIED_SHARE.minBookings} bookings in both systems the day is not read (L716)`);
eq(thin.applied, first.applied, "and the share in force stays");
const thinFirst = judge(null, 10, 5, 1);
eq(thinFirst.applied, null, "a first day too thin to read leaves no share at all, never a guess");

const shut = judge(first, 0, 0, 0, { touchesClosed: true });
eq(shut.last.outcome, "closed-day", "a window touching a closed day is not read: the office being shut is not a share");
eq(shut.applied, first.applied, "and the share in force stays");

const off = judge(first, 150, null, null);
eq(off.last.outcome, "calcom-off", "cal.com switched off is its own outcome");
eq(off.applied?.share, 1, "and Slate is taken to carry the whole tier, the state cutover freezes at");
eq(judge(null, 0, null, null).applied?.share, 1, "even on a day Slate took nothing: with cal.com off there is nothing else to carry it");

const noLevel = judge(first, 40, 100, null);
eq(noLevel.last.outcome, "applied", "a tier with no whole tier measurement to judge its level against is applied as measured");

// --- the stored shape is validated, never trusted ---
assert(isStoredCarriedShare({ measuredAt: to, from, to, tiers: { "1": first } }), "a real record reads");
assert(isStoredCarriedShare({ measuredAt: to, from, to, tiers: {} }), "a record for no tiers reads: nothing was carried");
assert(!isStoredCarriedShare({ measuredAt: to, from, to, tiers: { "9": first } }), "a key that is not a tier does not");
assert(!isStoredCarriedShare({ measuredAt: to, from, to, tiers: { "1": { ...first, applied: { ...first.applied!, share: 1.4 } } } }), "a share above 1 does not");
assert(!isStoredCarriedShare({ measuredAt: to, from, to, tiers: { "1": { ...first, last: { ...first.last, outcome: "guessed" } } } }), "an outcome nobody writes does not");
assert(!isStoredCarriedShare({ measuredAt: "yesterday", from, to, tiers: {} }), "an unreadable stamp does not");
assert(!isStoredCarriedShare(null), "nothing does not");

// --- cal.com's side: booked responses per tier, over the window, as measured ---
{
  const at = (h: number) => new Date(monday9 + h * HOUR).toISOString();
  const rows: RoutingResponse[] = [
    { formName: "A", createdAt: at(1), code: "111", booked: true },
    { formName: "A", createdAt: at(2), code: "112", booked: true },
    { formName: "A", createdAt: at(3), code: "211", booked: true },
    { formName: "A", createdAt: at(4), code: "111", booked: false },
    { formName: "A", createdAt: at(5), code: null, booked: true },
    { formName: "A", createdAt: at(-1), code: "111", booked: true },
    { formName: "A", createdAt: at(24), code: "111", booked: true },
  ];
  eq(
    bookedByTier(rows, monday9, monday9 + DAY),
    { "1": 2, "2": 1, "3": 0, "4": 0, "5": 0 },
    "booked responses in [from, to) by the lead's code: unbooked, codeless and out of window ones are not counted",
  );
  let threw = false;
  try {
    bookedByTier([{ formName: "A", createdAt: "not a time", code: "111", booked: true }], monday9, monday9 + DAY);
  } catch {
    threw = true;
  }
  assert(threw, "an unreadable stamp refuses the count rather than dropping a booking cal.com took");
}

// --- #3671 (L1023): a lead's code is read WHOLE, never by its first digit ---
// The code is text from outside Slate (the landing page's query string, through
// cal.com, which stores `22` as the number 22). Read by its first digit, a two digit
// code, a four digit one or a code with a suffix counted as a tier with full
// confidence, while Slate's live booker refuses every one of them and Slate's own
// bookings are tiered by the strict reader (`tierOfBucketCode`).
{
  eq(tierOf("111"), "1", "a Low code is tier 1");
  eq(tierOf(" 532 "), "5", "surrounding space is ignored, as the strict reader ignores it");
  for (const code of ["22", "2", "1320", "1abc", "611", "141", "113", "", null]) {
    eq(tierOf(code), null, `${JSON.stringify(code)} is not a code, so it belongs to no tier`);
  }
  const at = new Date(monday9 + HOUR).toISOString();
  eq(
    bookedByTier(
      [
        { formName: "A", createdAt: at, code: "211", booked: true },
        { formName: "A", createdAt: at, code: "22", booked: true },
        { formName: "A", createdAt: at, code: "2111", booked: true },
      ],
      monday9,
      monday9 + DAY,
    ),
    { "1": 0, "2": 1, "3": 0, "4": 0, "5": 0 },
    "only the whole code counts toward a tier",
  );
}

// --- the reader owns the cal.com API version, so every caller counts the same way ---
// The measurements were read at one version; a reader that let each caller choose
// (the Worker's daily count sent none) could get a different answer for the same
// traffic, and the share would compare two different things (L728).
{
  const versions: string[] = [];
  const read = await readRoutingResponses({
    get: async (path, apiVersion) => {
      versions.push(apiVersion);
      if (path.endsWith("/routing-forms")) return { status: 200, json: { data: [{ id: "f1", name: "Form" }] } };
      return { status: 200, json: { data: [] } };
    },
    org: "1",
    fromIso: new Date(monday9).toISOString(),
    paceMs: 0,
    sleep: async () => {},
  });
  eq(read.ok, true, "a fake cal.com answers");
  eq(versions.length, 2, "one forms read and one responses page");
  assert(versions.every((v) => v === ROUTING_API_VERSION), `every read asks for the one pinned version (${versions.join(", ")})`);
  eq(ROUTING_API_VERSION, "2024-06-14", "the version the committed measurements were read at");
}

finish();
