// The per isolate queue that confirms for one slot wait in (#3221).
//
// One confirm leads; the rest wait for it rather than running the same work at
// the same time. When the leader's own confirm shows the slot is full, everybody
// waiting is answered at once with no work of their own. Otherwise the next one
// leads. A follower waits at most `waitMs` (its own, or the queue's), then is told
// it waited it out and its caller answers it, so the queue can delay a confirm but
// never strand one.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-confirm-queue.ts
import {
  makeConfirmQueue,
  confirmLineWaitMs,
  CONFIRM_QUEUE_WAIT_MS,
  CONFIRM_QUEUE_RESERVE_MS,
  type QueueTurn,
} from "../src/lib/booking/confirm-queue.ts";
import { BOOKING_CONFIRM_BUDGET_MS } from "../src/lib/booking/confirm-budget.ts";
import { createAsserter } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

/** A timer the test fires by hand. */
function manualTimer() {
  const pending: { ms: number; fire: () => void; live: boolean }[] = [];
  const timer = (ms: number, fire: () => void) => {
    const t = { ms, fire, live: true };
    pending.push(t);
    return () => {
      t.live = false;
    };
  };
  const fireAll = () => {
    for (const t of pending.splice(0)) if (t.live) t.fire();
  };
  const live = () => pending.filter((t) => t.live).length;
  return { timer, fireAll, live, pending };
}

const tick = () => new Promise((r) => setImmediate(r));

async function main() {
  // --- the budget relation the wait is sized against (#3257) ------------------
  //
  // A production confirm answers at 7.4 to 8.0s at the median (#3221), so a wait
  // shorter than that sends every follower off on its own while the leader is
  // still working: the stampede the line exists to stop. A follower that waited
  // that long cannot also run a chain of its own inside the 12s budget, so the two
  // constraints cannot both hold; the wait is the budget less a reserve, and a
  // follower that waits it out answers from the reserve instead of starting work.
  const LEADER_ANSWER_P50_MS = 8_000;
  assert(
    CONFIRM_QUEUE_WAIT_MS + CONFIRM_QUEUE_RESERVE_MS === BOOKING_CONFIRM_BUDGET_MS,
    `the wait is the confirm budget less the reserve (${CONFIRM_QUEUE_WAIT_MS} + ${CONFIRM_QUEUE_RESERVE_MS} vs ${BOOKING_CONFIRM_BUDGET_MS})`,
  );
  assert(
    CONFIRM_QUEUE_WAIT_MS > LEADER_ANSWER_P50_MS,
    `a follower outwaits a production leader at the median (${CONFIRM_QUEUE_WAIT_MS}ms vs ${LEADER_ANSWER_P50_MS}ms)`,
  );
  assert(CONFIRM_QUEUE_RESERVE_MS >= 1_000, "the reserve leaves room for a holder's short chain and the answer");
  assert(confirmLineWaitMs(null) === CONFIRM_QUEUE_WAIT_MS, "outside a budget the follower waits the full bound");
  assert(confirmLineWaitMs(BOOKING_CONFIRM_BUDGET_MS) === CONFIRM_QUEUE_WAIT_MS, "a fresh budget waits the full bound");
  assert(
    confirmLineWaitMs(7_000) === 7_000 - CONFIRM_QUEUE_RESERVE_MS,
    "a budget the route's own reads already spent part of keeps the reserve whole",
  );
  assert(confirmLineWaitMs(1_500) === 0, "a budget already inside the reserve does not wait at all");

  // --- the first in leads at once, without waiting ----------------------------
  {
    const { timer, live } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = await q.enter("slot");
    assert(first.kind === "lead", "first: the first confirm for a slot leads");
    assert(live() === 0, "first: a leader starts no wait timer");
    if (first.kind === "lead") first.done({ full: false });
  }

  // --- a full slot answers every follower, and only them ----------------------
  {
    const { timer, live } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const lead = await q.enter("slot");
    const other = await q.enter("another slot");
    const followers: QueueTurn<string>[] = [];
    const waits = [q.enter("slot"), q.enter("slot"), q.enter("slot")];
    for (const w of waits) void w.then((t) => followers.push(t));
    await tick();
    assert(followers.length === 0, "full: followers wait while the leader runs");
    assert(other.kind === "lead", "full: a different slot has its own leader and never waits");
    if (lead.kind === "lead") lead.done({ full: true, refusal: "race", settled: "the leader's booking" });
    await tick();
    assert(followers.length === 3, `full: every follower is answered (got ${followers.length})`);
    assert(
      followers.every((t) => t.kind === "refused" && t.refusal === "race" && t.settled === "the leader's booking"),
      `full: each is refused with what took the slot (got ${JSON.stringify(followers)})`,
    );
    assert(live() === 0, `full: the followers' wait timers are cancelled once they are answered (live ${live()})`);
    // The line is gone: the next confirm for the slot leads, and finds the slot
    // taken through its own reads, as any later confirm does.
    const later = await q.enter("slot");
    assert(later.kind === "lead", "full: a confirm arriving after the verdict leads a fresh line");
    if (later.kind === "lead") later.done({ full: false });
    if (other.kind === "lead") other.done({ full: false });
  }

  // --- an open slot hands the lead to the next follower, one at a time --------
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const lead = await q.enter("slot");
    const seen: string[] = [];
    const second = q.enter("slot").then((t) => (seen.push(`second:${t.kind}`), t));
    const third = q.enter("slot").then((t) => (seen.push(`third:${t.kind}`), t));
    if (lead.kind === "lead") lead.done({ full: false });
    await tick();
    assert(JSON.stringify(seen) === JSON.stringify(["second:lead"]), `open: only the next follower leads (got ${JSON.stringify(seen)})`);
    const t2 = await second;
    if (t2.kind === "lead") t2.done({ full: true, refusal: "race", settled: "second" });
    const t3 = await third;
    assert(t3.kind === "refused" && t3.settled === "second", "open: the second leader's verdict answers the third");
  }

  // --- a leader that reports twice changes nothing the second time ------------
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const lead = await q.enter("slot");
    const follower = q.enter("slot");
    if (lead.kind === "lead") {
      lead.done({ full: false });
      lead.done({ full: true, refusal: "taken", settled: null });
    }
    const t = await follower;
    assert(t.kind === "lead", "twice: the first report stands, so the follower leads rather than being refused");
    if (t.kind === "lead") t.done({ full: false });
  }

  // --- a follower that waits too long runs on its own --------------------------
  {
    const { timer, fireAll, pending } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const lead = await q.enter("slot");
    const follower = q.enter("slot");
    await tick();
    assert(pending.length === 1 && pending[0].ms === CONFIRM_QUEUE_WAIT_MS, "patience: the follower waits the configured bound");
    fireAll();
    const t = await follower;
    assert(t.kind === "unqueued", "patience: past the bound the follower runs unqueued");
    // The leader finishing afterwards must not answer a follower that already left.
    if (lead.kind === "lead") lead.done({ full: true, refusal: "race", settled: "late" });
    await tick();
    assert(t.kind === "unqueued", "patience: a follower that left is never answered by the leader afterwards");
  }

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
