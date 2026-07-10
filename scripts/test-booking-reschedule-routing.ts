// rescheduleBooking routing: in-place vs re-route across shift, buffer, notice, caps.
//
// Split out of the old 3,229-line scripts/test-booking-orchestration.ts (#605);
// the shared BookingDeps fake lives in scripts/lib/booking-fakes.ts.
// Run: node --experimental-strip-types scripts/test-booking-reschedule-routing.ts
import {
  rescheduleBooking,
  OUTBOX_HANDLERS,
  rescheduleOutboxSteps,
} from "../src/lib/booking/orchestration.ts";
import type {
  EventType,
  BookingOutbox,
} from "../src/lib/db/types.ts";
import {
  createAsserter,
  makeDeps,
  makeBooking,
  bucket,
  eventType,
  RR,
  NOW,
} from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

async function run() {
  // --- reschedule: same agent free -> in-place move, no reassign, RR untouched ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    // The outbox handlers re-load by id AFTER the commit, so loadBookingById
    // must return the committed (new-time) booking, mirroring production.
    const rescheduled = {
      booking: {
        ...ctx.booking,
        starts_at: "2026-06-09T14:00:00.000Z",
        ends_at: "2026-06-09T14:30:00.000Z",
        status: "rescheduled" as const,
      },
      bucket,
      eventType,
    };
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: rescheduled,
      freeEmails: new Set(["a@x.com"]),
    });
    const res = await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    assert(
      calls.updateEventTime.length === 1 && calls.updateEventTime[0].id === "gcal-old",
      "reschedule(same agent): moves the existing event in place",
    );
    assert(calls.createEvent.length === 0 && calls.deleteEvent.length === 0, "reschedule(same agent): no new/old event churn");
    assert(
      calls.moveBusyBlock.length === 1 &&
        calls.moveBusyBlock[0].bookingId === res.booking.id &&
        calls.moveBusyBlock[0].startIso === "2026-06-09T14:00:00.000Z" &&
        calls.deleteBusyBlocks.length === 0 &&
        calls.insertBusyBlock.length === 0,
      "reschedule: busy block moved atomically (#429 P3)",
    );
    assert(res.booking.status === "rescheduled" && res.booking.starts_at === "2026-06-09T14:00:00.000Z", "reschedule: status + new start applied");
    assert(calls.webhooks[0].event === "booking.rescheduled", "reschedule: fires booking.rescheduled");
    assert(
      calls.claimReschedule === 1 && calls.releaseReschedule === 1,
      "reschedule: claims then releases the idempotency lock",
    );
    // #326: records the reason as a history event + carries it on the webhook.
    assert(
      calls.bookingEvents.length === 1 &&
        calls.bookingEvents[0].action === "rescheduled" &&
        calls.bookingEvents[0].initiator === "customer" &&
        calls.bookingEvents[0].reason_code === "schedule_conflict",
      "reschedule: records one 'rescheduled' history event with the reason + initiator",
    );
    assert(
      calls.bookingEvents[0].from_starts_at === "2026-06-08T13:00:00.000Z" &&
        calls.bookingEvents[0].to_starts_at === "2026-06-09T14:00:00.000Z" &&
        calls.bookingEvents[0].to_agent_user_id === "a",
      "reschedule: history event carries from/to time and the (kept) agent",
    );
    assert(
      JSON.stringify(calls.webhooks[0].reason) ===
        JSON.stringify({ code: "schedule_conflict", detail: null, initiator: "customer" }),
      "reschedule: webhook payload carries the reason + initiator",
    );
  }

  // --- #614: an oscillating reschedule that returns to a previously-used start
  // time must still emit its own rescheduled webhook + history row. The dedupe
  // key is versioned by the booking's reschedule_seq, so a move back to a used
  // to_starts_at can't reuse the earlier reschedule's row (which would swallow
  // the webhook). We drive the NOTIFY step directly across three moves whose
  // targets oscillate (T2 -> T1 -> T2), then re-run the last (drain resume). ---
  {
    const notify = OUTBOX_HANDLERS[rescheduleOutboxSteps()[2].name];
    const T2 = "2026-06-09T14:00:00.000Z";
    const T1 = "2026-06-10T15:00:00.000Z";
    // One mutable context: loadBookingById returns it, and we advance the
    // booking's time + reschedule_seq between moves like the real commit does.
    const ctx = { booking: makeBooking({ status: "rescheduled" }), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx });
    const row = {
      id: "ob-osc",
      booking_id: "bk1",
      action: "reschedule" as const,
      status: "pending" as const,
      steps: rescheduleOutboxSteps(),
      payload: {
        reasonCode: "schedule_conflict",
        reasonDetail: null,
        initiator: "customer" as const,
        fromStartsIso: "2026-06-08T13:00:00.000Z",
        fromAgentUserId: "a",
      },
      lease_until: null,
      attempts: 0,
      last_error: null,
      next_attempt_at: null,
      created_at: "",
      updated_at: "",
    } as BookingOutbox;

    const move = async (toIso: string, seq: number) => {
      ctx.booking.starts_at = toIso;
      ctx.booking.reschedule_seq = seq;
      await notify(deps, row);
    };
    await move(T2, 1);
    await move(T1, 2);
    await move(T2, 3); // back to a USED start: pre-#614 this reused move 1's row

    assert(
      calls.webhooks.length === 3 && calls.webhooks.every((w) => w.event === "booking.rescheduled"),
      "oscillating reschedule: every move emits its own booking.rescheduled webhook (#614)",
    );
    assert(
      calls.bookingEvents.length === 3,
      "oscillating reschedule: every move records its own history row (#614)",
    );
    assert(
      new Set(calls.webhooks.map((w) => w.dedupeKey)).size === 3,
      "oscillating reschedule: each move's webhook carries a distinct dedupe key (#614)",
    );
    assert(
      calls.bookingEvents[2].to_starts_at === T2 && calls.bookingEvents[2].reschedule_seq === 3,
      "oscillating reschedule: the return-to-T2 row is versioned by seq 3, not folded into seq 1",
    );

    // Drain re-run of the last move (same booking state) must dedupe: no new
    // history row, and the re-fired webhook reuses move 3's key so emit's unique
    // (endpoint, event, dedupe_key) index suppresses the duplicate POST.
    const move3Key = calls.webhooks[2].dedupeKey;
    await move(T2, 3);
    assert(
      calls.bookingEvents.length === 3,
      "oscillating reschedule: a drain re-run inserts no duplicate history row (#614)",
    );
    assert(
      calls.webhooks[3]?.dedupeKey === move3Key,
      "oscillating reschedule: a drain re-run reuses the same dedupe key (emit dedupes to one) (#614)",
    );
  }

  // --- reschedule in-place when the calendar event was DELETED (#617): the
  // PATCH 410s -> updateEventTime raises EventGone -> the branch recreates the
  // event (with a deterministic id) instead of committing a phantom move. ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const rescheduled = {
      booking: {
        ...ctx.booking,
        starts_at: "2026-06-09T14:00:00.000Z",
        ends_at: "2026-06-09T14:30:00.000Z",
        status: "rescheduled" as const,
      },
      bucket,
      eventType,
    };
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: rescheduled,
      freeEmails: new Set(["a@x.com"]),
      updateEventTimeGone: true, // the existing event is gone on Google
    });
    const res = await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    assert(
      calls.updateEventTime.length === 1 && calls.updateEventTime[0].id === "gcal-old",
      "reschedule(deleted event): still attempts the in-place PATCH first",
    );
    assert(
      calls.createEvent.length === 1 && calls.createEvent[0].email === "a@x.com",
      "reschedule(deleted event): recreates the event on EventGone",
    );
    assert(
      calls.deleteEvent.length === 0,
      "reschedule(deleted event): no delete, the old event is already gone",
    );
    assert(
      typeof calls.createEvent[0].clientId === "string" && calls.createEvent[0].clientId.length > 0,
      "reschedule(deleted event): recreate uses a deterministic client id (idempotent on resume)",
    );
    assert(
      res.booking.gcal_event_id !== "gcal-old" && (res.booking.gcal_event_id ?? "").length > 0,
      "reschedule(deleted event): commits the NEW recreated event id, not the phantom one",
    );
    assert(
      res.booking.assigned_user_id === "a" && res.booking.status === "rescheduled",
      "reschedule(deleted event): stays on the same agent and commits the move",
    );
    assert(calls.webhooks[0].event === "booking.rescheduled", "reschedule(deleted event): still fires booking.rescheduled");
  }

  // --- reschedule by LESS than the event length: stays in-place on the SAME
  // agent even in a multi-agent bucket (#523). The booking's own still-present
  // event overlaps the new slot; the self-free check must exclude it, else the
  // current agent looks busy and the booking silently re-routes to another. ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const rescheduled = {
      booking: {
        ...ctx.booking,
        starts_at: "2026-06-08T13:15:00.000Z",
        ends_at: "2026-06-08T13:45:00.000Z",
        status: "rescheduled" as const,
      },
      bucket,
      eventType,
    };
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: rescheduled,
      candidates: ["a", "b"], // a multi-agent bucket: re-route would pick a DIFFERENT agent
      freeEmails: new Set(["a@x.com", "b@x.com"]),
      // a@x.com is busy ONLY with its own current event (13:00 to 13:30).
      busyByEmail: new Map([["a@x.com", [{ start: "2026-06-08T13:00:00.000Z", end: "2026-06-08T13:30:00.000Z" }]]]),
    });
    // +15min: new slot 13:15 to 13:45 overlaps the original 13:00 to 13:30 event.
    const res = await rescheduleBooking("tok1", "2026-06-08T13:15:00.000Z", RR, "customer", deps, NOW);
    assert(
      res.booking.assigned_user_id === "a" && res.booking.agent_email === "a@x.com",
      "reschedule(sub-event-length): stays on the SAME agent, no silent re-route",
    );
    assert(
      calls.updateEventTime.length === 1 && calls.updateEventTime[0].id === "gcal-old",
      "reschedule(sub-event-length): moves the existing event in place",
    );
    assert(
      calls.createEvent.length === 0 && calls.deleteEvent.length === 0,
      "reschedule(sub-event-length): no reassign create/delete churn",
    );
  }

  // --- reschedule PAST the assigned agent's shift end -> re-routes to a working
  // agent even though the agent's CALENDAR is free (#527). `isFree` alone would
  // keep the off-shift agent in place; the working-hours guard falls through to
  // assignAgent so a working agent in the bucket can cover. ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const rescheduled = {
      booking: {
        ...ctx.booking,
        assigned_user_id: "b",
        agent_name: "Agent B",
        agent_email: "b@x.com",
        starts_at: "2026-06-08T18:00:00.000Z",
        ends_at: "2026-06-08T18:30:00.000Z",
        status: "rescheduled" as const,
      },
      bucket,
      eventType,
    };
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: rescheduled,
      // Availability-aware round-robin drops off-shift agent A; only B is offered.
      candidates: ["b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]), // A's CALENDAR is free...
      // ...but A's Monday shift ends 13:30 NY (17:30 UTC), so 14:00 NY is off-shift.
      workingHoursByUser: new Map([
        ["a", { timezone: "America/New_York", rules: [{ weekday: 1, start_minute: 9 * 60, end_minute: 810 }] }],
      ]),
    });
    // 2026-06-08T18:00Z = 14:00 NY Monday, past A's 13:30 shift end.
    const res = await rescheduleBooking("tok1", "2026-06-08T18:00:00.000Z", RR, "customer", deps, NOW);
    assert(
      res.booking.assigned_user_id === "b" && res.booking.agent_email === "b@x.com",
      "reschedule(off-shift): re-routes to a working agent instead of staying in-place (#527)",
    );
    assert(
      calls.agentWorkingHours.includes("a"),
      "reschedule(off-shift): consults the assigned agent's working hours",
    );
    assert(
      calls.updateEventTime.length === 0 && calls.createEvent.length === 1 && calls.deleteEvent.length === 1,
      "reschedule(off-shift): reassign churn (delete old + create new), no in-place move",
    );
  }

  // --- reschedule WITHIN the assigned agent's shift -> stays in-place even in a
  // multi-agent bucket (#527 companion: the working-hours guard permits the move
  // when the new time is on-shift and the calendar is free). ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const rescheduled = {
      booking: {
        ...ctx.booking,
        starts_at: "2026-06-08T18:00:00.000Z",
        ends_at: "2026-06-08T18:30:00.000Z",
        status: "rescheduled" as const,
      },
      bucket,
      eventType,
    };
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: rescheduled,
      candidates: ["a", "b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]),
      // A works a late shift (09:00-20:00 NY) that includes 14:00 NY.
      workingHoursByUser: new Map([
        ["a", { timezone: "America/New_York", rules: [{ weekday: 1, start_minute: 9 * 60, end_minute: 20 * 60 }] }],
      ]),
    });
    // 2026-06-08T18:00Z = 14:00 NY Monday, inside A's 09:00-20:00 shift.
    const res = await rescheduleBooking("tok1", "2026-06-08T18:00:00.000Z", RR, "customer", deps, NOW);
    assert(
      res.booking.assigned_user_id === "a" && res.booking.agent_email === "a@x.com",
      "reschedule(on-shift): stays on the same agent in-place (#527)",
    );
    assert(
      calls.updateEventTime.length === 1 && calls.createEvent.length === 0 && calls.deleteEvent.length === 0,
      "reschedule(on-shift): moves in place, no reassign churn",
    );
  }

  // --- #(reassign-cap) reschedule keeping the SAME agent is NOT blocked by the daily
  // cap, even onto a day already full of the agent's OTHER meetings (a reschedule moves
  // an existing meeting, it's not a net-new booking). ---
  {
    const capEvent = { ...eventType, daily_cap: 1 } as unknown as EventType;
    const ctx = { booking: makeBooking({}), bucket, eventType: capEvent };
    const rescheduled = {
      booking: {
        ...ctx.booking,
        starts_at: "2026-06-08T18:00:00.000Z",
        ends_at: "2026-06-08T18:30:00.000Z",
        status: "rescheduled" as const,
      },
      bucket,
      eventType: capEvent,
    };
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: rescheduled,
      candidates: ["a", "b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]),
      // A already has another booking that day; cap is 1 -> would be "over cap".
      agentDayBookings: new Map([["a", ["2026-06-08T13:00:00.000Z"]]]),
    });
    const res = await rescheduleBooking("tok1", "2026-06-08T18:00:00.000Z", RR, "customer", deps, NOW);
    assert(
      res.booking.assigned_user_id === "a" && res.booking.agent_email === "a@x.com",
      "reschedule(over cap, same agent): stays on the SAME agent (cap not enforced on reschedule)",
    );
    assert(
      calls.updateEventTime.length === 1 && calls.createEvent.length === 0 && calls.deleteEvent.length === 0,
      "reschedule(over cap, same agent): moves in place, no reassign churn",
    );
  }

  // --- #536: reschedule into the agent's BUFFER window -> re-routes. The slot
  // itself is calendar-free, but a busy block sits inside the required buffer-after
  // gap, so the booker would never offer it; the in-place guard must decline. ---
  {
    const bufEvent = { ...eventType, buffer_after_min: 30 } as unknown as EventType;
    const ctx = { booking: makeBooking({}), bucket, eventType: bufEvent };
    const rescheduled = {
      booking: { ...ctx.booking, assigned_user_id: "b", agent_name: "Agent B", agent_email: "b@x.com",
        starts_at: "2026-06-08T18:00:00.000Z", ends_at: "2026-06-08T18:30:00.000Z", status: "rescheduled" as const },
      bucket, eventType: bufEvent,
    };
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: rescheduled,
      candidates: ["b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]),
      // A is free AT the slot (18:00-18:30) but busy 18:30-18:45, inside the 30-min
      // buffer-after window [18:30, 19:00). B has no conflicts.
      busyByEmail: new Map([["a@x.com", [{ start: "2026-06-08T18:30:00.000Z", end: "2026-06-08T18:45:00.000Z" }]]]),
    });
    const res = await rescheduleBooking("tok1", "2026-06-08T18:00:00.000Z", RR, "customer", deps, NOW);
    assert(
      res.booking.assigned_user_id === "b" && res.booking.agent_email === "b@x.com",
      "reschedule(buffer violation): re-routes off the agent whose buffer is violated (#536)",
    );
    assert(
      calls.updateEventTime.length === 0 && calls.createEvent.length === 1,
      "reschedule(buffer violation): reassign churn, no in-place move (#536)",
    );
  }

  // --- #536: reschedule to a time inside the minimum-notice window -> rejected. The
  // agent is on-shift and free, but the new time is too soon; no agent qualifies, so
  // the in-place guard declines and the schedule-aware reassign finds nobody. ---
  {
    const noticeEvent = { ...eventType, min_notice_min: 120 } as unknown as EventType;
    const ctx = { booking: makeBooking({}), bucket, eventType: noticeEvent };
    const { deps, calls } = makeDeps({
      existing: ctx,
      candidates: [], // too-soon: the schedule-aware reassign finds no eligible agent
      freeEmails: new Set(["a@x.com", "b@x.com"]),
    });
    const slot = "2026-06-08T18:00:00.000Z";
    const tooSoonNow = Date.parse(slot) - 30 * 60_000; // 30 min before the slot, notice is 120
    let err: unknown;
    try {
      await rescheduleBooking("tok1", slot, RR, "customer", deps, tooSoonNow);
    } catch (e) {
      err = e;
    }
    assert(
      err != null && (err as Error).name === "NoEligibleAgentsError",
      "reschedule(too soon): in-place guard declines and reassign finds nobody (#536)",
    );
    assert(
      calls.updateEventTime.length === 0,
      "reschedule(too soon): never moves the agent in place (#536)",
    );
  }

  // --- reschedule no-op / retry: records the reason ONCE, no move/webhook (#326 C1) ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType }; // starts 13:00Z
    const { deps, calls } = makeDeps({ existing: ctx, freeEmails: new Set(["a@x.com"]) });
    const res = await rescheduleBooking("tok1", "2026-06-08T13:00:00.000Z", RR, "customer", deps, NOW);
    assert(res.booking.starts_at === "2026-06-08T13:00:00.000Z", "reschedule no-op: returns the unchanged booking");
    assert(
      calls.claimReschedule === 0 && calls.updateEventTime.length === 0 && calls.createEvent.length === 0,
      "reschedule no-op: skips the lock and all calendar work when already at target",
    );
    assert(
      calls.commitReschedule.length === 0 && calls.webhooks.length === 0,
      "reschedule no-op: no DB write or webhook for a same-instant reschedule",
    );
    // The mandatory reason must NOT be silently dropped on the no-op path: it's
    // recorded once. A retry (same target) must not double-record it.
    assert(
      calls.bookingEvents.length === 1 && calls.bookingEvents[0].reason_code === "schedule_conflict",
      "reschedule no-op: records the reason once (never silently dropped)",
    );
    await rescheduleBooking("tok1", "2026-06-08T13:00:00.000Z", RR, "customer", deps, NOW);
    assert(
      calls.bookingEvents.length === 1,
      "reschedule retry: does not double-record the reason (idempotent)",
    );
  }

  // --- reschedule idempotency: concurrent duplicate loses the lock, no-ops ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType }; // starts 13:00Z
    const { deps, calls } = makeDeps({
      existing: ctx,
      freeEmails: new Set(["a@x.com"]),
      // Another in-flight reschedule holds a FRESH lease for the SAME target -> a
      // same-target double-submit is an idempotent no-op (not a conflict).
      heldLease: { target: "2026-06-09T14:00:00.000Z" },
    });
    const res = await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    assert(res.booking.starts_at === "2026-06-08T13:00:00.000Z", "reschedule dup: returns the booking without moving it");
    assert(calls.claimReschedule === 1, "reschedule dup: attempted the claim");
    assert(
      calls.updateEventTime.length === 0 && calls.createEvent.length === 0 && calls.deleteEvent.length === 0,
      "reschedule dup: no calendar churn for the lock loser",
    );
    assert(
      calls.commitReschedule.length === 0 && calls.webhooks.length === 0 && calls.releaseReschedule === 0,
      "reschedule dup: no DB write, no duplicate webhook, and doesn't release a lock it never held",
    );
  }

}

await run();
finish();
