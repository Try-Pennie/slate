// #518: crash-safe standalone reassign create. The durable reassign_intents
// intent written BEFORE the Google create, recorded with the replaced event
// AFTER the swap, deleted on success, and cleaned by the abandoned-intent sweep.
//
// Node-native (scripts/test-*.ts); shared BookingDeps fake in scripts/lib/booking-fakes.ts.
// Run: node --experimental-strip-types scripts/test-reassign-intents.ts
import {
  reassignBooking,
  processAbandonedReassignIntents,
  type BookingDeps,
  type AbandonedReassignIntent,
} from "../src/lib/booking/orchestration.ts";
import type { User } from "../src/lib/db/types.ts";
import { createAsserter, makeDeps, makeBooking, bucket, eventType, SYS } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();
const OWNER_B = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;

async function run() {
  // --- ordering invariant: the intent is written BEFORE the Google create ---
  // The whole durability property is "record intent, THEN create the event." A
  // createEvent that fires before any intent row exists reintroduces the #518 gap,
  // so the fake throws in that case and the reassign would fail.
  {
    const { deps, calls } = makeDeps({
      bookingById: { booking: makeBooking({}), bucket, eventType },
      agentByEmail: OWNER_B,
    });
    const origCreate = deps.createEvent;
    deps.createEvent = async (email, args, clientId) => {
      assert(
        calls.reassignIntents.length === 1,
        "reassign-intent: writeReassignIntent runs BEFORE createEvent",
      );
      return origCreate(email, args, clientId);
    };
    const res = await reassignBooking("bk1", "b@x.com", SYS, deps);
    assert(res.booking.assigned_user_id === "b", "reassign-intent: reassign still succeeds");
    assert(
      calls.reassignIntents[0]?.pinnedAgentEmail === "b@x.com" &&
        calls.reassignIntents[0]?.gcalClientId === calls.createEvent[0]?.clientId,
      "reassign-intent: intent pins the target agent + the new event's client id",
    );
  }

  // --- after the swap, the replaced old event is recorded on the intent ---
  {
    const { deps, calls } = makeDeps({
      bookingById: { booking: makeBooking({ gcal_event_id: "gcal-old" }), bucket, eventType },
      agentByEmail: OWNER_B,
    });
    await reassignBooking("bk1", "b@x.com", SYS, deps);
    assert(
      calls.reassignIntentPrev.length === 1 &&
        calls.reassignIntentPrev[0].prevGcalEventId === "gcal-old",
      "reassign-intent: the replaced old event is recorded on the intent after the swap",
    );
  }

  // --- happy path deletes the intent (ephemeral; nothing left for the sweep) ---
  {
    const { deps, calls } = makeDeps({
      bookingById: { booking: makeBooking({}), bucket, eventType },
      agentByEmail: OWNER_B,
    });
    const res = await reassignBooking("bk1", "b@x.com", SYS, deps);
    assert(res.booking.assigned_user_id === "b", "reassign-intent(happy): moved");
    assert(
      calls.reassignIntentDeletes.length === 1 &&
        calls.reassignIntentDeletes[0].gcalClientId === calls.createEvent[0]?.clientId,
      "reassign-intent(happy): the intent is deleted on success",
    );
  }

  // --- a terminal swap deletes the intent (no orphaned row for the sweep) ---
  {
    const { deps, calls } = makeDeps({
      bookingById: { booking: makeBooking({}), bucket, eventType },
      agentByEmail: OWNER_B,
      reassignSwapTerminal: true,
    });
    let threw = false;
    try {
      await reassignBooking("bk1", "b@x.com", SYS, deps);
    } catch {
      threw = true;
    }
    assert(threw, "reassign-intent(terminal): surfaces the error");
    assert(
      calls.reassignIntentDeletes.length === 1,
      "reassign-intent(terminal): the intent is deleted when the swap doesn't take",
    );
  }

  // --- a swap RPC error deletes the intent too ---
  {
    const { deps, calls } = makeDeps({
      bookingById: { booking: makeBooking({}), bucket, eventType },
      agentByEmail: OWNER_B,
      reassignSwapThrows: true,
    });
    try {
      await reassignBooking("bk1", "b@x.com", SYS, deps);
    } catch {
      /* expected */
    }
    assert(
      calls.reassignIntentDeletes.length === 1,
      "reassign-intent(rpc error): the intent is deleted when the swap throws",
    );
  }

  // --- SWEEP: an abandoned NEW-event orphan is deleted AND counted as dropped ---
  // Crash between create and swap: the booking still points at the OLD event, so
  // the intent's new event was never adopted. The sweep deletes the orphan and
  // reports it dropped (a contact-owner reassign was silently lost -> the service
  // wrapper alerts on dropped > 0, per "fail loud").
  {
    const intent: AbandonedReassignIntent = {
      booking_id: "bk1",
      pinned_agent_email: "b@x.com",
      gcal_client_id: "gcal-new-orphan",
      prev_agent_email: null,
      prev_gcal_event_id: null,
      swapped_at: null, // the swap never committed => genuinely lost
      booking_gcal_event_id: "gcal-old", // booking still on the old event => not adopted
    };
    const { deps, calls } = makeDeps({ abandonedReassignIntents: [intent] });
    const result = await processAbandonedReassignIntents(deps, 0);
    assert(
      calls.enqueueEventDeletion.length === 1 &&
        calls.enqueueEventDeletion[0].eventId === "gcal-new-orphan" &&
        calls.enqueueEventDeletion[0].email === "b@x.com",
      "reassign-sweep: the abandoned new-event orphan is enqueued for deletion",
    );
    assert(
      result.dropped === 1,
      "reassign-sweep: a genuinely-lost reassign is counted as dropped (fail-loud signal)",
    );
    assert(
      calls.reassignIntentDeletes.length === 1,
      "reassign-sweep: the intent row is removed after cleanup",
    );
  }

  // --- SWEEP: a recorded OLD event (post-swap crash) is cleaned, NOT dropped ---
  // Crash after the swap committed but before delete-old: the booking is on the
  // NEW event (reassign succeeded), and the recorded prev old event is the orphan.
  {
    const intent: AbandonedReassignIntent = {
      booking_id: "bk1",
      pinned_agent_email: "b@x.com",
      gcal_client_id: "gcal-new",
      prev_agent_email: "a@x.com",
      prev_gcal_event_id: "gcal-old",
      swapped_at: "2026-07-13T12:00:00.000Z",
      booking_gcal_event_id: "gcal-new", // booking adopted the new event => reassign succeeded
    };
    const { deps, calls } = makeDeps({ abandonedReassignIntents: [intent] });
    const result = await processAbandonedReassignIntents(deps, 0);
    assert(
      calls.enqueueEventDeletion.length === 1 &&
        calls.enqueueEventDeletion[0].eventId === "gcal-old" &&
        calls.enqueueEventDeletion[0].email === "a@x.com",
      "reassign-sweep: the replaced old event is enqueued for deletion",
    );
    assert(
      result.dropped === 0,
      "reassign-sweep: a succeeded-but-uncleaned reassign is NOT counted as dropped (no false alert)",
    );
  }

  // --- SWEEP: adoption guard never deletes the booking's live event ---
  {
    const intent: AbandonedReassignIntent = {
      booking_id: "bk1",
      pinned_agent_email: "b@x.com",
      gcal_client_id: "gcal-live",
      prev_agent_email: null,
      prev_gcal_event_id: null,
      swapped_at: null,
      booking_gcal_event_id: "gcal-live", // the intent's event IS the live one
    };
    const { deps, calls } = makeDeps({ abandonedReassignIntents: [intent] });
    await processAbandonedReassignIntents(deps, 0);
    assert(
      calls.enqueueEventDeletion.length === 0,
      "reassign-sweep: the booking's live event is never deleted (adoption guard)",
    );
    assert(
      calls.reassignIntentDeletes.length === 1,
      "reassign-sweep: the stale intent row is still removed",
    );
  }

  // --- SWEEP (#758): ADOPTED-THEN-SUPERSEDED is not a dropped reassign ---
  // The chained crash: reassign #1 committed its swap and recorded prev, then crashed
  // before deleting its intent. Reassign #2 then moved the booking to a THIRD agent
  // before the sweep ran. Intent #1's new event is no longer the live one, which used
  // to be read as "never adopted" -> dropped -> a Slack alert saying a reassign was
  // silently lost and must be re-run. It was not lost. It succeeded and was superseded.
  // `swapped_at` is written ONLY after a committed swap, so it tells the two apart.
  {
    const intent: AbandonedReassignIntent = {
      booking_id: "bk1",
      pinned_agent_email: "b@x.com",
      gcal_client_id: "gcal-new-1",
      prev_agent_email: "a@x.com",
      prev_gcal_event_id: "gcal-old",
      swapped_at: "2026-07-13T12:00:00.000Z", // the swap COMMITTED
      booking_gcal_event_id: "gcal-new-2", // ...but a later reassign moved it on again
    };
    const { deps, calls } = makeDeps({ abandonedReassignIntents: [intent] });
    const result = await processAbandonedReassignIntents(deps, 0);
    assert(
      result.dropped === 0,
      "reassign-sweep(#758): an adopted-then-superseded reassign is NOT counted as dropped",
    );
    // Cleanup is unchanged: the superseded event is still an orphan worth deleting.
    assert(
      calls.enqueueEventDeletion.some((c) => c.eventId === "gcal-new-1"),
      "reassign-sweep(#758): still cleans up the superseded event",
    );
    assert(
      calls.reassignIntentDeletes.length === 1,
      "reassign-sweep(#758): still removes the stale intent row",
    );
  }

  // The signal must stay LOUD for the case it exists for: a swap that never committed
  // is still a genuinely-lost reassign, even once a later reassign moved the booking.
  {
    const intent: AbandonedReassignIntent = {
      booking_id: "bk1",
      pinned_agent_email: "b@x.com",
      gcal_client_id: "gcal-never-adopted",
      prev_agent_email: null,
      prev_gcal_event_id: null,
      swapped_at: null, // never committed
      booking_gcal_event_id: "gcal-somewhere-else",
    };
    const { deps } = makeDeps({ abandonedReassignIntents: [intent] });
    const result = await processAbandonedReassignIntents(deps, 0);
    assert(
      result.dropped === 1,
      "reassign-sweep(#758): a never-committed reassign is STILL counted as dropped",
    );
  }
}

// Assert the sweep export exists so a refactor that drops it fails loudly here.
void (processAbandonedReassignIntents as (deps: BookingDeps, graceMs: number) => unknown);

await run();
finish();
