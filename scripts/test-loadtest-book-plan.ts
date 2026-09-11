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
} from "./loadtest/book-plan.ts";
import {
  AVAILABILITY_LIMITER,
  BOOKING_API_IP_LIMITER,
} from "../src/lib/rate-limit-core.ts";
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

finish();
