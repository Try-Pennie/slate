// The #429 P3 outbox: resuming cancel / reschedule / reassign after a mid-flight crash.
//
// Split out of the old 3,229-line scripts/test-booking-orchestration.ts (#605);
// the shared BookingDeps fake lives in scripts/lib/booking-fakes.ts.
// Run: node --experimental-strip-types scripts/test-booking-outbox-resume.ts
import {
  OUTBOX_HANDLERS,
  cancelOutboxSteps,
  rescheduleOutboxSteps,
  reassignOutboxSteps,
} from "../src/lib/booking/orchestration.ts";
import { runOutboxSteps } from "../src/lib/booking/outbox.ts";
import type {
  BookingOutbox,
} from "../src/lib/db/types.ts";
import {
  createAsserter,
  makeDeps,
  makeBooking,
  bucket,
  eventType,
} from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

async function run() {
  // --- outbox cancel resume after a crash (#429 P3) ---
  {
    const ctx = { booking: makeBooking({ status: "cancelled" }), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx });
    // Simulate a crash that finished gcal_delete + busyblock_delete inline, then
    // died before recompute/notify. The drain re-runs the row with those done.
    const steps = cancelOutboxSteps();
    steps[0].state = "done"; // cancel:gcal_delete
    steps[1].state = "done"; // cancel:busyblock_delete
    const row: BookingOutbox = {
      id: "ob-resume",
      booking_id: ctx.booking.id,
      action: "cancel",
      status: "pending",
      steps,
      payload: {
        reasonCode: "no_longer_interested",
        reasonDetail: null,
        initiator: "customer",
        fromStartsIso: ctx.booking.starts_at,
        fromAgentUserId: ctx.booking.assigned_user_id,
      },
      lease_until: null,
      attempts: 0,
      last_error: null,
      created_at: "",
      updated_at: "",
    };
    const res = await runOutboxSteps(deps, row, OUTBOX_HANDLERS);
    assert(res.delivered === true, "resume: the row reaches delivered");
    assert(calls.deleteEvent.length === 0, "resume: does NOT re-delete the already-done gcal event");
    assert(calls.deleteBusyBlocks.length === 0, "resume: does NOT re-delete the already-done busy block");
    assert(calls.invalidateSlots.length === 1, "resume: runs the pending recompute step");
    assert(
      calls.webhooks.length === 1 && calls.webhooks[0].event === "booking.cancelled",
      "resume: fires the pending webhook exactly once",
    );
    assert(
      calls.webhooks[0].deferred === false,
      "#884: the outbox drain sends inline (no scheduler), under its bounded fan-out",
    );
  }

  // --- outbox reschedule resume after a crash (#429 P3) ---
  {
    const rescheduled = {
      booking: makeBooking({
        starts_at: "2026-06-09T14:00:00.000Z",
        ends_at: "2026-06-09T14:30:00.000Z",
        status: "rescheduled",
      }),
      bucket,
      eventType,
    };
    const { deps, calls } = makeDeps({ existing: rescheduled, bookingById: rescheduled });
    // Crash finished busyblock_move, died before recompute/notify; drain resumes.
    const steps = rescheduleOutboxSteps();
    steps[0].state = "done"; // reschedule:busyblock_move
    const row: BookingOutbox = {
      id: "ob-resched-resume",
      booking_id: rescheduled.booking.id,
      action: "reschedule",
      status: "pending",
      steps,
      payload: {
        reasonCode: "schedule_conflict",
        reasonDetail: null,
        initiator: "customer",
        fromStartsIso: "2026-06-08T13:00:00.000Z",
        fromAgentUserId: "a",
      },
      lease_until: null,
      attempts: 0,
      last_error: null,
      created_at: "",
      updated_at: "",
    };
    const res = await runOutboxSteps(deps, row, OUTBOX_HANDLERS);
    assert(res.delivered === true, "resched resume: row reaches delivered");
    assert(calls.moveBusyBlock.length === 0, "resched resume: does NOT re-move the already-done busy block");
    assert(calls.invalidateSlots.length === 1, "resched resume: runs the pending recompute");
    assert(
      calls.webhooks.length === 1 &&
        calls.webhooks[0].event === "booking.rescheduled",
      "resched resume: fires the rescheduled webhook exactly once",
    );
    assert(
      calls.bookingEvents.length === 1 &&
        calls.bookingEvents[0].to_starts_at === "2026-06-09T14:00:00.000Z",
      "resched resume: history records the NEW time as to_starts_at",
    );
  }

  // --- outbox reassign resume after a crash (#429 P3) ---
  {
    const reassigned = {
      booking: makeBooking({ assigned_user_id: "b", status: "rescheduled" }),
      bucket,
      eventType,
    };
    const { deps, calls } = makeDeps({ existing: reassigned, bookingById: reassigned });
    const steps = reassignOutboxSteps();
    steps[0].state = "done"; // reassign:busyblock_move
    const row: BookingOutbox = {
      id: "ob-reassign-resume",
      booking_id: reassigned.booking.id,
      action: "reassign",
      status: "pending",
      steps,
      payload: {
        reasonCode: "contact_owner",
        reasonDetail: null,
        initiator: "system",
        fromStartsIso: reassigned.booking.starts_at,
        fromAgentUserId: "a",
      },
      lease_until: null,
      attempts: 0,
      last_error: null,
      created_at: "",
      updated_at: "",
    };
    const res = await runOutboxSteps(deps, row, OUTBOX_HANDLERS);
    assert(res.delivered === true, "reassign resume: row reaches delivered");
    assert(calls.moveBusyBlock.length === 0, "reassign resume: does NOT re-move the already-done busy block");
    assert(calls.invalidateSlots.length === 1, "reassign resume: runs the pending recompute");
    assert(
      calls.webhooks.length === 1 &&
        calls.webhooks[0].event === "booking.reassigned" &&
        calls.webhooks[0].dedupeKey === "ob-reassign-resume",
      "reassign resume: fires booking.reassigned once, keyed on the outbox row id (#2368)",
    );
    // This row's payload carries no fromAgentEmail, which is exactly the row a
    // drain meets when it resumes a reassign enqueued before #2368 deployed. The
    // outgoing advisor is unknowable from here (the booking already holds the new
    // one), so it must come through as null rather than as whoever the booking
    // names today.
    assert(
      calls.webhooks[0].previousAgentEmail === null,
      "reassign resume: a row enqueued before #2368 reports no previous advisor, rather than the wrong one",
    );
    assert(
      calls.bookingEvents.length === 1 && calls.bookingEvents[0].action === "reassigned",
      "reassign resume: records a 'reassigned' history row",
    );
  }

  // --- outbox reassign resume carrying the outgoing advisor (#2368) ---
  // The other half of the pair above: a row enqueued since #2368 holds the address
  // the swap replaced, and the resumed webhook has to carry it. Without this, a
  // handler that ignored the field entirely would pass the null case happily.
  {
    const reassigned = {
      booking: makeBooking({ assigned_user_id: "b", agent_email: "b@x.com", status: "rescheduled" }),
      bucket,
      eventType,
    };
    const { deps, calls } = makeDeps({ existing: reassigned, bookingById: reassigned });
    const steps = reassignOutboxSteps();
    steps[0].state = "done";
    const row: BookingOutbox = {
      id: "ob-reassign-prev",
      booking_id: reassigned.booking.id,
      action: "reassign",
      status: "pending",
      steps,
      payload: {
        reasonCode: "coverage",
        reasonDetail: "out sick",
        initiator: "admin",
        fromStartsIso: reassigned.booking.starts_at,
        fromAgentUserId: "a",
        fromAgentEmail: "a@x.com",
      },
      lease_until: null,
      attempts: 0,
      last_error: null,
      created_at: "",
      updated_at: "",
    };
    const res = await runOutboxSteps(deps, row, OUTBOX_HANDLERS);
    assert(res.delivered === true, "reassign resume (#2368): row reaches delivered");
    assert(
      calls.webhooks.length === 1 &&
        calls.webhooks[0].event === "booking.reassigned" &&
        calls.webhooks[0].previousAgentEmail === "a@x.com",
      "reassign resume (#2368): the resumed webhook still names the advisor the call moved away from",
    );
    assert(
      (calls.webhooks[0].reason as { code?: string } | null)?.code === "coverage",
      "reassign resume (#2368): the resumed webhook still carries the reason Regal branches on",
    );
  }

}

await run();
finish();
