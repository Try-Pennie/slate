// The contention simulation's clock moves only when nothing real is outstanding.
//
// `scripts/test-confirm-contention.ts` runs a hundred confirms on a virtual clock.
// Its first run loop yielded a fixed 20 event loop turns and then moved the clock,
// which assumed every continuation on the confirm path finishes inside 20 turns.
// One does not: `deterministicEventId` hashes through `crypto.subtle.digest`, which
// Node answers from the libuv threadpool in REAL time. On a loaded CI runner the
// hash outlasted the turns, the clock jumped past the queue's 6 second waits while
// a confirm was still hashing, and main went red with 99 of 100 confirms answered
// 503 on one attempt and "simulation hung" on the other (run 37227801023).
//
// These controls pin the condition the clock now waits on. The first two fail
// against the fixed turn loop: real work that outlasts a handful of turns must
// leave the clock where it was. The stall control proves the wait is bounded and
// names what it waited on, and the last two prove the clock still moves, and
// still reports a hang, when only virtual time can make progress.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-confirm-contention-clock.ts
import { pbkdf2 } from "node:crypto";
import { createAsserter } from "./lib/booking-fakes.ts";
import { VirtualClock } from "./lib/confirm-contention-sim.ts";

const { assert, finish } = createAsserter();
const START = Date.parse("2026-06-01T00:00:00.000Z");

/** Runs `work` as one simulated request beside a virtual timer a second away, and
 *  says what the virtual time was at the moment the work finished. */
async function finishedAt(clock: VirtualClock, work: () => Promise<void>): Promise<number | undefined> {
  let at: number | undefined;
  clock.at(clock.now + 1_000, () => {});
  void work().then(() => {
    at = clock.now;
  });
  await clock.runUntil(() => at !== undefined);
  return at;
}

/** The same, with a failed run described rather than thrown, so every control
 *  reports on its own. */
async function outcome(clock: VirtualClock, work: () => Promise<void>): Promise<string> {
  try {
    const at = await finishedAt(clock, work);
    return `finished at +${(at ?? NaN) - START}ms`;
  } catch (err) {
    return `threw ${(err as Error)?.message}`;
  }
}

async function main() {
  // --- a real timer the code under test waits on holds the clock still --------
  {
    const clock = new VirtualClock(START);
    const got = await outcome(clock, () => new Promise((r) => setTimeout(r, 30)));
    assert(got === "finished at +0ms", `a real 30ms wait finishes before virtual time moves (${got})`);
  }

  // --- a hash queued behind a busy threadpool, the CI failure itself ----------
  {
    // Every threadpool thread is given work first, so the digest queues behind it
    // and answers in real time well after any fixed number of turns.
    for (let i = 0; i < 8; i++) pbkdf2("busy", "salt", 100_000, 32, "sha256", () => {});
    const clock = new VirtualClock(START);
    const got = await outcome(clock, async () => {
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode("key:agent"));
    });
    assert(got === "finished at +0ms", `a digest behind a busy threadpool finishes before virtual time moves (${got})`);
  }

  // --- real work that never ends is a loud, named failure, not a hang ---------
  {
    const clock = new VirtualClock(START, { realWaitCapMs: 100 });
    let handle: ReturnType<typeof setTimeout> | undefined;
    let err: unknown;
    try {
      await finishedAt(clock, () => new Promise((r) => (handle = setTimeout(r, 60_000))));
    } catch (e) {
      err = e;
    } finally {
      clearTimeout(handle);
    }
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.startsWith("simulation stalled:"), `a stuck real wait fails as a stall (got ${msg})`);
    assert(
      msg.includes("Timeout at") && msg.includes("test-confirm-contention-clock.ts"),
      `the stall names the kind of work and where it was started (got ${msg})`,
    );
    assert(clock.now === START, "the clock did not move past the stuck work");
  }

  // --- only virtual timers left: the clock moves to them ----------------------
  {
    const clock = new VirtualClock(START);
    const got = await outcome(clock, () => clock.sleep(500));
    assert(got === "finished at +500ms", `a virtual 500ms sleep finishes at +500ms (${got})`);
  }

  // --- nothing real, nothing scheduled, not done: still reported as a hang ----
  {
    const clock = new VirtualClock(START);
    let err: unknown;
    try {
      await clock.runUntil(() => false);
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof Error && err.message.startsWith("simulation hung:"),
      `an empty run that is never done is a hang (got ${String(err)})`,
    );
  }

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
