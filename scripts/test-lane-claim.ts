// #4222: a cron lane sent twice for the same tick runs once.
//
// A Durable Object call fails as a rejected promise, and the relay (#4189, phase 4)
// will fall back to today's route rather than skip a run, so the same lane request
// can reach the app twice. Each scheduled lane therefore claims (tick id, lane) in
// `lane_runs` before any work, and a lost claim answers 200 with
// `x-slate-lane-not-run: duplicate` and does nothing.
//
// What is pinned here, through a store fake that behaves as the primary key does
// (one insert of a key wins, every other one is told the key is taken):
//   1. A lane delivered twice, one after the other, runs once; the second answers
//      duplicate.
//   2. Two deliveries at the same moment run once between them.
//   3. A lane that crashed after claiming is not run again by a re-send of that tick,
//      and the NEXT tick runs it (the lease and the heartbeat cover liveness).
//   4. A claim that cannot be read runs nothing and answers 503, never duplicate and
//      never a run: a failed read is neither "claimed" nor "taken".
//   5. No tick id runs the lane unclaimed (a hand run with the cron secret); a tick id
//      that does not read as one runs nothing.
//   6. The database adapter maps exactly 23505 to taken; any other error, an error with
//      no code, or a rejected call is unreadable.
//   7. The retention prune's cutoff, and that a failed delete fails it.
//
// The constraint itself, two sessions inserting at once included, is proved in a real
// Postgres by scripts/verify-lane-runs-sql.ts. The route wiring is in
// src/lib/cron-lane-claim.test.ts, and every scheduled route claiming first is held by
// scripts/test-lane-claim-coverage.ts.
//
// Run: node --experimental-strip-types scripts/test-lane-claim.ts
import {
  claimLane,
  laneClaimAnswer,
  laneRunStore,
  laneRunCutoffIso,
  pruneLaneRuns,
  LANE_RUN_RETENTION_DAYS,
  type LaneClaimStore,
} from "../src/lib/monitor/lane-claim.ts";
import { LANE_NOT_RUN_HEADER } from "../src/lib/monitor/lane-failure.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** Behaves as the primary key does: the first insert of a key wins, atomically. */
function pkStore(): LaneClaimStore & { rows: Set<string>; calls: number } {
  const rows = new Set<string>();
  const store = {
    rows,
    calls: 0,
    async claim(tickId: string, lane: string): Promise<"claimed" | "taken"> {
      store.calls++;
      // Yield first, so two deliveries started together are both in flight.
      await new Promise((r) => setImmediate(r));
      const key = `${tickId}|${lane}`;
      if (rows.has(key)) return "taken";
      rows.add(key);
      return "claimed";
    },
  };
  return store;
}

const PATH = "/api/cron/sync";

/** A lane route as the routes are written: claim, then work. Counts the work. */
function lane(store: LaneClaimStore, work: () => Promise<void> = async () => {}) {
  const ran = { count: 0 };
  const deliver = async (tickHeader: string | null) => {
    const claim = await claimLane(tickHeader, PATH, store);
    const answer = laneClaimAnswer(claim);
    if (answer) return { answer, ran: false };
    ran.count++;
    await work();
    return { answer: null, ran: true };
  };
  return { deliver, ran };
}

async function main() {
  // --- 1. sent twice, one after the other ------------------------------------------------
  {
    const store = pkStore();
    const { deliver, ran } = lane(store);
    const first = await deliver("abc123");
    eq(first.ran, true, "the first delivery of a tick runs the lane");
    const second = await deliver("abc123");
    eq(second.ran, false, "a second delivery of the same tick does not run it");
    eq(ran.count, 1, "the lane's work ran once");
    eq(second.answer?.status, 200, "the re-sent lane answers 200, so the dispatcher reads no failure");
    eq(second.answer?.notRun, "duplicate", "and says it did not run because it was a duplicate");
    eq(second.answer?.headers[LANE_NOT_RUN_HEADER], "duplicate", "on the not-run header");
    eq((await deliver("abc124")).ran, true, "the next tick runs the lane");
    const other = await claimLane("abc123", "/api/cron/recompute", store);
    eq(other.run, true, "another lane on the same tick is a different claim and runs");
    eq(ran.count, 2, "two ticks, two runs");
  }

  // --- 2. two deliveries at once ---------------------------------------------------------
  {
    const store = pkStore();
    const { deliver, ran } = lane(store);
    const results = await Promise.all([deliver("feed01"), deliver("feed01"), deliver("feed01")]);
    eq(ran.count, 1, "three concurrent deliveries of one tick run the lane once");
    eq(results.filter((r) => r.ran).length, 1, "exactly one of them ran");
    eq(
      results.filter((r) => r.answer?.notRun === "duplicate").length,
      2,
      "and the other two answered duplicate",
    );
  }

  // --- 3. crashed after claiming ---------------------------------------------------------
  {
    const store = pkStore();
    let crash = true;
    const { deliver, ran } = lane(store, async () => {
      if (crash) throw new Error("cpu limit");
    });
    let threw = false;
    try {
      await deliver("dead01");
    } catch {
      threw = true;
    }
    assert(threw, "the first delivery crashed part way, after its claim");
    crash = false;
    const resent = await deliver("dead01");
    eq(resent.ran, false, "a re-send of the crashed tick does not run the lane again");
    eq(resent.answer?.notRun, "duplicate", "it answers duplicate");
    eq(ran.count, 1, "the work was started once for that tick");
    eq((await deliver("dead02")).ran, true, "the next tick runs the lane");
  }

  // --- 4. a claim that cannot be read ----------------------------------------------------
  {
    const failing: LaneClaimStore = {
      claim: async () => {
        throw new Error("connection reset");
      },
    };
    const { deliver, ran } = lane(failing);
    const r = await deliver("abc123");
    eq(r.ran, false, "a claim that cannot be read runs nothing");
    eq(ran.count, 0, "no work at all");
    eq(r.answer?.status, 503, "and answers 503, so the dispatcher reports the lane as failed");
    eq(r.answer?.notRun, "claim_unreadable", "saying the claim could not be read");
    eq(r.answer?.headers[LANE_NOT_RUN_HEADER], "claim_unreadable", "on the not-run header");
    const claim = await claimLane("abc123", PATH, failing);
    assert(!claim.run && claim.error instanceof Error, "the claim keeps the error for the log");
  }

  // --- 5. no tick id, or one that does not read ------------------------------------------
  {
    const store = pkStore();
    const { deliver, ran } = lane(store);
    const r = await deliver(null);
    eq(r.ran, true, "a request with no tick id (a hand run) runs the lane");
    eq(store.calls, 0, "unclaimed: nothing is written for it");
    eq((await deliver(null)).ran, true, "and a second hand run runs too");
    eq(ran.count, 2, "both ran");
    for (const bad of ["", "not a tick", "ABC123", "a".repeat(33), "abc123; drop"]) {
      const b = await deliver(bad);
      eq(b.ran, false, `a tick id that does not read (${JSON.stringify(bad)}) runs nothing`);
      eq(b.answer?.status, 400, "and answers 400");
      eq(b.answer?.notRun, "tick_unreadable", "saying the tick id could not be read");
    }
    eq(store.calls, 0, "and nothing was written for any of them");
    eq(ran.count, 2, "still two runs");
  }

  // --- 6. the database adapter -----------------------------------------------------------
  {
    const rows: Array<Record<string, unknown>> = [];
    const answers: Array<{ error: { code?: string; message: string } | null } | Error> = [];
    const store = laneRunStore(async (row) => {
      rows.push(row);
      const next = answers.shift() ?? { error: null };
      if (next instanceof Error) throw next;
      return next;
    });
    eq(await store.claim("abc123", "sync"), "claimed", "an insert that succeeds is a claim");
    eq(rows[0], { tick_id: "abc123", lane: "sync" }, "it inserts the tick id and the lane, nothing else");
    answers.push({ error: { code: "23505", message: "duplicate key value violates unique constraint" } });
    eq(await store.claim("abc123", "sync"), "taken", "a unique violation (23505) is a taken claim");
    const unreadable = async (answer: { error: { code?: string; message: string } | null } | Error, what: string) => {
      answers.push(answer);
      let threw = false;
      try {
        await store.claim("abc123", "sync");
      } catch {
        threw = true;
      }
      assert(threw, `${what} is unreadable: it throws, never claimed and never taken`);
    };
    await unreadable({ error: { code: "42P01", message: 'relation "lane_runs" does not exist' } }, "a missing table");
    await unreadable({ error: { code: "57014", message: "canceling statement due to statement timeout" } }, "a timeout");
    await unreadable({ error: { message: "fetch failed" } }, "an error with no code");
    await unreadable(new Error("network down"), "a rejected call");
  }

  // --- 7. retention ----------------------------------------------------------------------
  {
    eq(LANE_RUN_RETENTION_DAYS, 2, "claims are kept two days");
    const now = Date.parse("2026-10-26T03:05:00Z");
    eq(laneRunCutoffIso(now), "2026-10-24T03:05:00.000Z", "the cutoff is two days before now");
    const cutoffs: string[] = [];
    const pruned = await pruneLaneRuns({
      nowMs: now,
      deleteClaimedBefore: async (cutoff) => {
        cutoffs.push(cutoff);
        return 41;
      },
    });
    eq(pruned, { deleted: 41, cutoff: "2026-10-24T03:05:00.000Z" }, "the prune reports what it deleted and from when");
    eq(cutoffs, ["2026-10-24T03:05:00.000Z"], "one delete, before the cutoff");
    let threw = false;
    try {
      await pruneLaneRuns({
        nowMs: now,
        deleteClaimedBefore: async () => {
          throw new Error("delete refused");
        },
      });
    } catch {
      threw = true;
    }
    assert(threw, "a failed delete fails the prune, never reads as nothing deleted");
  }

  finish();
}

void main();
