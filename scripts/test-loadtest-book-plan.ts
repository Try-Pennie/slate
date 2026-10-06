// What the booking load driver decides, driven offline (#2243).
//
// Every decision here was pulled out of the driver so it can be tested without a
// network, a clock or a branch database. The two that matter most:
//
//   the PACING is derived from the app's own rate limit constants, so a run cannot
//   drift into measuring a ceiling somebody changed;
//
//   a driver that arrives LATE for the burst exits instead of firing. A late
//   request meets an already taken slot and records a SLOT_TAKEN indistinguishable
//   from the contention the control is counting, so the judge would be handed a
//   staggered burst wearing a simultaneous one's clothes.
//
// Run: node --experimental-strip-types scripts/test-loadtest-book-plan.ts
import {
  requestSchedule,
  availabilityRefreshMs,
  burstReadiness,
  waitForBurstMoment,
  externalIdFor,
  pickSlot,
  AVAILABILITY_PER_MINUTE,
  BOOKING_WRITES_PER_MINUTE,
  DRIVERS,
  PER_DRIVER_PER_MINUTE,
  RUN_MINUTES,
  chooseBurstSlot,
  burstStartAt,
  offeredSlots,
  loadtestPhone,
  idPrefix,
  chooseBurstSlots,
  burstMoments,
  burstCodeFor,
  burstLegOut,
  readBurstPlan,
  readDriverMode,
  bookingRequestHeaders,
  DRIVER_MODES,
  BURST_LEGS,
  BURST_REQUESTS_DEFAULT,
  BURST_SPACING_MS,
  BURST_SLOT_GAP_MS,
  BURST_GRACE_DEFAULT_MS,
  REQUEST_TIMEOUT_MS,
} from "./loadtest/book-plan.ts";
import {
  AVAILABILITY_LIMITER,
  BOOKING_API_IP_LIMITER,
} from "../src/lib/rate-limit-core.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOADTEST_LEGS, LOADTEST_LEG_HEADER } from "../src/lib/booking/wait-marks.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- the ceilings come from the app, not from a copy --------------------------

{
  eq(AVAILABILITY_PER_MINUTE, AVAILABILITY_LIMITER.perMinute, "availability pacing tracks the shipped limiter");
  eq(
    BOOKING_WRITES_PER_MINUTE,
    BOOKING_API_IP_LIMITER.perMinute,
    "and so does the per address write ceiling",
  );
  // The run's target sits exactly ON the write ceiling, deliberately, so the judge
  // can attribute the 429s it produces rather than leaving the limiter unexercised.
  eq(
    DRIVERS * PER_DRIVER_PER_MINUTE,
    BOOKING_WRITES_PER_MINUTE,
    "four drivers at fifteen a minute is exactly the per address write ceiling",
  );
  eq(RUN_MINUTES, 10, "the steady run is ten minutes");
}

// --- the schedule -------------------------------------------------------------

const T0 = Date.parse("2026-09-15T14:00:00.000Z");

{
  const plan = requestSchedule({ total: 150, perMinute: 15, startAtMs: T0 });
  eq(plan.length, 150, "one planned request per booking");
  eq(plan[0]!.atMs, T0, "the first fires at the start");
  // Evenly spaced, not bunched at the top of each minute. Sixty in the first second
  // is inside a per minute ceiling too, and measures a thundering herd rather than
  // a rate; the burst measures that separately, with a control.
  const gaps = plan.slice(1).map((r, i) => r.atMs - plan[i]!.atMs);
  assert(
    gaps.every((g) => Math.abs(g - 4000) <= 1),
    `fifteen a minute is one every four seconds; got gaps ${[...new Set(gaps)].join(",")}`,
  );
  eq(plan[plan.length - 1]!.atMs - T0, 149 * 4000, "and the last lands ten minutes in");
  // Each request carries its own id and its own code.
  eq(new Set(plan.map((r) => r.n)).size, 150, "every request is numbered uniquely");
  assert(new Set(plan.map((r) => r.code)).size > 5, "and the plan spans many codes");
}

{
  eq(requestSchedule({ total: 0, perMinute: 15, startAtMs: T0 }).length, 0, "no requests, no plan");
  eq(requestSchedule({ total: 10, perMinute: 0, startAtMs: T0 }).length, 0, "no rate, no plan");
  // A mix that can produce no codes produces NO plan, rather than a plan whose
  // codes are undefined: every request would send the string "undefined" and every
  // response would refuse it for a reason nobody could read.
  eq(
    requestSchedule({ total: 5, perMinute: 15, startAtMs: T0, mix: [] }).length,
    0,
    "an empty mix produces no plan rather than a plan of undefined codes",
  );
}

// --- availability pacing ------------------------------------------------------

{
  const everyMs = availabilityRefreshMs(DRIVERS);
  const perDriverPerMinute = 60_000 / everyMs;
  assert(
    perDriverPerMinute * DRIVERS <= AVAILABILITY_PER_MINUTE,
    `four drivers refreshing every ${everyMs}ms stay under ${AVAILABILITY_PER_MINUTE} a minute ` +
      `from one address; got ${(perDriverPerMinute * DRIVERS).toFixed(1)}`,
  );
  // With headroom, because the run retries a failed read: spending the whole budget
  // on first attempts makes the first failure the start of a cascade, and the run
  // would then be measuring its own pacing.
  assert(
    perDriverPerMinute * DRIVERS <= AVAILABILITY_PER_MINUTE * 0.85,
    "and leave headroom for a retry",
  );
  // The budget is really DIVIDED by the drivers, or four of them on one address
  // would each think they had the whole ceiling.
  assert(
    availabilityRefreshMs(8) > availabilityRefreshMs(2),
    "more drivers on one address means each refreshes less often",
  );
  assert(availabilityRefreshMs(0) > 0, "a nonsense driver count still yields a positive interval");
}

// --- the burst ----------------------------------------------------------------

{
  const startAtMs = T0;
  eq(burstReadiness({ startAtMs, nowMs: T0 - 1000, graceMs: 2000 }), "early", "before the moment");
  eq(burstReadiness({ startAtMs, nowMs: T0, graceMs: 2000 }), "ready", "at the moment");
  eq(burstReadiness({ startAtMs, nowMs: T0 + 1999, graceMs: 2000 }), "ready", "inside the grace");
  eq(
    burstReadiness({ startAtMs, nowMs: T0 + 2001, graceMs: 2000 }),
    "missed",
    "past the grace, the driver must NOT fire: a late request meets a taken slot and " +
      "records a SLOT_TAKEN that looks exactly like the contention being counted",
  );
  // A zero grace still admits the exact instant, or a driver that woke up perfectly
  // on time would be told it had missed.
  eq(burstReadiness({ startAtMs, nowMs: T0, graceMs: 0 }), "ready", "a zero grace admits the instant");
}

// --- waiting for the burst's moment (#3103) -----------------------------------
// Run 37162784607 lost its whole run to one driver whose sleep ended 1 to 3 ms
// before the moment: `setTimeout` runs on a monotonic clock and `Date.now()` on the
// wall clock, so a timer returning a hair early is ordinary, and a single sleep then
// one readiness check read that as "early" and fired nothing. The wait must hold
// until the wall clock has actually reached the moment.
{
  const T0 = 1_791_071_579_054;
  // A fake clock whose sleep always returns 3 ms short of what was asked.
  function shortClock(start: number) {
    let now = start;
    const sleeps: number[] = [];
    return {
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += Math.max(1, ms - 3);
      },
      sleeps,
    };
  }

  const c = shortClock(T0 - 270_000);
  await waitForBurstMoment(T0, c);
  assert(c.now() >= T0, `a sleep that returns short is followed by another, so the wait ends at or past the moment (ended ${c.now() - T0} ms from it)`);
  eq(burstReadiness({ startAtMs: T0, nowMs: c.now(), graceMs: 2000 }), "ready", "and the driver fires");
  assert(c.sleeps.length >= 2 && c.sleeps.length < 10, `it re-sleeps a bounded number of times (${c.sleeps.length})`);

  // Control: without the loop, the same clock reads "early", which is the run's bug.
  const single = shortClock(T0 - 270_000);
  await single.sleep(T0 - single.now());
  eq(burstReadiness({ startAtMs: T0, nowMs: single.now(), graceMs: 2000 }), "early", "one sleep on that clock lands early (the defect, reproduced)");

  // A driver that wakes after the moment does not sleep at all and still reads late.
  const late = shortClock(T0 + 5_000);
  await waitForBurstMoment(T0, late);
  eq(late.sleeps.length, 0, "a driver already past the moment does not sleep");
  eq(burstReadiness({ startAtMs: T0, nowMs: late.now(), graceMs: 2000 }), "missed", "and a genuinely late start still reads missed, firing nothing");

  // A clock that never advances must not hang the driver: the wait gives up after a
  // bounded number of sleeps and leaves the readiness check to say "early".
  let frozenSleeps = 0;
  await waitForBurstMoment(T0, { now: () => T0 - 10, sleep: async () => { frozenSleeps++; } });
  assert(frozenSleeps > 0 && frozenSleeps <= 100, `a frozen clock stops waiting after a bounded number of sleeps (${frozenSleeps})`);
}

// --- the lead id --------------------------------------------------------------

{
  eq(externalIdFor("run7", 2, 41), "run7-2-41", "the id carries run, driver and request");
  // Unique across every driver and request in a run. A repeat is not a duplicate
  // row: external_id IS the Salesforce id to Slate, so the booker would answer with
  // the FIRST booking and the run would silently stop creating anything.
  const ids = new Set<string>();
  for (let d = 0; d < DRIVERS; d++) {
    for (let n = 0; n < PER_DRIVER_PER_MINUTE * RUN_MINUTES; n++) ids.add(externalIdFor("r", d, n));
  }
  eq(ids.size, DRIVERS * PER_DRIVER_PER_MINUTE * RUN_MINUTES, "every request in a run has its own id");
}

// --- the slot ------------------------------------------------------------------

{
  const slots = ["a", "b", "c", "d"];
  // Random, injected so the choosing is testable. Four drivers each taking the
  // FIRST offered time would contend on one slot all run, which measures the unique
  // index over and over and never measures the path at a rate.
  eq(pickSlot(slots, () => 0), "a", "the bottom of the range picks the first");
  eq(pickSlot(slots, () => 0.99), "d", "the top picks the last");
  eq(pickSlot(slots, () => 0.5), "c", "and the middle picks from the middle");
  // A generator at or past 1 must not index past the end: the caller would send a
  // missing start and every response would refuse it as a validation error.
  eq(pickSlot(slots, () => 1), "d", "a generator returning exactly 1 stays in range");
  eq(pickSlot(slots, () => 1.7), "d", "and so does one out of range");
  eq(pickSlot(slots, () => -0.3), "a", "in both directions");
  eq(pickSlot([], () => 0.5), null, "no offered times means no slot, never an undefined one");
  // It really does spread, or "random" is a word rather than a behaviour.
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) seen.add(pickSlot(slots)!);
  eq(seen.size, 4, "over many picks every offered time is reached");
}

// --- the burst's one slot and one moment (#2262) ------------------------------

{
  // The FURTHEST offered time, not the first. The preflight books the first time
  // its own bucket offers, minutes earlier, and the two buckets can share an
  // agent: a burst aimed at an already booked slot meets SLOT_TAKEN on every
  // request and fails "exactly one 200" for a reason that is not the index.
  const slots = [
    "2026-09-15T14:00:00.000Z",
    "2026-09-15T14:10:00.000Z",
    "2026-09-15T16:30:00.000Z",
  ];
  eq(chooseBurstSlot(slots), "2026-09-15T16:30:00.000Z", "the last offered time is chosen");
}

{
  // Order is not trusted (L343). A response's list carries no order unless
  // something declares one, and "the last element" of an unordered list is not
  // "the furthest away": this is the same three times, shuffled.
  const shuffled = [
    "2026-09-15T16:30:00.000Z",
    "2026-09-15T14:00:00.000Z",
    "2026-09-15T14:10:00.000Z",
  ];
  eq(
    chooseBurstSlot(shuffled),
    "2026-09-15T16:30:00.000Z",
    "and it is the furthest in time whatever order they arrived in",
  );
}

{
  // Nothing offered is NULL, so the setup step can refuse by name. An empty answer
  // and a bucket nobody asked about produce the same file otherwise (L98).
  eq(chooseBurstSlot([]), null, "an empty list yields no slot");
  eq(chooseBurstSlot(["nonsense", ""]), null, "and neither does a list of unreadable times");
}

{
  // An unreadable time is DROPPED rather than sorted: NaN compares false against
  // everything, so it would land wherever the sort happened to put it and could
  // be returned as the choice.
  const mixed = ["2026-09-15T14:00:00.000Z", "not a time", "2026-09-15T15:00:00.000Z"];
  eq(
    chooseBurstSlot(mixed),
    "2026-09-15T15:00:00.000Z",
    "an unreadable time never becomes the burst's slot",
  );
}

{
  const now = 1_757_000_000_000;
  eq(burstStartAt(now, 300), now + 300_000, "the moment is the lead ahead of now");
  eq(burstStartAt(now, 0), now, "a zero lead is now");
  // Never in the past: a negative lead would put the moment behind every driver,
  // and burstReadiness would answer "missed" for all of them.
  eq(burstStartAt(now, -60), now, "and a negative lead is clamped to now rather than going backwards");
}

// --- reading what /api/availability actually answers (#2261) ------------------
//
// There were THREE readers of this payload and every one of them was wrong the
// same way: each declared `slots` as `{ start?: string }[]` and mapped `s.start`,
// which is undefined for a string, so all three resolved to an EMPTY list on a
// perfectly healthy response. It was invisible because empty is a real answer.
// Measured against the deployed load test Worker on 2026-09-11: bucket 112
// offered 130 times and bucket 122 offered 94, and every reader saw nil.

{
  // The REAL shape, copied from the deployment's own response rather than from
  // what the code believed (L58, L34): a list of ISO strings.
  const body = {
    bucket: "122",
    orgName: "Loadtest Org",
    eventType: { durationMinutes: 20 },
    slots: ["2026-09-15T14:00:00.000Z", "2026-09-15T14:10:00.000Z"],
    emptyBecause: null,
  };
  eq(offeredSlots(body).length, 2, "the real payload's times are read");
  eq(offeredSlots(body)[0], "2026-09-15T14:00:00.000Z", "and come back as the strings they are");
}

{
  // A genuinely empty bucket is EMPTY, not an error: the drivers record it as an
  // outcome of its own and the preflight refuses on it by name.
  eq(offeredSlots({ slots: [] }).length, 0, "a bucket offering nothing reads as no times");
}

{
  // The shape all three readers assumed. It must THROW, never read as empty: a
  // reader that returns [] for both an empty bucket and an unreadable payload is
  // exactly what made this cost a day (L98, L11).
  let threw = "";
  try {
    offeredSlots({ slots: [{ start: "2026-09-15T14:00:00.000Z" }] });
  } catch (err) {
    threw = (err as Error).message;
  }
  assert(threw !== "", "the object shape every reader assumed is REFUSED, not read as empty");
  assert(threw.includes("start"), "and the refusal names the keys it actually saw");
  assert(
    threw.includes("empty list on a healthy response"),
    "and says what that mistake looks like, since its symptom is silence",
  );
}

{
  // Every other way the payload can be unreadable, each refusing rather than
  // resolving to a comfortable empty list.
  for (const [label, body] of [
    ["a payload that is not an object", "nope"],
    ["a payload that is null", null],
    ["a response with no slots field", { bucket: "122" }],
    ["a slots field that is not an array", { slots: { first: "x" } }],
    ["a slots list holding numbers", { slots: [1757000000000] }],
  ] as const) {
    let threw = false;
    try {
      offeredSlots(body);
    } catch {
      threw = true;
    }
    assert(threw, `${label} is refused`);
  }
}

{
  // An empty string is dropped rather than thrown on: it is a string, so the shape
  // is right, and a blank time is nothing to book rather than a payload nobody can
  // read. Both directions on the same input (L159).
  const got = offeredSlots({ slots: ["2026-09-15T14:00:00.000Z", "", "2026-09-15T15:00:00.000Z"] });
  eq(got.length, 2, "a blank time is dropped, not refused");
}

// --- every attempt is its own person (#2261) ----------------------------------
//
// The dedupe gate is a PERSON gate and a weak match is email OR phone, so ONE
// shared number is enough to refuse every booking after the first as the same
// person calling again. Every driver sent `+15555550100`, so a run would have
// made one booking and been answered `confirm_required` five hundred and ninety
// nine times, and the judge would have reported a confirmed-per-minute collapse
// that had nothing to do with the booking path's capacity.
//
// The email was already unique per attempt, which is exactly why it hid.

{
  const a = loadtestPhone("run-1-0-0");
  const b = loadtestPhone("run-1-0-1");
  assert(a !== b, "two attempts of one driver get different numbers");
  assert(loadtestPhone("run-1-0-0") !== loadtestPhone("run-1-1-0"), "and so do two drivers");
  assert(loadtestPhone("run-1-0-0") !== loadtestPhone("run-2-0-0"), "and so do two runs");
}

{
  // Deterministic, so a re-run of the same attempt is the same person and a
  // re-driven id cannot become a second lead.
  eq(loadtestPhone("run-1-0-0"), loadtestPhone("run-1-0-0"), "the same id gives the same number");
}

{
  // Shaped like the number it replaces, and inside the 555 range, which is
  // unassignable in the real numbering plan: nothing this produces is a number
  // somebody actually holds.
  const n = loadtestPhone("run-1-0-0");
  assert(/^\+1555\d{7}$/.test(n), `the number is a 555 range E.164 value (${n})`);
  eq(n.length, "+15555550100".length, "and is the same length as the one it replaces");
}

{
  // The spread that matters: a real run makes six hundred of these, and a branch
  // can see several runs. A generator colliding inside one run would refuse the
  // colliding attempts for a reason the judge would read as the path failing.
  const seen = new Set<string>();
  for (let driver = 0; driver < 4; driver++) {
    for (let n = 0; n < 150; n++) seen.add(loadtestPhone(`run-1-${driver}-${n}`));
  }
  eq(seen.size, 600, "a whole run's six hundred attempts are six hundred distinct people");
}

// --- each leg mints its own external ids (#2261) ------------------------------
//
// All three legs built `<run>-<driver>-<n>`, so they COLLIDED, and `external_id`
// IS the Salesforce id to Slate: a repeat is a strong match, answered by
// RESCHEDULING the existing booking rather than by creating one. Neither
// collision showed up as an error anywhere, because a reschedule is a 200.

{
  const run = "run-1";
  const three = new Set([
    idPrefix(run, "steady"),
    idPrefix(run, "burst"),
    idPrefix(run, "fault"),
  ]);
  eq(three.size, 3, "the three legs get three different id spaces");
}

{
  // The live collisions. The fault pass runs as driver 0 under the same run id, so
  // it minted exactly the ids the steady pass had used; the burst runs first and
  // its winners took ids the steady pass then reused.
  const run = "run-1";
  const steadyId = externalIdFor(idPrefix(run, "steady"), 0, 0);
  const faultId = externalIdFor(idPrefix(run, "fault"), 0, 0);
  const burstId = externalIdFor(idPrefix(run, "burst"), 0, 0);
  eq(new Set([steadyId, faultId, burstId]).size, 3, "the same driver and index collide no more");
}

{
  // Every prefix stays rooted at the run id, because the judge scopes its database
  // reads to `external_id=like.<run>-*` and an id outside that is a row the run
  // cannot see at all.
  const run = "run-34656052378-1";
  for (const mode of ["steady", "burst", "fault"] as const) {
    const id = externalIdFor(idPrefix(run, mode), 2, 7);
    assert(id.startsWith(`${run}-`), `a ${mode} id is still inside the run's scope (${id})`);
  }
}

{
  // Two runs never collide either, whatever the leg.
  const a = externalIdFor(idPrefix("run-1", "fault"), 0, 0);
  const b = externalIdFor(idPrefix("run-2", "fault"), 0, 0);
  assert(a !== b, "two runs' fault passes do not share ids");
}

// --- three bursts a run, at three slots, split across two sibling codes (#3325) ----
//
// One burst is one spread of requests over the deployment's isolates, and one lucky
// spread can pass a run that a second would fail (L395). So a run fires THREE bursts,
// each at its own slot and its own moment, and each is judged on its own. And each
// burst is split across TWO codes whose fallback ladders are the same pools at every
// rung, so the shared confirm line is exercised across codes rather than only within
// one.

{
  eq(BURST_LEGS, 3, "a run fires three bursts");
  // Spaced so a burst has finished before the next one fires: every request carries
  // its own abort, so a burst is over by its timeout plus the lateness a driver is
  // allowed, and the next moment must be past that or two bursts would overlap and
  // neither would be the contention it is counted as.
  assert(
    BURST_SPACING_MS > REQUEST_TIMEOUT_MS + BURST_GRACE_DEFAULT_MS,
    `the bursts are spaced past one burst's longest life (${BURST_SPACING_MS}ms against ${REQUEST_TIMEOUT_MS + BURST_GRACE_DEFAULT_MS}ms)`,
  );
  // The slots are an hour apart, which is longer than any appointment plus its
  // buffers, so a booking made by one burst cannot overlap the slot another fires at.
  assert(BURST_SLOT_GAP_MS >= 60 * 60_000, "the three slots are at least an hour apart");
}

{
  const at = 1_760_000_000_000;
  eq(burstMoments(at, 3, 60_000), [at, at + 60_000, at + 120_000], "three moments, spaced");
  eq(burstMoments(at, 1, 60_000), [at], "one leg is one moment");
}

{
  // The last offered time first, as one burst always chose (the preflight books the
  // FIRST time its own bucket offers), then the latest earlier time at least the gap
  // before it, and again. Fired in time order, so the report reads forwards.
  const hour = 60 * 60_000;
  const t = (h: number, m = 0) => new Date(Date.parse("2026-10-06T13:00:00.000Z") + h * hour + m * 60_000).toISOString();
  const offered = [t(0), t(0, 10), t(1), t(1, 20), t(2), t(2, 30), t(3), t(3, 10)];
  eq(
    chooseBurstSlots(offered, 3, hour),
    [t(1), t(2), t(3, 10)],
    "picks the furthest time and then the latest ones an hour or more before it",
  );
}

{
  const hour = 60 * 60_000;
  const t = (m: number) => new Date(Date.parse("2026-10-06T13:00:00.000Z") + m * 60_000).toISOString();
  const offered = [t(0), t(30), t(70), t(130)];
  eq(chooseBurstSlots(offered, 3, hour), [t(0), t(70), t(130)], "every chosen pair is at least the gap apart");
  eq(chooseBurstSlots([...offered].reverse(), 3, hour), [t(0), t(70), t(130)], "whatever order they arrived in (L343)");
  eq(chooseBurstSlots([t(0), t(30), t(50)], 3, hour), null, "too few times far enough apart yields nothing, never two of three");
  eq(chooseBurstSlots([t(0), "not a time", t(70), t(140)], 3, hour), [t(0), t(70), t(140)], "an unreadable time is dropped, never chosen");
  eq(chooseBurstSlots([], 3, hour), null, "nothing offered yields nothing");
  // The one slot chooser is the three slot chooser asked for one, so the two cannot
  // disagree about which time is the furthest (L41).
  eq(chooseBurstSlot(offered), t(130), "one slot is still the last offered time");
}

{
  // Each driver's share alternates between the two codes, starting on a different
  // one per driver, so four drivers of twenty five split a burst fifty fifty.
  const codes = ["120", "121"] as const;
  const counts = new Map<string, number>();
  for (let d = 0; d < DRIVERS; d++) {
    for (let i = 0; i < BURST_REQUESTS_DEFAULT; i++) {
      const c = burstCodeFor(codes, d, i);
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  }
  eq(counts.get("120"), 50, "half the burst asks for the first code");
  eq(counts.get("121"), 50, "and half for its sibling");
  eq(burstCodeFor(codes, 0, 0), "120", "driver 0 opens on the first code");
  eq(burstCodeFor(codes, 1, 0), "121", "driver 1 opens on the second");
}

{
  eq(burstLegOut("results/burst-2.json", 0), "results/burst-2-leg-0.json", "leg 0's file sits beside the driver's own name");
  eq(burstLegOut("results/burst-2.json", 2), "results/burst-2-leg-2.json", "and leg 2's");
  eq(burstLegOut("results/burst-2", 1), "results/burst-2-leg-1.json", "a name with no extension still gets one");
}

{
  // The plan is chosen ONCE by the setup and handed through as one value, so the
  // drivers cannot fire at different codes, slots or moments while each reads as
  // correct (L70). Read strictly: a plan this cannot read is refused by name rather
  // than becoming a burst nobody configured.
  const good = JSON.stringify({
    codes: ["120", "121"],
    bursts: [
      { slot: "2026-10-06T14:00:00.000Z", startAtMs: 1_760_000_000_000 },
      { slot: "2026-10-06T15:10:00.000Z", startAtMs: 1_760_000_060_000 },
      { slot: "2026-10-06T16:20:00.000Z", startAtMs: 1_760_000_120_000 },
    ],
  });
  const read = readBurstPlan(good);
  assert(read.ok, `a well formed plan is read (got: ${JSON.stringify(read)})`);
  if (read.ok) {
    eq(read.plan.codes, ["120", "121"], "with its two codes");
    eq(read.plan.bursts.length, 3, "and its three bursts");
    eq(read.plan.bursts[1]!.startAtMs, 1_760_000_060_000, "each with its moment");
  }

  const refusals: [string, string][] = [
    ["not json", "not JSON"],
    [JSON.stringify({ codes: ["120"], bursts: JSON.parse(good).bursts }), "two codes"],
    [JSON.stringify({ codes: ["120", "120"], bursts: JSON.parse(good).bursts }), "two different codes"],
    [JSON.stringify({ codes: ["120", "121"], bursts: [] }), "no bursts"],
    [JSON.stringify({ codes: ["120", "121"], bursts: [{ slot: "soon", startAtMs: 1 }] }), "slot"],
    [JSON.stringify({ codes: ["120", "121"], bursts: [{ slot: "2026-10-06T14:00:00.000Z", startAtMs: "x" }] }), "moment"],
    [
      JSON.stringify({
        codes: ["120", "121"],
        bursts: [
          { slot: "2026-10-06T14:00:00.000Z", startAtMs: 1_760_000_060_000 },
          { slot: "2026-10-06T15:00:00.000Z", startAtMs: 1_760_000_000_000 },
        ],
      }),
      "in time order",
    ],
  ];
  for (const [raw, says] of refusals) {
    const r = readBurstPlan(raw);
    assert(!r.ok && r.why.includes(says), `refused, saying "${says}" (got: ${JSON.stringify(r)})`);
  }
}

// --- #3354: the driver says which leg it is on every confirm it sends ---------------
// The route logs it on the confirm's own line, so the run can say which leg each cold
// confirm came from. The mode is the leg, read from the one vocabulary the route
// reads (L41), and a mode the driver does not know is refused by name rather than
// cast into one it does.
{
  for (const mode of DRIVER_MODES) {
    const r = readDriverMode(mode);
    assert(r.ok && r.mode === mode, `the ${mode} mode is read as itself`);
    assert((LOADTEST_LEGS as readonly string[]).includes(mode), `the ${mode} mode is a leg the route reads`);
  }
  for (const leg of LOADTEST_LEGS) {
    const h = bookingRequestHeaders("k", leg);
    assert(h[LOADTEST_LEG_HEADER] === leg, `a ${leg} sender names its leg on the request (got ${JSON.stringify(h)})`);
    assert(h.Authorization === "Bearer k" && h["content-type"] === "application/json", "and still sends its key and its body's type");
  }
  const unset = readDriverMode(undefined);
  assert(unset.ok && unset.mode === "steady", "no mode is the steady pass, as before");
  const typo = readDriverMode("Burst");
  assert(!typo.ok && typo.why.includes("Burst"), `a mode outside the four is refused by name (got ${JSON.stringify(typo)})`);
  const control = readDriverMode("preflight");
  assert(!control.ok, "a control's leg is not a mode this driver runs, so it is refused rather than run as the steady pass");

  // One vocabulary, written once (L41). The mode list was first added beside a hand
  // written DriverMode union, which declared the type twice; only tsc over scripts/
  // reports that, and the build gate there fails on undefined names alone.
  const declaresMode = (source: string) => source.match(/^export type DriverMode\b.*$/gm) ?? [];
  const planSource = readFileSync(join(import.meta.dirname, "loadtest", "book-plan.ts"), "utf8");
  eq(declaresMode(planSource), ["export type DriverMode = (typeof DRIVER_MODES)[number];"], "DriverMode is declared once, derived from the mode list");
  const twice = planSource.replace(/^(export type DriverMode = \(typeof DRIVER_MODES\)\[number\];)$/m, '$1\nexport type DriverMode = "steady" | "burst" | "fault" | "baseline";');
  assert(twice !== planSource && declaresMode(twice).length === 2, "control: a second, hand written union beside it is caught");
}

finish();
