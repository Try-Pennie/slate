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
  CONFIRM_LINE_LOOKAHEAD,
  CONFIRM_CLAIM_LEASE_MS,
  type QueueTurn,
} from "../src/lib/booking/confirm-queue.ts";
import { BOOKING_CONFIRM_BUDGET_MS, BOOKING_CONFIRM_WORST_CASE_MS } from "../src/lib/booking/confirm-budget.ts";
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

  // --- a follower that waits too long is told it waited it out ---------------
  //
  // The queue only says so ("unqueued"); the confirm then answers the retryable
  // 503 at once rather than starting a chain its budget cannot finish (#3257).
  {
    const { timer, fireAll, pending } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const lead = await q.enter("slot");
    const follower = q.enter("slot");
    await tick();
    assert(pending.length === 1 && pending[0].ms === CONFIRM_QUEUE_WAIT_MS, "patience: the follower waits the configured bound");
    fireAll();
    const t = await follower;
    assert(t.kind === "unqueued", "patience: past the bound the follower is told it waited the line out");
    // The leader finishing afterwards must not answer a follower that already left.
    if (lead.kind === "lead") lead.done({ full: true, refusal: "race", settled: "late" });
    await tick();
    assert(t.kind === "unqueued", "patience: a follower that left is never answered by the leader afterwards");
  }

  // --- #3257: a leader that claimed an advisor with others left hands on ------
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = await q.enter("slot");
    const seen: string[] = [];
    const second = q.enter("slot").then((t) => (seen.push(`second:${t.kind}`), t));
    const third = q.enter("slot").then((t) => (seen.push(`third:${t.kind}`), t));
    await tick();
    assert(seen.length === 0, "hand on: followers wait until the leader has claimed an advisor");
    if (first.kind === "lead") first.seat.claim("p0", true);
    await tick();
    assert(JSON.stringify(seen) === JSON.stringify(["second:lead"]), `hand on: the next leads at once (got ${JSON.stringify(seen)})`);
    const t2 = await second;
    if (t2.kind === "lead") {
      assert(
        JSON.stringify([...t2.seat.claimedByOthers()]) === JSON.stringify(["p0"]),
        "hand on: the new leader sees the advisor the first one claimed",
      );
      // The second takes the LAST unclaimed advisor, so it holds the line.
      t2.seat.claim("p1", false);
    }
    await tick();
    assert(seen.length === 1, "hand on: a leader on the last advisor keeps the rest waiting");
    // The second books the last advisor while the first is still in flight: the
    // first could yet fail and free p0, so the third is not refused; it leads.
    if (t2.kind === "lead") t2.done({ full: true, refusal: "race", settled: "second" });
    const t3 = await third;
    assert(t3.kind === "lead", `hand on: a full verdict with another claim in flight lets the next ask for itself (got ${t3.kind})`);
    if (first.kind === "lead") first.done({ full: false });
    if (t3.kind === "lead") t3.done({ full: false });
  }

  // --- #3257: once every leader has handed on, a newcomer leads at once --------
  {
    const { timer, live } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = await q.enter("slot");
    if (first.kind === "lead") first.seat.claim("p0", true);
    const second = await q.enter("slot");
    assert(second.kind === "lead", "newcomer: leads at once when nobody holds the line");
    assert(live() === 0, "newcomer: starts no wait timer");
    if (second.kind === "lead") {
      assert(second.seat.claimedByOthers().has("p0"), "newcomer: sees the claim in flight");
      second.done({ full: false });
    }
    if (first.kind === "lead") first.done({ full: false });
    const fresh = await q.enter("slot");
    assert(fresh.kind === "lead" && fresh.seat.claimedByOthers().size === 0, "newcomer: a finished line keeps no stale claims");
    if (fresh.kind === "lead") fresh.done({ full: false });
  }

  // --- #3257: a full verdict with no other claim in flight refuses the waiting -
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = await q.enter("slot");
    if (first.kind === "lead") first.seat.claim("a", false);
    const follower = q.enter("slot");
    if (first.kind === "lead") first.done({ full: true, refusal: "race", settled: "first" });
    const t = await follower;
    assert(t.kind === "refused" && t.settled === "first", "last advisor: the follower is refused from the verdict");
  }

  // --- #3257: a leader that takes no advisor here hands on at once -----------
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = await q.enter("slot");
    const seen: string[] = [];
    const second = q.enter("slot").then((t) => (seen.push(t.kind), t));
    await tick();
    assert(seen.length === 0, "pass: the follower waits while the leader decides");
    if (first.kind === "lead") first.seat.pass();
    await tick();
    assert(JSON.stringify(seen) === JSON.stringify(["lead"]), `pass: the next leads at once (got ${JSON.stringify(seen)})`);
    const t2 = await second;
    if (t2.kind === "lead") assert(t2.seat.claimedByOthers().size === 0, "pass: a leader that passed claims nobody");
    if (first.kind === "lead") first.done({ full: false });
    if (t2.kind === "lead") t2.done({ full: false });
  }

  // --- #3257: the lookahead is offered only at a busy line, and is bounded ----
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    assert(q.lookahead("slot") === null, "lookahead: an idle line offers none, the confirm just leads");
    const first = await q.enter("slot");
    const gives = Array.from({ length: CONFIRM_LINE_LOOKAHEAD + 1 }, () => q.lookahead("slot"));
    assert(
      gives.filter((g) => g !== null).length === CONFIRM_LINE_LOOKAHEAD,
      `lookahead: a busy line offers exactly ${CONFIRM_LINE_LOOKAHEAD} at once`,
    );
    gives[0]?.();
    gives[0]?.(); // giving it back twice frees only one place
    const again = [q.lookahead("slot"), q.lookahead("slot")];
    assert(again.filter((g) => g !== null).length === 1, "lookahead: a returned place is offered again, once");
    for (const g of [...gives, ...again]) g?.();
    if (first.kind === "lead") first.done({ full: false });
    const fresh = await q.enter("slot");
    assert(fresh.kind === "lead", "lookahead: the line is released once its leader and lookaheads are done");
    if (fresh.kind === "lead") fresh.done({ full: false });
  }

  // --- #3257: a lookahead returned after its line settled leaves a newer one ---
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = await q.enter("slot");
    const give = q.lookahead("slot");
    if (first.kind === "lead") first.done({ full: true, refusal: "race", settled: null });
    const newer = await q.enter("slot");
    const follower = q.enter("slot");
    give?.();
    // A confirm arriving after the stale give back must still find the newer line
    // busy and wait, rather than open a second line and lead beside it.
    const later = q.enter("slot");
    let laterAnswered = false;
    void later.then(() => (laterAnswered = true));
    await tick();
    assert(!laterAnswered, "stale lookahead: a later arrival still waits in the newer line");
    if (newer.kind === "lead") newer.done({ full: false });
    const t = await follower;
    assert(t.kind === "lead", "stale lookahead: the newer line hands on normally");
    if (t.kind === "lead") t.done({ full: false });
    const t2 = await later;
    if (t2.kind === "lead") t2.done({ full: false });
  }

  // --- #3274: a claim from an abandoned confirm is leased, not held for ever ----
  //
  // A confirm torn down mid flight (a client disconnect cancelling the invocation)
  // may never report its verdict, so its claim on an advisor would keep every later
  // confirm in this isolate off that advisor for that slot, and a leader that never
  // handed on would keep the line behind it. A claim lives for the confirm budget
  // plus its cleanup, the longest a real confirm can still be working, and is then
  // ignored and dropped.
  assert(
    CONFIRM_CLAIM_LEASE_MS === BOOKING_CONFIRM_WORST_CASE_MS,
    `lease: the confirm budget plus cleanup (${CONFIRM_CLAIM_LEASE_MS} vs ${BOOKING_CONFIRM_WORST_CASE_MS})`,
  );
  {
    let now = 1_000_000;
    const t = manualTimer();
    const q = makeConfirmQueue<string>({ timer: t.timer, now: () => now });
    const abandoned = await q.enter("slot");
    assert(abandoned.kind === "lead", "lease: the first confirm leads");
    // It claims advisor x with another free beside it, hands on, and is never heard from again.
    if (abandoned.kind === "lead") abandoned.seat.claim("x", true);

    const second = await q.enter("slot");
    assert(second.kind === "lead", "lease: the next confirm leads at once (the first handed on)");
    if (second.kind !== "lead") return;
    assert(second.seat.claimedByOthers().has("x"), "lease: inside the lease the abandoned claim still excludes x");

    now += CONFIRM_CLAIM_LEASE_MS - 1;
    assert(second.seat.claimedByOthers().has("x"), "lease: one millisecond before it ends, still excluded");

    now += 1;
    assert(!second.seat.claimedByOthers().has("x"), "lease: once the lease passes, x is no longer excluded");
    second.done({ full: false });

    // And it is dropped, so the idle line goes with it: a fresh confirm leads a clean line.
    const third = await q.enter("slot");
    assert(third.kind === "lead" && third.seat.claimedByOthers().size === 0, "lease: the expired claim was dropped, not just hidden");
    if (third.kind === "lead") third.done({ full: false });
  }

  // --- #3274: an abandoned leader that never handed on stops holding the line ----
  {
    let now = 5_000_000;
    const t = manualTimer();
    const q = makeConfirmQueue<string>({ timer: t.timer, now: () => now });
    const abandoned = await q.enter("slot");
    assert(abandoned.kind === "lead", "held: the first confirm leads, then is abandoned without handing on");

    const early = q.enter("slot");
    let earlyTurn: QueueTurn<string> | null = null;
    void early.then((turn) => (earlyTurn = turn));
    await tick();
    assert(earlyTurn === null, "held: inside the lease a later confirm waits behind it, as before");
    t.fireAll(); // its own wait runs out
    await tick();
    assert((earlyTurn as QueueTurn<string> | null)?.kind === "unqueued", "held: and is answered retryably when its wait runs out");

    now += CONFIRM_CLAIM_LEASE_MS;
    const late = await q.enter("slot");
    assert(late.kind === "lead", `held: once the lease passes, a new confirm leads rather than waiting (got ${late.kind})`);
    // A verdict the abandoned confirm reports after its lease cannot claim again.
    if (abandoned.kind === "lead") abandoned.seat.claim("y", false);
    if (late.kind === "lead") {
      assert(!late.seat.claimedByOthers().has("y"), "held: an expired confirm's late claim is ignored");
      late.done({ full: false });
    }
  }

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
