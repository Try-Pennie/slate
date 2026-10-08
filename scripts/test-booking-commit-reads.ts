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
import type { BookingReservation, User } from "../src/lib/db/types.ts";
import { createAsserter, makeDeps, makeBooking, input } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

type Deps = ReturnType<typeof makeDeps>["deps"];

/**
 * The deps with the two reads counted, by what they were asked for. Every advisor read
 * answers with a marker naming that advisor in its attributes, so the routing decision
 * can be checked for the advisor it carries (the fakes' advisors carry none).
 */
function counting(deps: Deps) {
  const bucketReads: string[] = [];
  const advisorReads: string[] = [];
  const reservationsWritten: Parameters<Deps["insertReservation"]>[0][] = [];
  return {
    bucketReads,
    advisorReads,
    reservationsWritten,
    deps: {
      ...deps,
      resolveBucketByCode: async (code: string) => {
        bucketReads.push(code);
        return deps.resolveBucketByCode(code);
      },
      getUser: async (userId: string) => {
        advisorReads.push(userId);
        return { ...(await deps.getUser(userId)), attributes: { marker: userId } } as unknown as User;
      },
      insertReservation: async (row: Parameters<Deps["insertReservation"]>[0]) => {
        reservationsWritten.push(row);
        return deps.insertReservation(row);
      },
    },
  };
}

const markerOf = (attributes: unknown) => JSON.stringify(attributes);

async function main() {
  // --- a fresh booking -----------------------------------------------------------
  let written: Parameters<Deps["insertReservation"]>[0] | undefined;
  {
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const c = counting(deps);
    const res = await createBooking(input, c.deps);
    assert(res.booking.id === "bk-new", "fresh: the booking is made");
    assert(JSON.stringify(c.bucketReads) === JSON.stringify([input.bucketCode]), `fresh: the bucket is read once, at the start (got ${JSON.stringify(c.bucketReads)})`);
    assert(JSON.stringify(c.advisorReads) === JSON.stringify(["a"]), `fresh: the advisor is read once, before the booking is written (got ${JSON.stringify(c.advisorReads)})`);
    // What the two reads fed is still fed, from what the confirm held.
    const created = calls.webhooks.filter((w) => w.event === "booking.created");
    assert(created.length === 1, `fresh: booking.created fires once (got ${created.length})`);
    const decision = calls.recordRoutingDecision.at(-1);
    assert(decision?.bucketCode === input.bucketCode, `fresh: the routing decision names the booked bucket (got ${decision?.bucketCode})`);
    assert(
      markerOf(decision?.chosenAttributes) === markerOf({ marker: "a" }),
      `fresh: the routing decision carries the booked advisor's attributes, from the advisor the confirm read (got ${markerOf(decision?.chosenAttributes)})`,
    );
    written = c.reservationsWritten.at(-1);
  }

  // --- a fresh booking a rung down: the held bucket is the rung it booked on -------
  {
    const { deps, calls } = makeDeps({ candidatesByCode: { "411": [], "311": ["c"] }, freeEmails: new Set(["c@x.com"]) });
    const c = counting(deps);
    const res = await createBooking({ ...input, bucketCode: "411" }, c.deps);
    assert(res.booking.assigned_user_id === "c", `rung down: the booking is made on the rung below (got ${res.booking.assigned_user_id})`);
    assert(JSON.stringify(c.bucketReads) === JSON.stringify(["411", "311"]), `rung down: the requested bucket and the rung below are read once each, never again (got ${JSON.stringify(c.bucketReads)})`);
    const decision = calls.recordRoutingDecision.at(-1);
    assert(decision?.bucketCode === "311", `rung down: the routing decision names the rung it booked on (got ${decision?.bucketCode})`);
  }

  // --- the reservation drain still reads what it does not hold -------------------
  // A crash resume: the booking was inserted before the crash.
  {
    const already = makeBooking({ id: "bk-drain", idempotency_key: "k-drain", assigned_user_id: "a" });
    const reservation = {
      id: "resv-drain",
      idempotency_key: "k-drain",
      pinned_user_id: "a",
      pinned_agent_email: "a@x.com",
      gcal_client_id: "gcal-drain",
      payload: { booking: { idempotency_key: "k-drain" }, event: {}, bucketCode: "411" },
      status: "pending",
      lease_until: null,
      attempts: 0,
      last_error: null,
      next_attempt_at: null,
      created_at: "",
      updated_at: "",
    } as unknown as BookingReservation;
    const { deps, calls } = makeDeps({ drainableReservations: [reservation], existingByKey: already });
    const c = counting(deps);
    const res = await processBookingReservations(c.deps, 15);
    assert(res.completed === 1, "drain resume: the crashed reservation is completed");
    assert(JSON.stringify(c.bucketReads) === JSON.stringify(["411"]), `drain resume: the bucket is read exactly once, since the drain holds none (got ${JSON.stringify(c.bucketReads)})`);
    assert(calls.webhooks.filter((w) => w.event === "booking.created").length === 1, "drain resume: booking.created is redelivered once");
  }
  // The drain finishing a reservation itself, from the payload a fresh confirm wrote:
  // it routes the booking, so it reads the advisor for the routing decision.
  {
    assert(written !== undefined, "drain finish: the fresh confirm above wrote a reservation to drain");
    const reservation = {
      ...written,
      id: "resv-finish",
      status: "pending",
      lease_until: null,
      attempts: 0,
      last_error: null,
      next_attempt_at: null,
      created_at: "",
      updated_at: "",
    } as unknown as BookingReservation;
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]), drainableReservations: [reservation] });
    const c = counting(deps);
    const res = await processBookingReservations(c.deps, 15);
    assert(res.completed === 1, `drain finish: the reservation is completed (got ${JSON.stringify(res)})`);
    assert(JSON.stringify(c.bucketReads) === JSON.stringify([input.bucketCode]), `drain finish: the bucket is read exactly once (got ${JSON.stringify(c.bucketReads)})`);
    assert(JSON.stringify(c.advisorReads) === JSON.stringify(["a"]), `drain finish: the advisor is read exactly once, for the routing decision (got ${JSON.stringify(c.advisorReads)})`);
    const decision = calls.recordRoutingDecision.at(-1);
    assert(markerOf(decision?.chosenAttributes) === markerOf({ marker: "a" }), `drain finish: the routing decision carries the advisor it read (got ${markerOf(decision?.chosenAttributes)})`);
  }

  // The two reads the drain makes only feed the webhook and the routing record, which
  // never decided whether a booking is made: before the one call save they ran after
  // the insert, where a failure cost that part alone. So neither may fail the booking.
  const drainable = () =>
    ({
      ...written,
      id: "resv-finish",
      status: "pending",
      lease_until: null,
      attempts: 0,
      last_error: null,
      next_attempt_at: null,
      created_at: "",
      updated_at: "",
    }) as unknown as BookingReservation;
  // An advisor that will not read: the routing record goes in without the advisor's
  // attributes (the misroute check judges nothing it cannot read), and the booking is made.
  {
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]), drainableReservations: [drainable()] });
    const res = await processBookingReservations(
      {
        ...deps,
        getUser: async () => {
          throw new Error("advisor read refused");
        },
      },
      15,
    );
    assert(res.completed === 1, `drain finish, advisor unreadable: the booking is made (got ${JSON.stringify(res)})`);
    assert(calls.insertBooking.length === 1, `and saved once (got ${calls.insertBooking.length})`);
    const decision = calls.recordRoutingDecision.at(-1);
    assert(decision !== undefined && decision.chosenAttributes === null, `and its routing record carries no attributes rather than none at all (got ${JSON.stringify(decision?.chosenAttributes)})`);
    assert(calls.webhooks.filter((w) => w.event === "booking.created").length === 1, "and booking.created goes in");
  }
  // A bucket that will not read: the booking is saved without its webhook, and the
  // reservation STAYS, so the next drain, which reads the bucket again, sends it.
  {
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]), drainableReservations: [drainable()] });
    const res = await processBookingReservations(
      {
        ...deps,
        resolveBucketByCode: async () => {
          throw new Error("bucket read refused");
        },
      },
      15,
    );
    assert(calls.insertBooking.length === 1, `drain finish, bucket unreadable: the booking is saved (got ${calls.insertBooking.length})`);
    assert(calls.webhooks.length === 0, `with no webhook sent at all yet, since it could not be built (got ${JSON.stringify(calls.webhooks.map((w) => w.event))})`);
    assert(calls.deletedReservations.length === 0, "and the reservation stays, so the next drain sends it");
    assert(res.failed === 1, `and the drain counts the unfinished webhook against the reservation, to back off and retry (got ${JSON.stringify(res)})`);
    assert(calls.recordRoutingDecision.length === 0, "a routing record needs the bucket, so none is written, as before");
  }

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
