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
  FRONTIER_FRESH_MS,
  RELEASE_CAP,
  CONFIRM_LINE_SETTLED_MEMORY_MS,
  type QueueTurn,
} from "../src/lib/booking/confirm-queue.ts";
import { BOOKING_CONFIRM_BUDGET_MS, BOOKING_CONFIRM_WORST_CASE_MS } from "../src/lib/booking/confirm-budget.ts";
import { createAsserter } from "./lib/booking-fakes.ts";
import { eq } from "./lib/harness.ts";

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
  // A production confirm answered at 7.4 to 8.0s at the median on 2026-10-04
  // (#3221). It takes about 1.6s now (#3490), but 8s is still the slow confirm the
  // line must survive (each Google call may run to its 8s deadline), so a wait
  // shorter than that sends every follower off on its own while the leader is
  // still working: the stampede the line exists to stop. A follower that waited
  // that long cannot also run a chain of its own inside the 12s budget, so the two
  // constraints cannot both hold; the wait is the budget less a reserve, and a
  // follower that waits it out answers from the reserve instead of starting work.
  const SLOW_LEADER_ANSWER_MS = 8_000;
  assert(
    CONFIRM_QUEUE_WAIT_MS + CONFIRM_QUEUE_RESERVE_MS === BOOKING_CONFIRM_BUDGET_MS,
    `the wait is the confirm budget less the reserve (${CONFIRM_QUEUE_WAIT_MS} + ${CONFIRM_QUEUE_RESERVE_MS} vs ${BOOKING_CONFIRM_BUDGET_MS})`,
  );
  assert(
    CONFIRM_QUEUE_WAIT_MS > SLOW_LEADER_ANSWER_MS,
    `a follower outwaits a slow leader (${CONFIRM_QUEUE_WAIT_MS}ms vs ${SLOW_LEADER_ANSWER_MS}ms)`,
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
    if (other.kind === "lead") other.done({ full: false });
  }

  // --- #3570: a full verdict answers a confirm arriving just after it, too ----
  //
  // Load run 37977451270, burst 3: a confirm on a fresh isolate reached the line about
  // 60ms after the crowd's full verdict had answered everybody waiting. The line had
  // forgotten it, so that confirm led a line of its own and ran the whole confirm
  // under load (a person decision, then every rung read) to be told the same thing
  // 5.9s after the last booking. Within `CONFIRM_LINE_SETTLED_MEMORY_MS` the verdict
  // answers it as it answered the crowd, with the same settlement.
  {
    const { timer } = manualTimer();
    let now = 1_000_000;
    const q = makeConfirmQueue<string>({ timer, now: () => now });
    const lead = await q.enter("slot");
    const waiting = q.enter("slot");
    if (lead.kind === "lead") lead.done({ full: true, refusal: "race", settled: "who sits there" });
    assert((await waiting).kind === "refused", "settled memory: the confirm waiting is refused, as before");
    now += CONFIRM_LINE_SETTLED_MEMORY_MS - 1;
    const late = await q.enter("slot");
    assert(
      late.kind === "refused" && late.refusal === "race" && late.settled === "who sits there",
      `settled memory: a confirm arriving after the verdict, inside the window, is answered from it (got ${JSON.stringify(late)})`,
    );
    assert(q.lookahead("slot") === null, "settled memory: there is no busy line to look ahead of");
    const elsewhere = await q.enter("another slot");
    assert(elsewhere.kind === "lead", "settled memory: another slot's line is untouched by it");
    if (elsewhere.kind === "lead") elsewhere.done({ full: false });
    // Once the window has passed, the next confirm leads a fresh line and reads for
    // itself, as any later confirm does.
    now += 1;
    const after = await q.enter("slot");
    assert(after.kind === "lead", `settled memory: past the window, a confirm leads a fresh line (got ${after.kind})`);
    if (after.kind === "lead") after.done({ full: false });
  }

  // --- #3570: only a FULL verdict is remembered --------------------------------
  {
    const { timer } = manualTimer();
    let now = 1_000_000;
    const q = makeConfirmQueue<string>({ timer, now: () => now });
    const lead = await q.enter("slot");
    if (lead.kind === "lead") lead.done({ full: false });
    now += 1;
    const next = await q.enter("slot");
    assert(next.kind === "lead", `settled memory: a line that ended open is not remembered, the next confirm leads (got ${next.kind})`);
    if (next.kind === "lead") next.done({ full: false });
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
    // The second books the last advisor while the first is still in flight. Since
    // #3489 step 3 (Dan, 2026-10-07) its full verdict is HELD for the third rather than
    // the third asking for itself: the first could yet fail and free p0, and the line
    // reads again if it does (the "held" and "discard" cases below).
    if (t2.kind === "lead") t2.done({ full: true, refusal: "race", settled: "second" }, "booked");
    await tick();
    assert(seen.length === 1, "hand on: a full verdict with another claim in flight keeps the third waiting");
    if (first.kind === "lead") first.done({ full: false }, "booked", "both");
    const t3 = await third;
    assert(t3.kind === "refused" && t3.settled === "both", `hand on: the first's booking applies it (got ${JSON.stringify(t3)})`);
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
    let now = 1_000_000;
    const q = makeConfirmQueue<string>({ timer, now: () => now });
    const first = await q.enter("slot");
    const give = q.lookahead("slot");
    if (first.kind === "lead") first.done({ full: true, refusal: "race", settled: null });
    // #3570: the full verdict answers arrivals for a while; a lookahead's lease (14s)
    // outlives that memory (5s), so its stale give back can still meet a newer line.
    now += CONFIRM_LINE_SETTLED_MEMORY_MS;
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

  // --- #3325: a lead turn says whether it is still alive -----------------------
  {
    let now = 1_000;
    const leases = manualTimer();
    const q = makeConfirmQueue<string>({ timer: manualTimer().timer, leaseTimer: leases.timer, now: () => now, ackMs: 1_000, leaseMs: 4_000 });
    const a = q.enterNow("a");
    const b = q.enterNow("b");
    if (a.kind !== "lead" || b.kind !== "lead") throw new Error("alive: did not lead");
    assert(a.turn.alive() && b.turn.alive(), "alive: a new lead is alive");
    a.turn.done({ full: false });
    assert(!a.turn.alive(), "alive: a lead that reported is not");
    now += 1_000;
    leases.fireAll();
    assert(!b.turn.alive(), "alive: a lead whose lease ran out is not");
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

  // --- #3338: a lead turn says whether it waited behind another confirm ----------
  //
  // A confirm that waited while the one ahead of it booked, and then drops a tier,
  // dropped BEHIND that booking, which is counted on /admin/routing apart from a
  // drop nobody contended. Only the line knows it waited, so the turn says.
  {
    const { timer } = manualTimer();
    const line = isolateLine(makeConfirmQueue<string>({ timer }));
    const key = { group: "code:521", instant: "1791232000000" };
    const first = await line.enter(key);
    assert(first.kind === "lead" && first.queued === false, "queued: a confirm that leads at once did not wait");
    if (first.kind !== "lead") throw new Error("queued: unexpected");
    const behind = line.enter(key);
    await tick();
    await first.done({ full: false });
    const promoted = await behind;
    assert(promoted.kind === "lead" && promoted.queued === true, "queued: a confirm promoted after waiting says it waited");
    if (promoted.kind === "lead") await promoted.done({ full: false });
    // Handed on at once by a leader that claimed one of several advisors: it never waited.
    const a = await line.enter(key);
    if (a.kind !== "lead") throw new Error("queued: unexpected");
    await a.seat.claimFirst(["p0", "p1"]);
    const b = await line.enter(key);
    assert(b.kind === "lead" && b.queued === false, "queued: a confirm handed the line at once did not wait");
    await a.done({ full: false });
    if (b.kind === "lead") await b.done({ full: false });
  }

  // --- #3489: a leader's read releases one waiting confirm per unclaimed advisor ----
  //
  // Before, a leader that claimed an advisor with others unclaimed handed the line to
  // ONE waiter, who then read the ladder again from the top before it could claim and
  // hand on in turn: a walking crowd was served one confirm every two to three seconds
  // (load run 37640583621). Now the leader's own read is the line's FRONTIER, and the
  // line releases as many waiters as it has unclaimed advisors, each handed its rung
  // and its advisor (claimed for it, so no two are ever handed one advisor).
  const leadOf = (t: QueueTurn<string>) => {
    if (t.kind !== "lead") throw new Error(`expected a lead turn, got ${t.kind}`);
    return t;
  };
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const leader = leadOf(await q.enter("slot"));
    const waiting = [q.enter("slot"), q.enter("slot"), q.enter("slot"), q.enter("slot"), q.enter("slot")];
    // Each waiter's answer as it arrives, read after one turn: no wait on the clock (L290).
    const answered: (QueueTurn<string> | null)[] = waiting.map(() => null);
    waiting.forEach((w, i) => void w.then((t) => (answered[i] = t)));
    await tick();
    const picked = leader.seat.claimFirst(["p0", "p1", "p2", "p3"], { rung: 1 });
    assert(JSON.stringify(picked.pool) === JSON.stringify(["p0", "p1", "p2", "p3"]), `release: the leader still gets every candidate, its own first (got ${JSON.stringify(picked)})`);
    await tick();
    const firstThree = answered.slice(0, 3);
    assert(firstThree.every((t) => t !== null), "release: three waiters are released at once, one per unclaimed advisor beside the leader's");
    const released = firstThree.filter((t): t is QueueTurn<string> => t !== null).map(leadOf);
    const handed = released.map((t) => t.start?.advisor);
    assert(JSON.stringify(handed) === JSON.stringify(["p1", "p2", "p3"]), `release: each is handed its own advisor, in the leader's order (got ${JSON.stringify(handed)})`);
    assert(released.every((t) => t.start?.rung === 1), "release: each is handed the leader's rung");
    assert(released.every((t) => JSON.stringify(t.start?.read) === JSON.stringify(["p0", "p1", "p2", "p3"])), "release: each is handed the leader's whole read, for its own verdict and race handling");
    assert(released.every((t) => t.seat.claimedByOthers().has("p0") && !t.seat.claimedByOthers().has(t.start!.advisor)), "release: a handed advisor is claimed for the confirm it was handed to");
    // The fourth and fifth wait: every unclaimed advisor is handed, and the confirm handed
    // the rung's LAST one holds the line (#3257: it may yet fail and free that advisor).
    const late: string[] = [];
    void waiting[3]!.then((t) => late.push(t.kind));
    await tick();
    assert(late.length === 0, "release: the rest wait behind the confirm handed the rung's last unclaimed advisor");
    // That one ends booked: the next waiter leads in the ordinary way, with nothing handed.
    released[2]!.done({ full: false }, "booked");
    const fourth = leadOf(await waiting[3]!);
    assert(fourth.start === undefined, "release: with nothing unclaimed left, the next waiter leads with nothing handed");
    for (const t of [leader, released[0]!, released[1]!, fourth]) t.done({ full: false }, "booked");
    leadOf(await waiting[4]!).done({ full: false });
  }

  // --- #3489: the release is bounded, and only by what is really unclaimed -----
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const leader = leadOf(await q.enter("slot"));
    const waiting = Array.from({ length: RELEASE_CAP + 3 }, () => q.enter("slot"));
    const kinds: string[] = waiting.map(() => "still waiting");
    waiting.forEach((w, i) => void w.then((t) => (kinds[i] = t.kind)));
    await tick();
    const read = Array.from({ length: RELEASE_CAP + 10 }, (_, i) => `a${i}`);
    leader.seat.claimFirst(read, { rung: 0 });
    await tick();
    const releasedNow = kinds.filter((k) => k === "lead").length;
    assert(releasedNow === RELEASE_CAP, `cap: at most RELEASE_CAP (${RELEASE_CAP}) are released at once, however many are free (got ${releasedNow})`);
    // Nobody holds the line while advisors stay unclaimed, so a newcomer leads at once
    // and its own claim takes one of them out of the frontier.
    let newcomer = "still waiting";
    void q.enter("slot").then((t) => (newcomer = t.kind));
    await tick();
    assert(newcomer === "still waiting", "cap: a newcomer joins behind the waiters the cap held back");
    for (const w of waiting) void w.then((t) => t.kind === "lead" && t.done({ full: false }, "booked"));
    leader.done({ full: false }, "booked");
  }

  // --- #3489: an advisor handed out and never tried goes back to the frontier --------
  //
  // Only an UNTRIED advisor is free for certain: one whose confirm was found busy by
  // Google, lost the insert race, or ended without saying stays out (L163). The line
  // knows untried itself: a handed advisor is untried until the confirm says `trying`.
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const leader = leadOf(await q.enter("slot"));
    const first = q.enter("slot");
    await tick();
    leader.seat.claimFirst(["p0", "p1"], { rung: 2 });
    const handed = leadOf(await first);
    assert(handed.start?.advisor === "p1", "untried: the waiter is handed p1");
    const next = q.enter("slot");
    await tick();
    // Its request ended before it tried p1 (a replay, a person gate, a client gone).
    handed.done({ full: false }, "untried");
    const again = leadOf(await next);
    assert(again.start?.advisor === "p1" && again.start.rung === 2, `untried: p1 is handed to the next waiter (got ${JSON.stringify(again.start)})`);
    // This one tried p1 and Google found it busy: p1 does not come back.
    again.seat.trying("p1");
    const after = q.enter("slot");
    await tick();
    again.done({ full: false }, "advisor-busy");
    const third = leadOf(await after);
    assert(third.start === undefined, "untried: an advisor Google found busy is never handed on");
    for (const t of [leader, third]) t.done({ full: false }, "booked");
  }

  // --- #3489: a claim that ends without saying how is never handed on ------------
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const leader = leadOf(await q.enter("slot"));
    const first = q.enter("slot");
    await tick();
    leader.seat.claimFirst(["p0", "p1"], { rung: 0 });
    const handed = leadOf(await first);
    handed.seat.trying("p1");
    const next = q.enter("slot");
    await tick();
    // An older client's report carries no outcome: unknown, today's rule (L168).
    handed.done({ full: false });
    const n = leadOf(await next);
    assert(n.start === undefined, "unknown: a tried claim that ended without an outcome is not handed on");
    for (const t of [leader, n]) t.done({ full: false }, "booked");
  }

  // --- #3489: a handed advisor nobody collected comes back when its lead lapses ------
  //
  // On the shared line a released lead must be acknowledged by its caller within the
  // ack window (#3325); one whose caller is gone lapses there, its advisor untried.
  // (A per isolate lease is longer than a frontier stays fresh, so it hands nothing.)
  {
    const { timer } = manualTimer();
    const lease = manualTimer();
    let clockMs = 0;
    const q = makeConfirmQueue<string>({ timer, leaseTimer: lease.timer, now: () => clockMs, ackMs: 1_000 });
    const leader = leadOf(await q.enter("slot"));
    leader.ack();
    const first = q.enter("slot");
    await tick();
    leader.seat.claimFirst(["p0", "p1"], { rung: 0 });
    leadOf(await first); // handed p1, never acknowledged
    leader.seat.trying("p0");
    const next = q.enter("slot");
    await tick();
    clockMs += 1_001;
    lease.fireAll();
    const n = leadOf(await next);
    assert(n.start?.advisor === "p1", `lease: an untried handed advisor whose confirm vanished is handed again (got ${JSON.stringify(n.start)})`);
    for (const t of [leader, n]) t.done({ full: false }, "booked");
  }

  // --- #3489: a stale frontier is never handed out --------------------------------
  {
    const { timer } = manualTimer();
    let clockMs = 0;
    const q = makeConfirmQueue<string>({ timer, now: () => clockMs });
    const leader = leadOf(await q.enter("slot"));
    leader.seat.claimFirst(["p0", "p1", "p2"], { rung: 0 });
    clockMs += FRONTIER_FRESH_MS + 1;
    const late = leadOf(await q.enter("slot"));
    assert(late.start === undefined, "stale: a frontier older than FRONTIER_FRESH_MS hands nothing, so the confirm reads for itself");
    for (const t of [leader, late]) t.done({ full: false }, "booked");
  }

  // --- #3489: a caller that does not name its rung keeps today's line exactly -------
  //
  // A reschedule's reroute, an in place move, or an older client: no frontier, no
  // release, one waiter handed the line as before (L255).
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const leader = leadOf(await q.enter("slot"));
    const seen: QueueTurn<string>[] = [];
    const waiting = [q.enter("slot"), q.enter("slot")].map((p) => p.then((t) => (seen.push(t), t)));
    await tick();
    leader.seat.claimFirst(["p0", "p1", "p2"]);
    await tick();
    assert(seen.length === 1 && seen[0]!.kind === "lead" && (seen[0] as { start?: unknown }).start === undefined, `unnamed rung: exactly one waiter leads, handed nothing (got ${seen.length})`);
    for (const t of [leader, leadOf(await waiting[0]!)]) t.done({ full: false });
    leadOf(await waiting[1]!).done({ full: false });
  }

  // === #3489 step 3: a rung spent by claims, and a full verdict the line holds =======
  //
  // Dan, 2026-10-07, on a rung whose last free advisor is claimed but not yet booked:
  // "Walk down straight away". A confirm that can walk (`canWalk`: a new booking's
  // walk and a lost race's) treats a rung every candidate of which is claimed as spent,
  // and a leader claiming a rung's LAST unclaimed advisor hands the line on, so the
  // confirms behind it walk down at once. A walker that reaches the end of its ladder
  // having skipped a rung only for claims PARKS instead of refusing, and the line holds
  // that as a pending full verdict, applied to everybody waiting when the last claim in
  // flight ends booked. Any other ending discards it and one confirm reads again.

  // --- a walker reads a rung whose every candidate is claimed as spent ------------------
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = leadOf(await q.enter("slot"));
    const seen: QueueTurn<string>[] = [];
    const behind = q.enter("slot").then((t) => (seen.push(t), t));
    await tick();
    const got = first.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true });
    assert(JSON.stringify(got) === JSON.stringify({ pool: ["a"], unclaimed: 1, waiting: 1 }), `walk: the first claims the rung's one advisor, and hears one confirm waits behind it (got ${JSON.stringify(got)})`);
    await tick();
    assert(seen.length === 1 && seen[0]!.kind === "lead", "walk: claiming a rung's last advisor hands the line on to a confirm that can walk past it");
    const second = leadOf(await behind);
    const spent = second.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true });
    assert(JSON.stringify(spent) === JSON.stringify({ pool: [], unclaimed: 0, spent: true, waiting: 0 }), `walk: every candidate claimed is a spent rung to a walker (got ${JSON.stringify(spent)})`);
    assert(!second.seat.claimedByOthers().has("none") && first.seat.claimedByOthers().size === 0, "walk: a spent rung claims nothing for the walker");
    // Control: a caller that cannot walk keeps today's rule, the insert decides.
    const stays = second.seat.claimFirst(["a"], { rung: 0 });
    assert(JSON.stringify(stays) === JSON.stringify({ pool: ["a"], unclaimed: 0 }), `walk control: a confirm that cannot walk is offered the claimed advisor, as before (got ${JSON.stringify(stays)})`);
    first.done({ full: false }, "booked");
    second.done({ full: false });
  }

  // --- on the LAST rung, claiming its last advisor keeps the line ------------------------
  // Nowhere below to walk to, so handing on would only send a confirm off to read for
  // nothing; and a walker that still meets it all claimed sees it spent, and parks.
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = leadOf(await q.enter("slot"));
    const seen: QueueTurn<string>[] = [];
    void q.enter("slot").then((t) => seen.push(t));
    await tick();
    first.seat.claimFirst(["a"], { rung: 3, canWalk: true, below: false });
    await tick();
    assert(seen.length === 0, "last rung: claiming its last advisor keeps the confirms behind it waiting");
    first.done({ full: true, refusal: "race", settled: "first" }, "booked");
    await tick();
    assert(seen.length === 1 && seen[0]!.kind === "refused", "last rung: its full verdict answers them, as before");
  }

  // --- a confirm handed a rung's last advisor does not hold the line when a rung is below --
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = leadOf(await q.enter("slot"));
    const seen: QueueTurn<string>[] = [];
    for (let i = 0; i < 3; i++) void q.enter("slot").then((t) => seen.push(t));
    await tick();
    first.seat.claimFirst(["a", "b"], { rung: 0, canWalk: true, below: true });
    await tick();
    const kinds = seen.map((t) => (t.kind === "lead" ? (t.start ? `handed:${t.start.advisor}` : "reader") : t.kind));
    assert(JSON.stringify(kinds) === JSON.stringify(["handed:b", "reader"]), `handed: b is handed out and one more confirm walks down past the rung at once (got ${JSON.stringify(kinds)})`);
    for (const t of seen) if (t.kind === "lead") t.done({ full: false });
    first.done({ full: false });
  }

  // --- #3529: a leader's read of the rungs BELOW it is handed out in the same release -----
  // Load runs 37857243671 and 37863081340: a crowd whose ladder had 13 or 14 advisors free
  // across three rungs booked them in waves, one rung at a time, each wave waiting about
  // two seconds for a walker to claim the rung below and become the frontier, so the last
  // booking landed near ten seconds and the crowd behind it ran out of time. The leader's
  // one ladder read already holds every rung, so it hands the lower rungs' reads with its
  // claim and the line releases the whole ladder at once, rung by rung in order.
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = leadOf(await q.enter("slot"));
    const seen: QueueTurn<string>[] = [];
    for (let i = 0; i < 5; i++) void q.enter("slot").then((t) => seen.push(t));
    await tick();
    first.seat.claimFirst(["a", "b"], { rung: 0, canWalk: true, below: true, lower: [{ rung: 1, read: ["b", "c", "d"] }, { rung: 2, read: ["e"] }] });
    await tick();
    const kinds = seen.map((t) => (t.kind === "lead" ? (t.start ? `${t.start.rung}:${t.start.advisor}` : "reader") : t.kind));
    eq(kinds.slice(0, 4).join(","), "0:b,1:c,1:d,2:e", "lower rungs: every unclaimed advisor of the ladder is handed out at once, top rung first, each once");
    const last = seen[3] as Extract<QueueTurn<string>, { kind: "lead" }>;
    eq(JSON.stringify(last.start?.read), JSON.stringify(["e"]), "lower rungs: a confirm handed a lower rung is handed that rung's own read");
    // The read did not say it covered every rung below (no `lowerComplete`), so a rung under
    // the last one listed may be unread: one more confirm walks on rather than everybody
    // waiting on the one handed the last listed advisor.
    eq(seen.length, 5, "lower rungs, not covered: one more confirm is released to walk past the rungs listed");
    const walker = seen[4]!;
    assert(walker.kind === "lead" && !walker.start, `lower rungs, not covered: that one walks for itself, handed nothing (got ${JSON.stringify(walker)})`);
    for (const t of seen) leadOf(t).done({ full: false }, "booked");
    first.done({ full: false }, "booked");
  }
  {
    // #3529: when the read covered every rung below, nothing below is unread, so the one
    // handed the ladder's last advisor holds the line: nobody is left to hand.
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = leadOf(await q.enter("slot"));
    const seen: QueueTurn<string>[] = [];
    for (let i = 0; i < 5; i++) void q.enter("slot").then((t) => seen.push(t));
    await tick();
    first.seat.claimFirst(["a", "b"], { rung: 0, canWalk: true, below: true, lower: [{ rung: 1, read: ["b", "c", "d"] }, { rung: 2, read: ["e"] }], lowerComplete: true });
    await tick();
    eq(seen.length, 4, "lower rungs, covered: the confirm behind the last one handed waits, with nothing left to hand it");
    for (const t of seen) leadOf(t).done({ full: false }, "booked");
    first.done({ full: false }, "booked");
  }
  {
    // #3529: when the leader's read covered every rung below (`lowerComplete`), the advisors
    // on the DEEPEST rung that read found anyone on are marked `deepest`: below them the read
    // found nobody, so booking one of them can settle the crowd without a walk of the empty
    // rungs. Without that cover, nothing is marked.
    for (const complete of [true, false]) {
      const { timer } = manualTimer();
      const q = makeConfirmQueue<string>({ timer });
      const first = leadOf(await q.enter("slot"));
      const seen: QueueTurn<string>[] = [];
      for (let i = 0; i < 3; i++) void q.enter("slot").then((t) => seen.push(t));
      await tick();
      first.seat.claimFirst(["a", "b"], { rung: 0, canWalk: true, below: true, lower: [{ rung: 1, read: ["c", "d"] }], ...(complete ? { lowerComplete: true as const } : {}) });
      await tick();
      const marks = seen.map((t) => (t.kind === "lead" && t.start ? `${t.start.rung}:${t.start.advisor}:${t.start.deepest === true}` : t.kind));
      eq(marks.join(","), complete ? "0:b:false,1:c:true,1:d:true" : "0:b:false,1:c:false,1:d:false", `deepest (${complete ? "read covered the ladder" : "not covered"}): only a covered read marks its deepest rung`);
      for (const t of seen) leadOf(t).done({ full: false }, "booked");
      first.done({ full: false }, "booked");
    }
  }
  {
    // #3529: pools overlap, so a lower rung can list only advisors already on a rung above
    // it (load model burst 3: rungs two and three held tier one's own people). Such a rung
    // adds nobody, so the deepest rung is the deepest that brings someone new.
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = leadOf(await q.enter("slot"));
    const seen: QueueTurn<string>[] = [];
    for (let i = 0; i < 2; i++) void q.enter("slot").then((t) => seen.push(t));
    await tick();
    first.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true, lower: [{ rung: 1, read: ["c", "d"] }, { rung: 2, read: ["d", "c"] }, { rung: 3, read: ["c"] }], lowerComplete: true });
    await tick();
    const marks = seen.map((t) => (t.kind === "lead" && t.start ? `${t.start.rung}:${t.start.advisor}:${t.start.deepest === true}` : t.kind));
    eq(marks.join(","), "1:c:true,1:d:true", "deepest overlap: a rung of advisors already above adds nobody, so tier one is the deepest");
    for (const t of seen) leadOf(t).done({ full: false }, "booked");
    first.done({ full: false }, "booked");
  }
  {
    // #3529 review: a read that covered every rung below and found nobody sends
    // `lowerComplete` with no `lower`. The frontier's own rung is then the deepest: its
    // advisors are handed marked `deepest`, and the one handed the last holds the line,
    // rather than one more confirm walking rungs the read already found empty.
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = leadOf(await q.enter("slot"));
    const seen: QueueTurn<string>[] = [];
    for (let i = 0; i < 3; i++) void q.enter("slot").then((t) => seen.push(t));
    await tick();
    first.seat.claimFirst(["a", "b", "c"], { rung: 1, canWalk: true, below: true, lowerComplete: true });
    await tick();
    const marks = seen.map((t) => (t.kind === "lead" ? (t.start ? `${t.start.rung}:${t.start.advisor}:${t.start.deepest === true}` : "reader") : t.kind));
    eq(marks.join(","), "1:b:true,1:c:true", "nobody below: the frontier's rung is the deepest, and nobody walks the empty rungs again");
    for (const t of seen) if (t.kind === "lead") t.done({ full: false }, "booked");
    first.done({ full: false }, "booked");
  }
  {
    // #3529 review: lower rungs arrive over the wire, so their order is not trusted. Out of
    // order or repeated, they are handed top rung first, each rung once (the first listing
    // of a repeated rung kept), and the deepest is still the deepest that brings anyone new.
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = leadOf(await q.enter("slot"));
    const seen: QueueTurn<string>[] = [];
    for (let i = 0; i < 3; i++) void q.enter("slot").then((t) => seen.push(t));
    await tick();
    first.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true, lower: [{ rung: 2, read: ["d"] }, { rung: 1, read: ["c"] }, { rung: 1, read: ["x"] }], lowerComplete: true });
    await tick();
    const marks = seen.map((t) => (t.kind === "lead" && t.start ? `${t.start.rung}:${t.start.advisor}:${t.start.deepest === true}` : t.kind));
    eq(marks.join(","), "1:c:false,2:d:true", "wire order: lower rungs are handed top first and a repeated rung counts once");
    for (const t of seen) if (t.kind === "lead") t.done({ full: false }, "booked");
    first.done({ full: false }, "booked");
  }
  {
    // #3529: the line marks the LAST advisor it hands out (`StartFrom.last`), because a rung's
    // read ends wherever round robin put its people: load run 37871606406 read tier one with
    // an advisor of the top rung LAST, the line handed that one on the top rung, and nobody
    // handed tier one stood at its read's end, so nobody could say the time was full and 85
    // of 100 waited out the line. Only the final hand out carries it, wherever it sits.
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = leadOf(await q.enter("slot"));
    const seen: QueueTurn<string>[] = [];
    for (let i = 0; i < 3; i++) void q.enter("slot").then((t) => seen.push(t));
    await tick();
    first.seat.claimFirst(["a", "b"], { rung: 0, canWalk: true, below: true, lower: [{ rung: 1, read: ["c", "b"] }], lowerComplete: true });
    await tick();
    const marks = seen.map((t) => (t.kind === "lead" && t.start ? `${t.start.rung}:${t.start.advisor}:${t.start.last === true}` : t.kind));
    eq(marks.join(","), "0:b:false,1:c:true", "last: the final hand out is marked, though its rung's read ends with an advisor handed above");
    for (const t of seen) if (t.kind === "lead") t.done({ full: false }, "booked");
    first.done({ full: false }, "booked");
  }
  {
    // #3529: and it goes to whoever is handed that advisor, so a release cut short by the cap
    // or by too few waiting hands no mark until the final advisor is actually handed.
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = leadOf(await q.enter("slot"));
    const seen: QueueTurn<string>[] = [];
    void q.enter("slot").then((t) => seen.push(t));
    await tick();
    first.seat.claimFirst(["a", "b"], { rung: 0, canWalk: true, below: true, lower: [{ rung: 1, read: ["c"] }], lowerComplete: true });
    await tick();
    const later: QueueTurn<string>[] = [];
    for (let i = 0; i < 2; i++) void q.enter("slot").then((t) => later.push(t));
    await tick();
    const marks = [...seen, ...later].map((t) => (t.kind === "lead" && t.start ? `${t.start.rung}:${t.start.advisor}:${t.start.last === true}` : t.kind));
    eq(marks.join(","), "0:b:false,1:c:true", "last: one waiting is handed b unmarked, and c, handed later, carries the mark");
    for (const t of [...seen, ...later]) if (t.kind === "lead") t.done({ full: false }, "booked");
    first.done({ full: false }, "booked");
  }
  {
    // An advisor found busy on a lower rung is never handed again, there or above.
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = leadOf(await q.enter("slot"));
    const seen: QueueTurn<string>[] = [];
    void q.enter("slot").then((t) => seen.push(t));
    await tick();
    first.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true, lower: [{ rung: 1, read: ["c", "d"] }] });
    await tick();
    const handed = leadOf(seen[0]!);
    eq(handed.start?.advisor, "c", "lower busy: c on the rung below is handed");
    handed.seat.trying("c");
    const next: QueueTurn<string>[] = [];
    void q.enter("slot").then((t) => next.push(t));
    await tick();
    handed.done({ full: false }, "advisor-busy");
    await tick();
    eq(next[0]?.kind === "lead" ? next[0].start?.advisor : "none", "d", "lower busy: the next confirm is handed d, never c again");
    leadOf(next[0]!).done({ full: false }, "booked");
    first.done({ full: false }, "booked");
  }

  // --- a walker that parks waits for the claims in flight, answered when they book -----
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = leadOf(await q.enter("slot"));
    first.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true });
    const walker = leadOf(await q.enter("slot"));
    walker.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true });
    const later: QueueTurn<string>[] = [];
    void q.enter("slot").then((t) => later.push(t));
    const parked = walker.park();
    const parkedSeen: QueueTurn<string>[] = [];
    void parked.then((t) => parkedSeen.push(t));
    await tick();
    assert(parkedSeen.length === 0 && later.length === 0, "park: the parked walker and those behind it wait while a claim is in flight");
    first.done({ full: false }, "booked", "seated now");
    await tick();
    assert(
      parkedSeen.length === 1 && parkedSeen[0]!.kind === "refused" && parkedSeen[0]!.refusal === "race" && parkedSeen[0]!.settled === "seated now",
      `park: the last booking answers the parked walker, from its own settlement (got ${JSON.stringify(parkedSeen)})`,
    );
    assert(later.length === 1 && later[0]!.kind === "refused" && (later[0] as { settled?: unknown }).settled === "seated now", `park: and everybody waiting behind it (got ${JSON.stringify(later)})`);
  }

  // --- a claim that ends without booking discards the pending verdict -------------------
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = leadOf(await q.enter("slot"));
    first.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true });
    const walker = leadOf(await q.enter("slot"));
    walker.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true });
    const parked = walker.park();
    const behind: QueueTurn<string>[] = [];
    void q.enter("slot").then((t) => behind.push(t));
    const parkedSeen: QueueTurn<string>[] = [];
    void parked.then((t) => parkedSeen.push(t));
    await tick();
    first.seat.trying("a");
    first.done({ full: false }, "advisor-busy");
    await tick();
    assert(parkedSeen.length === 1 && parkedSeen[0]!.kind === "lead", `discard: the parked walker reads again, since the advisor it waited on is free of claims (got ${JSON.stringify(parkedSeen.map((t) => t.kind))})`);
    assert(behind.length === 0, "discard: ONE reader, never the whole crowd");
    leadOf(parkedSeen[0]!).done({ full: true, refusal: "taken", settled: null });
    await tick();
    assert(behind.length === 1 && behind[0]!.kind === "refused", "discard: that reader's own verdict answers the rest");
  }

  // --- a full verdict with another claim in flight is HELD, never a fresh reader ---------
  //
  // Replaces #3257's "a full verdict with a claim in flight lets the next ask for
  // itself" (Dan, 2026-10-07, decision 1): asking for itself re-walked every rung while
  // the only thing that could change the answer was the claim in flight.
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = leadOf(await q.enter("slot"));
    first.seat.claim("p0", true);
    const second = leadOf(await q.enter("slot"));
    second.seat.claim("p1", false);
    const third: QueueTurn<string>[] = [];
    void q.enter("slot").then((t) => third.push(t));
    second.done({ full: true, refusal: "race", settled: "second" }, "booked");
    await tick();
    assert(third.length === 0, "held: a full verdict with another claim in flight keeps the waiting waiting");
    first.done({ full: false }, "booked", "both seated");
    await tick();
    assert(third.length === 1 && third[0]!.kind === "refused" && (third[0] as { settled?: unknown }).settled === "both seated", `held: the last booking applies it, with the settlement read at that moment (got ${JSON.stringify(third)})`);
  }

  // --- applied only from a settlement read when it applies, never from a stale one -------
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = leadOf(await q.enter("slot"));
    first.seat.claim("p0", true);
    const second = leadOf(await q.enter("slot"));
    second.seat.claim("p1", false);
    const third: QueueTurn<string>[] = [];
    void q.enter("slot").then((t) => third.push(t));
    second.done({ full: true, refusal: "race", settled: "second" }, "booked");
    // An older client, or a settling read that failed: the last booking brings none.
    first.done({ full: false }, "booked");
    await tick();
    assert(third.length === 1 && third[0]!.kind === "lead", `stale: with no settlement read at the end, one confirm reads for itself (got ${JSON.stringify(third.map((t) => t.kind))})`);
    leadOf(third[0]!).done({ full: false });
  }

  // --- a claim that moves to another advisor discards it too ------------------------------
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = leadOf(await q.enter("slot"));
    first.seat.claimFirst(["a", "b"], { rung: 0, canWalk: true, below: true });
    first.seat.claimFirst(["b"], { rung: 0, canWalk: true, below: true });
    const walker = leadOf(await q.enter("slot"));
    const spent = walker.seat.claimFirst(["a", "b"], { rung: 0, canWalk: true, below: true });
    assert(JSON.stringify(spent) === JSON.stringify({ pool: ["a"], unclaimed: 1, waiting: 0 }), `moved: the first's move off a frees a for the next (got ${JSON.stringify(spent)})`);
    first.done({ full: false }, "booked", "s");
    walker.done({ full: false }, "booked", "s");
  }

  // --- a parked walker whose skipped claims have all BOOKED: its walk stands --------------
  // Every rung it walked was spent by the time it reached the bottom: the ones it read had
  // nobody free, and the ones it skipped were held by claims that have since booked. So it
  // leads again marked `spent` and reports the ladder full itself, rather than the next
  // confirm walking the whole ladder again (2.8s of burst 1 in the load model).
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = leadOf(await q.enter("slot"));
    first.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true });
    const walker = leadOf(await q.enter("slot"));
    walker.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true });
    const behind: QueueTurn<string>[] = [];
    void q.enter("slot").then((t) => behind.push(t));
    first.done({ full: false }, "booked", "s");
    await tick();
    assert(behind.length === 0, "walk stands: the confirm behind the walker still waits");
    const parked = await walker.park();
    assert(parked.kind === "lead" && parked.spent === true, `walk stands: a walker whose skipped claims have all booked leads again marked spent (got ${JSON.stringify(parked)})`);
    leadOf(parked).done({ full: true, refusal: "taken", settled: "seated" });
    await tick();
    assert(behind.length === 1 && behind[0]!.kind === "refused", `walk stands: its full verdict answers the confirm behind it (got ${JSON.stringify(behind)})`);
  }
  // #3529: a full verdict from a confirm that walked past a claim holds only while no
  // claim has ended without a booking since that confirm first read (`unlessFreed`). In
  // a crowd that is the usual case, and everybody waiting is answered at once rather
  // than one of them walking the whole ladder again to find what the line already knew.
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = leadOf(await q.enter("slot"));
    first.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true });
    const walker = leadOf(await q.enter("slot"));
    const behind: QueueTurn<string>[] = [];
    void q.enter("slot").then((t) => behind.push(t));
    walker.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true });
    walker.seat.claimFirst(["c"], { rung: 2, canWalk: true, below: false });
    first.done({ full: false }, "booked", "s");
    walker.done({ full: true, refusal: "race", settled: "w", unlessFreed: true }, "booked");
    await tick();
    assert(behind.length === 1 && behind[0]!.kind === "refused", `unless freed: nothing freed since it read, so the waiting are answered at once (got ${JSON.stringify(behind.map((t) => t.kind))})`);
  }
  // Control: the claim it walked past ended WITHOUT a booking after it read, so its
  // advisor may be free: the verdict is void and the confirm behind reads for itself.
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = leadOf(await q.enter("slot"));
    first.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true });
    first.seat.trying("a");
    const walker = leadOf(await q.enter("slot"));
    const behind: QueueTurn<string>[] = [];
    void q.enter("slot").then((t) => behind.push(t));
    walker.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true });
    walker.seat.claimFirst(["c"], { rung: 2, canWalk: true, below: false });
    first.done({ full: false }, "unknown");
    walker.done({ full: true, refusal: "race", settled: "w", unlessFreed: true }, "booked");
    await tick();
    assert(behind.length === 1 && behind[0]!.kind === "lead", `unless freed control: a claim ended unbooked since it read, so one confirm reads again (got ${JSON.stringify(behind.map((t) => t.kind))})`);
    leadOf(behind[0]!).done({ full: false });
  }
  // Control: a confirm that never read through the line has nothing to vouch for its
  // verdict with, so `unlessFreed` never settles anybody from it.
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const lone = leadOf(await q.enter("slot"));
    const behind: QueueTurn<string>[] = [];
    void q.enter("slot").then((t) => behind.push(t));
    lone.done({ full: true, refusal: "race", settled: "l", unlessFreed: true }, "booked");
    await tick();
    assert(behind.length === 1 && behind[0]!.kind === "lead", `unless freed, unread: no read to vouch with, so one confirm reads (got ${JSON.stringify(behind.map((t) => t.kind))})`);
    leadOf(behind[0]!).done({ full: false });
  }

  // #3529: a HANDED confirm's full verdict is vouched for by the read it was handed from:
  // its rungs above were read by the leader, so when nothing was freed since that leader
  // first read, the crowd behind it is answered at once, with no walk of the ladder again.
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const leader = leadOf(await q.enter("slot"));
    const released: QueueTurn<string>[] = [];
    void q.enter("slot").then((t) => released.push(t));
    await tick();
    // As the app sends it: its lower read covers every rung below (`lowerRungReads`).
    leader.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true, lower: [{ rung: 1, read: ["c"] }], lowerComplete: true });
    await tick();
    const handed = leadOf(released[0]!);
    eq(handed.start?.advisor, "c", "handed vouched: c on the rung below is handed out");
    const behind: QueueTurn<string>[] = [];
    void q.enter("slot").then((t) => behind.push(t));
    await tick();
    handed.seat.trying("c");
    leader.done({ full: false }, "booked", "s");
    handed.done({ full: true, refusal: "race", settled: "h", unlessFreed: true }, "booked");
    await tick();
    assert(behind.length === 1 && behind[0]!.kind === "refused", `handed vouched: nothing freed since the leader read, so the crowd is answered at once (got ${JSON.stringify(behind.map((t) => t.kind))})`);
  }

  // #3529: a host drops a parked confirm whose caller stopped polling by cancelling its
  // wait. Handed straight back as spent, that wait is already a lead turn holding the
  // line, so cancelling it must end the turn and hand the line on, as cancelling any
  // answered lead does, rather than hold everybody behind it until its lease lapses.
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = leadOf(await q.enter("slot"));
    first.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true });
    const walker = leadOf(await q.enter("slot"));
    walker.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true });
    const behind: QueueTurn<string>[] = [];
    void q.enter("slot").then((t) => behind.push(t));
    first.done({ full: false }, "booked", "s");
    await tick();
    const parked = walker.parkNow();
    assert((await parked.turn).kind === "lead", "spent cancel: the walk stands, handed back as a lead");
    parked.cancel();
    await tick();
    assert(behind.length === 1 && behind[0]!.kind === "lead", `spent cancel: cancelling it hands the line to the confirm behind (got ${JSON.stringify(behind.map((t) => t.kind))})`);
    leadOf(behind[0]!).done({ full: false });
  }
  // Control: the claim it skipped ended in a way that may have left its advisor free (its
  // confirm never said how it ended), so its walk proves nothing: it reads again, unmarked.
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = leadOf(await q.enter("slot"));
    first.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true });
    first.seat.trying("a");
    const walker = leadOf(await q.enter("slot"));
    walker.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true });
    first.done({ full: false }, "unknown");
    const parked = await walker.park();
    assert(parked.kind === "lead" && parked.spent === undefined, `walk control: a claim it skipped ended unknown, so it reads again, unmarked (got ${JSON.stringify(parked)})`);
    leadOf(parked).done({ full: true, refusal: "taken", settled: null });
  }
  // #3529: a claim that ended BUSY or LOST ITS RACE frees nobody (Google said the advisor
  // cannot take the time, or a booking already holds them), so a walk past it still
  // stands. Load run 37822382352, burst 1: a walker's own two lost races moved the epoch,
  // its walk could not stand when it parked, and the crowd behind it timed out while a
  // second confirm walked the ladder again to learn what the line already knew.
  for (const ending of ["advisor-busy", "lost-race"] as const) {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const first = leadOf(await q.enter("slot"));
    first.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true });
    first.seat.trying("a");
    const walker = leadOf(await q.enter("slot"));
    walker.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true });
    // Its own claim below that it lost too, then moved on from: no freeing either.
    walker.seat.claimFirst(["c", "d"], { rung: 2, canWalk: true, below: false });
    walker.seat.trying("c");
    walker.seat.claimFirst(["d"], { rung: 2, canWalk: true, below: false });
    walker.seat.trying("d");
    first.done({ full: false }, ending);
    const parked = await walker.park();
    assert(parked.kind === "lead" && parked.spent === true, `walk stands, ${ending}: nothing it skipped or tried was freed, so its walk stands (got ${JSON.stringify(parked)})`);
    leadOf(parked).done({ full: true, refusal: "taken", settled: null });
  }
  // #3529: a confirm the line HANDS an advisor on a lower rung never read the rungs above;
  // the leader whose read it was handed did. When nothing has been freed since that
  // leader first read, and the claims are done, the handed confirm's walk stands too.
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const holder = leadOf(await q.enter("slot"));
    holder.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true });
    const leader = leadOf(await q.enter("slot"));
    const released: QueueTurn<string>[] = [];
    void q.enter("slot").then((t) => released.push(t));
    await tick();
    leader.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true });
    leader.seat.claimFirst(["c", "d"], { rung: 2, canWalk: true, below: false });
    await tick();
    const handed = leadOf(released[0]!);
    assert(handed.start?.rung === 2 && handed.start.advisor === "d", `handed: d on the lower rung is handed out (got ${JSON.stringify(handed.start)})`);
    handed.seat.trying("d");
    holder.done({ full: false }, "booked", "s");
    leader.done({ full: false }, "booked", "s");
    const parked = await handed.park();
    assert(parked.kind === "lead" && parked.spent === true, `handed stands: the leader's walk vouches for the rungs above it, so it stands (got ${JSON.stringify(parked)})`);
    leadOf(parked).done({ full: true, refusal: "taken", settled: null });
  }
  // Control: a walker that never met a spent rung (no claim to walk past) and parks is not
  // marked either: nothing it skipped could have proved anything.
  {
    const { timer } = manualTimer();
    const q = makeConfirmQueue<string>({ timer });
    const walker = leadOf(await q.enter("slot"));
    walker.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true });
    const parked = await walker.park();
    assert(parked.kind === "lead" && parked.spent === undefined, `walk control: a walker that skipped nothing is not marked (got ${JSON.stringify(parked)})`);
    leadOf(parked).done({ full: false });
  }

  // --- an expired claim is an unknown ending, so the pending verdict is discarded ----------
  {
    const { timer } = manualTimer();
    const lease = manualTimer();
    let t = 0;
    const q = makeConfirmQueue<string>({ timer, leaseTimer: lease.timer, now: () => t });
    const first = leadOf(await q.enter("slot"));
    first.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true });
    const walker = leadOf(await q.enter("slot"));
    walker.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true });
    walker.renew();
    const parkedSeen: QueueTurn<string>[] = [];
    void walker.park().then((x) => parkedSeen.push(x));
    await tick();
    t = CONFIRM_CLAIM_LEASE_MS + 1;
    lease.fireAll();
    await tick();
    assert(parkedSeen.length === 1 && parkedSeen[0]!.kind === "lead", `lapsed: the claim the walker waited on lapsed, so it reads again (got ${JSON.stringify(parkedSeen.map((x) => x.kind))})`);
  }
  // #3529: the same lapse on a claim that had said `trying`. Its advisor does not go back
  // on the frontier (it may have been asked about), but the claim is gone and the verdict
  // it held is void, so the parked walker must still be woken, not left to time out.
  {
    const { timer } = manualTimer();
    const lease = manualTimer();
    let t = 0;
    const q = makeConfirmQueue<string>({ timer, leaseTimer: lease.timer, now: () => t });
    const first = leadOf(await q.enter("slot"));
    first.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true });
    first.seat.trying("a");
    const walker = leadOf(await q.enter("slot"));
    walker.seat.claimFirst(["a"], { rung: 0, canWalk: true, below: true });
    walker.renew();
    const parkedSeen: QueueTurn<string>[] = [];
    void walker.park().then((x) => parkedSeen.push(x));
    await tick();
    assert(parkedSeen.length === 0, "lapsed tried: the parked walker waits while the claim is live");
    t = CONFIRM_CLAIM_LEASE_MS + 1;
    lease.fireAll();
    await tick();
    assert(parkedSeen.length === 1 && parkedSeen[0]!.kind === "lead", `lapsed tried: a tried claim that lapsed wakes the parked walker to read again (got ${JSON.stringify(parkedSeen.map((x) => x.kind))})`);
  }
  // #3529: and a lapsed HANDED claim makes room under the release cap, so a confirm held
  // back by the cap is released then, not left to time out behind it.
  {
    const { timer } = manualTimer();
    const lease = manualTimer();
    let t = 0;
    const q = makeConfirmQueue<string>({ timer, leaseTimer: lease.timer, now: () => t });
    const first = leadOf(await q.enter("slot"));
    const pool = Array.from({ length: RELEASE_CAP + 3 }, (_, i) => `p${i}`);
    const seen: QueueTurn<string>[] = [];
    for (let i = 0; i < RELEASE_CAP + 1; i++) void q.enter("slot").then((x) => seen.push(x));
    await tick();
    first.seat.claimFirst(pool, { rung: 0 });
    await tick();
    const handed = seen.filter((x) => x.kind === "lead" && x.start !== undefined);
    assert(handed.length === RELEASE_CAP && seen.length === RELEASE_CAP, `cap: the release stops at the cap (got ${seen.length} answered, ${handed.length} handed)`);
    // Every handed confirm says trying and renews, except one that is torn down.
    first.renew();
    for (const h of handed.slice(1)) {
      const lead = leadOf(h);
      lead.seat.trying(lead.start!.advisor);
      lead.renew();
    }
    leadOf(handed[0]!).seat.trying(leadOf(handed[0]!).start!.advisor);
    t = CONFIRM_CLAIM_LEASE_MS - 1;
    first.renew();
    for (const h of handed.slice(1)) leadOf(h).renew();
    t = CONFIRM_CLAIM_LEASE_MS + 1;
    lease.fireAll();
    await tick();
    assert(seen.length === RELEASE_CAP + 1, `cap: the handed claim that lapsed frees room, so the one held back is released (got ${seen.length} answered)`);
  }

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
