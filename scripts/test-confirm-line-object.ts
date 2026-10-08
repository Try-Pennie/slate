// The confirm line hosted in a shared object (#3325): the message handler the
// `ConfirmLine` Durable Object runs, driven here with hand fired timers and no
// network. Every rule of the line itself lives in `makeConfirmQueue` (tested by
// test-confirm-queue.ts); what is tested here is the protocol around it, and above
// all every way a message can be lost, late, repeated or outlived by a deploy,
// because each of those strands a line that a lease alone frees too late.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-confirm-line-object.ts
import {
  makeConfirmLineHost,
  CONFIRM_LINE_PROTOCOL,
  CONFIRM_LINE_POLL_MS,
  CONFIRM_LINE_POLL_GRACE_MS,
  CONFIRM_LINE_ACK_MS,
  CONFIRM_LINE_LEASE_MS,
  CONFIRM_LINE_HEARTBEAT_MS,
} from "../src/lib/booking/confirm-line-object.ts";
import { CONFIRM_QUEUE_WAIT_MS } from "../src/lib/booking/confirm-queue.ts";
import { createAsserter } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();
const v = CONFIRM_LINE_PROTOCOL;
const tick = () => new Promise((r) => setImmediate(r));

/** Timers fired by hand, in order of when they are due on a clock the test moves. */
function clockAndTimers(start = 1_000) {
  let now = start;
  const pending: { at: number; fire: () => void; live: boolean }[] = [];
  const timer = (ms: number, fire: () => void) => {
    const t = { at: now + ms, fire, live: true };
    pending.push(t);
    return () => {
      t.live = false;
    };
  };
  /** Moves the clock forward and fires everything now due, earliest first. */
  const advance = async (ms: number) => {
    now += ms;
    for (;;) {
      const due = pending.filter((t) => t.live && t.at <= now).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.live = false;
      due.fire();
      await tick();
    }
    await tick();
  };
  return { now: () => now, timer, advance };
}

function host() {
  const c = clockAndTimers();
  let n = 0;
  const h = makeConfirmLineHost({ now: c.now, timer: c.timer, leaseTimer: c.timer, newId: () => `id${++n}` });
  const send = async (req: Record<string, unknown>) => JSON.parse(await h.handle({ v, ...req })) as Record<string, unknown>;
  return { ...c, h, send };
}

async function main() {
  // --- the timings hold together -----------------------------------------------
  //
  // An abandoned leader must free the line while the followers behind it can still
  // be served, so the ack window and the lease must sit well inside the follower
  // wait, and a heartbeat must renew comfortably before the lease ends.
  // The worst case is the larger of the two: a lead that never checks in is freed
  // after the ack window, one that dies just after renewing after one lease.
  assert(CONFIRM_LINE_ACK_MS < CONFIRM_LINE_LEASE_MS, "timings: the ack window is shorter than a lease");
  assert(CONFIRM_LINE_LEASE_MS <= CONFIRM_QUEUE_WAIT_MS / 2, "timings: an abandoned leader is freed inside half the follower wait");
  assert(CONFIRM_LINE_HEARTBEAT_MS * 2 < CONFIRM_LINE_LEASE_MS, "timings: two heartbeats fit inside one lease, so one lost renewal is survivable");
  assert(CONFIRM_LINE_POLL_MS + CONFIRM_LINE_POLL_GRACE_MS < CONFIRM_LINE_LEASE_MS, "timings: a vanished follower is dropped before a lease runs out");

  // --- the first in leads, and a repeated enter gets the same answer ------------
  {
    const { send } = host();
    const a = await send({ op: "enter", attempt: "A", line: "100", waitMs: 10_000 });
    assert(a.kind === "lead" && typeof a.turn === "string", `enter: the first confirm leads (got ${JSON.stringify(a)})`);
    const again = await send({ op: "enter", attempt: "A", line: "100", waitMs: 10_000 });
    assert(JSON.stringify(again) === JSON.stringify(a), "enter: a retried enter with the same attempt id gets the same answer, not a second place");
    const b = await send({ op: "enter", attempt: "B", line: "100", waitMs: 10_000 });
    assert(b.kind === "wait" && typeof b.ticket === "string", "enter: the next confirm waits with a ticket");
    const other = await send({ op: "enter", attempt: "C", line: "200", waitMs: 10_000 });
    assert(other.kind === "lead", "enter: another instant in the same object is its own line");
  }

  // --- a full verdict answers every waiter, from ONE serialised settlement --------
  {
    const { send } = host();
    const lead = await send({ op: "enter", attempt: "A", line: "100", waitMs: 10_000 });
    await send({ op: "ack", turn: lead.turn });
    await send({ op: "claimFirst", turn: lead.turn, candidates: ["p0"] });
    const w1 = await send({ op: "enter", attempt: "B", line: "100", waitMs: 10_000 });
    const w2 = await send({ op: "enter", attempt: "C", line: "100", waitMs: 10_000 });
    const p1 = send({ op: "poll", ticket: w1.ticket });
    const p2 = send({ op: "poll", ticket: w2.ticket });
    await tick();
    const settled = { booked: { idempotencyKey: "k", result: { booking: { id: "b1" }, manageUrl: "u" } }, seated: [] };
    const d = await send({ op: "done", turn: lead.turn, verdict: { full: true, refusal: "race", settled } });
    assert(d.ok === true, "done: the leader's report is accepted");
    const [r1, r2] = await Promise.all([p1, p2]);
    assert(r1.kind === "refused" && r1.refusal === "race", `poll: a held follower is refused from the verdict (got ${JSON.stringify(r1)})`);
    assert(JSON.stringify(r1.settled) === JSON.stringify(settled), "poll: the settlement arrives intact after the round trip");
    assert(JSON.stringify(r1) === JSON.stringify(r2), "poll: every follower gets the same answer");
    const again = await send({ op: "done", turn: lead.turn, verdict: { full: false } });
    assert(again.ok === true, "done: a repeated report is accepted and changes nothing");
  }

  // --- #3529: a verdict full only `unlessFreed` keeps that condition over the wire ----
  // Dropped in transit it would read as plainly full and refuse everybody waiting. Sent
  // by a lead that never read through the line, nothing vouches for it, so the line
  // must hand the next waiter a turn to read for itself instead.
  {
    const { send } = host();
    const lead = await send({ op: "enter", attempt: "A", line: "100", waitMs: 10_000 });
    await send({ op: "ack", turn: lead.turn });
    const w = await send({ op: "enter", attempt: "B", line: "100", waitMs: 10_000 });
    const polled = send({ op: "poll", ticket: w.ticket });
    await tick();
    await send({ op: "done", turn: lead.turn, verdict: { full: true, refusal: "race", settled: null, unlessFreed: true }, outcome: "booked" });
    const r = await polled;
    assert(r.kind === "lead", `wire: an unless freed verdict nothing vouches for refuses nobody (got ${JSON.stringify(r)})`);
    await send({ op: "done", turn: r.turn, verdict: { full: false } });
  }

  // --- a poll with nothing to report comes back after one poll length -----------
  {
    const { send, advance } = host();
    await send({ op: "enter", attempt: "A", line: "100", waitMs: 10_000 }).then((l) => send({ op: "ack", turn: l.turn }));
    const w = await send({ op: "enter", attempt: "B", line: "100", waitMs: 10_000 });
    const p = send({ op: "poll", ticket: w.ticket });
    await advance(CONFIRM_LINE_POLL_MS);
    const r = await p;
    assert(r.kind === "pending", `poll: an unsettled line answers pending after one poll (got ${JSON.stringify(r)})`);
  }

  // --- a lead nobody acknowledges frees the line for the waiter behind it ---------
  {
    const { send, advance } = host();
    await send({ op: "enter", attempt: "A", line: "100", waitMs: 10_000 });
    const w = await send({ op: "enter", attempt: "B", line: "100", waitMs: 10_000 });
    const p = send({ op: "poll", ticket: w.ticket });
    await advance(CONFIRM_LINE_ACK_MS);
    const r = await p;
    assert(r.kind === "lead", `ack: an unacknowledged lead (its answer lost) hands the line on within the ack window (got ${JSON.stringify(r)})`);
  }

  // --- a leader that keeps renewing keeps the line; one that stops loses it ------
  {
    const { send, advance } = host();
    const lead = await send({ op: "enter", attempt: "A", line: "100", waitMs: 10_000 });
    await send({ op: "ack", turn: lead.turn });
    await send({ op: "claim", turn: lead.turn, userId: "p0", othersRemain: false });
    // A wait long enough that only the leader's lease, never the follower's own
    // bound, can end this case.
    const w = await send({ op: "enter", attempt: "B", line: "100", waitMs: 60_000 });
    for (let i = 0; i < 3; i++) {
      await advance(CONFIRM_LINE_HEARTBEAT_MS);
      await send({ op: "renew", turn: lead.turn });
      const r = await (async () => {
        const p = send({ op: "poll", ticket: w.ticket });
        await advance(CONFIRM_LINE_POLL_MS);
        return p;
      })();
      assert(r.kind === "pending", `renew: a renewing leader keeps the follower waiting (round ${i}, got ${r.kind})`);
    }
    // The leader goes silent. The follower keeps polling, as its client does.
    let r: Record<string, unknown> = { kind: "pending" };
    let polls = 0;
    while (r.kind === "pending" && polls < 6) {
      const p = send({ op: "poll", ticket: w.ticket });
      await advance(CONFIRM_LINE_POLL_MS);
      r = await p;
      polls++;
    }
    assert(r.kind === "lead", `renew: a leader that stopped renewing frees the line one lease later (got ${JSON.stringify(r)})`);
    assert(polls * CONFIRM_LINE_POLL_MS <= CONFIRM_LINE_LEASE_MS + CONFIRM_LINE_POLL_MS, `renew: within one lease and one poll (took ${polls} polls)`);
    const late = await send({ op: "claim", turn: lead.turn, userId: "p1", othersRemain: false });
    assert(late.kind === "gone", "renew: a call from the expired leader is told its turn is gone");
  }

  // --- a follower that stops polling is dropped, and does not hold a lead ---------
  {
    const { send, advance } = host();
    const lead = await send({ op: "enter", attempt: "A", line: "100", waitMs: 10_000 });
    await send({ op: "ack", turn: lead.turn });
    await send({ op: "claim", turn: lead.turn, userId: "p0", othersRemain: false });
    await send({ op: "enter", attempt: "B", line: "100", waitMs: 10_000 }); // never polls: its caller went away
    const c = await send({ op: "enter", attempt: "C", line: "100", waitMs: 10_000 });
    await send({ op: "done", turn: lead.turn, verdict: { full: false } });
    // B was promoted to lead, but nobody collects it.
    let r: Record<string, unknown> = { kind: "pending" };
    for (let i = 0; i < 4 && r.kind === "pending"; i++) {
      const p = send({ op: "poll", ticket: c.ticket });
      await advance(CONFIRM_LINE_POLL_MS);
      r = await p;
    }
    assert(r.kind === "lead", `vanished: a follower promoted to lead and never collected is dropped, and the next one leads (got ${JSON.stringify(r)})`);
  }

  // --- abandon: the caller gave up on an enter that the object did answer ---------
  {
    const { send } = host();
    await send({ op: "enter", attempt: "A", line: "100", waitMs: 10_000 }); // answered too late for its caller
    const w = await send({ op: "enter", attempt: "B", line: "100", waitMs: 10_000 });
    const p = send({ op: "poll", ticket: w.ticket });
    const ab = await send({ op: "abandon", attempt: "A" });
    assert(ab.ok === true, "abandon: accepted");
    const r = await p;
    assert(r.kind === "lead", `abandon: the abandoned lead hands the line on at once (got ${JSON.stringify(r)})`);
    const unknown = await send({ op: "abandon", attempt: "nobody" });
    assert(unknown.ok === true, "abandon: an attempt the object never saw is a no op");
  }

  // --- #3351: abandon reaches a lead whose poll was answered and the answer lost ---
  // A follower's poll hands it the lead, and the answer never reaches it (a timeout on
  // the way back). It falls back and abandons its attempt. The attempt must lead to the
  // turn the poll registered, not only to the ticket the poll already deleted, or the
  // line waits out the ack window behind a lead nobody holds.
  {
    const { send, advance } = host();
    const lead = await send({ op: "enter", attempt: "A", line: "100", waitMs: 10_000 });
    await send({ op: "ack", turn: lead.turn });
    const b = await send({ op: "enter", attempt: "B", line: "100", waitMs: 10_000 });
    const c = await send({ op: "enter", attempt: "C", line: "100", waitMs: 10_000 });
    await send({ op: "done", turn: lead.turn, verdict: { full: false } });
    const handed = await send({ op: "poll", ticket: b.ticket }); // answered; lost on the way back
    assert(handed.kind === "lead", `lost lead: B's poll hands it the lead (got ${JSON.stringify(handed)})`);
    await send({ op: "abandon", attempt: "B" });
    let answered = false;
    const p = send({ op: "poll", ticket: c.ticket }).then((r) => {
      answered = true;
      return r;
    });
    await tick();
    await tick();
    assert(answered, "lost lead: abandoning B hands the line to C at once, not after the ack window");
    await advance(CONFIRM_LINE_ACK_MS + CONFIRM_LINE_POLL_MS);
    const r = await p;
    assert(r.kind === "lead", `lost lead: and C leads (got ${JSON.stringify(r)})`);
  }

  // --- a deploy: the new instance knows nothing, and says so ----------------------
  {
    const { send } = host();
    const g1 = await send({ op: "poll", ticket: "from-the-old-instance" });
    const g2 = await send({ op: "claimFirst", turn: "from-the-old-instance", candidates: ["p0"] });
    const g3 = await send({ op: "done", turn: "from-the-old-instance", verdict: { full: false } });
    assert(g1.kind === "gone" && g2.kind === "gone", "deploy: a ticket or turn the instance never issued is gone");
    assert(g3.ok === true && g3.gone === true, "deploy: a report for an unknown turn is accepted as already over");
    const old = JSON.parse(await host().h.handle({ v: v + 1, op: "enter", attempt: "A", line: "1", waitMs: 1 })) as Record<string, unknown>;
    assert(old.kind === "gone" && old.why === "version", "deploy: a message from another protocol version is gone, never guessed at");
  }

  // --- lookahead: a busy line hands out a leased place instead of a ticket --------
  {
    const { send, advance } = host();
    const idle = await send({ op: "enter", attempt: "A", line: "100", waitMs: 10_000, wantLookahead: true });
    assert(idle.kind === "lead", "lookahead: an idle line just leads");
    await send({ op: "ack", turn: idle.turn });
    const l1 = await send({ op: "enter", attempt: "B", line: "100", waitMs: 10_000, wantLookahead: true });
    const l2 = await send({ op: "enter", attempt: "C", line: "100", waitMs: 10_000, wantLookahead: true });
    const l3 = await send({ op: "enter", attempt: "D", line: "100", waitMs: 10_000, wantLookahead: true });
    assert(l1.kind === "lookahead" && l2.kind === "lookahead", "lookahead: a busy line offers its places");
    assert(l3.kind === "wait", "lookahead: past the bound, a confirm waits like the rest");
    const gb = await send({ op: "giveBack", permit: l1.permit });
    assert(gb.ok === true, "lookahead: a place is given back");
    const l4 = await send({ op: "enter", attempt: "E", line: "100", waitMs: 10_000, wantLookahead: true });
    assert(l4.kind === "lookahead", "lookahead: a returned place is offered again");
    await advance(CONFIRM_LINE_LEASE_MS * 2);
    await send({ op: "renew", turn: idle.turn });
    const l5 = await send({ op: "enter", attempt: "F", line: "100", waitMs: 10_000, wantLookahead: true });
    assert(l5.kind === "lookahead" || l5.kind === "lead", "lookahead: places nobody gave back are reclaimed by their lease");
  }

  // --- malformed input is refused by name, never crashes the object ---------------
  {
    const { h } = host();
    const bad = JSON.parse(await h.handle({ v, op: "claimFirst", turn: 3, candidates: "p0" })) as Record<string, unknown>;
    assert(bad.kind === "bad", `malformed: a message of the wrong shape is refused (got ${JSON.stringify(bad)})`);
    const junk = JSON.parse(await h.handle("not an object")) as Record<string, unknown>;
    assert(junk.kind === "bad", "malformed: something that is not a message is refused");
  }

  // --- #3354: a traced call says it arrived, so the load run can join it ----------
  // The client sends a trace only under the load test, so the object stays silent for
  // every production call. A call it reports names the op, the confirm's trace and the
  // client's stage; the time it spent is the runtime's own `wallTime` on that event.
  {
    const c = clockAndTimers();
    let n = 0;
    const calls: Record<string, unknown>[] = [];
    const h = makeConfirmLineHost({
      now: c.now,
      timer: c.timer,
      leaseTimer: c.timer,
      newId: () => `id${++n}`,
      onTrace: (call) => calls.push({ ...call }),
    });
    const send = async (req: Record<string, unknown>) => JSON.parse(await h.handle({ v, ...req })) as Record<string, unknown>;
    const lead = await send({ op: "enter", attempt: "A", line: "100", waitMs: 10_000, trace: "t-1", stage: "wait" });
    assert(lead.kind === "lead", "trace: a traced enter is answered exactly as an untraced one");
    await send({ op: "ack", turn: lead.turn, trace: "t-1", stage: "wait" });
    await send({ op: "done", turn: lead.turn, verdict: { full: false }, trace: "t-1", stage: "turn" });
    assert(
      JSON.stringify(calls) ===
        JSON.stringify([
          { op: "enter", trace: "t-1", stage: "wait" },
          { op: "ack", trace: "t-1", stage: "wait" },
          { op: "done", trace: "t-1", stage: "turn" },
        ]),
      `trace: each traced call is reported with its op, trace and stage (got ${JSON.stringify(calls)})`,
    );
    calls.length = 0;
    await send({ op: "enter", attempt: "B", line: "200", waitMs: 10_000 });
    assert(calls.length === 0, "trace: a call carrying no trace reports nothing, which is every production call");
    await send({ op: "enter", attempt: "C", line: "300", waitMs: 10_000, trace: 7, stage: "wait" });
    await send({ op: "enter", attempt: "D", line: "400", waitMs: 10_000, trace: "", stage: "wait" });
    assert(calls.length === 0, `trace: a trace that is not a non empty string reports nothing (got ${JSON.stringify(calls)})`);
    await send({ op: "enter", attempt: "E", line: "500", waitMs: 10_000, trace: "t-2", stage: "elsewhere" });
    assert(calls[0]?.stage === "unknown", `trace: a stage outside the two the client sends is reported as unknown, never as one of them (got ${JSON.stringify(calls)})`);
    calls.length = 0;
    const old = JSON.parse(await h.handle({ v: v + 1, op: "enter", attempt: "F", line: "600", waitMs: 0, trace: "t-3", stage: "wait" })) as Record<string, unknown>;
    assert(old.kind === "gone" && calls.length === 1 && calls[0]?.op === "enter", "trace: a call on another protocol version is still reported, so a load run can see it was refused");
  }

  // --- #3489: a claim that names its rung releases a waiter with what it was handed ---
  //
  // The object hosts the same line (`makeConfirmQueue`), so the release itself is the
  // queue suite's to prove; this proves the wire: the rung reaches the line, the lead
  // answer carries the start, `trying` and a claim's outcome reach the line, and an
  // older client's messages (no rung, no outcome) keep today's line exactly (L255).
  {
    const { send } = host();
    const lead = await send({ op: "enter", attempt: "A", line: "100", waitMs: 10_000 });
    await send({ op: "ack", turn: lead.turn });
    const w = await send({ op: "enter", attempt: "B", line: "100", waitMs: 10_000 });
    const polled = send({ op: "poll", ticket: w.ticket });
    await tick();
    const claimed = await send({ op: "claimFirst", turn: lead.turn, candidates: ["p0", "p1"], rung: 2 });
    assert(claimed.ok === true && JSON.stringify(claimed.pool) === JSON.stringify(["p0", "p1"]), `wire: a claim with a rung is answered as before (got ${JSON.stringify(claimed)})`);
    const released = await polled;
    assert(released.kind === "lead", `wire: the waiter is released (got ${JSON.stringify(released)})`);
    assert(
      JSON.stringify(released.start) === JSON.stringify({ rung: 2, advisor: "p1", read: ["p0", "p1"] }),
      `wire: the lead answer carries what the line handed it (got ${JSON.stringify(released.start)})`,
    );
    await send({ op: "ack", turn: released.turn });
    const tried = await send({ op: "trying", turn: released.turn, userId: "p1" });
    assert(tried.ok === true, "wire: trying is accepted");
    const next = await send({ op: "enter", attempt: "C", line: "100", waitMs: 10_000 });
    const nextPolled = send({ op: "poll", ticket: next.ticket });
    await tick();
    // It tried p1 and Google found it busy: the next waiter is handed nothing.
    await send({ op: "done", turn: released.turn, verdict: { full: false }, outcome: "advisor-busy" });
    const n = await nextPolled;
    assert(n.kind === "lead" && n.start === undefined, `wire: an outcome reaches the line; a busy advisor is not handed on (got ${JSON.stringify(n)})`);
    for (const t of [lead.turn, n.turn]) await send({ op: "done", turn: t, verdict: { full: false }, outcome: "booked" });
  }
  {
    const { send } = host();
    const lead = await send({ op: "enter", attempt: "A", line: "100", waitMs: 10_000 });
    await send({ op: "ack", turn: lead.turn });
    const w = await send({ op: "enter", attempt: "B", line: "100", waitMs: 10_000 });
    const polled = send({ op: "poll", ticket: w.ticket });
    await tick();
    await send({ op: "claimFirst", turn: lead.turn, candidates: ["p0", "p1"] });
    const r = await polled;
    assert(r.kind === "lead" && r.start === undefined, `wire: an older client's claim (no rung) hands the line on with nothing handed (got ${JSON.stringify(r)})`);
    const odd = await send({ op: "done", turn: r.turn, verdict: { full: false }, outcome: "something-new" });
    assert(odd.ok === true, "wire: an outcome this side does not know is accepted, as unknown");
    await send({ op: "done", turn: lead.turn, verdict: { full: false } });
    const bad = await send({ op: "claimFirst", turn: "nobody", candidates: ["p0"], rung: 1.5 });
    assert(bad.kind === "bad", `wire: a rung that is not a whole number is refused by name (got ${JSON.stringify(bad)})`);
  }

  // --- #3489 step 3: walking past a rung others hold, parking, and the settlement ----
  //
  // The rules are the queue suite's; this proves the wire carries each of them: `canWalk`
  // and `below` reach the line, its `spent` and `waiting` reach the client, a park takes
  // ONE place however often it is retried, and the settlement a booking reads as it ends
  // reaches every confirm the held verdict answers, the parked one included.
  {
    const { send } = host();
    const a = await send({ op: "enter", attempt: "A", line: "100", waitMs: 10_000 });
    await send({ op: "ack", turn: a.turn });
    const b = await send({ op: "enter", attempt: "B", line: "100", waitMs: 10_000 });
    const bTurn = send({ op: "poll", ticket: b.ticket });
    await tick();
    // The top rung's only advisor, with a rung below: the line hands on at once.
    const aClaim = await send({ op: "claimFirst", turn: a.turn, candidates: ["p0"], rung: 0, canWalk: true, below: true });
    assert(
      aClaim.ok === true && JSON.stringify(aClaim.pool) === JSON.stringify(["p0"]) && aClaim.waiting === 1,
      `step 3 wire: a walker's claim is answered with how many waited (got ${JSON.stringify(aClaim)})`,
    );
    const bLead = await bTurn;
    assert(bLead.kind === "lead", `step 3 wire: claiming a rung's last advisor with a rung below hands the line on (got ${JSON.stringify(bLead)})`);
    await send({ op: "ack", turn: bLead.turn });
    const bClaim = await send({ op: "claimFirst", turn: bLead.turn, candidates: ["p0"], rung: 0, canWalk: true, below: true });
    assert(
      bClaim.ok === true && bClaim.spent === true && JSON.stringify(bClaim.pool) === JSON.stringify([]),
      `step 3 wire: a rung every candidate of which is claimed is answered spent (got ${JSON.stringify(bClaim)})`,
    );
    const c = await send({ op: "enter", attempt: "C", line: "100", waitMs: 10_000 });
    const cTurn = send({ op: "poll", ticket: c.ticket });
    await tick();
    const parked = await send({ op: "park", turn: bLead.turn, attempt: "B-park", waitMs: 10_000 });
    assert(parked.kind === "wait" && typeof parked.ticket === "string", `step 3 wire: a park is answered with a ticket (got ${JSON.stringify(parked)})`);
    const again = await send({ op: "park", turn: bLead.turn, attempt: "B-park", waitMs: 10_000 });
    assert(JSON.stringify(again) === JSON.stringify(parked), `step 3 wire: a retried park gets the same ticket, never a second place (got ${JSON.stringify(again)})`);
    const bParked = send({ op: "poll", ticket: parked.ticket });
    await tick();
    const settlement = { booked: { idempotencyKey: "k-a", result: { booking: { id: "b-a" } } }, seated: [{ id: "b-a", assigned_user_id: "p0" }] };
    await send({ op: "done", turn: a.turn, verdict: { full: false }, outcome: "booked", settlement });
    for (const [who, answer] of [["the parked confirm", await bParked], ["the confirm waiting behind it", await cTurn]] as const) {
      assert(
        answer.kind === "refused" && answer.refusal === "race" && JSON.stringify(answer.settled) === JSON.stringify(settlement),
        `step 3 wire: the held verdict answers ${who} with the booking's own settlement (got ${JSON.stringify(answer)})`,
      );
    }
  }
  {
    // A booking that ends with NO settlement (null on the wire, as a failed read sends)
    // never answers the held verdict from nothing: one confirm is let read instead.
    const { send } = host();
    const a = await send({ op: "enter", attempt: "A", line: "100", waitMs: 10_000 });
    await send({ op: "ack", turn: a.turn });
    const b = await send({ op: "enter", attempt: "B", line: "100", waitMs: 10_000 });
    const bTurn = send({ op: "poll", ticket: b.ticket });
    await tick();
    await send({ op: "claimFirst", turn: a.turn, candidates: ["p0"], rung: 0, canWalk: true, below: true });
    const bLead = await bTurn;
    await send({ op: "ack", turn: bLead.turn });
    await send({ op: "claimFirst", turn: bLead.turn, candidates: ["p0"], rung: 0, canWalk: true, below: true });
    const parked = await send({ op: "park", turn: bLead.turn, attempt: "B-park", waitMs: 10_000 });
    const bParked = send({ op: "poll", ticket: parked.ticket });
    await tick();
    await send({ op: "done", turn: a.turn, verdict: { full: false }, outcome: "booked", settlement: null });
    const answer = await bParked;
    assert(answer.kind === "lead", `step 3 wire: with no settlement the parked confirm is let read for itself (got ${JSON.stringify(answer)})`);
    await send({ op: "done", turn: answer.turn, verdict: { full: false } });
    // An older client: no `canWalk`, so a rung others hold is shared as it always was,
    // never answered spent, and no count of the waiting is sent.
    const d = await send({ op: "enter", attempt: "D", line: "200", waitMs: 10_000 });
    await send({ op: "ack", turn: d.turn });
    const e = await send({ op: "enter", attempt: "E", line: "200", waitMs: 10_000 });
    const eTurn = send({ op: "poll", ticket: e.ticket });
    await tick();
    await send({ op: "claimFirst", turn: d.turn, candidates: ["p0", "p1"], rung: 0 });
    const eLead = await eTurn;
    await send({ op: "ack", turn: eLead.turn });
    const older = await send({ op: "claimFirst", turn: eLead.turn, candidates: ["p0"] });
    assert(
      older.ok === true && older.spent === undefined && older.waiting === undefined && JSON.stringify(older.pool) === JSON.stringify(["p0"]),
      `step 3 wire: an older client's claim on a rung others hold is shared, never spent (got ${JSON.stringify(older)})`,
    );
    for (const t of [d.turn, eLead.turn]) await send({ op: "done", turn: t, verdict: { full: false } });
    // A walker that parks once every claim it walked past has booked leads again at once,
    // and the lead answer says its walk stands (`spent`), so it reports the ladder full.
    const f = await send({ op: "enter", attempt: "F", line: "300", waitMs: 10_000 });
    await send({ op: "ack", turn: f.turn });
    const g = await send({ op: "enter", attempt: "G", line: "300", waitMs: 10_000 });
    const gTurn = send({ op: "poll", ticket: g.ticket });
    await tick();
    await send({ op: "claimFirst", turn: f.turn, candidates: ["p0"], rung: 0, canWalk: true, below: true });
    const gLead = await gTurn;
    await send({ op: "ack", turn: gLead.turn });
    await send({ op: "claimFirst", turn: gLead.turn, candidates: ["p0"], rung: 0, canWalk: true, below: true });
    await send({ op: "done", turn: f.turn, verdict: { full: false }, outcome: "booked", settlement: { booked: null, seated: [] } });
    const gParked = await send({ op: "park", turn: gLead.turn, attempt: "G-park", waitMs: 10_000 });
    const gAgain = await send({ op: "poll", ticket: gParked.ticket });
    assert(gAgain.kind === "lead" && gAgain.spent === true && typeof gAgain.turn === "string", `step 3 wire: a walker whose skipped claims all booked leads again marked spent (got ${JSON.stringify(gAgain)})`);
    await send({ op: "done", turn: gAgain.turn, verdict: { full: true, refusal: "taken" } });
    // A park on a turn the object does not hold is gone, and one missing its fields is bad.
    const gone = await send({ op: "park", turn: "nobody", attempt: "Z", waitMs: 1_000 });
    assert(gone.kind === "gone", `step 3 wire: parking a turn the object does not hold is gone (got ${JSON.stringify(gone)})`);
    const malformed = await send({ op: "park", turn: "nobody", waitMs: 1_000 });
    assert(malformed.kind === "bad", `step 3 wire: a park with no attempt is refused by name (got ${JSON.stringify(malformed)})`);
  }

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
