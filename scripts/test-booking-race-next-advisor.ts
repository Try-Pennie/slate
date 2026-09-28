// #2281: a confirm that LOSES the overlap race (#2274) is offered the next
// advisor the same rung of the same bucket already resolved for that instant,
// before the lead is asked to pick another time.
//
// Dan's boundary: "If it's possible to just send it to another advisor in the
// correct bucket/routing rules, we should just do that. If it would require
// cascading or anything we can ask them to pick another time." So the retry uses
// only the candidates already in hand, the same live free check, never a lower
// rung and never a named link, and is bounded.
// Run: node --experimental-strip-types scripts/test-booking-race-next-advisor.ts
import {
  createBooking,
  SlotUnavailableError,
  RaceLostRefusalError,
  MAX_RACE_REASSIGNS,
  type CreateBookingInput,
} from "../src/lib/booking/orchestration.ts";
import { tierLadder } from "../src/lib/routing/tiers.ts";
import type { BookingReservation, RoutingTrace } from "../src/lib/db/types.ts";
import { createAsserter, makeDeps, input } from "./lib/booking-fakes.ts";

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

  // --- nobody else in the rung is free: refused exactly as today -------------
  {
    const { deps, calls } = makeDeps({
      candidates: ["a", "b"],
      freeEmails: new Set(["a@x.com"]),
      insertBookingConflictFor: new Set(["a"]),
    });
    const err = await refusal(() => createBooking(input, deps));
    assert(err instanceof SlotUnavailableError, "race, rung full: the lead is asked to pick another time");
    // #2838: the refusal says it followed a lost race, so the booker can count it
    // apart from a time already taken at the free check, and says the bound was NOT hit.
    assert(
      err instanceof RaceLostRefusalError && err.lostRaces === 1 && err.boundHit === false,
      `race, rung full: refused as a lost race, one lost, bound not hit (got ${JSON.stringify(err)})`,
    );
    assert(calls.insertBooking.length === 1, "race, rung full: no second insert when nobody else is free");
    assert(
      calls.deleteEvent.length === calls.createEvent.length && calls.deleteEvent[0].id === "gcal-1",
      "race, rung full: the first event is still removed",
    );
    assert(calls.moveBusyBlock.length === 0 && calls.webhooks.length === 0, "race, rung full: no busy block, no webhook");
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
  }

  // --- a lower rung is never used ---------------------------------------------
  {
    const lower = tierLadder(input.bucketCode)[1];
    assert(typeof lower === "string" && lower !== input.bucketCode, `fixture: 411 has a lower rung (got ${lower})`);
    const byCode = { [input.bucketCode]: ["a"], [lower]: ["c"] };
    // Positive control first (L159): with the requested rung EMPTY the fixture's
    // lower rung really is reachable, so its absence below is a decision.
    {
      const { deps } = makeDeps({
        candidatesByCode: { [input.bucketCode]: [], [lower]: ["c"] },
        freeEmails: new Set(["a@x.com", "c@x.com"]),
      });
      const res = await createBooking(input, deps);
      assert(res.booking.assigned_user_id === "c", "control: the fixture's lower rung is reachable by the ladder");
    }
    const { deps, calls } = makeDeps({
      candidatesByCode: byCode,
      freeEmails: new Set(["a@x.com", "c@x.com"]),
      insertBookingConflictFor: new Set(["a"]),
    });
    const err = await refusal(() => createBooking(input, deps));
    assert(err instanceof SlotUnavailableError, "race, lower rung free: refused rather than cascaded");
    assert(
      !calls.insertBooking.some((r) => r.assigned_user_id === "c"),
      "race, lower rung free: the lower rung's advisor is never booked",
    );
    assert(
      !calls.verifyFree.flat().includes("c@x.com"),
      "race, lower rung free: the lower rung's advisor is never even checked",
    );
    assert(
      calls.resolveBucketByCode.every((c) => c === input.bucketCode),
      `race, lower rung free: no other rung is resolved (got ${calls.resolveBucketByCode.join(",")})`,
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
    const trace = res.booking.routing_trace as RoutingTrace;
    assert(trace.bucket_code === lower && trace.rungs_dropped === 1, "race after a tier drop: the trace keeps the rung it booked");
    assert(
      calls.roundRobinPreview.length === 2,
      `race after a tier drop: each rung's pool is read once, so the ladder is not walked again (got ${calls.roundRobinPreview.length})`,
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
