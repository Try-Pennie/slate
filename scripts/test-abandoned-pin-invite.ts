// #3924: an in place reschedule that dies between its Google PATCH and its booking
// commit leaves the lead's invite at the new time while the booking stays at the old
// one. The PATCH is sent with `sendUpdates=all`, so the lead has already been emailed
// a time nobody booked. The abandoned pin sweep is what finds such a pin, and it now
// reads the invite and puts it back to the booking's time (the lead emailed again),
// or reports it when it cannot.
//
// Everything here is the real reschedule and the real sweep over the shared fakes:
// the reschedule is crashed for real at its commit (the dead process never runs its
// own release), so the pin the sweep finds is the one a crash leaves.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-abandoned-pin-invite.ts
import {
  rescheduleBooking,
  processAbandonedReschedulePins,
  RescheduleConflictError,
  type BookingDeps,
} from "../src/lib/booking/orchestration.ts";
import { EventGone } from "../src/lib/booking/core.ts";
import { GoogleHttpError } from "../src/lib/google/http-error.ts";
import { createAsserter, makeDeps, makeBooking, bucket, eventType, RR, NOW } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

const BOOKED_START = "2026-06-08T13:00:00.000Z";
const BOOKED_END = "2026-06-08T13:30:00.000Z";
const TARGET = "2026-06-09T14:00:00.000Z";
const TARGET_END = "2026-06-09T14:30:00.000Z";

/**
 * A PROCESS crash at `method`: it throws once, and the dead attempt's own release
 * never runs (a dead process runs no `finally`), so its pinned lock is left behind
 * exactly as a crash leaves it.
 */
function crashAt(deps: BookingDeps, method: "commitReschedule" | "updateEventTime"): void {
  let fired = false;
  const original = (deps[method] as (...args: unknown[]) => Promise<unknown>).bind(deps);
  (deps as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
    if (!fired) {
      fired = true;
      throw new Error(`injected crash: ${method}`);
    }
    return original(...args);
  };
  let suppressed = false;
  const release = deps.releaseReschedule.bind(deps);
  deps.releaseReschedule = async (bookingId: string) => {
    if (!suppressed) {
      suppressed = true;
      return;
    }
    return release(bookingId);
  };
}

/** A booking moved in place by a reschedule that died at `at`, its lease run out. */
async function crashedInPlace(at: "commitReschedule" | "updateEventTime" = "commitReschedule") {
  const ctx = { booking: makeBooking({}), bucket, eventType };
  // The advisor is free at the new time, so the move keeps them: the in place branch.
  const made = makeDeps({ existing: ctx, candidates: ["a", "b"], freeEmails: new Set(["a@x.com", "b@x.com"]) });
  crashAt(made.deps, at);
  let crashed = false;
  try {
    await rescheduleBooking("tok1", TARGET, RR, "customer", made.deps, NOW);
  } catch {
    crashed = true;
  }
  made.expireLease("bk1");
  return { ...made, ctx, crashed };
}

/** Where the advisor's calendar holds the invite now. */
async function inviteStart(deps: BookingDeps): Promise<string | null> {
  const ev = await deps.readEventOnPrimary("a@x.com", "gcal-old");
  return ev?.start?.dateTime ?? null;
}

async function run() {
  // --- 1. the headline: the PATCH landed, the commit did not, the sweep puts it back
  {
    const { deps, calls, ctx, crashed, getLease } = await crashedInPlace();
    assert(crashed, "setup: the in place reschedule dies at its commit");
    assert(
      calls.updateEventTime.length === 1 &&
        calls.updateEventTime[0].start === TARGET &&
        calls.updateEventTime[0].end === TARGET_END,
      "setup: the crashed reschedule had already PATCHed the invite to the new time",
    );
    assert(ctx.booking.starts_at === BOOKED_START, "setup: the booking is still at its original time");
    assert(getLease("bk1")?.pin?.branch === "in_place", "setup: the dead reschedule's in place pin is left behind");

    const res = await processAbandonedReschedulePins(deps, 0, NOW);
    const putBack = calls.updateEventTime[1];
    assert(
      calls.updateEventTime.length === 2 &&
        putBack.id === "gcal-old" &&
        putBack.start === BOOKED_START &&
        putBack.end === BOOKED_END,
      "the sweep moves the invite back to the booking's own time (the update the lead is emailed)",
    );
    assert((await inviteStart(deps)) === BOOKED_START, "the advisor's invite is at the booked time again");
    assert(res.invitesPutBack === 1, "the put back is counted, so the dropped reschedule alert can say it");
    assert(res.dropped === 1, "the reschedule is still reported as lost: the booking never moved");
    assert(res.strandedInvites.length === 0, "nothing is reported as stranded when the put back worked");
    assert(getLease("bk1") === undefined, "the sweep frees the lock once the invite is back");

    // Runs twice: the second pass finds no pin and moves nothing.
    const again = await processAbandonedReschedulePins(deps, 0, NOW);
    assert(again.swept === 0 && calls.updateEventTime.length === 2, "a second sweep moves the invite no further");
  }

  // --- 2. two sweeps at once: exactly one takes the lock and puts the invite back
  {
    const { deps, calls } = await crashedInPlace();
    const [r1, r2] = await Promise.all([
      processAbandonedReschedulePins(deps, 0, NOW),
      processAbandonedReschedulePins(deps, 0, NOW),
    ]);
    assert(calls.updateEventTime.length === 2, "two concurrent sweeps put the invite back once, not twice");
    assert(r1.invitesPutBack + r2.invitesPutBack === 1, "only the sweep that took the lock counts the put back");
    assert(r1.dropped + r2.dropped === 1, "the lost reschedule is counted once, by the sweep that took the lock");
  }

  // --- 3. a live reschedule takes the lease between the sweep's read and its claim
  {
    const { deps, calls, getLease } = await crashedInPlace();
    const load = deps.loadAbandonedReschedulePins.bind(deps);
    deps.loadAbandonedReschedulePins = async (graceMs: number) => {
      const rows = await load(graceMs);
      // The lead retried: their reschedule took over the expired lease and is live.
      getLease("bk1")!.leaseUntilMs = Date.now() + 120_000;
      return rows;
    };
    const res = await processAbandonedReschedulePins(deps, 0, NOW);
    assert(calls.updateEventTime.length === 1, "lock held: the sweep never touches an invite a live reschedule is moving");
    assert(getLease("bk1") !== undefined, "lock held: the live holder's lock is left in place, not deleted under it");
    assert(res.swept === 0 && res.dropped === 0, "lock held: a row somebody now holds is not swept or counted");
  }

  // --- 4. while the sweep holds the lock, a lead re-sending the same move is refused,
  // never told it is done: the sweep is undoing that move, not finishing it.
  {
    const { deps } = await crashedInPlace();
    const patch = deps.updateEventTime.bind(deps);
    let retry: unknown = "not attempted";
    deps.updateEventTime = async (email, id, start, end, tz) => {
      if (start === BOOKED_START) {
        retry = await rescheduleBooking("tok1", TARGET, RR, "customer", deps, NOW).then(
          () => "answered as done",
          (err: unknown) => err,
        );
      }
      return patch(email, id, start, end, tz);
    };
    await processAbandonedReschedulePins(deps, 0, NOW);
    assert(
      retry instanceof RescheduleConflictError,
      "held: the lead's same move during the put back meets the busy answer, not a false success",
    );
  }

  // --- 5. Google refuses the put back: reported, the lock freed, the sweep goes on
  {
    const { deps, getLease } = await crashedInPlace();
    const patch = deps.updateEventTime.bind(deps);
    let attempts = 0;
    deps.updateEventTime = async (email, id, start, end, tz) => {
      if (start === BOOKED_START) {
        attempts++;
        throw new GoogleHttpError("events.patch failed: 403 forbiddenForNonOrganizer", 403, "forbiddenForNonOrganizer");
      }
      return patch(email, id, start, end, tz);
    };
    const res = await processAbandonedReschedulePins(deps, 0, NOW);
    const s = res.strandedInvites[0];
    assert(
      res.strandedInvites.length === 1 &&
        s.bookingId === "bk1" &&
        s.reason === "refused" &&
        s.advisorEmail === "a@x.com" &&
        s.bookedStartsAt === BOOKED_START &&
        s.targetStartsAt === TARGET &&
        s.inviteStartsAt === TARGET &&
        (s.detail ?? "").includes("403"),
      "refused: the invite is reported with Google's short reason and both times",
    );
    assert(res.invitesPutBack === 0, "refused: nothing is counted as put back");
    assert(getLease("bk1") === undefined, "refused: the lock is still freed");
    assert(attempts === 1, "refused: one attempt, not retried in the same pass");
  }

  // --- 6. the invite is gone when the sweep goes to put it back
  {
    const { deps } = await crashedInPlace();
    const patch = deps.updateEventTime.bind(deps);
    deps.updateEventTime = async (email, id, start, end, tz) => {
      if (start === BOOKED_START) throw new EventGone("events.patch");
      return patch(email, id, start, end, tz);
    };
    const res = await processAbandonedReschedulePins(deps, 0, NOW);
    assert(
      res.strandedInvites.length === 1 && res.strandedInvites[0].reason === "gone",
      "gone: an invite that vanished before it could be put back is reported as gone",
    );
  }

  // --- 7. the invite cannot be read: reported, never guessed at
  {
    const { deps, calls, getLease } = await crashedInPlace();
    deps.readEventOnPrimary = async () => {
      throw new GoogleHttpError("events.get failed: 503 backendError", 503, "backendError");
    };
    const res = await processAbandonedReschedulePins(deps, 0, NOW);
    const s = res.strandedInvites[0];
    assert(
      res.strandedInvites.length === 1 && s.reason === "invite-unreadable" && s.inviteStartsAt === null && (s.detail ?? "").includes("503"),
      "unreadable: an invite that could not be read is reported, with no time claimed for it",
    );
    assert(calls.updateEventTime.length === 1, "unreadable: nothing is moved on a guess");
    assert(getLease("bk1") === undefined, "unreadable: the lock is freed");
  }

  // --- 7b. the booking cannot be read under the lock: reported as that, not as the invite
  {
    const { deps, calls } = await crashedInPlace();
    deps.readBookingInviteState = async () => {
      throw new Error("abandoned pin booking: canceling statement due to statement timeout");
    };
    const res = await processAbandonedReschedulePins(deps, 0, NOW);
    const s = res.strandedInvites[0];
    assert(
      res.strandedInvites.length === 1 && s.reason === "booking-unreadable" && s.inviteStartsAt === null,
      "booking unreadable: reported as the booking that could not be read, never as the invite",
    );
    assert(calls.updateEventTime.length === 1 && calls.readEventOnPrimary.length === 0, "booking unreadable: no invite read, nothing moved");
  }

  // --- 8. the invite is at a third time: not what the crash wrote, so not put back
  {
    const { deps, calls, googleEvents } = await crashedInPlace();
    googleEvents.set("gcal-old", { start: "2026-06-10T09:00:00.000Z", end: "2026-06-10T09:30:00.000Z" });
    const res = await processAbandonedReschedulePins(deps, 0, NOW);
    const s = res.strandedInvites[0];
    assert(
      res.strandedInvites.length === 1 && s.reason === "elsewhere" && s.inviteStartsAt === "2026-06-10T09:00:00.000Z",
      "elsewhere: an invite at neither the booked time nor the crashed move's is reported",
    );
    assert(calls.updateEventTime.length === 1, "elsewhere: a move Slate did not make is not undone by the sweep");
  }

  // --- 9. the reschedule died BEFORE its PATCH: the invite never moved, nothing to do
  {
    const { deps, calls, crashed } = await crashedInPlace("updateEventTime");
    assert(crashed && calls.updateEventTime.length === 0, "setup: the reschedule dies at its PATCH, before it is sent");
    const res = await processAbandonedReschedulePins(deps, 0, NOW);
    assert(calls.updateEventTime.length === 0, "unpatched: an invite still at the booked time is left alone");
    assert(res.invitesPutBack === 0 && res.strandedInvites.length === 0, "unpatched: nothing put back, nothing reported");
    assert(res.dropped === 1, "unpatched: the lost reschedule is still reported");
  }

  // --- 10. cancelled while the pin sat there: its invite is not the sweep's to move
  {
    const { deps, calls, ctx } = await crashedInPlace();
    ctx.booking.status = "cancelled";
    const res = await processAbandonedReschedulePins(deps, 0, NOW);
    assert(calls.updateEventTime.length === 1, "cancelled: a cancelled booking's invite is never moved or emailed about");
    assert(res.strandedInvites.length === 0, "cancelled: and it is not reported as stranded");
  }

  // --- 11. the call has already happened: nothing to put right, no Google read
  {
    const { deps, calls } = await crashedInPlace();
    let reads = 0;
    const read = deps.readEventOnPrimary.bind(deps);
    deps.readEventOnPrimary = async (email, id) => {
      reads++;
      return read(email, id);
    };
    const res = await processAbandonedReschedulePins(deps, 0, Date.parse(BOOKED_END) + 60_000);
    assert(reads === 0 && calls.updateEventTime.length === 1, "past: an ended call's invite is neither read nor moved");
    assert(res.strandedInvites.length === 0, "past: and nothing is reported");
  }

  // --- 12. the reroute branch is untouched: its pin names a new advisor's event
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls, expireLease } = makeDeps({ existing: ctx, candidates: ["b"], freeEmails: new Set(["b@x.com"]) });
    crashAt(deps, "commitReschedule");
    await rescheduleBooking("tok1", TARGET, RR, "customer", deps, NOW).catch(() => undefined);
    expireLease("bk1");
    const res = await processAbandonedReschedulePins(deps, 0, NOW);
    assert(calls.updateEventTime.length === 0, "reroute: the original invite was never moved, so nothing is put back");
    assert(res.enqueued === 1 && res.dropped === 1, "reroute: the new advisor's event is queued for deletion as before");
  }
}

run().then(finish, (err) => {
  console.error(err);
  process.exit(1);
});
