// rescheduleBooking under concurrency: crash windows, leases, pins, oscillation guards.
//
// Split out of the old 3,229-line scripts/test-booking-orchestration.ts (#605);
// the shared BookingDeps fake lives in scripts/lib/booking-fakes.ts.
// Run: node --experimental-strip-types scripts/test-booking-reschedule-concurrency.ts
import {
  rescheduleBooking,
  processAbandonedReschedulePins,
  RescheduleConflictError,
  type BookingDeps,
} from "../src/lib/booking/orchestration.ts";
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
  // --- reschedule: same agent busy -> reassign to B ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx, candidates: ["b"], freeEmails: new Set(["b@x.com"]) });
    const res = await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    assert(res.booking.assigned_user_id === "b" && res.booking.agent_email === "b@x.com", "reschedule(reassign): moves to free agent B");
    assert(calls.deleteEvent.length === 1 && calls.deleteEvent[0].id === "gcal-old", "reschedule(reassign): old event deleted");
    assert(calls.createEvent.length === 1, "reschedule(reassign): new event created for B");
    assert(calls.updateEventTime.length === 0, "reschedule(reassign): no in-place move");
  }

  // ===================================================================
  // Phase 0 (#471): crash-injection RED tests for crash-safe reschedule.
  // These assert the END-STATE invariants the lease-pin design must give
  // (windows a/b/c + oscillation + the headline abandoned-pin gap). They
  // fail against today's applyReschedule and go green as Phases 1-3 land.
  // ===================================================================

  // Make a deps method throw on its first invocation, then delegate, a crash
  // injected mid-sequence. The retry runs on the SAME deps so the simulated
  // Google state (the clientId->event reuse map) persists across the crash.
  const crashOnce = (deps: BookingDeps, method: keyof BookingDeps): void => {
    let fired = false;
    const original = (deps[method] as (...args: unknown[]) => Promise<unknown>).bind(deps);
    (deps as Record<string, unknown>)[method as string] = async (...args: unknown[]) => {
      if (!fired) {
        fired = true;
        throw new Error(`injected crash: ${String(method)}`);
      }
      return original(...args);
    };
  };

  // Model a PROCESS crash at the commit: commitReschedule throws once, AND the
  // crashed attempt's `finally`-release is suppressed (a dead process never runs
  // its finally), so the lease is left behind for the retry to resume, exactly
  // the crashed-holder state the design recovers from. The retry's own release
  // still works.
  const crashAtCommit = (deps: BookingDeps): void => {
    crashOnce(deps, "commitReschedule");
    let suppressed = false;
    const release = deps.releaseReschedule.bind(deps);
    deps.releaseReschedule = async (bookingId: string) => {
      if (!suppressed) {
        suppressed = true;
        return;
      }
      return release(bookingId);
    };
  };

  // --- window (a): crash in the reassign branch after createEvent, before commit ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls, expireLease } = makeDeps({ existing: ctx, candidates: ["b"], freeEmails: new Set(["b@x.com"]) });
    crashAtCommit(deps); // crash at the commit, after the pin write + createEvent
    let crashed = false;
    try {
      await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    } catch {
      crashed = true;
    }
    assert(crashed, "window(a): reassign-branch reschedule crashes after createEvent, before commit");
    // The crashed holder's lease must EXPIRE before a retry resumes (a fresh-lease
    // same-target retry is a deliberate no-op); then the retry adopts the pin.
    expireLease("bk1");
    await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    const clientIds = new Set(calls.createEvent.map((c) => c.clientId));
    assert(
      calls.createEvent.length >= 2 &&
        calls.createEvent.every((c) => typeof c.clientId === "string" && c.clientId.startsWith("slate")) &&
        clientIds.size === 1,
      "window(a): crash + retry reuse ONE deterministic event id (no duplicate Google event)",
    );
  }

  // --- window (b): crash in the same-agent in-place branch, before commit ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const free = new Set(["a@x.com", "b@x.com"]); // a free at first -> in-place branch
    const { deps, calls, expireLease } = makeDeps({ existing: ctx, candidates: ["a", "b"], freeEmails: free });
    crashAtCommit(deps); // crash at the commit, after the in-place pin write + updateEventTime
    let crashed = false;
    try {
      await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    } catch {
      crashed = true;
    }
    assert(crashed, "window(b): same-agent in-place reschedule crashes after updateEventTime, before commit");
    // Poison freeBusy AND expire the lease: on a resume the pin's branch=in_place
    // must short-circuit isFree entirely, so the poisoned read can't bump the agent.
    free.delete("a@x.com");
    expireLease("bk1");
    const res = await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    assert(
      res.booking.assigned_user_id === "a" &&
        res.booking.starts_at === "2026-06-09T14:00:00.000Z" &&
        calls.createEvent.length === 0,
      "window(b): resume stays on the SAME agent, completes the move, creates no new event",
    );
  }

  // --- #615: a cancel that lands DURING an in-place reschedule (after the PATCH,
  // before the commit) must NOT resurrect the booking. The gated commit touches 0
  // rows, the booking stays cancelled, and the reschedule surfaces a conflict. ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls } = makeDeps({
      existing: ctx,
      candidates: ["a", "b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]), // a on-shift + free -> in-place branch
      // The cancel lands mid-PATCH: flip the row to cancelled (as claimCancellation would).
      concurrentBeforeCommit: (b) => {
        b.status = "cancelled";
      },
    });
    let conflicted = false;
    try {
      await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    } catch (err) {
      conflicted = err instanceof RescheduleConflictError;
    }
    assert(conflicted, "#615 cancel-during-reschedule: throws RescheduleConflictError (no silent resurrect)");
    assert(
      ctx.booking.status === "cancelled",
      "#615 cancel-during-reschedule: the booking STAYS cancelled (gated commit touched 0 rows)",
    );
    assert(
      calls.createEvent.length === 0,
      "#615 cancel-during-reschedule: in-place branch created no event, so there is no orphan",
    );
  }

  // --- #615: a reassign that lands DURING a reassign-branch reschedule (after the
  // new event is created, before the commit) must NOT be clobbered. The gated
  // commit touches 0 rows, the reschedule rolls back the event it created and
  // conflicts, and the reassign's agent + event remain the live ones. ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls } = makeDeps({
      existing: ctx,
      // a is off-shift at the new time, so the reschedule re-routes to b (reassign branch).
      candidates: ["b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]),
      workingHoursByUser: new Map([
        ["a", { timezone: "America/New_York", rules: [{ weekday: 1, start_minute: 9 * 60, end_minute: 810 }] }],
      ]),
      // A concurrent reassign to agent C swaps assignee + event id (0058 swap shape).
      concurrentBeforeCommit: (b) => {
        b.assigned_user_id = "c";
        b.agent_email = "c@x.com";
        b.gcal_event_id = "ev-reassign";
        b.status = "rescheduled";
      },
    });
    let conflicted = false;
    // 2026-06-08T18:00Z = 14:00 NY Monday, past a's 13:30 shift end -> reassign branch.
    try {
      await rescheduleBooking("tok1", "2026-06-08T18:00:00.000Z", RR, "customer", deps, NOW);
    } catch (err) {
      conflicted = err instanceof RescheduleConflictError;
    }
    assert(conflicted, "#615 reassign-during-reschedule: throws RescheduleConflictError (does not clobber)");
    assert(
      ctx.booking.assigned_user_id === "c" && ctx.booking.gcal_event_id === "ev-reassign",
      "#615 reassign-during-reschedule: the reassign's agent + event stay live (not overwritten)",
    );
    assert(
      // AUD-044/#518 create-first: the old event is deleted only AFTER a durable
      // commit, which this conflict never reaches. So the ONLY deletion is the
      // rollback of the event this reschedule created (1). The concurrent
      // reassign's live event ("ev-reassign") AND the original old event
      // ("gcal-old", owned by the concurrent reassign's own lifecycle) are both
      // left intact (strictly better than the old delete-first, which clobbered
      // gcal-old before even knowing about the conflict).
      calls.deleteEvent.length === 1 &&
        !calls.deleteEvent.some((d) => d.id === "ev-reassign") &&
        !calls.deleteEvent.some((d) => d.id === "gcal-old"),
      "#615 reassign-during-reschedule: rolls back its own created event, leaves the reassign's + the old event intact",
    );
  }

  // --- window (c): concurrent different-target reschedule must CONFLICT, not no-op ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    // Another in-flight reschedule holds a FRESH lease for a DIFFERENT target.
    const { deps, calls } = makeDeps({
      existing: ctx,
      freeEmails: new Set(["a@x.com"]),
      heldLease: { target: "2026-06-09T09:00:00.000Z" },
    });
    let err: unknown;
    try {
      await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    } catch (e) {
      err = e;
    }
    assert(
      err != null && (err as Error).name === "RescheduleConflictError",
      "window(c): a concurrent different-target reschedule throws RescheduleConflictError (not a silent no-op)",
    );
    assert(
      calls.updateEventTime.length === 0 && calls.createEvent.length === 0,
      "window(c): the conflict loser makes no Google move",
    );
  }

  // --- #480: Guard-1 cleanup must NOT clobber a concurrent different-target lease ---
  // The booking already sits at target T (a commit-then-crash left a T-pinned lock).
  // Guard-1 cleans that leftover up, but between the OLD read-then-delete a DIFFERENT
  // -target holder re-pins to T2. An unconditional delete clobbers that fresh T2 lease
  // (the documented micro-race); the atomic target-conditional delete leaves it alone.
  {
    const T = "2026-06-08T13:00:00.000Z"; // the booking's current time (Guard-1 path)
    const T2 = "2026-06-11T10:00:00.000Z"; // the concurrent holder's different target
    const ctx = { booking: makeBooking({ starts_at: T }), bucket, eventType };
    const pinAt = (target: string, seq: number) => ({
      reschedule_seq: seq,
      branch: "in_place" as const,
      pinned_user_id: "a",
      pinned_agent_email: "a@x.com",
      gcal_client_id: "gcal-old",
      target_starts_at: target,
    });
    const { deps, calls, getLease } = makeDeps({
      existing: ctx,
      heldLease: { target: T, pin: pinAt(T, 0) }, // the commit-then-crash leftover at T
      repinAtCleanup: { toTarget: T2, pin: pinAt(T2, 1) }, // a different-target holder slips in
    });
    await rescheduleBooking("tok1", T, RR, "customer", deps, NOW);
    const lease = getLease("bk1");
    assert(
      lease != null && Date.parse(lease.target) === Date.parse(T2),
      "#480: Guard-1 cleanup leaves a concurrent different-target lease intact (no read->delete clobber)",
    );
    assert(
      calls.releaseRescheduleIfTarget === 1 && calls.releaseReschedule === 0,
      "#480: Guard-1 cleans up via the atomic target-conditional delete, not the unconditional one",
    );
  }

  // --- oscillation guard: reassign-branch create must use a deterministic seq-keyed id ---
  // (A->T1->T2->T1 must not reuse a tombstoned id; the full seq-increment assertion
  //  lands in Phase 2/3 unit tests once reschedule_seq exists. Here we pin the core:
  //  the reassign create carries a deterministic 'slate' client id at all.)
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx, candidates: ["b"], freeEmails: new Set(["b@x.com"]) });
    await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    assert(
      calls.createEvent.length === 1 &&
        typeof calls.createEvent[0].clientId === "string" &&
        calls.createEvent[0].clientId!.startsWith("slate"),
      "oscillation guard: reassign-branch reschedule uses a deterministic 'slate' client id",
    );
  }

  // --- sequential reschedule after release: a later different-target move is VALID, not a false conflict ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps } = makeDeps({ existing: ctx, freeEmails: new Set(["a@x.com"]) });
    await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW); // committed + released
    let err: unknown;
    try {
      await rescheduleBooking("tok1", "2026-06-10T15:00:00.000Z", RR, "customer", deps, NOW);
    } catch (e) {
      err = e;
    }
    assert(err == null, "sequential after release: a later different-target reschedule is valid, NOT a false conflict");
  }

  // --- headline gap: different-target reschedule after an ABANDONED same-booking crash ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls, expireLease } = makeDeps({ existing: ctx, candidates: ["b"], freeEmails: new Set(["b@x.com"]) });
    crashAtCommit(deps); // abandon the A->T1 reassign at the commit
    let crashed = false;
    try {
      await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    } catch {
      crashed = true;
    }
    assert(crashed, "headline-gap: A->T1 reschedule crashes after createEvent (abandoned pin)");
    // The abandoned holder's lease expires; a DIFFERENT-target retry adopts its seq.
    expireLease("bk1");
    const res = await rescheduleBooking("tok1", "2026-06-10T15:00:00.000Z", RR, "customer", deps, NOW);
    assert(res.booking.starts_at === "2026-06-10T15:00:00.000Z", "headline-gap: booking lands on T2, not the abandoned T1");
    assert(
      calls.enqueueEventDeletion.length >= 1,
      "headline-gap: the orphaned T1 calendar event is enqueued into pending_event_deletions",
    );
  }

  // --- abandoned-pin GC sweep (#439, #476): cleanup only ---
  const OLD = "2026-06-09T10:00:00.000Z"; // where the booking still sits
  const TARGET = "2026-06-09T14:00:00.000Z"; // where the reschedule meant to move it
  {
    const { deps, calls } = makeDeps({
      abandonedPins: [
        // never-adopted reassign pin -> enqueue its orphaned event, free the lock
        { booking_id: "bk1", pinned_agent_email: "b@x.com", gcal_client_id: "slateorphan", branch: "reassign", booking_gcal_event_id: "gcal-old", target_starts_at: TARGET, booking_starts_at: OLD },
        // in-place pin -> no orphan event, just free the lock
        { booking_id: "bk2", pinned_agent_email: "a@x.com", gcal_client_id: "gcal-old", branch: "in_place", booking_gcal_event_id: "gcal-old", target_starts_at: TARGET, booking_starts_at: OLD },
        // reassign pin that WAS adopted (client id == the live event) -> no enqueue
        { booking_id: "bk3", pinned_agent_email: "c@x.com", gcal_client_id: "gcal-live", branch: "reassign", booking_gcal_event_id: "gcal-live", target_starts_at: TARGET, booking_starts_at: TARGET },
      ],
    });
    const res = await processAbandonedReschedulePins(deps, 0);
    assert(res.swept === 3 && res.enqueued === 1, "sweep: enqueues only the never-adopted reassign orphan");
    assert(
      calls.enqueueEventDeletion.length === 1 && calls.enqueueEventDeletion[0].eventId === "slateorphan",
      "sweep: enqueues the orphaned reassign event for durable deletion",
    );
    assert(calls.releaseReschedule === 3, "sweep: frees every swept lock row");
  }

  // --- #757: the sweep must SAY when a reschedule was genuinely lost ---
  // Cleanup alone is silent, so a crashed reschedule that never moved the booking
  // vanished unnoticed. `dropped` counts the pins whose booking never reached the
  // pinned target time; the caller alerts on it ("fail loud, not silent").
  {
    const { deps } = makeDeps({
      abandonedPins: [
        // Crashed reroute: booking never moved off its old time -> LOST.
        { booking_id: "bk1", pinned_agent_email: "b@x.com", gcal_client_id: "slateorphan", branch: "reassign", booking_gcal_event_id: "gcal-old", target_starts_at: TARGET, booking_starts_at: OLD },
        // Crashed in-place: same story, no orphan event to clean but still LOST.
        { booking_id: "bk2", pinned_agent_email: "a@x.com", gcal_client_id: "gcal-old", branch: "in_place", booking_gcal_event_id: "gcal-old", target_starts_at: TARGET, booking_starts_at: OLD },
      ],
    });
    const res = await processAbandonedReschedulePins(deps, 0);
    assert(res.dropped === 2, "sweep(#757): counts a lost reschedule on BOTH branches, not just the reroute");
  }

  // The false-positive case that decides whether this alert is trustworthy: the
  // reschedule COMMITTED and only the lock release was lost. The booking is sitting
  // at the target time, so nothing was dropped and nobody should be paged.
  {
    const { deps } = makeDeps({
      abandonedPins: [
        { booking_id: "bk1", pinned_agent_email: "a@x.com", gcal_client_id: "gcal-live", branch: "in_place", booking_gcal_event_id: "gcal-live", target_starts_at: TARGET, booking_starts_at: TARGET },
      ],
    });
    const res = await processAbandonedReschedulePins(deps, 0);
    assert(res.swept === 1, "sweep(#757): still frees the stale lock");
    assert(res.dropped === 0, "sweep(#757): a committed reschedule whose release was lost is NOT a dropped reschedule");
  }

  // The booking is gone entirely: there is no stranded reschedule to re-run, so
  // this is cleanup, not a drop.
  {
    const { deps } = makeDeps({
      abandonedPins: [
        { booking_id: "bk1", pinned_agent_email: "a@x.com", gcal_client_id: "gcal-old", branch: "in_place", booking_gcal_event_id: null, target_starts_at: TARGET, booking_starts_at: null },
      ],
    });
    const res = await processAbandonedReschedulePins(deps, 0);
    assert(res.dropped === 0, "sweep(#757): a vanished booking is not a dropped reschedule");
  }

  // --- reschedule: terminal states / not found ---
  {
    const ctx = { booking: makeBooking({ status: "cancelled" }), bucket, eventType };
    const { deps } = makeDeps({ existing: ctx });
    let threw = false;
    try {
      await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    } catch {
      threw = true;
    }
    assert(threw, "reschedule: rejects a cancelled booking");

    const { deps: deps2 } = makeDeps({ existing: null });
    let threw2 = false;
    try {
      await rescheduleBooking("nope", "2026-06-09T14:00:00.000Z", RR, "customer", deps2, NOW);
    } catch {
      threw2 = true;
    }
    assert(threw2, "reschedule: throws when booking not found");
  }

}

await run();
finish();
