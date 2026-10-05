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
  isolateLine,
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
    // Thrown, never returned: a return here would skip the held scenario below and
    // finish(), and the run would exit 0 having reported nothing (L184).
    if (second.kind !== "lead") throw new Error(`lease: the second confirm must lead to be tested (got ${second.kind})`);
    assert(second.seat.claimedByOthers().has("x"), "lease: inside the lease the abandoned claim still excludes x");

    now += CONFIRM_CLAIM_LEASE_MS - 1;
    assert(second.seat.claimedByOthers().has("x"), "lease: one millisecond before it ends, still excluded");

    now += 1;
    assert(!second.seat.claimedByOthers().has("x"), "lease: once the lease passes, x is no longer excluded");
    second.done({ full: false });
  }

  // --- #3274 review: the expired claim is DROPPED, not just hidden, on a live line --
  //
  // A claim only filtered out of `claimedByOthers` would still count as somebody
  // booking in the slot, and a full verdict settles the waiting only when nobody is.
  // So: the abandoned confirm and a LATER one share one line, the abandoned lease
  // ends while the later one is still live, and the later one's full verdict must
  // answer the follower behind it rather than hand it the lead.
  {
    const start = 2_000_000;
    let now = start;
    const t = manualTimer();
    const lt = manualTimer();
    const q = makeConfirmQueue<string>({ timer: t.timer, leaseTimer: lt.timer, now: () => now });
    const abandoned = await q.enter("slot");
    if (abandoned.kind !== "lead") throw new Error("dropped: the first confirm must lead");
    abandoned.seat.claim("x", true); // hands on, then is never heard from again
    now += 1_000; // the next confirm starts later, so its lease ends later
    const live = await q.enter("slot");
    if (live.kind !== "lead") throw new Error("dropped: the later confirm must lead");
    let followerTurn: QueueTurn<string> | null = null;
    void q.enter("slot").then((turn) => (followerTurn = turn));
    await tick();
    assert(followerTurn === null, "dropped: a follower waits behind the later confirm");

    now = start + CONFIRM_CLAIM_LEASE_MS; // the abandoned lease ends; the later one runs on
    assert(!live.seat.claimedByOthers().has("x"), "dropped: its earlier claim no longer excludes x");

    live.done({ full: true, refusal: "taken", settled: null });
    await tick();
    const f = followerTurn as QueueTurn<string> | null;
    assert(
      f?.kind === "refused",
      `dropped: with the expired claim gone, the full verdict answers the follower (got ${f?.kind ?? "still waiting"})`,
    );
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
    if (late.kind === "lead") late.done({ full: false });
  }

  // --- #3274 review: a turn that has ended cannot claim again, on a live line -------
  //
  // The guard on `claim` refuses a turn that has reported; removing it makes this
  // fail, since a re-set claim would carry the turn's still running lease. An
  // EXPIRED turn's late claim needs no test of its own: a re-set would carry the
  // turn's expired lease, and every read expires first, which is what the "dropped"
  // test above pins (it fails when an expired claim is only hidden).
  {
    const t = manualTimer();
    const lt = manualTimer();
    const q = makeConfirmQueue<string>({ timer: t.timer, leaseTimer: lt.timer, now: () => 3_000_000 });
    const first = await q.enter("slot");
    if (first.kind !== "lead") throw new Error("reported: the first confirm must lead");
    first.seat.claim("x", true);
    const second = await q.enter("slot");
    if (second.kind !== "lead") throw new Error("reported: the second confirm must lead");
    first.done({ full: false });
    first.seat.claim("z", false); // a stray call after the verdict
    assert(!second.seat.claimedByOthers().has("z"), "reported: a turn that reported cannot claim an advisor again");
    second.done({ full: false });
  }

  // --- #3274 review: the lease end itself expires the turn, with no traffic --------
  //
  // Expiry used to run only when something read the line. A follower's own wait
  // (10s) is shorter than the lease (14s), so one stuck behind an abandoned holder
  // still times out first and is answered retryably (rare, and the lead can retry);
  // the timer at the lease end is what frees the line for whoever is still waiting
  // then, and drops a line nobody is in, with nothing else touching it.
  {
    const start = 7_000_000;
    let now = start;
    const t = manualTimer();
    const lt = manualTimer();
    const q = makeConfirmQueue<string>({ timer: t.timer, leaseTimer: lt.timer, now: () => now });
    const abandoned = await q.enter("slot");
    if (abandoned.kind !== "lead") throw new Error("lease timer: the first confirm must lead");
    assert(lt.live() === 1 && lt.pending[0]?.ms === CONFIRM_CLAIM_LEASE_MS, "lease timer: armed at the lease end when a turn starts");
    let followerTurn: QueueTurn<string> | null = null;
    void q.enter("slot").then((turn) => (followerTurn = turn));
    await tick();
    assert(followerTurn === null, "lease timer: a follower waits behind the abandoned holder");

    now = start + CONFIRM_CLAIM_LEASE_MS;
    lt.fireAll(); // nothing else touches the line: no enter, no claim, no wait timer
    await tick();
    const f = followerTurn as QueueTurn<string> | null;
    assert(f?.kind === "lead", `lease timer: the follower leads once the lease ends (got ${f?.kind ?? "still waiting"})`);
    if (f?.kind === "lead") f.done({ full: false });
    assert(lt.live() === 0, "lease timer: the finished follower cancelled its own lease timer");

    // A timer that fires a little before the lease ends (clocks disagree by a
    // millisecond) finds nothing expired. It must re-arm for what is left rather
    // than never run again.
    const early = makeConfirmQueue<string>({ timer: t.timer, leaseTimer: lt.timer, now: () => now });
    const s0 = now;
    const held = await early.enter("early");
    if (held.kind !== "lead") throw new Error("early timer: the first confirm must lead");
    let waitingTurn: QueueTurn<string> | null = null;
    void early.enter("early").then((turn) => (waitingTurn = turn));
    await tick();
    now = s0 + CONFIRM_CLAIM_LEASE_MS - 1; // lands just short
    lt.fireAll();
    await tick();
    assert(waitingTurn === null, "early timer: one millisecond short, nothing has expired yet");
    assert(lt.live() === 1 && lt.pending.at(-1)?.ms === 1, `early timer: re-armed for the 1ms left (got ${lt.pending.at(-1)?.ms})`);
    now = s0 + CONFIRM_CLAIM_LEASE_MS;
    lt.fireAll();
    await tick();
    const w = waitingTurn as QueueTurn<string> | null;
    assert(w?.kind === "lead", `early timer: the re-armed timer ends the lease (got ${w?.kind ?? "still waiting"})`);
    if (w?.kind === "lead") w.done({ full: false });

    // A turn that reports normally cancels its timer, so it never fires on a later line.
    const q2 = makeConfirmQueue<string>({ timer: t.timer, leaseTimer: lt.timer, now: () => now });
    const normal = await q2.enter("other");
    if (normal.kind === "lead") normal.done({ full: false });
    assert(lt.live() === 0, "lease timer: a confirm that reports cancels its lease timer");
  }

  // --- #3274 review: expiry found by a waiter's own timer still hands the line on --
  //
  // The abandoned holder can be expired by ANY path that reads the line, here the
  // first follower's wait running out (its timer drops it and checks whether the
  // line is idle). If that path expired the holder without handing on, the second
  // follower would sit behind nobody until its own wait ran out too, and be answered
  // retryably for no reason. It must lead at once.
  {
    let now = 9_000_000;
    const t = manualTimer();
    const q = makeConfirmQueue<string>({ timer: t.timer, now: () => now });
    const abandoned = await q.enter("slot");
    assert(abandoned.kind === "lead", "timer expiry: the first confirm leads, then is abandoned holding the line");
    let firstTurn: QueueTurn<string> | null = null;
    let secondTurn: QueueTurn<string> | null = null;
    void q.enter("slot").then((turn) => (firstTurn = turn));
    void q.enter("slot").then((turn) => (secondTurn = turn));
    await tick();
    assert(firstTurn === null && secondTurn === null, "timer expiry: both followers wait behind the holder");

    now += CONFIRM_CLAIM_LEASE_MS;
    const firstTimer = t.pending[0];
    if (!firstTimer) throw new Error("timer expiry: the first follower armed no wait timer");
    firstTimer.fire(); // only the FIRST follower's wait runs out
    await tick();
    assert((firstTurn as QueueTurn<string> | null)?.kind === "unqueued", "timer expiry: the follower whose wait ran out is answered retryably");
    const second = secondTurn as QueueTurn<string> | null;
    assert(
      second?.kind === "lead",
      `timer expiry: the next follower leads at once rather than waiting out its own bound (got ${second?.kind ?? "still waiting"})`,
    );
    if (second?.kind === "lead") second.done({ full: false });
  }

  // --- #3325: reading who else is claimed and claiming happen in ONE step ------
  //
  // In one isolate the read and the claim were two synchronous calls, so nothing
  // could come between them. Hosted in a shared object they are network calls, and
  // a second leader could claim the same advisor in the gap, so the seat answers
  // both in one operation: the advisors nobody else has claimed, first, and a claim
  // on the first of them, handing on when another unclaimed one remains.
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = await q.enter("slot");
    if (first.kind !== "lead") throw new Error("claimFirst: the first confirm did not lead");
    const seen: string[] = [];
    const second = q.enter("slot").then((t) => (seen.push(t.kind), t));
    const picked = first.seat.claimFirst(["p0", "p1", "p2"]);
    assert(JSON.stringify(picked) === JSON.stringify({ pool: ["p0", "p1", "p2"], unclaimed: 3 }), `claimFirst: an empty line offers every candidate (got ${JSON.stringify(picked)})`);
    await tick();
    assert(JSON.stringify(seen) === JSON.stringify(["lead"]), "claimFirst: claiming with others unclaimed hands the line on");
    const t2 = await second;
    if (t2.kind !== "lead") throw new Error("claimFirst: the second confirm did not lead");
    const next = t2.seat.claimFirst(["p0", "p1", "p2"]);
    assert(JSON.stringify(next) === JSON.stringify({ pool: ["p1", "p2"], unclaimed: 2 }), `claimFirst: the advisor claimed beside it is left out (got ${JSON.stringify(next)})`);
    assert(t2.seat.claimedByOthers().has("p0") && !t2.seat.claimedByOthers().has("p1"), "claimFirst: the second leader's own claim is p1, not counted as another's");
    const third = await q.enter("slot");
    if (third.kind !== "lead") throw new Error("claimFirst: the third confirm did not lead");
    const last = third.seat.claimFirst(["p0", "p1", "p2"]);
    assert(JSON.stringify(last) === JSON.stringify({ pool: ["p2"], unclaimed: 1 }), `claimFirst: one advisor left is offered alone (got ${JSON.stringify(last)})`);
    const fourthSeen: string[] = [];
    void q.enter("slot").then((t) => fourthSeen.push(t.kind));
    await tick();
    assert(fourthSeen.length === 0, "claimFirst: claiming the LAST unclaimed advisor keeps the line");
    const allClaimed = third.seat.claimFirst(["p0", "p1"]);
    assert(JSON.stringify(allClaimed) === JSON.stringify({ pool: ["p0", "p1"], unclaimed: 0 }), "claimFirst: when every candidate is claimed none is left out, the insert decides");
    first.done({ full: false });
    t2.done({ full: false });
    third.done({ full: false });
  }

  // --- #3325: a move claims its advisor and hands on only when another is free --
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = await q.enter("slot");
    if (first.kind !== "lead") throw new Error("claimBeside: the first confirm did not lead");
    first.seat.claim("p1", false);
    first.done({ full: false });
    const mover = await q.enter("slot");
    const other = await q.enter("other");
    if (mover.kind !== "lead" || other.kind !== "lead") throw new Error("claimBeside: a confirm did not lead");
    const seen: string[] = [];
    void q.enter("slot").then((t) => seen.push(t.kind));
    mover.seat.claimBeside("p0", ["p0"]);
    await tick();
    assert(seen.length === 0, "claimBeside: nobody else free beside the move keeps the crowd behind it");
    mover.seat.claimBeside("p0", ["p0", "p2"]);
    await tick();
    assert(JSON.stringify(seen) === JSON.stringify(["lead"]), "claimBeside: an unclaimed advisor beside the move hands the line on");
    assert(JSON.stringify([...mover.seat.claimedByOthers()]) === "[]", "claimBeside: a mover counts nobody else's claim but the next leader's");
    mover.done({ full: false });
    other.done({ full: false });
  }

  // --- #3325: entering answers at once, and a waiter can be cancelled ----------
  //
  // A shared object must answer "you lead" or "you wait" without holding the call,
  // so its caller can tell an unreachable object from a long line. And it must be
  // able to drop a waiter whose caller went away (nothing tells an object that a
  // request was cancelled), including one that was promoted to lead in the meantime,
  // whose turn would otherwise hold the line until its lease ran out.
  {
    const { timer, live } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const lead = q.enterNow("slot");
    assert(lead.kind === "lead", "enterNow: an idle line answers lead synchronously");
    const w = q.enterNow("slot");
    assert(w.kind === "wait", "enterNow: a busy line answers wait synchronously");
    assert(live() === 1, "enterNow: the waiter's own wait is armed");
    if (lead.kind !== "lead" || w.kind !== "wait") throw new Error("enterNow: unexpected kinds");
    w.cancel();
    const cancelled = await w.turn;
    assert(cancelled.kind === "unqueued", `enterNow: a cancelled waiter is answered unqueued (got ${cancelled.kind})`);
    assert(live() === 0, "enterNow: cancelling clears the waiter's timer");
    const w2 = q.enterNow("slot");
    if (w2.kind !== "wait") throw new Error("enterNow: second waiter did not wait");
    lead.turn.done({ full: false });
    const promoted = await w2.turn;
    assert(promoted.kind === "lead", "enterNow: the next waiter is promoted to lead");
    const w3 = q.enterNow("slot");
    if (w3.kind !== "wait") throw new Error("enterNow: third waiter did not wait");
    w2.cancel(); // its caller never collected the lead it was promoted to
    const after = await w3.turn;
    assert(after.kind === "lead", `enterNow: cancelling an uncollected lead hands the line on at once (got ${after.kind})`);
    if (after.kind === "lead") after.done({ full: false });
    const back = q.enterNow("slot");
    assert(back.kind === "lead", "enterNow: the line is idle again once everyone has left");
    if (back.kind === "lead") back.turn.done({ full: false });
  }

  // --- #3325: a host can require a lead to check in, and to keep checking in ----
  //
  // In one isolate a leader that dies takes the whole invocation with it, which is
  // rare, so a 14s lease was enough. Hosted in a shared object the leader is in
  // another process: an `enter` answered after its caller gave up, or a `done` that
  // never arrives, would hold the line for 14s, past every follower's 10s wait. So a
  // hosted line gives a new lead a short window to acknowledge it, then a short lease
  // its calls renew, both well under the follower wait.
  {
    let now = 1_000;
    const waits = manualTimer();
    const leases = manualTimer();
    const q = makeConfirmQueue<string>({ timer: waits.timer, leaseTimer: leases.timer, now: () => now, ackMs: 1_000, leaseMs: 4_000 });
    const silent = q.enterNow("slot");
    if (silent.kind !== "lead") throw new Error("ack: first did not lead");
    const w = q.enterNow("slot");
    if (w.kind !== "wait") throw new Error("ack: second did not wait");
    now += 1_000;
    leases.fireAll();
    const t = await w.turn;
    assert(t.kind === "lead", `ack: a lead never acknowledged within the window frees the line (got ${t.kind})`);
    if (t.kind !== "lead") throw new Error("ack: unexpected");
    t.ack();
    const w2 = q.enterNow("slot");
    if (w2.kind !== "wait") throw new Error("ack: third did not wait");
    now += 3_000;
    t.renew();
    leases.fireAll();
    let settled = false;
    void w2.turn.then(() => (settled = true));
    await tick();
    assert(!settled, "ack: an acknowledged lead that keeps renewing keeps the line");
    now += 4_000;
    leases.fireAll();
    const t2 = await w2.turn;
    assert(t2.kind === "lead", `ack: a lead that stops renewing frees the line one lease later (got ${t2.kind})`);
    if (t2.kind === "lead") t2.done({ full: false });
    silent.turn.done({ full: false }); // a late report from the expired turn changes nothing
  }

  // --- #3325: a lookahead place that is never given back is reclaimed ----------
  {
    let now = 1_000;
    const waits = manualTimer();
    const leases = manualTimer();
    const q = makeConfirmQueue<string>({ timer: waits.timer, leaseTimer: leases.timer, now: () => now, lookaheadLeaseMs: 3_000 });
    const first = q.enterNow("slot");
    if (first.kind !== "lead") throw new Error("lookahead lease: first did not lead");
    const lost = [q.lookahead("slot"), q.lookahead("slot")];
    assert(lost.every((g) => g !== null), "lookahead lease: both places are given out");
    assert(q.lookahead("slot") === null, "lookahead lease: a third is refused while both are out");
    now += 3_000;
    leases.fireAll();
    assert(q.lookahead("slot") !== null, "lookahead lease: a place nobody gave back is reclaimed after its lease");
    first.turn.done({ full: false });
  }

  // --- #3325: the booking path talks to any line through one async interface ----
  //
  // A line hosted in a shared object answers over the network, so the confirm path
  // awaits every step. The per isolate line is wrapped in the same interface rather
  // than given a second set of call sites, and it keeps its own rules exactly: the
  // adapter only translates, it decides nothing.
  {
    const { timer } = manualTimer();
    const line = isolateLine(makeConfirmQueue<string>({ timer }));
    const key = { group: "code:521", instant: "1791230400000" };
    const first = await line.enter(key);
    assert(first.kind === "lead", "adapter: the first confirm leads");
    if (first.kind !== "lead") throw new Error("adapter: unexpected");
    const picked = await first.seat.claimFirst(["p0", "p1"]);
    assert(JSON.stringify(picked) === JSON.stringify({ pool: ["p0", "p1"], unclaimed: 2 }), "adapter: claimFirst answers through a promise");
    const second = await line.enter(key);
    assert(second.kind === "lead", "adapter: the line was handed on, so the next leads");
    if (second.kind !== "lead") throw new Error("adapter: unexpected");
    assert((await second.seat.claimedByOthers()).has("p0"), "adapter: the second leader sees the first one's claim");
    await second.seat.claimBeside("p1", ["p1"]);
    const waiting = line.enter(key);
    await tick();
    assert((await second.waiting()) === 1, "adapter: waiting counts the confirm behind the last advisor");
    await first.done({ full: false });
    await second.done({ full: true, refusal: "race", settled: "second" });
    const refused = await waiting;
    assert(refused.kind === "refused" && refused.settled === "second", "adapter: a full verdict refuses the waiting through the adapter");
    const other = await line.enter({ group: "code:521", instant: "1791231000000" });
    assert(other.kind === "lead", "adapter: another instant of the same group is its own line");
    const look = await line.lookahead({ group: "code:521", instant: "1791231000000" });
    assert(typeof look === "function", "adapter: a busy line offers a lookahead place");
    if (look) await look();
    if (other.kind === "lead") await other.done({ full: false });
    assert((await line.lookahead(key)) === null, "adapter: an idle line offers none");
  }

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
