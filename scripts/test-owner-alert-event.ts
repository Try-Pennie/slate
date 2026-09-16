// #2371: the advisor only "previously pitched" alert on the owner's calendar.
//
// The Pipedream flow it replaces put the LEAD'S EMAIL in the title of an event on the
// advisor's calendar. Slate's version carries no lead detail at all, is marked free so
// it can never move availability, and is a row in `owner_alert_events` before it is
// anything on Google, so a crash between the two leaves a row pointing at nothing
// rather than an event nothing points at (L421).
//
// Every lifecycle exit is driven here, through the real outbox executor over the real
// step lists, because the thing worth pinning is what a DRAIN does with each action's
// row, not what a helper returns.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-owner-alert-event.ts
import {
  OUTBOX_HANDLERS,
  cancelOutboxSteps,
  rescheduleOutboxSteps,
  reassignOutboxSteps,
  completePastBookings,
} from "../src/lib/booking/orchestration.ts";
import { runOutboxSteps } from "../src/lib/booking/outbox.ts";
import {
  OWNER_ALERT_COLOR_ID,
  OWNER_ALERT_MINUTES,
  OWNER_ALERT_REASON_CODE,
  OWNER_ALERT_TITLE,
  isOwnerAlertReassign,
  ownerAlertBody,
} from "../src/lib/booking/owner-alert.ts";
import { isBusyEvent } from "../src/lib/google/sync-core.ts";
import type { BookingOutbox, OutboxPayload } from "../src/lib/db/types.ts";
import {
  assert,
  eq,
  finish,
} from "./lib/harness.ts";
import {
  makeDeps,
  makeBooking,
  bucket,
  eventType,
} from "./lib/booking-fakes.ts";

const OWNER_PAYLOAD: OutboxPayload = {
  reasonCode: OWNER_ALERT_REASON_CODE,
  reasonDetail: null,
  initiator: "system",
  fromAgentUserId: "a",
};

/** A booking already moved onto owner "b" (b@x.com), as the swap leaves it. */
function ownedBooking(over: Record<string, unknown> = {}) {
  return {
    booking: makeBooking({
      assigned_user_id: "b",
      agent_email: "b@x.com",
      agent_name: "Owner B",
      status: "rescheduled",
      ...over,
    }),
    bucket,
    eventType,
  };
}

function row(
  action: "reassign" | "cancel" | "reschedule",
  steps: { name: string; state: string }[],
  payload: OutboxPayload,
  id = `ob-${action}`,
): BookingOutbox {
  return {
    id,
    booking_id: "bk1",
    action,
    status: "pending",
    steps,
    payload,
    lease_until: null,
    attempts: 0,
    last_error: null,
    next_attempt_at: null,
    created_at: "",
    updated_at: "",
  } as unknown as BookingOutbox;
}

const run = (deps: unknown, r: BookingOutbox) =>
  runOutboxSteps(deps as never, r, OUTBOX_HANDLERS, "lease-tok");

async function main() {
  // --- the gate: only a MACHINE owner reassign -----------------------------
  {
    eq(
      isOwnerAlertReassign({ initiator: "system", reasonCode: OWNER_ALERT_REASON_CODE }),
      true,
      "gate: a system reassign with the owner reason is the alert case",
    );
    eq(
      isOwnerAlertReassign({ initiator: "admin", reasonCode: OWNER_ALERT_REASON_CODE }),
      false,
      "gate: an ADMIN choosing the owner reason is not (a manager coverage move)",
    );
    eq(
      isOwnerAlertReassign({ initiator: "system", reasonCode: "coverage" }),
      false,
      "gate: a system reassign for another reason is not",
    );
    eq(
      isOwnerAlertReassign({ reasonCode: OWNER_ALERT_REASON_CODE }),
      true,
      "gate: an unset initiator is the machine path, matching the notify step's default",
    );
  }

  // --- the happy path: a row, then the event, then the id -------------------
  {
    const ctx = ownedBooking();
    const { deps, calls } = makeDeps({ existing: ctx, bookingById: ctx });
    const res = await run(deps, row("reassign", reassignOutboxSteps(), OWNER_PAYLOAD));

    assert(res.delivered === true, "create: the reassign row reaches delivered");
    eq(calls.ownerAlertRows.length, 1, "create: exactly one owner_alert_events row");
    const stored = calls.ownerAlertRows[0];
    eq(stored.user_id, "b", "create: the row belongs to the NEW owner");
    eq(stored.calendar_id, "b@x.com", "create: the row names the owner's own calendar");
    eq(stored.removed_at, null, "create: the row is live");
    eq(calls.ownerAlertCreates.length, 1, "create: exactly one calendar write");
    const write = calls.ownerAlertCreates[0];
    eq(write.actorEmail, "b@x.com", "create: written as the owner, on their own calendar");
    eq(stored.gcal_event_id, write.eventId, "create: the event id is stored back on the row");

    // The body AS SHIPPED, not as a builder returns it in isolation: the step is what
    // fills in every value, so a placeholder that only the step supplies (a base URL,
    // an id) is only visible here.
    //
    // The first version linked `/admin/bookings/<id>`, and that link was a dead end
    // for exactly the person the alert is written for: `loadBookingDetail`
    // (src/lib/booking/detail.ts) answers `forbidden` unless `canManageAgents(role)`,
    // which is manager and up, and an advisor is `agent`. Nothing an advisor CAN open
    // names a specific call either, so the body links NOTHING (L651).
    assert(
      !/https?:\/\//.test(write.body.description),
      "create: the shipped body carries no link, because no page an advisor can open names this call",
    );
    assert(
      !write.body.description.includes("/admin"),
      "create: and no console address they would simply be refused at",
    );
    assert(
      !write.body.description.includes("undefined"),
      "create: and nothing half-built, which is how a dropped value reads on a calendar",
    );
  }

  // --- the event body: free, coloured, 20 minutes, and no lead anywhere -----
  {
    const body = ownerAlertBody({
      startsAt: "2026-06-08T13:00:00.000Z",
      timezone: "America/New_York",
    });
    eq(body.summary, OWNER_ALERT_TITLE, "body: the title names no lead");
    eq(body.transparency, "transparent", "body: marked free, so it cannot occupy a slot");
    eq(body.colorId, OWNER_ALERT_COLOR_ID, "body: carries the alert colour");
    eq(body.start, "2026-06-08T13:00:00.000Z", "body: starts with the call");
    eq(
      body.end,
      new Date(Date.parse(body.start) + OWNER_ALERT_MINUTES * 60_000).toISOString(),
      `body: runs ${OWNER_ALERT_MINUTES} minutes`,
    );
    // The first version of this linked `/admin/bookings/<id>`, and that link was a
    // dead end for exactly the person the alert is written for: `loadBookingDetail`
    // (src/lib/booking/detail.ts) answers `forbidden` unless `canManageAgents(role)`,
    // which is manager and up, and an advisor is `agent`. Nothing an advisor CAN open
    // names a specific call either (the /me area is their availability and their time
    // off), so the body links NOTHING and says what the warning means on its own
    // (L651). These assertions replace the one that defended the link, rather than
    // being adjusted around it (L252).
    assert(
      !/https?:\/\//.test(body.description),
      "body: carries no link at all, because no page an advisor can open names this call",
    );
    assert(
      !body.description.includes("/admin"),
      "body: and no console address they would simply be refused at",
    );
    assert(
      body.description.toLowerCase().includes("calendar"),
      "body: it points at the call on their own calendar, which is where the lead's details already are",
    );
    assert(
      body.description.split("\n\n").length >= 2,
      "body: and it reads as more than a label, since there is nowhere else for the advisor to go",
    );

    // The whole point of the issue: the invite Pipedream wrote carried the lead's
    // email. Nothing a lead is identified by may appear anywhere in this payload.
    const text = JSON.stringify(body).toLowerCase();
    for (const leak of ["kris", "k@x.com", "+12035615295", "2035615295"]) {
      assert(!text.includes(leak), `body: carries no lead detail (${leak})`);
    }
    assert(!("attendees" in body), "body: has no attendees field at all");
  }

  // --- availability can never see it ---------------------------------------
  {
    const alert = {
      status: "confirmed",
      transparency: "transparent",
      start: { dateTime: "2026-06-08T13:00:00.000Z" },
      end: { dateTime: "2026-06-08T13:20:00.000Z" },
    };
    eq(isBusyEvent(alert), false, "sync: a transparent event never becomes a busy block");
    eq(
      isBusyEvent({ ...alert, transparency: undefined }),
      true,
      "sync: control, the same window WITHOUT transparency would block, so the rule above is the transparency",
    );
  }

  // --- the row is written BEFORE the event ---------------------------------
  {
    const ctx = ownedBooking();
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: ctx,
      ownerAlertCreateFails: "transient",
    });
    const res = await run(deps, row("reassign", reassignOutboxSteps(), OWNER_PAYLOAD));

    assert(res.delivered === false, "row first: a failed calendar write leaves the row undelivered");
    eq(calls.ownerAlertRows.length, 1, "row first: the database row exists even though Google refused");
    eq(
      calls.ownerAlertRows[0].gcal_event_id,
      null,
      "row first: with no event id, so nothing is on a calendar that no row points at",
    );
  }

  // --- a resume re-uses Google's existing event (the 409 path) -------------
  {
    const ctx = ownedBooking();
    // A crash after the insert and before the id was stored: the row is live with a
    // null event id, and Google already holds the event under the deterministic id.
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: ctx,
      ownerAlerts: [
        {
          id: "oae-pre",
          booking_id: "bk1",
          user_id: "b",
          calendar_id: "b@x.com",
          gcal_event_id: null,
          created_at: "",
          removed_at: null,
          skip_reason: null,
        },
      ],
      // The event Google already created under this run's deterministic client id.
      existingCalendarEvents: { "owner-alert:ob-reassign:b": "alert-already-there" },
    });
    const res = await run(deps, row("reassign", reassignOutboxSteps(), OWNER_PAYLOAD));

    assert(res.delivered === true, "409 reuse: the row reaches delivered");
    eq(calls.ownerAlertRows.length, 1, "409 reuse: no second owner_alert_events row");
    eq(
      calls.ownerAlertRows[0].gcal_event_id,
      "alert-already-there",
      "409 reuse: the event Google already had is stored, never a second one",
    );
  }

  // --- a definitive calendar failure is recorded, never retried ------------
  for (const kind of ["not-provisioned", "gone"] as const) {
    const ctx = ownedBooking();
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: ctx,
      ownerAlertCreateFails: kind,
    });
    const res = await run(deps, row("reassign", reassignOutboxSteps(), OWNER_PAYLOAD));

    assert(
      res.delivered === true,
      `${kind}: the step completes rather than failing the row, so nothing retries or pages`,
    );
    eq(
      calls.ownerAlertRows[0].skip_reason,
      kind,
      `${kind}: the reason is recorded on the row, so the silence is readable`,
    );

    // And a second pass does not try Google again.
    const before = calls.ownerAlertCreates.length;
    await run(deps, row("reassign", reassignOutboxSteps(), OWNER_PAYLOAD));
    eq(
      calls.ownerAlertCreates.length,
      before,
      `${kind}: a later pass makes no further calendar call`,
    );
  }

  // --- a transient failure is retried by the ordinary outbox mechanics -----
  {
    const ctx = ownedBooking();
    const fake = makeDeps({ existing: ctx, bookingById: ctx, ownerAlertCreateFails: "transient" });
    const first = await run(fake.deps, row("reassign", reassignOutboxSteps(), OWNER_PAYLOAD));
    assert(first.delivered === false, "transient: the row stays pending");
    eq(
      fake.calls.ownerAlertRows[0].skip_reason,
      null,
      "transient: nothing is recorded as skipped, so the drain will come back",
    );

    fake.setOwnerAlertCreateFails(null);
    const second = await run(fake.deps, row("reassign", reassignOutboxSteps(), OWNER_PAYLOAD));
    assert(second.delivered === true, "transient: the next drain pass delivers it");
    assert(
      fake.calls.ownerAlertRows[0].gcal_event_id !== null,
      "transient: and the event lands on the retry",
    );
  }

  // --- running the step twice creates nothing new --------------------------
  {
    const ctx = ownedBooking();
    const { deps, calls } = makeDeps({ existing: ctx, bookingById: ctx });
    await run(deps, row("reassign", reassignOutboxSteps(), OWNER_PAYLOAD));
    await run(deps, row("reassign", reassignOutboxSteps(), OWNER_PAYLOAD));
    eq(calls.ownerAlertRows.length, 1, "idempotent: still one row");
    eq(calls.ownerAlertCreates.length, 1, "idempotent: still one calendar write");
  }

  // --- cancelling the booking removes the alert ---------------------------
  {
    const ctx = ownedBooking({ status: "cancelled" });
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: ctx,
      ownerAlerts: [liveAlert()],
    });
    const res = await run(deps, row("cancel", cancelOutboxSteps(), { initiator: "customer" }));

    assert(res.delivered === true, "cancel: the row reaches delivered");
    eq(calls.ownerAlertDeletes.length, 1, "cancel: the alert event is deleted");
    eq(calls.ownerAlertDeletes[0].eventId, "alert-1", "cancel: the event the row names");
    eq(calls.ownerAlertDeletes[0].calendarId, "b@x.com", "cancel: on the owner's calendar");
    assert(calls.ownerAlertRows[0].removed_at !== null, "cancel: the row is marked removed");
  }

  // --- a removal Google refuses: definitive closes, transient comes back ---
  {
    const ctx = ownedBooking({ status: "cancelled" });
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: ctx,
      ownerAlerts: [liveAlert()],
      ownerAlertDeleteFails: "not-provisioned",
    });
    const res = await run(deps, row("cancel", cancelOutboxSteps(), { initiator: "customer" }));

    assert(
      res.delivered === true,
      "removal refused definitively: the cancel still completes, because nothing can ever reach that calendar",
    );
    assert(
      calls.ownerAlertRows[0].removed_at !== null,
      "removal refused definitively: the row is closed, so no later pass hunts for it forever",
    );
    eq(
      calls.ownerAlertRows[0].skip_reason,
      "not-provisioned",
      "removal refused definitively: and it says which kind of refusal it was",
    );
  }
  {
    const ctx = ownedBooking({ status: "cancelled" });
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: ctx,
      ownerAlerts: [liveAlert()],
      ownerAlertDeleteFails: "transient",
    });
    const res = await run(deps, row("cancel", cancelOutboxSteps(), { initiator: "customer" }));

    assert(res.delivered === false, "removal refused transiently: the cancel row stays pending");
    eq(
      calls.ownerAlertRows[0].removed_at,
      null,
      "removal refused transiently: the row stays OPEN, so the drain comes back for the event",
    );
  }

  // --- the advisor deleted the alert themselves ----------------------------
  {
    const ctx = ownedBooking({
      starts_at: "2026-06-09T14:00:00.000Z",
      ends_at: "2026-06-09T14:30:00.000Z",
    });
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: ctx,
      ownerAlerts: [liveAlert()],
      ownerAlertMoveGone: true,
    });
    const res = await run(deps, row("reschedule", rescheduleOutboxSteps(), { initiator: "customer" }));

    assert(
      res.delivered === true,
      "move on a gone event: nothing is wrong, so the reschedule completes",
    );
    assert(
      calls.ownerAlertRows[0].removed_at !== null,
      "move on a gone event: the row is closed rather than chasing an event nobody has",
    );
    eq(
      calls.ownerAlertRows[0].skip_reason,
      "event-gone",
      "move on a gone event: recorded as the advisor's own removal, not a calendar failure",
    );
  }

  // --- rescheduling MOVES it: the same owner keeps the warning -------------
  {
    const ctx = ownedBooking({
      starts_at: "2026-06-09T14:00:00.000Z",
      ends_at: "2026-06-09T14:30:00.000Z",
    });
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: ctx,
      ownerAlerts: [liveAlert()],
    });
    const res = await run(deps, row("reschedule", rescheduleOutboxSteps(), { initiator: "customer" }));

    assert(res.delivered === true, "reschedule: the row reaches delivered");
    eq(calls.ownerAlertDeletes.length, 0, "reschedule: the alert is not removed");
    eq(calls.ownerAlertMoves.length, 1, "reschedule: the alert event is moved");
    eq(
      calls.ownerAlertMoves[0].start,
      "2026-06-09T14:00:00.000Z",
      "reschedule: to the call's new start",
    );
    eq(
      calls.ownerAlertMoves[0].end,
      "2026-06-09T14:20:00.000Z",
      `reschedule: still ${OWNER_ALERT_MINUTES} minutes long`,
    );
    assert(calls.ownerAlertRows[0].removed_at === null, "reschedule: the row stays live");
  }

  // --- a reschedule that RE-ROUTES to another agent removes it -------------
  {
    const ctx = ownedBooking({ assigned_user_id: "c", agent_email: "c@x.com" });
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: ctx,
      ownerAlerts: [liveAlert()],
    });
    await run(deps, row("reschedule", rescheduleOutboxSteps(), { initiator: "customer" }));
    eq(
      calls.ownerAlertMoves.length,
      0,
      "reschedule re-route: nothing is moved onto a calendar that no longer holds the call",
    );
    eq(calls.ownerAlertDeletes.length, 1, "reschedule re-route: the alert is removed instead");
    assert(calls.ownerAlertRows[0].removed_at !== null, "reschedule re-route: and the row closed");
  }

  // --- ANY reassign away from that owner removes it ------------------------
  for (const payload of [
    { initiator: "admin", reasonCode: "coverage" } as OutboxPayload,
    { initiator: "system", reasonCode: OWNER_ALERT_REASON_CODE } as OutboxPayload,
    { initiator: "admin", reasonCode: "offboarding" } as OutboxPayload,
  ]) {
    const ctx = ownedBooking({ assigned_user_id: "c", agent_email: "c@x.com" });
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: ctx,
      ownerAlerts: [liveAlert()],
    });
    await run(deps, row("reassign", reassignOutboxSteps(), payload));
    eq(
      calls.ownerAlertDeletes.length,
      1,
      `reassign away (${payload.initiator}/${payload.reasonCode}): B's alert is removed`,
    );
    assert(
      calls.ownerAlertRows[0].removed_at !== null,
      `reassign away (${payload.initiator}/${payload.reasonCode}): the row is closed`,
    );
  }

  // --- an owner reassign onto a DIFFERENT owner swaps the alert ------------
  {
    const ctx = ownedBooking({ assigned_user_id: "c", agent_email: "c@x.com" });
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: ctx,
      ownerAlerts: [liveAlert()],
    });
    await run(deps, row("reassign", reassignOutboxSteps(), OWNER_PAYLOAD));
    eq(calls.ownerAlertDeletes.length, 1, "owner swap: the previous owner's alert is removed");
    eq(calls.ownerAlertRows.length, 2, "owner swap: a fresh row for the new owner");
    const live = calls.ownerAlertRows.filter((r) => r.removed_at === null);
    eq(live.length, 1, "owner swap: exactly one live alert for the booking");
    eq(live[0].user_id, "c", "owner swap: belonging to the new owner");
    eq(live[0].calendar_id, "c@x.com", "owner swap: on the new owner's calendar");
  }

  // --- a reassign back onto the SAME owner keeps the one alert -------------
  {
    const ctx = ownedBooking();
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: ctx,
      ownerAlerts: [liveAlert()],
    });
    await run(deps, row("reassign", reassignOutboxSteps(), OWNER_PAYLOAD));
    eq(calls.ownerAlertDeletes.length, 0, "same owner: nothing is removed");
    eq(calls.ownerAlertCreates.length, 0, "same owner: nothing is created");
    eq(calls.ownerAlertRows.length, 1, "same owner: still one row");
  }

  // --- a completed booking keeps its alert ---------------------------------
  {
    const ctx = ownedBooking();
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: ctx,
      pastDue: [ctx],
      ownerAlerts: [liveAlert()],
    });
    await completePastBookings(deps as never);
    eq(calls.ownerAlertDeletes.length, 0, "completed: the alert event is left alone");
    eq(calls.ownerAlertRows[0].removed_at, null, "completed: the row stays live");
  }

  finish();
}

/** A live alert on owner "b"'s calendar, the state every removal test starts in. */
function liveAlert() {
  return {
    id: "oae-1",
    booking_id: "bk1",
    user_id: "b",
    calendar_id: "b@x.com",
    gcal_event_id: "alert-1",
    created_at: "",
    removed_at: null,
    skip_reason: null,
  };
}

await main();
