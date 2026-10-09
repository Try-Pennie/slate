// A leader that LOSES the insert race tells its line before it cleans up (#3462).
//
// Load run 37566700055, burst 3: the `code:121` line's leader lost the insert race
// (another line's leader had booked the advisor at about 7s) and answered only at
// 12.0s. Its verdict reached the 41 confirms waiting behind it only when its own
// work ended, and on a lost race that work first rolled back the lost attempt
// (compensating the calendar event and deleting the reservation, under the cleanup
// allowance), looked for a next advisor, and awaited a routing decision row. None
// of that could change what the followers were owed: the unique index had already
// said somebody else holds the time. They ran out of budget waiting and were
// answered `503 VERIFY_UNAVAILABLE`.
//
// So a leader that has lost the race and has nobody left in its rung to hand to
// tells the line at once, and only then rolls back and records. What this pins:
//
//  - with a cleanup that does not finish until the test says so, every follower is
//    answered SLOT_TAKEN while it is still running, on the booker confirm and on
//    the direct booking API;
//  - the cleanup and the bookkeeping still run in full, and a cleanup that fails is
//    still the leader's own answer, with the line told once and never twice;
//  - a leader that hands the lead to a next advisor tells the line nothing until it
//    is booked (with its positive control: the same fixture with that advisor busy
//    does tell the line early);
//  - an outage never tells the line early: a failed insert, and a deadline while
//    looking for the next advisor (which must still roll the lost attempt back);
//  - a lost race inside a bucket move the booking API answers as declined settles
//    nothing for the line, as before, while one it does not tolerate reports early.
//
// Every slow call is a promise the test opens, and the line's own timers never
// fire on their own, so nothing here waits on real time (L290, L524).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-confirm-early-race-verdict.ts
import {
  bookViaApi,
  createBooking,
  RaceLostRefusalError,
  type ApiBookingInput,
  type BookingDeps,
  type CreateBookingInput,
} from "../src/lib/booking/orchestration.ts";
import { refusalTraceOf } from "../src/lib/booking/refusal-trace.ts";
import { isolateLine, makeConfirmQueue, type ConfirmLine, type LeaderVerdict } from "../src/lib/booking/confirm-queue.ts";
import { DeadlineExceededError } from "../src/lib/fetch-within-deadline.ts";
import { bucket, createAsserter, eventType, input, makeBooking, makeDeps } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

/** A call that does not finish until the test opens it. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

/**
 * Turn the event loop until `holds` is true, at most `turns` times. Every fake
 * here answers at once, so a confirm that can make progress makes all of it within
 * a turn or two; the bound only exists so a broken fix FAILS rather than hangs.
 */
async function until(holds: () => boolean, turns = 2_000): Promise<boolean> {
  for (let i = 0; i < turns && !holds(); i++) await new Promise((r) => setImmediate(r));
  return holds();
}

/** What a verdict says, as one token for the event log. */
function said(v: LeaderVerdict<unknown>): string {
  return v.full ? `full:${v.refusal}` : "open";
}

/**
 * The isolate's real confirm line, watched: how many confirms have entered it, and
 * every verdict a leader reported, in order, onto the shared event log. Its waits
 * and leases never end on their own, so a follower answered here was answered by a
 * leader's report and by nothing else.
 */
function watchedLine(log: string[]) {
  const never = () => () => {};
  const inner = isolateLine(makeConfirmQueue<unknown>({ timer: never, leaseTimer: never, now: () => 0 }));
  let entered = 0;
  const reports: LeaderVerdict<unknown>[] = [];
  const line: ConfirmLine<unknown> = {
    async enter(key, waitMs) {
      entered++;
      const turn = await inner.enter(key, waitMs);
      if (turn.kind !== "lead") return turn;
      return {
        ...turn,
        done: async (verdict) => {
          reports.push(verdict);
          log.push(`report:${said(verdict)}`);
          await turn.done(verdict);
        },
      };
    },
    lookahead: (key, waitMs) => inner.lookahead(key, waitMs),
    release: () => inner.release(),
  };
  return { line: line as BookingDeps["confirmQueue"], entered: () => entered, reports };
}

/** A different lead for the same slot, so nobody in a crowd matches anybody else. */
function follower(i: number): ApiBookingInput {
  return {
    ...input,
    externalId: `crowd-${i}`,
    salesforceId: `sf-crowd-${i}`,
    attendee: { name: `Lead ${i}`, email: `crowd${i}@example.com`, phone: `+1203556${String(1000 + i)}` },
    confirmReschedule: false,
  };
}

const at = (log: string[], entry: string) => log.indexOf(entry);
/** `first` is on the log, and before `then`, or `then` never came. */
const before = (log: string[], first: string, then: string) =>
  at(log, first) >= 0 && (at(log, then) < 0 || at(log, first) < at(log, then));

type Settled = { result: unknown } | { err: unknown };
const settle = (p: Promise<unknown>, onto: (s: Settled) => void) =>
  p.then(
    (result) => onto({ result }),
    (err: unknown) => onto({ err }),
  );
const errOf = (s: Settled | undefined): unknown => (s && "err" in s ? s.err : undefined);
const shown = (s: Settled | undefined): string => (s === undefined ? "unanswered" : "err" in s ? String(s.err) : "booked");

const CROWD = 5;

async function main() {
  // --- every follower hears SLOT_TAKEN while the leader is still cleaning up -----
  //
  // The pool's only advisor was booked a moment ago by a confirm the candidate read
  // has not caught up with, so only the insert sees it. Five confirms wait behind
  // the leader. The leader's rollback does not finish until the test opens it, and
  // the followers must all be answered before that. Then the rollback finishes and
  // the leader's own answer is the lost race refusal, with the bookkeeping done.
  for (const viaApi of [false, true]) {
    for (const cleanupFails of [false, true]) {
      const label = `${viaApi ? "booking API" : "booker confirm"}${cleanupFails ? ", cleanup fails" : ""}`;
      const log: string[] = [];
      const watched = watchedLine(log);
      const { deps, calls } = makeDeps({
        candidates: ["a"],
        freeEmails: new Set(["a@x.com"]),
        insertBookingConflictFor: new Set(["a"]),
      });
      const crowdIn = gate();
      const cleanup = gate();
      const boom = new Error("reservation delete failed");
      const d: BookingDeps = {
        ...deps,
        confirmQueue: watched.line,
        // The leader is held at its calendar write until the whole crowd is in line
        // behind it, so every follower is waiting when the race is lost.
        createEvent: async (...args) => {
          await crowdIn.promise;
          return deps.createEvent(...args);
        },
        deleteEvent: async (...args) => {
          log.push("event-removed");
          return deps.deleteEvent(...args);
        },
        // The slow cleanup: the reservation delete, the rollback's last step.
        deleteReservation: async (id) => {
          log.push("cleanup:start");
          await cleanup.promise;
          log.push("cleanup:end");
          if (cleanupFails) throw boom;
          return deps.deleteReservation(id);
        },
        recordRoutingDecision: async (row) => {
          log.push("routing-decision");
          return deps.recordRoutingDecision(row);
        },
      };
      const book = (one: ApiBookingInput | CreateBookingInput) => (viaApi ? bookViaApi(one as ApiBookingInput, d) : createBooking(one, d));

      let leader: Settled | undefined;
      const leaderDone = settle(book({ ...input, externalId: "leader-1", confirmReschedule: false } as ApiBookingInput), (s) => (leader = s));
      const answered: (Settled | undefined)[] = Array.from({ length: CROWD }, () => undefined);
      const crowdDone = Array.from({ length: CROWD }, (_, i) =>
        settle(book(follower(i)), (s) => {
          answered[i] = s;
          log.push(`follower-${i}`);
        }),
      );
      assert(await until(() => watched.entered() === 1 + CROWD), `${label}: the leader and all ${CROWD} followers are in the line (got ${watched.entered()})`);
      crowdIn.open();

      const allAnswered = await until(() => answered.every((s) => s !== undefined));
      const cleanupRunning = log.includes("cleanup:start") && !log.includes("cleanup:end");
      assert(
        allAnswered && cleanupRunning,
        `${label}: every follower is answered while the leader's cleanup is still running (answered ${answered.filter(Boolean).length} of ${CROWD}, log ${log.join(" ")})`,
      );
      assert(
        answered.every((s) => {
          const err = errOf(s);
          const t = refusalTraceOf(err);
          return err instanceof RaceLostRefusalError && t?.stage === "follower" && t.leaderRefusal === "race";
        }),
        `${label}: each is told the time is taken, from the leader's lost race (got ${answered.map(shown).join(" | ")})`,
      );
      assert(leader === undefined, `${label}: the leader itself is still cleaning up when they are answered`);

      cleanup.open();
      await leaderDone;
      await Promise.all(crowdDone);

      assert(watched.reports.length === 1, `${label}: the line is told exactly once, never a second time (got ${watched.reports.map(said).join(",")})`);
      assert(
        watched.reports[0]?.full === true && watched.reports[0].refusal === "race",
        `${label}: and what it is told is the lost race (got ${watched.reports.map(said).join(",")})`,
      );
      const seated = watched.reports[0]?.full ? (watched.reports[0].settled as { seated?: unknown } | null)?.seated : undefined;
      assert(Array.isArray(seated), `${label}: the report still carries who sits at the instant, so a lead who holds the time is not told it is taken`);
      assert(before(log, "report:full:race", "cleanup:end"), `${label}: the report comes before the cleanup ends (log ${log.join(" ")})`);
      assert(at(log, "event-removed") >= 0, `${label}: the lost attempt's calendar event is still removed`);
      assert(calls.insertBooking.length === 1, `${label}: only the leader ever reached the insert (got ${calls.insertBooking.length})`);
      if (!cleanupFails) {
        const err = errOf(leader);
        assert(
          err instanceof RaceLostRefusalError && err.lostRaces === 1 && err.boundHit === false,
          `${label}: the leader's own answer is the lost race refusal, as before (got ${String(err)})`,
        );
        assert(
          calls.recordRoutingDecision.length === 1 && calls.recordRoutingDecision[0]?.outcome === "no_availability",
          `${label}: the refusal's routing decision is still recorded (got ${calls.recordRoutingDecision.length})`,
        );
        assert(
          before(log, "report:full:race", "routing-decision") && at(log, "routing-decision") >= 0,
          `${label}: and recorded after the line was told (log ${log.join(" ")})`,
        );
      } else {
        assert(errOf(leader) === boom, `${label}: the cleanup's failure is still the leader's answer (got ${String(errOf(leader))})`);
      }
    }
  }

  // --- a leader that hands to a next advisor tells the line nothing early ----------
  //
  // The same lost race in a pool of two. With b free the leader hands the lead to b
  // and books, so the slot was NOT settled when it lost a: the line must hear
  // nothing while a's attempt rolls back, and one report once b is booked. With b
  // busy (the positive control, L159) there is nobody to hand to, and the line
  // must hear the verdict before the rollback ends.
  for (const nextFree of [true, false]) {
    const label = nextFree ? "hand off" : "hand off control, nobody free";
    const log: string[] = [];
    const watched = watchedLine(log);
    const { deps, calls } = makeDeps({
      candidates: ["a", "b"],
      freeEmails: new Set(nextFree ? ["a@x.com", "b@x.com"] : ["a@x.com"]),
      insertBookingConflictFor: new Set(["a"]),
    });
    const cleanup = gate();
    let deletes = 0;
    const d: BookingDeps = {
      ...deps,
      confirmQueue: watched.line,
      insertReservation: async (row) => {
        log.push(`reserve:${row.pinned_user_id}`);
        return deps.insertReservation(row);
      },
      deleteReservation: async (id) => {
        const n = ++deletes;
        if (n === 1) {
          log.push("cleanup:start");
          await cleanup.promise;
          log.push("cleanup:end");
        }
        return deps.deleteReservation(id);
      },
    };
    let leader: Settled | undefined;
    const done = settle(createBooking(input, d), (s) => (leader = s));
    assert(await until(() => log.includes("cleanup:start")), `${label}: the lost attempt's rollback is reached`);
    // Settle everything that can run while the rollback is held.
    await until(() => false, 50);
    if (nextFree) {
      assert(watched.reports.length === 0, `${label}: nothing is reported while the lost attempt rolls back (got ${watched.reports.map(said).join(",")})`);
    } else {
      assert(
        watched.reports.length === 1 && watched.reports[0]?.full === true,
        `${label}: with nobody to hand to, the lost race is reported before the rollback ends (got ${watched.reports.map(said).join(",")})`,
      );
    }
    cleanup.open();
    await done;
    assert(watched.reports.length === 1, `${label}: the line is told exactly once (got ${watched.reports.map(said).join(",")})`);
    if (nextFree) {
      const res = leader && "result" in leader ? (leader.result as { booking?: { assigned_user_id?: string } }) : undefined;
      assert(res?.booking?.assigned_user_id === "b", `${label}: the leader is booked with the next advisor (got ${String(errOf(leader) ?? res?.booking?.assigned_user_id)})`);
      // #3338: a leader settles its line only when its whole ladder is spent, and
      // booking b leaves the rungs below with room, so the one report says nothing
      // settles; the confirm behind runs for itself.
      assert(
        before(log, "reserve:b", "report:open") && at(log, "report:open") >= 0,
        `${label}: the report comes after the booking with b, and settles nothing while the ladder below has room (log ${log.join(" ")})`,
      );
      // The next attempt reuses the idempotency key, whose unique index would hand
      // back the lost reservation if it were still there.
      assert(
        before(log, "cleanup:end", "reserve:b") && at(log, "reserve:b") >= 0,
        `${label}: the lost reservation is gone before the next one is written (log ${log.join(" ")})`,
      );
      assert(calls.deleteEvent.some((e) => e.id === "gcal-1"), `${label}: the lost attempt's event is removed`);
    } else {
      assert(errOf(leader) instanceof RaceLostRefusalError, `${label}: the leader is refused as a lost race (got ${String(errOf(leader))})`);
    }
  }

  // --- an outage never tells the line early ----------------------------------------
  //
  // A failed insert is not a lost race: nothing about the slot was learnt, so the
  // line hears that nothing settles, once, at the end.
  {
    const log: string[] = [];
    const watched = watchedLine(log);
    const { deps } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]), insertBookingFails: true });
    let leader: Settled | undefined;
    await settle(createBooking(input, { ...deps, confirmQueue: watched.line }), (s) => (leader = s));
    assert(
      watched.reports.length === 1 && !watched.reports[0]?.full,
      `failed insert: the line is told nothing settles, once (got ${watched.reports.map(said).join(",")})`,
    );
    assert(String(errOf(leader)).includes("Failed to persist booking"), `failed insert: the leader answers its own failure (got ${String(errOf(leader))})`);
  }

  // A deadline while checking the next advisor (#3402): the budget ran out, so the
  // time was not learnt to be taken. No early report, the deadline is the answer,
  // and the lost attempt is still rolled back, even though the check now runs
  // before the rollback rather than after it.
  {
    const log: string[] = [];
    const watched = watchedLine(log);
    const { deps, calls } = makeDeps({
      candidates: ["a", "b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]),
      insertBookingConflictFor: new Set(["a"]),
    });
    const deadline = new DeadlineExceededError("google", 0, { label: "the booking confirm", totalMs: 12_000 });
    let verifies = 0;
    const d: BookingDeps = {
      ...deps,
      confirmQueue: watched.line,
      verifyFree: async (...args) => {
        if (++verifies > 1) throw deadline;
        return deps.verifyFree(...args);
      },
    };
    let leader: Settled | undefined;
    await settle(createBooking(input, d), (s) => (leader = s));
    assert(errOf(leader) === deadline, `deadline on the next advisor: the deadline is the answer (got ${String(errOf(leader))})`);
    assert(
      watched.reports.length === 1 && !watched.reports[0]?.full,
      `deadline on the next advisor: the line is told nothing settles, once (got ${watched.reports.map(said).join(",")})`,
    );
    assert(
      calls.deleteEvent.some((e) => e.id === "gcal-1") && calls.deletedReservations.length === 1,
      `deadline on the next advisor: the lost attempt is still rolled back (events ${JSON.stringify(calls.deleteEvent)}, reservations ${calls.deletedReservations.length})`,
    );
  }

  // --- a lost race inside a booking API bucket move ---------------------------------
  //
  // A lead who holds 13:00 in an old bucket is re-tiered and confirms 13:00 again,
  // so the API moves them, and the move's create loses the race with nobody left.
  // That arm answers the refusal as a declined move and its turn settles nothing
  // for the line (`bookViaApiDecided`), so the create inside must not tell the line
  // early that the time is taken. A move to a NEW time does not tolerate the
  // refusal: it goes up as the lost race, which the line hears as taken anyway, so
  // there the report may come early.
  {
    const SAME_TIME = "2026-06-08T13:00:00.000Z";
    const NEW_TIME = "2026-06-09T14:00:00.000Z";
    for (const startIso of [SAME_TIME, NEW_TIME]) {
      const tolerated = startIso === SAME_TIME;
      const label = tolerated ? "declined move" : "refused reschedule move";
      const existing = makeBooking({
        id: "bk-existing",
        external_id: "ext-1",
        bucket_id: "bkt-OLD",
        manage_token: "tokX",
        starts_at: SAME_TIME,
      });
      const log: string[] = [];
      const watched = watchedLine(log);
      const { deps } = makeDeps({
        personBookings: [existing],
        existing: { booking: existing, bucket, eventType },
        candidates: ["a"],
        freeEmails: new Set(["a@x.com"]),
        insertBookingConflictFor: new Set(["a"]),
      });
      // The rollback is held open, so "before it ends" is a measurement rather than
      // an accident of scheduling: since #3338 the confirm walks the rungs below while
      // its lost attempt rolls back, and reports once the walk finds nobody.
      const cleanup = gate();
      const d: BookingDeps = {
        ...deps,
        confirmQueue: watched.line,
        deleteReservation: async (id) => {
          log.push("cleanup:start");
          await cleanup.promise;
          log.push("cleanup:end");
          return deps.deleteReservation(id);
        },
      };
      let res: Settled | undefined;
      const done = settle(bookViaApi({ ...input, startIso, externalId: "ext-1", confirmReschedule: false }, d), (s) => (res = s));
      assert(await until(() => log.includes("cleanup:start")), `${label}: the lost attempt's rollback is reached`);
      // Settle everything that can run while the rollback is held.
      await until(() => false, 50);
      if (!tolerated) {
        assert(
          watched.reports.length === 1 && watched.reports[0]?.full === true,
          `${label}: the line hears the lost race while the rollback is still held (got ${watched.reports.map(said).join(",")})`,
        );
      }
      cleanup.open();
      await done;
      assert(watched.reports.length === 1, `${label}: the line is told exactly once (got ${watched.reports.map(said).join(",")})`);
      if (tolerated) {
        const r = res && "result" in res ? (res.result as { outcome?: string; bucketChangeDeclined?: string }) : undefined;
        assert(r?.outcome === "deduped" && r.bucketChangeDeclined === "slot_taken", `${label}: still answered as a declined move (got ${JSON.stringify(r) ?? String(errOf(res))})`);
        assert(!watched.reports[0]?.full, `${label}: and it settles nothing for the line, as before (got ${watched.reports.map(said).join(",")})`);
      } else {
        assert(errOf(res) instanceof RaceLostRefusalError, `${label}: refused as the lost race (got ${String(errOf(res))})`);
        assert(watched.reports[0]?.full === true, `${label}: the line hears the time is taken (got ${watched.reports.map(said).join(",")})`);
        assert(before(log, "report:full:race", "cleanup:end"), `${label}: before the cleanup ends (log ${log.join(" ")})`);
      }
    }
  }

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
