// A booking made through an agent's own named link (#2073): the booker with the
// pool resolution removed.
//
// What it must still do: every availability gate for that ONE agent (the
// candidate list runs the shared predicate), verify on book against live Google
// for that agent alone, the reservation backed write, the invite and the webhook,
// and refuse an exact double submit. What it must NOT do: route (no tier ladder,
// no other agent), apply the one call per person rule (#1337), or record a
// routing decision the catch all rate and the routing analytics would count.
// Run: node --experimental-strip-types scripts/test-agent-link-booking.ts
import {
  createBooking,
  rescheduleBooking,
  idempotencyCodeFor,
  SlotUnavailableError,
  VerifyUnavailableError,
  type CreateBookingInput,
} from "../src/lib/booking/orchestration.ts";
import {
  createAsserter,
  makeDeps,
  makeBooking,
  bucket,
  eventType,
  input,
  RR,
  NOW,
} from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

const named: CreateBookingInput = { ...input, agentLinkUserId: "b", refuseIfPersonHasCall: false };

async function run() {
  // --- books the named agent, and only them -------------------------------------
  {
    const { deps, calls } = makeDeps({
      candidates: ["a", "b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]),
    });
    const res = await createBooking(named, deps);
    assert(res.booking.assigned_user_id === "b", "the named agent is booked, even with another agent free and first in line");
    assert(
      calls.roundRobinOnly.length === 1 && calls.roundRobinOnly[0] === "b",
      "the candidate list is asked for that one agent, so every gate runs for them alone",
    );
    assert(
      calls.verifyFree.length === 1 && calls.verifyFree[0].length === 1 && calls.verifyFree[0][0] === "b@x.com",
      "verify on book asks live Google about that one agent",
    );
    const row = calls.insertBooking[0];
    assert(row.kind === "agent_link", "the row records it was booked through a named link");
    assert(row.routing_trace === null, "no routing trace is recorded, because nothing was routed");
    assert(calls.recordRoutingDecision.length === 0, "no routing decision is logged, so the catch all rate and routing analytics never see it");
    assert(calls.createEvent.length === 1 && calls.createEvent[0].email === "b@x.com", "the invite goes out on the named agent's calendar");
    const created = calls.webhooks.filter((w) => w.event === "booking.created");
    assert(created.length === 1, "booking.created still fires, as for any booking");
    assert(
      created[0].bookingKind === "agent_link",
      "the webhook says the booking came through a named link",
    );
    assert(
      created[0].routing === null,
      "the webhook carries no routing summary, never a fabricated 'no fallback' outcome for a booking nothing routed",
    );
    // #3495: the webhook reuses the bucket the confirm resolved, so the one resolve is the
    // confirm's own; a walk down the tier ladder would add one a rung.
    assert(
      calls.resolveBucketByCode.length === 1,
      `one bucket resolve, the confirm's own, never a walk down the tier ladder (got ${calls.resolveBucketByCode.length})`,
    );
  }

  // --- #3739: a bare advisor link takes the Lead id from the lead's earlier booking ---
  {
    const LEAD = "00Q8c00001AbCdEFGH";
    const bare: CreateBookingInput = { ...named, salesforceId: null, prefill: { source: "agent-direct" } };
    const earlier = {
      id: "earlier1",
      created_at: "2026-10-04T12:00:00Z",
      salesforce_id: LEAD,
      external_id: null,
      attendee_email: "K@x.com",
      attendee_phone: "+12035615295",
      assigned_user_id: "b",
    };
    {
      const { deps, calls } = makeDeps({ candidates: ["b"], freeEmails: new Set(["b@x.com"]), earlierLeadBookings: [earlier] });
      await createBooking(bare, deps);
      const row = calls.insertBooking[0];
      assert(row.salesforce_id === LEAD, `a bare link booking is saved under the Lead id its earlier booking carries (got ${row.salesforce_id})`);
      assert(row.prefill?.leadIdFrom === "earlier-booking", "the row records that the id was inferred from an earlier booking");
      assert(
        calls.earlierLeadBookings.length === 1 && calls.earlierLeadBookings[0].isTest === false,
        "the earlier bookings are read once, in the bucket's own world",
      );
      const created = calls.webhooks.filter((w) => w.event === "booking.created");
      assert(created.length === 1, "the booking still fires its one created webhook");
    }
    {
      // Two earlier bookings naming different Leads: none is saved.
      const { deps, calls } = makeDeps({
        candidates: ["b"],
        freeEmails: new Set(["b@x.com"]),
        earlierLeadBookings: [earlier, { ...earlier, id: "earlier2", salesforce_id: "00Q8c00001ZyXwVUTS" }],
      });
      const res = await createBooking(bare, deps);
      const row = calls.insertBooking[0];
      assert(row.salesforce_id === null, "two earlier bookings with different Lead ids save none, never a guess");
      assert(!("leadIdFrom" in (row.prefill ?? {})), "nothing is recorded as inferred when nothing was");
      assert(res.booking.assigned_user_id === "b", "the lead is still booked");
    }
    {
      // The earlier bookings read fails: the lead is booked, with no id.
      const { deps, calls } = makeDeps({ candidates: ["b"], freeEmails: new Set(["b@x.com"]), earlierLeadBookingsThrows: true });
      const res = await createBooking(bare, deps);
      assert(res.booking.assigned_user_id === "b", "a failed earlier bookings read never refuses the lead");
      assert(calls.insertBooking[0].salesforce_id === null, "a failed read books with no id rather than a guessed one");
    }
    {
      // An id on the link wins, and the earlier bookings are never asked.
      const { deps, calls } = makeDeps({ candidates: ["b"], freeEmails: new Set(["b@x.com"]), earlierLeadBookings: [earlier] });
      await createBooking({ ...bare, salesforceId: "00Q8c00001LinkIdAAA", prefill: { source: "agent-direct", leadIdFrom: "earlier-booking" } }, deps);
      const row = calls.insertBooking[0];
      assert(row.salesforce_id === "00Q8c00001LinkIdAAA", "the link's own id is saved as carried");
      assert(row.prefill?.leadIdFrom === "link", "a posted provenance is replaced by the server's: the id came from the link");
      assert(calls.earlierLeadBookings.length === 0, "a link carrying an id never reads earlier bookings");
    }
    {
      // A routed confirm never infers, and a posted provenance is dropped.
      const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]), earlierLeadBookings: [earlier] });
      await createBooking({ ...input, salesforceId: null, prefill: { xbc: "411", leadIdFrom: "earlier-booking" } }, deps);
      const row = calls.insertBooking[0];
      assert(row.salesforce_id === null && calls.earlierLeadBookings.length === 0, "a routed booking never takes an id from earlier bookings");
      assert(!("leadIdFrom" in (row.prefill ?? {})), "a client cannot forge the provenance key on a routed booking");
    }
  }

  // --- a routed booking is recorded as routed ---------------------------------
  {
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    await createBooking(input, deps);
    assert(calls.insertBooking[0].kind === "routed", "an ordinary confirm records a routed booking");
    assert(calls.roundRobinOnly[0] === undefined, "an ordinary confirm asks for the whole pool");
    assert(calls.recordRoutingDecision.length === 1, "an ordinary confirm still logs its routing decision");
    const routedCreated = calls.webhooks.find((w) => w.event === "booking.created");
    assert(
      routedCreated !== undefined && routedCreated.routing !== null && typeof routedCreated.routing === "object",
      "an ordinary confirm's webhook still carries its routing summary",
    );
  }

  // --- the one call per person rule does not apply ------------------------------
  {
    const { deps, calls } = makeDeps({
      candidates: ["b"],
      freeEmails: new Set(["b@x.com"]),
      personBookings: [makeBooking({ id: "bk-existing", starts_at: "2026-06-09T13:00:00.000Z" })],
    });
    // Even a caller that asks for the rule does not get it on a named link: the
    // later call with a lead who already has one is the exception the rule exists
    // to allow.
    const res = await createBooking({ ...named, refuseIfPersonHasCall: true }, deps);
    assert(res.booking.id === "bk-new", "a lead who already holds a call can book a second one through a named link");
    assert(calls.findActiveBookingsForPerson.length === 0, "the person lookup is not even asked");
  }

  // --- an exact double submit collapses onto the first --------------------------
  {
    const first = makeBooking({ id: "bk-first", assigned_user_id: "b", kind: "agent_link" });
    const { deps, calls } = makeDeps({ candidates: ["b"], freeEmails: new Set(["b@x.com"]), existingByKey: first });
    const res = await createBooking(named, deps);
    assert(res.booking.id === "bk-first", "a retry of the same submit returns the booking already made");
    assert(calls.insertBooking.length === 0 && calls.createEvent.length === 0, "and creates nothing");
  }
  {
    // The key is the agent's, never the bucket's: a routed booking and a named one
    // for the same person at the same instant are different submits.
    const routedKey = idempotencyCodeFor(input);
    const namedKey = idempotencyCodeFor(named);
    assert(routedKey !== namedKey, "the idempotency code of a named booking differs from a routed one in the same bucket");
    assert(namedKey === idempotencyCodeFor({ ...named, bucketCode: "999" }), "and does not move if the agent's bucket changes between retries");
  }

  // --- the named agent cannot take the time -----------------------------------------
  {
    const { deps, calls } = makeDeps({ candidates: ["a"], memberCount: 1, freeEmails: new Set(["a@x.com"]) });
    let err: unknown = null;
    try {
      await createBooking(named, deps);
    } catch (e) {
      err = e;
    }
    assert(err instanceof SlotUnavailableError, "the named agent off shift or busy is a taken slot, never another agent");
    assert(calls.insertBooking.length === 0, "nothing is written");
    assert(calls.recordRoutingDecision.length === 0, "a refused named booking logs no routing decision either");
  }
  {
    // No schedule row at all: the pool size is zero. For a pool that pages as a
    // misconfigured bucket; for one named agent it is the same as busy.
    const { deps } = makeDeps({ candidates: [], memberCount: 0 });
    let err: unknown = null;
    try {
      await createBooking(named, deps);
    } catch (e) {
      err = e;
    }
    assert(err instanceof SlotUnavailableError, "an agent with nothing to offer is a taken slot, never a misconfigured bucket page");
  }
  {
    const { deps } = makeDeps({
      candidates: ["b"],
      freeEmails: new Set<string>(),
      unverifiedEmails: new Set(["b@x.com"]),
    });
    let err: unknown = null;
    try {
      await createBooking(named, deps);
    } catch (e) {
      err = e;
    }
    assert(err instanceof VerifyUnavailableError, "a calendar Google would not read is a retriable outage, never a taken slot");
  }

  // --- moving a named booking keeps its agent or refuses ---------------------------
  {
    const ctx = { booking: makeBooking({ kind: "agent_link", assigned_user_id: "a" }), bucket, eventType };
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: ctx,
      candidates: ["b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]),
      // A is off shift at the new time, which reroutes a routed booking to B.
      workingHoursByUser: new Map([
        ["a", { timezone: "America/New_York", rules: [{ weekday: 1, start_minute: 9 * 60, end_minute: 810 }] }],
      ]),
    });
    let err: unknown = null;
    try {
      await rescheduleBooking("tok1", "2026-06-08T18:00:00.000Z", RR, "customer", deps, NOW);
    } catch (e) {
      err = e;
    }
    assert(err instanceof SlotUnavailableError, "a named booking the agent cannot take at the new time is refused, never moved to somebody else");
    assert(calls.roundRobinPreview.length === 0, "no pool is consulted for a named booking's move");
    assert(calls.commitReschedule.length === 0, "nothing is committed");
  }
  {
    const ctx = { booking: makeBooking({ kind: "agent_link", assigned_user_id: "a" }), bucket, eventType };
    const { deps } = makeDeps({
      existing: ctx,
      bookingById: ctx,
      freeEmails: new Set(["a@x.com"]),
      busyReadFailEmails: new Set(["a@x.com"]),
    });
    let err: unknown = null;
    try {
      await rescheduleBooking("tok1", "2026-06-08T14:00:00.000Z", RR, "customer", deps, NOW);
    } catch (e) {
      err = e;
    }
    assert(err instanceof VerifyUnavailableError, "an unreadable calendar on a named move is a retriable outage");
  }
  {
    // The control: the same move on a ROUTED booking still reroutes, so the refusal
    // above is the named kind's and not a broken fixture.
    const ctx = { booking: makeBooking({ assigned_user_id: "a" }), bucket, eventType };
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: ctx,
      candidates: ["b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]),
      workingHoursByUser: new Map([
        ["a", { timezone: "America/New_York", rules: [{ weekday: 1, start_minute: 9 * 60, end_minute: 810 }] }],
      ]),
    });
    await rescheduleBooking("tok1", "2026-06-08T18:00:00.000Z", RR, "customer", deps, NOW);
    assert(calls.roundRobinPreview.length === 1, "a routed booking in the same fixture reroutes");
  }

  finish();
}

run();
