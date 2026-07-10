// reassignBooking: caps, history, deterministic event ids, swap cleanup, authorization.
//
// Split out of the old 3,229-line scripts/test-booking-orchestration.ts (#605);
// the shared BookingDeps fake lives in scripts/lib/booking-fakes.ts.
// Run: node --experimental-strip-types scripts/test-booking-reassign.ts
import {
  reassignBooking,
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
  SYS,
} from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

async function run() {
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
    assert(calls.webhooks.some((w) => w.event === "booking.rescheduled"), "reassign: fires booking.rescheduled");
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
    const { deps } = makeDeps({
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
    assert(
      calls.webhooks.some((w) => w.event === "booking.rescheduled"),
      "reassign(admin): still fires booking.rescheduled (Regal contract)",
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

}

await run();
finish();
