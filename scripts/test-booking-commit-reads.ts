// A fresh booking reads its bucket and its advisor ONCE (#3495).
//
// Load run 37640583621 showed a crowd's bookings are limited by how many database
// requests each makes, not by the work inside them (#3492: Postgres was busy 0.4% of
// the time since June while each call took 90 to 200ms). Two of a fresh booking's
// requests read again what it already holds: the bucket, re-resolved for the
// booking.created webhook, and the advisor, read again for the routing decision. The
// confirm passes both into the commit; the reservation drain, which resumes a booking
// it never routed and holds neither, still reads them.
//
// The idempotency key's second read stays: between the confirm's first check and its
// commit, the same submission can complete in another request, and that read is what
// stops a second booking.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booking-commit-reads.ts
import { createBooking, processBookingReservations } from "../src/lib/booking/orchestration.ts";
import type { BookingReservation } from "../src/lib/db/types.ts";
import { createAsserter, makeDeps, makeBooking, input } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

/** The deps with the two reads counted, by what they were asked for. */
function counting(deps: ReturnType<typeof makeDeps>["deps"]) {
  const bucketReads: string[] = [];
  const advisorReads: string[] = [];
  return {
    bucketReads,
    advisorReads,
    deps: {
      ...deps,
      resolveBucketByCode: async (code: string) => {
        bucketReads.push(code);
        return deps.resolveBucketByCode(code);
      },
      getUser: async (userId: string) => {
        advisorReads.push(userId);
        return deps.getUser(userId);
      },
    },
  };
}

async function main() {
  // --- a fresh booking -----------------------------------------------------------
  {
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const c = counting(deps);
    const res = await createBooking(input, c.deps);
    assert(res.booking.id === "bk-new", "fresh: the booking is made");
    assert(c.bucketReads.length === 1, `fresh: the bucket is read once, at the start (got ${JSON.stringify(c.bucketReads)})`);
    assert(c.advisorReads.length === 1, `fresh: the advisor is read once, before the booking is written (got ${JSON.stringify(c.advisorReads)})`);
    // What the two reads fed is still fed, from what the confirm held.
    const created = calls.webhooks.filter((w) => w.event === "booking.created");
    assert(created.length === 1, `fresh: booking.created fires once (got ${created.length})`);
    const decision = calls.recordRoutingDecision.at(-1);
    assert(decision !== undefined && decision.bucketCode === input.bucketCode, `fresh: the routing decision names the booked bucket (got ${decision?.bucketCode})`);
    assert(decision !== undefined && decision.chosenAttributes !== undefined, "fresh: the routing decision carries the chosen advisor's attributes");
  }

  // --- the reservation drain still reads what it does not hold -------------------
  {
    const already = makeBooking({ id: "bk-drain", idempotency_key: "k-drain", assigned_user_id: "a" });
    const reservation: BookingReservation = {
      id: "resv-drain",
      idempotency_key: "k-drain",
      pinned_user_id: "a",
      pinned_agent_email: "a@x.com",
      gcal_client_id: "gcal-drain",
      payload: {
        booking: { idempotency_key: "k-drain" } as never,
        event: {} as never,
        bucketCode: "411",
      },
      status: "pending",
      lease_until: null,
      attempts: 0,
      last_error: null,
      next_attempt_at: null,
      created_at: "",
      updated_at: "",
    } as BookingReservation;
    const { deps, calls } = makeDeps({ drainableReservations: [reservation], existingByKey: already });
    const c = counting(deps);
    const res = await processBookingReservations(c.deps, 15);
    assert(res.completed === 1, "drain: the crashed reservation is completed");
    assert(c.bucketReads.length >= 1, `drain: the bucket is read, since the drain holds none (got ${c.bucketReads.length})`);
    assert(calls.webhooks.filter((w) => w.event === "booking.created").length === 1, "drain: booking.created is redelivered once");
  }

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
