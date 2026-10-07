// #2281: a confirm that LOSES the overlap race (#2274) is offered the next
// advisor the same rung of the same bucket already resolved for that instant,
// before the lead is asked to pick another time. Bounded, and never for a named
// link.
//
// #3338: when nobody after the loser on that rung is free, the confirm walks on
// down the tier ladder, "Same as a normal confirm" (Dan, 2026-10-06). That
// supersedes #2281's boundary ("If it would require cascading or anything we can
// ask them to pick another time", 2026-09-13) with sales ops' decision of
// 2026-10-02 that a lead who loses their tier's last opening keeps their time with
// the next tier down. Only that one reason continues; every other reason the next
// advisor search can give keeps the answer it had, each tested below.
// Run: node --experimental-strip-types scripts/test-booking-race-next-advisor.ts
import {
  createBooking,
  nextAdvisorAfterLostRace,
  SlotUnavailableError,
  RaceLostRefusalError,
  MAX_RACE_REASSIGNS,
  DependencyTimeoutError,
  timeoutAsRetryable,
  type CreateBookingInput,
} from "../src/lib/booking/orchestration.ts";
import { DeadlineExceededError } from "../src/lib/fetch-within-deadline.ts";
import { withinCallBudget } from "../src/lib/call-budget.ts";
import { dependencyTimeoutAlert } from "../src/lib/booking/alert-copy.ts";
import { refusalTraceOf } from "../src/lib/booking/refusal-trace.ts";
import { tierKeyOf, tierLadder } from "../src/lib/routing/tiers.ts";
import type { BookingReservation, EventType, RoutingTrace } from "../src/lib/db/types.ts";
import { createAsserter, makeDeps, makeBooking, input, eventType } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (e) {
    return e;
  }
}

async function main() {
  // --- the loser falls to the next free advisor in the same rung -------------
  {
    const { deps, calls } = makeDeps({
      candidates: ["a", "b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]),
      insertBookingConflictFor: new Set(["a"]),
    });
    const res = await createBooking(input, deps);
    assert(res.booking.assigned_user_id === "b", "race: the loser is booked with the next advisor in the rung");
    // #2838: the route counts a race only on a booking THIS call inserted.
    assert(res.newlyInserted === true, "race: a booking this confirm inserted says so");
    assert(res.booking.agent_email === "b@x.com", "race: the row names the advisor it was handed to");
    assert(calls.insertBooking.length === 2, `race: one insert per advisor tried (got ${calls.insertBooking.length})`);
    assert(
      calls.createEvent.length === 2 && calls.createEvent[0].email === "a@x.com" && calls.createEvent[1].email === "b@x.com",
      "race: the second event is on the second advisor's calendar",
    );
    assert(
      calls.createEvent[0].clientId !== calls.createEvent[1].clientId,
      "race: the second advisor's event has its own id, so nothing is reused across calendars",
    );
    assert(
      calls.deleteEvent.length === 1 && calls.deleteEvent[0].id === "gcal-1",
      "race: the first advisor's event is removed, not left behind",
    );
    assert(
      calls.verifyFree.length === 2 && calls.verifyFree[1].join(",") === "b@x.com",
      `race: the next advisor is re-checked live, and only advisors after the loser (got ${JSON.stringify(calls.verifyFree)})`,
    );
    assert(
      calls.reservations.length === 2 && calls.reservations[1].pinned_user_id === "b",
      "race: a fresh reservation pins the next advisor",
    );
    assert(calls.deletedReservations.length === 2, "race: both reservations are cleaned up");
    assert(
      calls.roundRobinPreview.length === 1,
      "race: the pool is NOT resolved a second time (the candidates already in hand)",
    );
    const trace = res.booking.routing_trace as RoutingTrace;
    assert(trace.chosen_user_id === "b", "race: the trace says who was actually chosen");
    assert(
      JSON.stringify(trace.race_lost) === JSON.stringify(["a"]),
      `race: the trace records that the first choice lost the race (got ${JSON.stringify(trace.race_lost)})`,
    );
    assert(trace.rungs_dropped === 0 && trace.tier_fallback === false, "race: the reassignment is not a tier drop");
    const decision = calls.recordRoutingDecision.at(-1);
    assert(
      decision?.chosenUserId === "b" && decision.outcome === "booked",
      "race: the routing decision log names the advisor who took the booking",
    );
    assert(
      calls.moveBusyBlock.length === 1 && calls.moveBusyBlock[0].userId === "b",
      "race: the busy block lands on the advisor who took it",
    );
    assert(calls.webhooks.length === 1, "race: booking.created fires once");
  }

  // --- a first choice that did NOT lose writes no race record -----------------
  {
    const { deps } = makeDeps({ candidates: ["a", "b"], freeEmails: new Set(["a@x.com", "b@x.com"]) });
    const res = await createBooking(input, deps);
    const trace = res.booking.routing_trace as RoutingTrace;
    assert(res.booking.assigned_user_id === "a", "control: an uncontested confirm books the first choice");
    assert(trace.race_lost === undefined, "control: an uncontested booking carries no race record");
  }

  // --- #3338: nobody free after the loser on ANY rung: refused, the ladder spent ---
  {
    const [top, second, third] = tierLadder(input.bucketCode);
    const { deps, calls } = makeDeps({
      candidatesByCode: { [top]: ["a", "b"], [second]: ["c"], [third]: ["d"] },
      freeEmails: new Set(["a@x.com"]),
      insertBookingConflictFor: new Set(["a"]),
    });
    const err = await refusal(() => createBooking(input, deps));
    assert(err instanceof SlotUnavailableError, "race, ladder full: the lead is asked to pick another time");
    // #2838: the refusal says it followed a lost race, so the booker can count it
    // apart from a time already taken at the free check, and says the bound was NOT hit.
    assert(
      err instanceof RaceLostRefusalError && err.lostRaces === 1 && err.boundHit === false && err.ladderExhausted === true,
      `race, ladder full: refused as a lost race, one lost, bound not hit, every rung asked (got ${JSON.stringify(err)})`,
    );
    assert(
      ["c@x.com", "d@x.com"].every((e) => calls.verifyFree.flat().includes(e)),
      `race, ladder full: every rung below was asked live before refusing (got ${JSON.stringify(calls.verifyFree)})`,
    );
    assert(calls.raceBoundHitPages.length === 0, "race, ladder full: below the bound nothing is paged");
    assert(calls.insertBooking.length === 1, "race, ladder full: no second insert when nobody else is free");
    assert(
      calls.deleteEvent.length === calls.createEvent.length && calls.deleteEvent[0].id === "gcal-1",
      "race, ladder full: the first event is still removed",
    );
    assert(calls.moveBusyBlock.length === 0 && calls.webhooks.length === 0, "race, ladder full: no busy block, no webhook");
    // #3272: the refusal's trace names the race stage and the rung the race was lost on.
    const t = refusalTraceOf(err);
    assert(t?.stage === "race_lost" && t.rungs.some((r) => r.code === top), `race, ladder full: the trace says where (got ${JSON.stringify(t)})`);
  }

  // --- #3338: the race was lost on the LAST rung: refused, nothing more to walk ----
  {
    const ladder = tierLadder(input.bucketCode);
    const last = ladder.at(-1)!;
    const { deps, calls } = makeDeps({
      candidatesByCode: { [last]: ["c"] },
      memberCount: 1,
      freeEmails: new Set(["c@x.com"]),
      insertBookingConflictFor: new Set(["c"]),
    });
    const err = await refusal(() => createBooking(input, deps));
    assert(
      err instanceof RaceLostRefusalError && err.ladderExhausted === true && err.boundHit === false,
      `race on the last rung: refused with the ladder spent (got ${String(err)})`,
    );
    assert(calls.insertBooking.length === 1, "race on the last rung: one insert, nobody else to try");
    assert(
      calls.insertBooking[0]?.bucket_id !== undefined && (calls.insertBooking[0].routing_trace as RoutingTrace).bucket_code === last,
      "race on the last rung: the attempt was on the last rung",
    );
  }

  // --- the next advisor cannot be verified: still refused, never guessed ------
  {
    const { deps, calls } = makeDeps({
      candidates: ["a", "b"],
      freeEmails: new Set(["a@x.com"]),
      unverifiedEmails: new Set(["b@x.com"]),
      insertBookingConflictFor: new Set(["a"]),
    });
    const err = await refusal(() => createBooking(input, deps));
    assert(err instanceof SlotUnavailableError, "race, unverifiable: refused as a taken time");
    assert(calls.insertBooking.length === 1, "race, unverifiable: an unverified advisor is never booked");
    // #3338: a check that could not answer is not nobody free, so the rung is not
    // dropped for it, and the refusal does not claim the ladder was spent (L11).
    assert(
      calls.resolveBucketByCode.every((c) => c === input.bucketCode),
      `race, unverifiable: no lower rung is resolved (got ${calls.resolveBucketByCode.join(",")})`,
    );
    assert(err instanceof RaceLostRefusalError && err.ladderExhausted === false, "race, unverifiable: the ladder is not called spent");
  }

  // --- the free check itself fails on the retry: refused, not an outage ---------
  {
    const { deps, calls } = makeDeps({
      candidates: ["a", "b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]),
      insertBookingConflictFor: new Set(["a"]),
    });
    const realVerify = deps.verifyFree;
    let verifies = 0;
    deps.verifyFree = async (emails, s, e) => {
      verifies += 1;
      if (verifies > 1) throw new Error("google 503");
      return realVerify(emails, s, e);
    };
    const err = await refusal(() => createBooking(input, deps));
    assert(err instanceof SlotUnavailableError, "race, check throws: the lead gets the taken time answer they got before");
    assert(calls.insertBooking.length === 1, "race, check throws: nobody unchecked is booked");
    assert(
      !(timeoutAsRetryable(err) instanceof DependencyTimeoutError),
      "race, check throws: an ordinary failure is not called a timeout",
    );
    assert(
      calls.resolveBucketByCode.every((c) => c === input.bucketCode),
      `race, check throws: no lower rung is resolved (got ${calls.resolveBucketByCode.join(",")})`,
    );
    assert(err instanceof RaceLostRefusalError && err.ladderExhausted === false, "race, check throws: the ladder is not called spent");
  }

  // --- #3402: the confirm's budget runs out while checking the next advisor ----
  // That is not a taken time: the lead can retry, and nothing about the slot was
  // learned. So the deadline goes up as itself and becomes the dependency timeout
  // (retryable 503, `dependencyTimeoutAlert`), never the lost race refusal. Both
  // shapes a deadline arrives in: the error itself, and one `unwrap` has quoted
  // inside its own message after PostgREST folded it into `error.message`.
  for (const [shape, deadline] of [
    ["thrown", new DeadlineExceededError("supabase", 0, { label: "the booking confirm", totalMs: 12_000 })],
    [
      "quoted",
      new Error(
        "read failed [users]: DeadlineExceededError: supabase did not answer within 0ms, when the booking confirm ran out of its 12000ms",
      ),
    ],
  ] as const) {
    const { deps, calls } = makeDeps({
      candidates: ["a", "b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]),
      insertBookingConflictFor: new Set(["a"]),
    });
    const realVerify = deps.verifyFree;
    let verifies = 0;
    deps.verifyFree = async (emails, s, e) => {
      verifies += 1;
      if (verifies > 1) throw deadline;
      return realVerify(emails, s, e);
    };
    const err = await refusal(() => createBooking(input, deps));
    assert(err === deadline, `race, deadline (${shape}): the deadline escapes as itself (got ${String(err)})`);
    assert(
      !(err instanceof SlotUnavailableError),
      `race, deadline (${shape}): the lead is not told the time was taken`,
    );
    const mapped = timeoutAsRetryable(err);
    assert(
      mapped instanceof DependencyTimeoutError && mapped.dependency === "supabase" && mapped.timeoutMs === 0,
      `race, deadline (${shape}): it maps to the dependency timeout the page names`,
    );
    assert(calls.insertBooking.length === 1, `race, deadline (${shape}): nobody unchecked is booked`);
    assert(calls.raceBoundHitPages.length === 0, `race, deadline (${shape}): no race page is handed off`);
    assert(
      calls.resolveBucketByCode.every((c) => c === input.bucketCode),
      `race, deadline (${shape}): no lower rung is resolved (got ${calls.resolveBucketByCode.join(",")})`,
    );
  }

  // --- #3338: a lost race on a rung's LAST advisor walks on down the ladder -------
  //
  // The rung below is a different bucket with a LONGER call, so every part of the
  // booking must be rebuilt for the rung that took it (L14, L510): the bucket, the
  // event type, the window, the candidates, the routing trace, the reservation, the
  // event, the routing decision, the slot invalidation and the webhook. Keeping any
  // of them from the rung the race was lost on would name a bucket that did not
  // take the call.
  {
    const [top, lower] = tierLadder(input.bucketCode);
    const longer = { ...eventType, id: "et-lower", name: "Lower Rung Call", duration_min: 45 } as EventType;
    const fixture = {
      rungBuckets: { [top]: { id: "bkt-top" }, [lower]: { id: "bkt-lower", eventType: longer } },
      freeEmails: new Set(["a@x.com", "c@x.com"]),
    };
    const endIso = new Date(Date.parse(input.startIso) + 45 * 60_000).toISOString();
    // Positive control first (L159): with the requested rung EMPTY, an ordinary
    // walk reaches the fixture's lower rung and books its own window.
    {
      const { deps } = makeDeps({ ...fixture, candidatesByCode: { [top]: [], [lower]: ["c"] }, memberCount: 1 });
      const res = await createBooking(input, deps);
      assert(
        res.booking.assigned_user_id === "c" && res.booking.bucket_id === "bkt-lower" && res.booking.ends_at === endIso,
        "control: an ordinary walk books the lower rung's bucket and window",
      );
      assert(
        (res.booking.routing_trace as RoutingTrace).dropped_behind === undefined,
        "control: a drop nobody contended is not marked as dropped behind anybody",
      );
    }
    const { deps, calls } = makeDeps({
      ...fixture,
      candidatesByCode: { [top]: ["a"], [lower]: ["c"] },
      insertBookingConflictFor: new Set(["a"]),
    });
    const res = await createBooking(input, deps);
    assert(res.booking.assigned_user_id === "c", `race, lower rung free: booked with the lower rung's advisor (got ${res.booking.assigned_user_id})`);
    assert(res.newlyInserted === true, "race, lower rung free: a booking this confirm inserted says so");
    assert(
      res.booking.bucket_id === "bkt-lower" && res.booking.event_type_id === "et-lower",
      `race, lower rung free: the row names the lower rung's bucket and event type (got ${res.booking.bucket_id}, ${res.booking.event_type_id})`,
    );
    assert(
      res.booking.starts_at === input.startIso && res.booking.ends_at === endIso && res.booking.original_ends_at === endIso,
      `race, lower rung free: the row holds the lower rung's window (got ${res.booking.starts_at} to ${res.booking.ends_at})`,
    );
    const trace = res.booking.routing_trace as RoutingTrace;
    assert(
      trace.bucket_code === lower && trace.bucket_id === "bkt-lower" && trace.rungs_dropped === 1 && trace.tier_fallback === true,
      `race, lower rung free: the trace names the rung that took it, measured from the requested code (got ${JSON.stringify(trace)})`,
    );
    assert(
      trace.requested_tier === tierKeyOf(input.bucketCode) && trace.booked_tier === tierKeyOf(lower),
      "race, lower rung free: the trace's tiers are the requested and the booked one",
    );
    assert(
      JSON.stringify(trace.considered) === JSON.stringify(["c"]) && trace.chosen_user_id === "c",
      `race, lower rung free: the trace considered the lower rung's candidates (got ${JSON.stringify(trace.considered)})`,
    );
    assert(
      JSON.stringify(trace.race_lost) === JSON.stringify(["a"]),
      `race, lower rung free: the trace records the advisor lost above (got ${JSON.stringify(trace.race_lost)})`,
    );
    assert(trace.dropped_behind === "race", `race, lower rung free: the trace says the drop came after a lost race (got ${trace.dropped_behind})`);
    const lowerWindow = calls.verifyFreeWindows[calls.verifyFree.findIndex((w) => w.includes("c@x.com"))];
    assert(
      lowerWindow?.fromIso === input.startIso && lowerWindow.toIso === endIso,
      `race, lower rung free: the lower advisor is checked live over the lower rung's window (got ${JSON.stringify(lowerWindow)})`,
    );
    const ev = calls.createEvent[1];
    assert(
      calls.createEvent.length === 2 && ev.email === "c@x.com" && ev.args.start === input.startIso && ev.args.end === endIso,
      `race, lower rung free: the event is on the lower advisor's calendar for the lower rung's length (got ${JSON.stringify(ev?.args)})`,
    );
    assert(ev.args.summary.startsWith("Lower Rung Call"), `race, lower rung free: the invite names the lower rung's call (got ${ev.args.summary})`);
    assert(
      calls.deleteEvent.length === 1 && calls.deleteEvent[0].id === "gcal-1",
      "race, lower rung free: the lost attempt's event above is removed",
    );
    assert(
      calls.reservations.length === 2 && calls.reservations[1].pinned_user_id === "c",
      "race, lower rung free: a fresh reservation pins the lower rung's advisor",
    );
    const decision = calls.recordRoutingDecision.at(-1);
    assert(
      decision?.outcome === "booked" &&
        decision.bucketCode === lower &&
        decision.bucketId === "bkt-lower" &&
        decision.rungsDropped === 1 &&
        decision.tierFallback === true &&
        decision.chosenUserId === "c",
      `race, lower rung free: the routing decision names the lower rung (got ${JSON.stringify(decision)})`,
    );
    assert(
      JSON.stringify(calls.invalidateSlots) === JSON.stringify([lower]),
      `race, lower rung free: the slots invalidated are the lower rung's (got ${JSON.stringify(calls.invalidateSlots)})`,
    );
    assert(
      calls.moveBusyBlock.length === 1 && calls.moveBusyBlock[0].userId === "c" && calls.moveBusyBlock[0].endIso === endIso,
      "race, lower rung free: the busy block lands on the lower advisor for the lower rung's window",
    );
    assert(
      calls.webhooks.length === 1 && calls.webhooks[0].bucket_code === lower,
      `race, lower rung free: booking.created fires once, naming the lower rung (got ${JSON.stringify(calls.webhooks.map((w) => w.bucket_code))})`,
    );
  }

  // --- #3338: MAX_RACE_REASSIGNS counts per confirm, across rungs ----------------
  {
    const [top, lower] = tierLadder(input.bucketCode);
    const all = ["a", "b", "c", "d", "e"];
    const { deps, calls } = makeDeps({
      candidatesByCode: { [top]: ["a", "b"], [lower]: ["c", "d", "e"] },
      freeEmails: new Set(all.map((id) => `${id}@x.com`)),
      insertBookingConflictFor: new Set(all),
    });
    const err = await refusal(() => createBooking(input, deps));
    assert(
      err instanceof RaceLostRefusalError && err.boundHit === true && err.lostRaces === 1 + MAX_RACE_REASSIGNS && err.ladderExhausted === false,
      `bound across rungs: refused at the bound, every attempt on both rungs counted (got ${String(err)})`,
    );
    assert(
      calls.insertBooking.length === 1 + MAX_RACE_REASSIGNS,
      `bound across rungs: one first attempt plus at most ${MAX_RACE_REASSIGNS} more in all (got ${calls.insertBooking.length})`,
    );
    assert(
      JSON.stringify(calls.insertBooking.map((r) => r.assigned_user_id)) === JSON.stringify(["a", "b", "c", "d"]),
      `bound across rungs: down the top rung, then the one below, never one advisor twice (got ${calls.insertBooking.map((r) => r.assigned_user_id).join(",")})`,
    );
    assert(calls.raceBoundHitPages.length === 1, "bound across rungs: the bound hit is paged");
  }

  // --- #3338: an advisor who lost a race above is not offered again below ---------
  // The overlap index said they hold the time, whatever the cache read says, and an
  // advisor can sit in more than one rung's pool.
  {
    const [top, lower] = tierLadder(input.bucketCode);
    const { deps, calls } = makeDeps({
      candidatesByCode: { [top]: ["a"], [lower]: ["a", "c"] },
      freeEmails: new Set(["a@x.com", "c@x.com"]),
      insertBookingConflictFor: new Set(["a"]),
    });
    const res = await createBooking(input, deps);
    assert(res.booking.assigned_user_id === "c", `shared advisor: the lower rung books somebody else (got ${res.booking.assigned_user_id})`);
    assert(
      calls.insertBooking.filter((r) => r.assigned_user_id === "a").length === 1,
      "shared advisor: the advisor who lost above is never inserted again",
    );
  }

  // --- #3338: the walk down after a lost race runs only when the time left covers it
  //
  // The cost of one rung is measured on the attempt that just lost (L224): its live
  // check, its reservation, its calendar event and its insert. With less of the
  // confirm's budget left than that, the next rung would be cut off part way,
  // after a live check and a calendar event nobody can use, so the lead is told to
  // retry (the dependency timeout, 503) rather than that the time is taken.
  {
    const [top, lower] = tierLadder(input.bucketCode);
    const realNow = Date.now;
    let clock = Date.parse("2026-06-01T12:00:00.000Z");
    Date.now = () => clock;
    try {
      for (const [label, attemptMs] of [["fast", 1_000], ["slow", 8_000]] as const) {
        const { deps, calls } = makeDeps({
          candidatesByCode: { [top]: ["a"], [lower]: ["c"] },
          freeEmails: new Set(["a@x.com", "c@x.com"]),
          insertBookingConflictFor: new Set(["a"]),
        });
        const writeEvent = deps.createEvent;
        deps.createEvent = async (...args) => {
          clock += attemptMs;
          return writeEvent(...args);
        };
        let booked: Awaited<ReturnType<typeof createBooking>> | null = null;
        const err = await refusal(async () => {
          booked = await withinCallBudget(12_000, "the booking confirm", () => createBooking(input, deps), () => Date.now());
        });
        if (label === "fast") {
          assert(err === null && booked !== null, `budget, ${label} attempt: the confirm walks on and books (got ${String(err)})`);
          assert(calls.verifyFree.flat().includes("c@x.com"), `budget, ${label} attempt: the lower rung's advisor is checked`);
        } else {
          assert(
            err instanceof DependencyTimeoutError && timeoutAsRetryable(err) === err,
            `budget, ${label} attempt: the lead is told to retry, the retryable timeout (got ${String(err)})`,
          );
          assert(!(err instanceof SlotUnavailableError), `budget, ${label} attempt: never told the time is taken`);
          assert(
            !calls.verifyFree.flat().includes("c@x.com") && calls.createEvent.length === 1,
            `budget, ${label} attempt: nothing on the lower rung is started (checks ${JSON.stringify(calls.verifyFree)}, events ${calls.createEvent.length})`,
          );
          assert(calls.deleteEvent.length === 1, `budget, ${label} attempt: the lost attempt's event is still removed`);
        }
      }
    } finally {
      Date.now = realNow;
    }
  }

  // --- #3338: one rung's cost is measured from the rung that lost, not the walk ----
  //
  // The confirm spends 7 seconds dropping the empty top rung, then loses a race on
  // the next rung after a 1 second attempt there. Walking on costs another rung,
  // about 1 second, and 4 are left. Measured from the start of the whole walk the
  // rung would look like 8 seconds and the lead would be told to retry; measured
  // from the rung that lost, it walks on and books on the rung below.
  {
    const [top, second, third] = tierLadder(input.bucketCode);
    const realNow = Date.now;
    let clock = Date.parse("2026-06-01T12:00:00.000Z");
    Date.now = () => clock;
    try {
      const { deps, calls } = makeDeps({
        candidatesByCode: { [top]: [], [second]: ["a"], [third]: ["c"] },
        memberCount: 1,
        freeEmails: new Set(["a@x.com", "c@x.com"]),
        insertBookingConflictFor: new Set(["a"]),
      });
      const read = deps.roundRobinCandidates;
      deps.roundRobinCandidates = async (b, ...rest) => {
        if (b.code === top) clock += 7_000;
        return read(b, ...rest);
      };
      const write = deps.createEvent;
      deps.createEvent = async (...args) => {
        clock += 1_000;
        return write(...args);
      };
      let booked: Awaited<ReturnType<typeof createBooking>> | null = null;
      const err = await refusal(async () => {
        booked = await withinCallBudget(12_000, "the booking confirm", () => createBooking(input, deps), () => Date.now());
      });
      const res = booked as Awaited<ReturnType<typeof createBooking>> | null;
      assert(
        err === null && res?.booking.assigned_user_id === "c",
        `dropped before losing: walks on and books the rung below (got ${String(err)}, ${res?.booking.assigned_user_id})`,
      );
      assert(
        (res?.booking.routing_trace as RoutingTrace | undefined)?.rungs_dropped === 2,
        "dropped before losing: two rungs down from the requested code",
      );
      assert(calls.insertBooking.length === 2, `dropped before losing: one lost insert, one booked (got ${calls.insertBooking.length})`);
    } finally {
      Date.now = realNow;
    }
  }

  // --- #3338: a spent budget is said as spent, never a negative or a zero -----------
  {
    const [top, lower] = tierLadder(input.bucketCode);
    const realNow = Date.now;
    let clock = Date.parse("2026-06-01T12:00:00.000Z");
    Date.now = () => clock;
    try {
      const { deps } = makeDeps({
        candidatesByCode: { [top]: ["a"], [lower]: ["c"] },
        freeEmails: new Set(["a@x.com", "c@x.com"]),
        insertBookingConflictFor: new Set(["a"]),
      });
      const write = deps.createEvent;
      deps.createEvent = async (...args) => {
        clock += 13_500;
        return write(...args);
      };
      const err = await refusal(() =>
        withinCallBudget(12_000, "the booking confirm", () => createBooking(input, deps), () => Date.now()),
      );
      const t = err as DependencyTimeoutError;
      assert(
        t instanceof DependencyTimeoutError && t.timeoutMs === 0 && t.neededMs !== undefined,
        `spent after a lost race: the retry carries no time left, clamped at zero (got ${String(err)}, ${t?.timeoutMs})`,
      );
      const page = dependencyTimeoutAlert(t);
      assert(/had no time left for the tier below a lost race/.test(page), `spent after a lost race: the page says so (got ${page})`);
      assert(!/-\s?\d|\b0ms\b/.test(page), `spent after a lost race: never a negative or a zero (got ${page})`);
    } finally {
      Date.now = realNow;
    }
  }

  // --- #3338: what a refusal tells the confirms waiting behind it ------------------
  //
  // A lost race settles the confirms in line only when it spent the whole ladder.
  // A bound hit or a check that could not answer says nothing about them (L11), so
  // the next one in line runs for itself rather than being told the time is taken.
  {
    const second: CreateBookingInput = {
      ...input,
      salesforceId: "sf2",
      attendee: { name: "Lee", email: "lee@x.com", phone: "+12035550002" },
    };
    const all = ["a", "b", "c", "d", "e"];
    const cases: { label: string; opts: Parameters<typeof makeDeps>[0]; settles: boolean }[] = [
      {
        label: "ladder spent",
        opts: { candidatesByCode: { [input.bucketCode]: ["a"] }, memberCount: 1, freeEmails: new Set(["a@x.com"]), insertBookingConflictFor: new Set(["a"]) },
        settles: true,
      },
      {
        label: "bound hit",
        opts: { candidates: all, freeEmails: new Set(all.map((x) => `${x}@x.com`)), insertBookingConflictFor: new Set(all) },
        settles: false,
      },
      {
        label: "check failed",
        opts: { candidates: ["a", "b"], freeEmails: new Set(["a@x.com"]), unverifiedEmails: new Set(["b@x.com"]), insertBookingConflictFor: new Set(["a"]) },
        settles: false,
      },
    ];
    for (const { label, opts, settles } of cases) {
      const { deps } = makeDeps(opts);
      const [first, behind] = await Promise.all([refusal(() => createBooking(input, deps)), refusal(() => createBooking(second, deps))]);
      assert(first instanceof RaceLostRefusalError, `line, ${label}: the leader is refused after a lost race (got ${String(first)})`);
      const stage = refusalTraceOf(behind)?.stage;
      assert(
        settles ? stage === "follower" : stage !== undefined && stage !== "follower",
        `line, ${label}: the confirm behind it is ${settles ? "answered from the leader's verdict" : "left to run for itself"} (got stage ${stage})`,
      );
    }
  }

  // --- #3338: each reason the next advisor search gives, read directly -----------
  // The unit beneath the tests above: every reason it can return, and that only
  // one of them lets the confirm walk on. It is asked only about a lost race
  // (`attemptReservation` answering `lost`, #3462), so there is no reason for a
  // failure that was not one.
  {
    const base = {
      named: false,
      reservation: { pinned_user_id: "a" } as BookingReservation,
      lostUserId: "a",
      candidates: ["a", "b"],
      lostSoFar: 0,
      startIso: input.startIso,
      endIso: new Date(Date.parse(input.startIso) + 30 * 60_000).toISOString(),
      eventType,
      seat: null,
    };
    type Lost = Parameters<typeof nextAdvisorAfterLostRace>[1];
    const ask = async (over: Partial<Lost>, opts: Parameters<typeof makeDeps>[0] = { freeEmails: new Set(["a@x.com", "b@x.com"]) }) =>
      nextAdvisorAfterLostRace(makeDeps(opts).deps, { ...base, ...over });
    const reasons = new Set<string>();
    const note = (r: Awaited<ReturnType<typeof nextAdvisorAfterLostRace>>) => {
      reasons.add(r.kind === "advisor" ? "advisor" : r.reason);
      return r;
    };
    const next = note(await ask({}));
    assert(next.kind === "advisor" && next.assignment.userId === "b", "reason: the next free advisor after the loser");
    const named = note(await ask({ named: true }));
    assert(named.kind === "none" && named.reason === "named-link", "reason: a named advisor link");
    const adopted = note(await ask({ reservation: { pinned_user_id: "b" } as BookingReservation }));
    assert(adopted.kind === "none" && adopted.reason === "not-chosen-here", "reason: an adopted pin");
    const stranger = note(await ask({ lostUserId: "z", reservation: { pinned_user_id: "z" } as BookingReservation }));
    assert(stranger.kind === "none" && stranger.reason === "not-chosen-here", "reason: a loser the rung never offered");
    const bound = note(await ask({ lostSoFar: MAX_RACE_REASSIGNS }));
    assert(bound.kind === "none" && bound.reason === "bound", "reason: the bound");
    const emptyAfter = note(await ask({ lostUserId: "b", reservation: { pinned_user_id: "b" } as BookingReservation }));
    assert(emptyAfter.kind === "none" && emptyAfter.reason === "rung-exhausted", "reason: nobody after the loser on this rung");
    const busyAfter = note(await ask({}, { freeEmails: new Set(["a@x.com"]) }));
    assert(busyAfter.kind === "none" && busyAfter.reason === "rung-exhausted", "reason: everybody after the loser busy is the same as nobody");
    const unverified = note(await ask({}, { freeEmails: new Set(["a@x.com"]), unverifiedEmails: new Set(["b@x.com"]) }));
    assert(unverified.kind === "none" && unverified.reason === "check-failed", "reason: a check that could not answer");
    const deadline = new DeadlineExceededError("google", 0, { label: "the booking confirm", totalMs: 12_000 });
    {
      const { deps } = makeDeps({ freeEmails: new Set(["a@x.com", "b@x.com"]) });
      deps.verifyFree = async () => {
        throw deadline;
      };
      const timedOut = note(await nextAdvisorAfterLostRace(deps, base));
      assert(timedOut.kind === "none" && timedOut.reason === "deadline" && timedOut.err === deadline, "reason: a deadline, carrying the deadline itself");
    }
    {
      const { deps } = makeDeps({ freeEmails: new Set(["a@x.com", "b@x.com"]) });
      deps.verifyFree = async () => {
        throw new Error("google 503");
      };
      const thrown = note(await nextAdvisorAfterLostRace(deps, base));
      assert(thrown.kind === "none" && thrown.reason === "check-failed", "reason: a check that threw");
    }
    const every = ["advisor", "named-link", "not-chosen-here", "bound", "rung-exhausted", "check-failed", "deadline"];
    assert(
      every.every((r) => reasons.has(r)) && reasons.size === every.length,
      `reason: every reason is produced by a case above (got ${[...reasons].join(",")})`,
    );
  }

  // --- the rung the lead was ALREADY dropped to is the rung retried ------------
  {
    const lower = tierLadder(input.bucketCode)[1];
    const { deps, calls } = makeDeps({
      candidatesByCode: { [input.bucketCode]: [], [lower]: ["c", "d"] },
      freeEmails: new Set(["c@x.com", "d@x.com"]),
      insertBookingConflictFor: new Set(["c"]),
    });
    const res = await createBooking(input, deps);
    assert(res.booking.assigned_user_id === "d", "race after a tier drop: the next advisor in the SAME booked rung");
    assert(
      (res.booking.routing_trace as RoutingTrace).dropped_behind === undefined,
      "race after a tier drop: a race lost on the rung it had already dropped to is not a drop behind a race",
    );
    const trace = res.booking.routing_trace as RoutingTrace;
    assert(trace.bucket_code === lower && trace.rungs_dropped === 1, "race after a tier drop: the trace keeps the rung it booked");
    assert(
      calls.roundRobinPreview.length === 2,
      `race after a tier drop: each rung's pool is read once, so the ladder is not walked again (got ${calls.roundRobinPreview.length})`,
    );
  }

  // --- #2838: a replay returning the existing booking is not a new booking --------
  {
    const existing = makeBooking({
      id: "bk-existing",
      manage_token: "tok-existing",
      routing_trace: { bucket_code: "411", bucket_id: "bkt1", considered: ["a", "b"], chosen_user_id: "b", fallback_applied: false, race_lost: ["a"] },
    });
    const { deps } = makeDeps({ candidates: ["a", "b"], freeEmails: new Set(["a@x.com", "b@x.com"]), existingByKey: existing });
    const res = await createBooking(input, deps);
    assert(res.booking.id === "bk-existing", "replay: the existing booking is returned");
    assert(
      res.newlyInserted !== true,
      "replay: a booking an earlier confirm made is not marked as inserted here, so its race is not counted twice",
    );
  }

  // --- the retry is bounded -----------------------------------------------------
  {
    const all = ["a", "b", "c", "d", "e"];
    assert(MAX_RACE_REASSIGNS < all.length - 1, "fixture: more free advisors than the retry bound allows");
    const { deps, calls } = makeDeps({
      candidates: all,
      freeEmails: new Set(all.map((id) => `${id}@x.com`)),
      insertBookingConflictFor: new Set(all),
    });
    const err = await refusal(() => createBooking(input, deps));
    assert(err instanceof SlotUnavailableError, "race, every insert refused: the lead is asked to pick another time");
    assert(
      err instanceof RaceLostRefusalError && err.boundHit === true && err.lostRaces === 1 + MAX_RACE_REASSIGNS,
      `race bound: refused at the bound, every attempt counted as lost (got ${JSON.stringify(err)})`,
    );
    // #2838: the page goes to the injected dispatcher, never to the real one.
    assert(
      calls.raceBoundHitPages.length === 1 && calls.raceBoundHitPages[0].key === "booking_race_bound_hit",
      `race bound: the bound hit page is handed to the dispatcher once (got ${JSON.stringify(calls.raceBoundHitPages)})`,
    );
    assert(
      calls.insertBooking.length === 1 + MAX_RACE_REASSIGNS,
      `race bound: one first attempt plus at most ${MAX_RACE_REASSIGNS} more (got ${calls.insertBooking.length})`,
    );
    assert(
      new Set(calls.insertBooking.map((r) => r.assigned_user_id)).size === calls.insertBooking.length,
      "race bound: no advisor is tried twice",
    );
    assert(
      calls.deleteEvent.length === calls.createEvent.length,
      `race bound: every event created is removed (${calls.createEvent.length} made, ${calls.deleteEvent.length} removed)`,
    );
    assert(calls.roundRobinPreview.length === 1, "race bound: the pool is resolved once");
  }

  // --- #2838: a dispatcher that throws never turns the 409 into a 500 --------------
  {
    const all = ["a", "b", "c", "d", "e"];
    const { deps, calls } = makeDeps({
      candidates: all,
      freeEmails: new Set(all.map((id) => `${id}@x.com`)),
      insertBookingConflictFor: new Set(all),
      raceBoundPageThrows: true,
    });
    const err = await refusal(() => createBooking(input, deps));
    assert(calls.raceBoundHitPages.length === 1, "throwing dispatcher: it was handed the page");
    assert(
      err instanceof RaceLostRefusalError && err.boundHit === true,
      `throwing dispatcher: the lead still gets the lost race refusal, not the dispatcher's error (got ${String(err)})`,
    );
  }

  // --- a named advisor link that loses is refused, never handed to anybody -----
  {
    const named: CreateBookingInput = { ...input, agentLinkUserId: "b", refuseIfPersonHasCall: false };
    const { deps, calls } = makeDeps({
      candidates: ["a", "b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]),
      insertBookingConflictFor: new Set(["b"]),
    });
    const err = await refusal(() => createBooking(named, deps));
    assert(err instanceof SlotUnavailableError, "named link race: refused");
    assert(calls.insertBooking.length === 1, "named link race: no second advisor is tried");
    assert(!calls.createEvent.some((c) => c.email === "a@x.com"), "named link race: no event on anybody else's calendar");
    assert(calls.deleteEvent.length === 1, "named link race: its own event is removed");
    // #3338: a named link has no ladder, so nothing below it is resolved, and its one
    // advisor taken IS its whole ladder spent.
    assert(
      calls.resolveBucketByCode.every((c) => c === input.bucketCode),
      `named link race: no lower rung is resolved (got ${calls.resolveBucketByCode.join(",")})`,
    );
    assert(err instanceof RaceLostRefusalError && err.ladderExhausted === true, "named link race: its one advisor taken is its ladder spent");
  }

  // --- an adopted same-key reservation is not retried under another name --------
  {
    const winner = {
      id: "resv-other",
      idempotency_key: "k",
      pinned_user_id: "b",
      pinned_agent_email: "b@x.com",
      gcal_client_id: "slateother",
      payload: null,
      status: "pending",
      lease_until: null,
      attempts: 0,
      last_error: null,
      created_at: "",
      updated_at: "",
    } as unknown as BookingReservation;
    const { deps, calls } = makeDeps({
      candidates: ["a", "b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]),
      insertBookingConflictFor: new Set(["a", "b"]),
      reservationWinner: winner,
    });
    // The adopted reservation carries its own payload, so give it ours with b's pin.
    const origInsert = deps.insertReservation;
    deps.insertReservation = async (row) => {
      const got = await origInsert(row);
      return { ...got, payload: { ...row.payload, booking: { ...row.payload.booking, assigned_user_id: "b" } } };
    };
    const err = await refusal(() => createBooking(input, deps));
    assert(err instanceof SlotUnavailableError, "adopted reservation: a lost insert is refused");
    assert(calls.reservations.length === 1, "adopted reservation: no retry under a pin this request did not choose");
    assert(
      calls.resolveBucketByCode.every((c) => c === input.bucketCode),
      `adopted reservation: no lower rung is resolved (got ${calls.resolveBucketByCode.join(",")})`,
    );
    assert(err instanceof RaceLostRefusalError && err.ladderExhausted === false, "adopted reservation: the ladder is not called spent");
  }

  // --- #2549: every attempt carries the answered first name ------------------
  // The retry rebuilds the insert per advisor, so the second row must hold the
  // same first name the lead typed, not fall back to the split.
  {
    const { deps, calls } = makeDeps({
      candidates: ["a", "b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]),
      insertBookingConflictFor: new Set(["a"]),
    });
    await createBooking(
      { ...input, attendee: { ...input.attendee, name: "Mary Jo Smith", firstName: "Mary Jo" } },
      deps,
    );
    assert(
      calls.insertBooking.length === 2 && calls.insertBooking.every((row) => row.attendee_first_name === "Mary Jo"),
      `race: both attempts store the answered first name (got ${JSON.stringify(calls.insertBooking.map((r) => r.attendee_first_name))})`,
    );
  }

  finish();
}

await main();
