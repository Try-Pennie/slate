// reassignBooking: caps, history, deterministic event ids, swap cleanup, authorization.
//
// Split out of the old 3,229-line scripts/test-booking-orchestration.ts (#605);
// the shared BookingDeps fake lives in scripts/lib/booking-fakes.ts.
// Run: node --experimental-strip-types scripts/test-booking-reassign.ts
import {
  reassignBooking,
  rescheduleBooking,
} from "../src/lib/booking/orchestration.ts";
import type {
  EventType,
  User,
} from "../src/lib/db/types.ts";
import {
  createAsserter,
  makeDeps,
  makeBooking,
  bucket,
  eventType,
  NOW,
  RR,
  SYS,
} from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

async function run() {
  // --- #2617: a reassign leaves the status alone ---------------------------
  // "rescheduled" is read everywhere as "the lead moved their call". A reassign
  // hands the SAME call to another advisor and the lead never touched it, so the
  // status must come out exactly as it went in, in both directions: a confirmed
  // booking stays confirmed, and one the lead really did move stays rescheduled.
  for (const before of ["confirmed", "rescheduled"] as const) {
    const ctx = { booking: makeBooking({ status: before, reschedule_seq: before === "rescheduled" ? 2 : 0 }), bucket, eventType };
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps } = makeDeps({ bookingById: ctx, agentByEmail: owner });
    const res = await reassignBooking("bk1", "b@x.com", SYS, deps);
    assert(res.booking.status === before, `#2617: a reassign of a ${before} booking returns it still ${before}`);
    assert(ctx.booking.status === before, `#2617: and the stored row is still ${before} after the swap`);
    assert(
      ctx.booking.reschedule_seq === (before === "rescheduled" ? 2 : 0),
      `#2617: a reassign of a ${before} booking does not move reschedule_seq`,
    );
    assert(res.booking.assigned_user_id === "b", `#2617: while the ${before} booking does move to the new advisor`);
  }

  // --- reassign: force a booking onto an owning agent (double-book allowed) ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType }; // assigned to "a"@a@x.com
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: owner });
    const res = await reassignBooking("bk1", "b@x.com", SYS, deps);
    assert(
      res.booking.assigned_user_id === "b" && res.booking.agent_email === "b@x.com",
      "reassign: booking moved to the owning agent",
    );
    // #449: the new event is created FIRST, then the atomic swap returns the
    // event it REPLACED ("gcal-old"), which is what gets deleted - not a stale
    // up-front read. The new event differs from the previous, so it's deleted.
    assert(calls.createEvent.length === 1, "reassign: event created on the owning agent");
    assert(
      calls.reassignSwaps.length === 1 && calls.reassignSwaps[0].userId === "b",
      "reassign: goes through the atomic reassign_booking_swap (not a plain update)",
    );
    assert(calls.deleteEvent.length === 1 && calls.deleteEvent[0].id === "gcal-old", "reassign: the REPLACED old event is removed (the swap's previous, not a stale read)");
    assert(
      res.booking.allow_double_book === true && res.booking.assigned_user_id === "b",
      "reassign: marks allow_double_book and the new agent",
    );
    assert(
      res.booking.routing_trace?.reassignments?.[0]?.from === "a" &&
        res.booking.routing_trace?.reassignments?.[0]?.to === "b",
      "reassign: records the override in routing_trace",
    );
    assert(
      calls.moveBusyBlock.length === 1 &&
        calls.moveBusyBlock[0].userId === "b" &&
        calls.deleteBusyBlocks.length === 0 &&
        calls.insertBusyBlock.length === 0,
      "reassign: busy block moved atomically to the owner (#429 P3)",
    );
    // #2368: a reassign is its own event. It fires booking.reassigned, and it
    // fires NO booking.rescheduled: the time never moved, and a reschedule event
    // is what made Regal tell a lead their call had been rebooked when only the
    // advisor changed. Both halves are asserted, because "the new event fires"
    // would still pass if the old one fired alongside it.
    assert(
      calls.webhooks.length === 1 && calls.webhooks[0].event === "booking.reassigned",
      "reassign: fires booking.reassigned, and only that",
    );
    assert(
      !calls.webhooks.some((w) => w.event === "booking.rescheduled"),
      "reassign: fires NO booking.rescheduled (the time did not move)",
    );
    assert(
      calls.webhooks[0].previousAgentEmail === "a@x.com",
      "reassign: the payload names the advisor the call moved away from",
    );
    assert(
      (calls.webhooks[0].reason as { code?: string; initiator?: string } | null)?.code ===
        "owner_reassignment" &&
        (calls.webhooks[0].reason as { initiator?: string } | null)?.initiator === "system",
      "reassign: the payload carries the reason and the initiator, so Regal can tell an owner move from a coverage move",
    );
    assert(
      calls.invalidateSlots.length === 1 && calls.invalidateSlots[0] === "411",
      "reassign: invalidates cached slots for the bucket exactly once",
    );
    // #326: recorded as 'reassigned' (NOT 'rescheduled') so it doesn't inflate
    // the reschedule rate, initiator 'system', same time, agent change to B.
    assert(
      calls.bookingEvents.length === 1 &&
        calls.bookingEvents[0].action === "reassigned" &&
        calls.bookingEvents[0].initiator === "system" &&
        calls.bookingEvents[0].to_agent_user_id === "b" &&
        calls.bookingEvents[0].to_starts_at === calls.bookingEvents[0].from_starts_at,
      "reassign: records a 'reassigned' (not 'rescheduled') system event, same time, new agent",
    );
  }

  // --- reassign: concurrent reassigns accumulate FULL history server-side (#519) ---
  // Two reassigns of the same booking whose callers BOTH loaded a base before
  // either swap committed (stale bases). The reassignment record must be appended
  // INSIDE reassign_booking_swap under its row lock, so the later swap adds to the
  // freshest history instead of overwriting it from a stale snapshot (which loses
  // one audit entry). Modeled with a SHARED backing row that the swap mutates,
  // while every load returns a pinned pre-race snapshot (reassignments empty),
  // simulating both racers reading before either swap.
  {
    const owner = (id: string, email: string) =>
      ({ id, name: `Owner ${id}`, email, bookable: true } as unknown as User);
    const sharedRow = makeBooking({ id: "bk1", assigned_user_id: "a", agent_email: "a@x.com" });
    sharedRow.routing_trace = {
      bucket_code: "411",
      bucket_id: "bkt1",
      considered: [],
      chosen_user_id: "a",
      fallback_applied: false,
      reassignments: [],
    };
    // The default mock's swap reads/mutates opts.bookingById.booking (= sharedRow),
    // deriving the record from ITS current agent and appending onto ITS trace.
    const { deps, calls } = makeDeps({
      bookingById: { booking: sharedRow, bucket, eventType },
      agentByEmail: owner("b", "b@x.com"),
    });
    // Every load hands the caller a frozen PRE-RACE snapshot (assigned to "a", no
    // reassignments yet), so neither caller's base reflects the other's swap.
    deps.loadBookingById = async () => ({
      booking: { ...makeBooking({ id: "bk1", assigned_user_id: "a", agent_email: "a@x.com" }),
        routing_trace: { bucket_code: "411", bucket_id: "bkt1", considered: [], chosen_user_id: "a", fallback_applied: false, reassignments: [] } },
      bucket,
      eventType,
    });
    deps.getAgentByEmail = async (email: string) =>
      email === "c@x.com" ? owner("c", email) : owner("b", email);

    await reassignBooking("bk1", "b@x.com", SYS, deps);
    await reassignBooking("bk1", "c@x.com", SYS, deps);

    const recorded = sharedRow.routing_trace?.reassignments ?? [];
    assert(
      recorded.length === 2 && recorded[0]?.to === "b" && recorded[1]?.to === "c",
      "reassign (#519): concurrent reassigns append full history server-side (no lost record)",
    );
    // from is derived under the lock, so the 2nd record's from is the true current
    // agent ("b") at swap time, not the caller's stale view ("a").
    assert(
      recorded[0]?.from === "a" && recorded[1]?.from === "b",
      "reassign (#519): the swap derives 'from' from the genuinely-current agent under the lock",
    );
    // #2368: the same rule for the address on the webhook. Both callers loaded a
    // base saying "a@x.com", so a payload built from the caller's own snapshot
    // would tell Regal the second move came off a@x.com, which it did not: the
    // first move had already put it on b@x.com. The advisor named to whoever
    // reads the timeline has to be the one the swap itself replaced.
    assert(
      calls.webhooks.length === 2 &&
        calls.webhooks[0].previousAgentEmail === "a@x.com" &&
        calls.webhooks[1].previousAgentEmail === "b@x.com",
      "reassign (#519/#2368): the webhook names the advisor the SWAP replaced, not the caller's stale snapshot",
    );
  }

  // --- #(reassign-cap): reassign onto an at-cap agent ---
  {
    const capEvent = { ...eventType, daily_cap: 1 } as unknown as EventType;
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    // B already has one booking on the booking's day (2026-06-08); cap is 1 -> over cap.
    const atCap = () =>
      makeDeps({
        bookingById: { booking: makeBooking({}), bucket, eventType: capEvent },
        agentByEmail: owner,
        agentDayBookings: new Map([["b", ["2026-06-08T15:00:00.000Z"]]]),
      });

    // Default (overrideCap omitted) -> blocked.
    {
      const { deps, calls } = atCap();
      let err: unknown;
      try {
        await reassignBooking("bk1", "b@x.com", SYS, deps);
      } catch (e) {
        err = e;
      }
      assert(
        err != null && (err as Error).name === "DailyCapExceededError",
        "reassign(at cap, no override): throws DailyCapExceededError",
      );
      assert(
        calls.createEvent.length === 0 && calls.reassignSwaps.length === 0,
        "reassign(at cap, no override): no event created, no swap (nothing mutated)",
      );
    }

    // overrideCap=true -> forces through, reports overCap.
    {
      const { deps, calls } = atCap();
      const res = await reassignBooking("bk1", "b@x.com", SYS, deps, { overrideCap: true });
      assert(
        res.booking.assigned_user_id === "b" && res.overCap === true,
        "reassign(at cap, override): forces through and reports overCap=true",
      );
      assert(calls.createEvent.length === 1, "reassign(at cap, override): event created");
      assert(
        calls.agentActiveBookingStartsMs[0]?.excludeBookingId === "bk1",
        "reassign(cap check): excludes the booking being moved from the day count",
      );
    }
  }

  // --- #(reassign-cap): reassign onto an UNDER-cap agent succeeds, overCap=false ---
  {
    const capEvent = { ...eventType, daily_cap: 3 } as unknown as EventType;
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps } = makeDeps({
      bookingById: { booking: makeBooking({}), bucket, eventType: capEvent },
      agentByEmail: owner,
      agentDayBookings: new Map([["b", ["2026-06-08T15:00:00.000Z"]]]), // 1 < 3
    });
    const res = await reassignBooking("bk1", "b@x.com", SYS, deps);
    assert(
      res.booking.assigned_user_id === "b" && res.overCap === false,
      "reassign(under cap): succeeds, overCap=false",
    );
  }

  // --- #(reassign-cap): uncapped event never blocks, overCap=false ---
  {
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps } = makeDeps({
      bookingById: { booking: makeBooking({}), bucket, eventType }, // daily_cap: null
      agentByEmail: owner,
      agentDayBookings: new Map([["b", ["2026-06-08T15:00:00.000Z"]]]),
    });
    const res = await reassignBooking("bk1", "b@x.com", SYS, deps);
    assert(res.overCap === false, "reassign(uncapped): never over cap");
  }

  // --- #546: manager reassign records initiator 'admin' (not 'system') + the actor ---
  {
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps, calls } = makeDeps({
      bookingById: { booking: makeBooking({}), bucket, eventType },
      agentByEmail: owner,
    });
    const res = await reassignBooking("bk1", "b@x.com", SYS, deps, {
      initiator: "admin",
      actor: { userId: "mgr1", actingAsUserId: null },
    });
    assert(res.booking.assigned_user_id === "b", "reassign(admin): booking moved");
    assert(
      calls.bookingEvents[0].initiator === "admin",
      "reassign(admin): history records initiator 'admin', not 'system'",
    );
    assert(
      calls.bookingEvents[0].actor_user_id === "mgr1",
      "reassign(admin): history records the acting manager (#549)",
    );
    // #2368: an ADMIN reassign is a reassign too. It is the same move made by a
    // person rather than the machine, so it takes the same event, and the
    // initiator on the payload is what tells the two apart downstream.
    assert(
      calls.webhooks.length === 1 && calls.webhooks[0].event === "booking.reassigned",
      "reassign(admin): fires booking.reassigned",
    );
    assert(
      !calls.webhooks.some((w) => w.event === "booking.rescheduled"),
      "reassign(admin): fires NO booking.rescheduled",
    );
    assert(
      (calls.webhooks[0].reason as { initiator?: string } | null)?.initiator === "admin",
      "reassign(admin): the payload says a person made the move, not the machine",
    );
    assert(
      calls.webhooks[0].previousAgentEmail === "a@x.com",
      "reassign(admin): the payload names the advisor the call moved away from",
    );
  }

  // --- #546: manager may reassign to an agent OUTSIDE the bookable pool only
  //     when allowNonBookable is set (coverage/escalation); else rejected. ---
  {
    const offPool = { id: "z", name: "Lead Z", email: "z@x.com", bookable: false } as unknown as User;
    {
      const { deps } = makeDeps({
        bookingById: { booking: makeBooking({}), bucket, eventType },
        agentByEmail: offPool,
      });
      let err: unknown;
      try {
        await reassignBooking("bk1", "z@x.com", SYS, deps);
      } catch (e) {
        err = e;
      }
      assert(
        err != null && /not bookable/i.test((err as Error).message),
        "reassign(non-bookable, default): rejected",
      );
    }
    {
      const { deps, calls } = makeDeps({
        bookingById: { booking: makeBooking({}), bucket, eventType },
        agentByEmail: offPool,
      });
      const res = await reassignBooking("bk1", "z@x.com", SYS, deps, {
        allowNonBookable: true,
        initiator: "admin",
      });
      assert(
        res.booking.assigned_user_id === "z" && calls.createEvent.length === 1,
        "reassign(non-bookable, allowNonBookable): succeeds for coverage/escalation",
      );
    }
    // #2370 added an owner guard that REFUSES a non-bookable or away target, and it
    // is deliberately on the machine contact-owner wrapper only. This is the same
    // target through the coverage shape (initiator 'system', the offboarding sweep
    // and the bulk redistribute's own move): still a move, unchanged. The proof that
    // the guard cannot reach here at all is the scan in
    // scripts/test-owner-reassign-guard.ts; this is the behaviour beside it.
    {
      const { deps, calls } = makeDeps({
        bookingById: { booking: makeBooking({}), bucket, eventType },
        agentByEmail: offPool,
      });
      const res = await reassignBooking("bk1", "z@x.com", SYS, deps, {
        allowNonBookable: true,
        initiator: "system",
      });
      assert(
        res.booking.assigned_user_id === "z" && calls.createEvent.length === 1,
        "reassign(non-bookable, system coverage): still moves, unchanged by the #2370 owner guard",
      );
    }
  }

  // --- reassign: new event uses a deterministic, target-keyed client id (#439 P4) ---
  // The reassign target is caller-supplied (deterministic), so a crash between the
  // create and the booking commit must reuse the SAME Google event on retry rather
  // than spawn a second. That requires a deterministic client id keyed on the
  // TARGET agent (so cross-agent moves don't collide) and on the booking.
  {
    const owner = (id: string, email: string) =>
      ({ id, name: `Owner ${id}`, email, bookable: true } as unknown as User);

    const dB = makeDeps({ bookingById: { booking: makeBooking({ id: "bk1" }), bucket, eventType }, agentByEmail: owner("b", "b@x.com") });
    await reassignBooking("bk1", "b@x.com", SYS, dB.deps);
    const clientB = dB.calls.createEvent[0]?.clientId;

    const dC = makeDeps({ bookingById: { booking: makeBooking({ id: "bk1" }), bucket, eventType }, agentByEmail: owner("c", "c@x.com") });
    await reassignBooking("bk1", "c@x.com", SYS, dC.deps);
    const clientC = dC.calls.createEvent[0]?.clientId;

    const d2 = makeDeps({ bookingById: { booking: makeBooking({ id: "bk2" }), bucket, eventType }, agentByEmail: owner("b", "b@x.com") });
    await reassignBooking("bk2", "b@x.com", SYS, d2.deps);
    const client2 = d2.calls.createEvent[0]?.clientId;

    assert(!!clientB && clientB.startsWith("slate"), "reassign: new event uses a deterministic 'slate' client id");
    assert(clientB !== clientC, "reassign: client id is keyed on the TARGET agent (B != C)");
    assert(clientB !== client2, "reassign: client id is keyed on the booking (bk1 != bk2)");

    // Determinism: the same booking + same target recomputes the SAME id, so a
    // crash-retry of this exact reassign reuses the event (Google 409) not a dup.
    const dB2 = makeDeps({ bookingById: { booking: makeBooking({ id: "bk1" }), bucket, eventType }, agentByEmail: owner("b", "b@x.com") });
    await reassignBooking("bk1", "b@x.com", SYS, dB2.deps);
    assert(
      dB2.calls.createEvent[0]?.clientId === clientB,
      "reassign: same booking+target yields the SAME client id (idempotent retry)",
    );
  }

  // --- reassign: same-target re-submit reuses the event, must NOT delete it (#449) ---
  // When the event created for the target equals the event the swap replaced
  // (a deterministic-id 409 reuse on a same-target re-submit), deleting it would
  // remove the LIVE event, so the guard must skip the delete.
  {
    // Booking currently on "a"; its current event id is "gcal-x". Make createEvent
    // return that same id, so the swap's previous == the new event.
    const ctx = { booking: makeBooking({ gcal_event_id: "gcal-x", agent_email: "a@x.com", assigned_user_id: "a" }), bucket, eventType };
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: owner });
    deps.createEvent = async () => "gcal-x";
    await reassignBooking("bk1", "b@x.com", SYS, deps);
    assert(
      calls.reassignSwaps.length === 1 && calls.deleteEvent.length === 0,
      "reassign: when the swap's previous event equals the new event, the live event is NOT deleted",
    );
  }

  // --- reassign: a swap that did not take (terminal) cleans up the created event (#449) ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: owner, reassignSwapTerminal: true });
    let threw = false;
    try {
      await reassignBooking("bk1", "b@x.com", SYS, deps);
    } catch {
      threw = true;
    }
    assert(threw, "reassign: a booking that went terminal during the swap surfaces an error");
    assert(calls.createEvent.length === 1, "reassign: the event was optimistically created");
    assert(
      calls.deleteEvent.length === 1,
      "reassign: the optimistically-created event is cleaned up (not orphaned) when the swap doesn't take",
    );
  }

  // --- reassign: a swap RPC error also cleans up the created event + rethrows (#449) ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: owner, reassignSwapThrows: true });
    let msg = "";
    try {
      await reassignBooking("bk1", "b@x.com", SYS, deps);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    assert(msg === "rpc down", "reassign: a swap RPC error surfaces the original error (not a masked message)");
    assert(
      calls.createEvent.length === 1 && calls.deleteEvent.length === 1,
      "reassign: a swap RPC error still cleans up the optimistically-created event (no orphan)",
    );
  }

  // --- reassign: unknown / offboarded agent is rejected ---
  {
    const { deps } = makeDeps({ bookingById: { booking: makeBooking({}), bucket, eventType }, agentByEmail: null });
    let threw = false;
    try {
      await reassignBooking("bk1", "ghost@x.com", SYS, deps);
    } catch {
      threw = true;
    }
    assert(threw, "reassign: rejects an unknown/offboarded agent");
  }

  // --- reassign: booking not found ---
  {
    const { deps } = makeDeps({ bookingById: null });
    let threw = false;
    try {
      await reassignBooking("nope", "b@x.com", SYS, deps);
    } catch {
      threw = true;
    }
    assert(threw, "reassign: throws when the booking is not found");
  }

  // --- reassign: already the owning agent is a no-op ---
  {
    const ctx = { booking: makeBooking({ assigned_user_id: "b", agent_email: "b@x.com" }), bucket, eventType };
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: owner });
    await reassignBooking("bk1", "b@x.com", SYS, deps);
    assert(
      calls.createEvent.length === 0 && calls.commitReschedule.length === 0 && calls.webhooks.length === 0,
      "reassign: no-op when already the owning agent",
    );
  }

  // --- #2368 control: a REAL reschedule still fires booking.rescheduled -------
  // The change above moves one event and must move only that one. Without this,
  // routing every move to booking.reassigned would pass every assertion in this
  // file while silently taking the reschedule event away from Regal, which is
  // where a genuine time change belongs. A one sided proof is no proof (L1).
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const moved = {
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
      bookingById: moved,
      freeEmails: new Set(["a@x.com"]),
    });
    await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    assert(
      calls.webhooks.length === 1 && calls.webhooks[0].event === "booking.rescheduled",
      "reschedule: a real time change still fires booking.rescheduled",
    );
    assert(
      !calls.webhooks.some((w) => w.event === "booking.reassigned"),
      "reschedule: a time change fires NO booking.reassigned",
    );
    assert(
      calls.webhooks[0].previousAgentEmail === null,
      "reschedule: no previous advisor on an event that did not change advisor",
    );
  }

  // --- a reassign invalidates the 24 hour reminder (#2500) --------------------
  //
  // The stored record is the START a reminder went out about, so a booking that
  // MOVES earns a fresh one by construction. A reassign at the SAME start does not
  // move, so the record still matches and no second reminder is sent: the lead is
  // left holding a message naming the advisor who is no longer taking the call,
  // from a mailbox that is no longer watching for their reply.
  //
  // The reminder is a property of the appointment, and WHO is calling is part of the
  // appointment, so the record is cleared where the advisor changes.
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: owner });
    await reassignBooking("bk1", "b@x.com", SYS, deps);
    assert(
      calls.clearedReminderRecords.length === 1 && calls.clearedReminderRecords[0] === "bk1",
      "reassign: the reminder record is cleared, so the lead hears from the new advisor",
    );
  }

  // --- and the clear cannot cost the lead their reassign ----------------------
  //
  // It is a write AFTER the durable anchor has committed, so a failure of it leaves
  // exactly the pre-#2500 behaviour (a reminder naming the previous advisor) rather
  // than an unreassigned booking. Throwing here would abandon the calendar cleanup
  // and the webhooks for a message that is a nicety beside them.
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps, calls } = makeDeps({
      bookingById: ctx,
      agentByEmail: owner,
      clearReminderRecordThrows: true,
    });
    const res = await reassignBooking("bk1", "b@x.com", SYS, deps);
    assert(res.booking.agent_email === "b@x.com", "reassign: still completes when the clear fails");
    assert(
      calls.webhooks.some((w) => w.event === "booking.reassigned"),
      "reassign: and the reassign webhook still fires",
    );
  }

}

await run();
finish();
