// #830: a creation orphan is a calendar event that was created on Google, but
// whose booking never persisted (the DB insert failed AND the rollback delete
// also failed), so it was enqueued to pending_event_deletions with a NULL
// booking_id. Today it is only surfaced when the deletion drain gives up after 5
// attempts. checkCreationOrphans surfaces it EARLIER and distinctly, but only
// after verifying the event STILL EXISTS on Google, so an agent who manually
// deleted the stray event (a false orphan) does not generate a noisy alert.
// Run: node --experimental-strip-types scripts/test-creation-orphan-alert.ts
import { checkCreationOrphans } from "../src/lib/booking/orchestration.ts";
import type * as O from "../src/lib/booking/orchestration.ts";
import { eq, assert, finish } from "./lib/harness.ts";

function orphan(id: string, eventId: string): O.PendingEventDeletion {
  return {
    id,
    calendar_email: `agent-${id}@trypennie.com`,
    gcal_event_id: eventId,
    booking_id: null,
    attempts: 0,
    last_error: null,
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
  };
}

// A: still on Google (real orphan, firing reminders). B: agent deleted it (false
// orphan). C: existence check errors (Google blip, cannot confirm this tick).
function deps(existsBy: Record<string, boolean | "throw">): O.BookingDeps {
  const eventExistsCalls: string[] = [];
  const d = {
    // #3215: nobody holds these events, so each is judged on existence alone.
    liveBookingHoldingEvent: async () => null,
    reservationPinsEvent: async () => false,
    loadCreationOrphans: async (_limit: number) => [
      orphan("A", "evt-A"),
      orphan("B", "evt-B"),
      orphan("C", "evt-C"),
    ],
    eventExists: async (_email: string, eventId: string) => {
      eventExistsCalls.push(eventId);
      const v = existsBy[eventId];
      if (v === "throw") throw new Error("google blip");
      return v ?? false;
    },
  } as unknown as O.BookingDeps;
  (d as unknown as { eventExistsCalls: string[] }).eventExistsCalls = eventExistsCalls;
  return d;
}

await (async () => {
  const d = deps({ "evt-A": true, "evt-B": false, "evt-C": "throw" });
  const res = await checkCreationOrphans(d, 20);

  eq(res.scanned, 3, "scanned all three null-booking_id rows");
  eq(res.confirmed.map((r) => r.gcal_event_id), ["evt-A"], "only the event confirmed present on Google is alerted");
  assert(
    !res.confirmed.some((r) => r.gcal_event_id === "evt-B"),
    "an agent-deleted event (false orphan) is NOT alerted",
  );
  assert(
    !res.confirmed.some((r) => r.gcal_event_id === "evt-C"),
    "an unverifiable event (existence check errored) is NOT alerted this tick",
  );
})();

// Nothing to do: no null-booking_id rows means no existence probes and no alert.
await (async () => {
  const d = {
    loadCreationOrphans: async () => [],
    eventExists: async () => {
      throw new Error("must not be probed when there are no orphans");
    },
  } as unknown as O.BookingDeps;
  const res = await checkCreationOrphans(d, 20);
  eq(res.scanned, 0, "no orphans scanned");
  eq(res.confirmed.length, 0, "no orphans confirmed");
})();

finish();
