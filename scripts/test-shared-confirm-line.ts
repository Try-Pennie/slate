// The confirm path's client for the shared line (#3325), driven against the REAL
// object host (`makeConfirmLineHost`) through an in process transport that can
// lose, delay or refuse any message, or swap the host for a fresh one (a deploy).
//
// What matters is what each failure leaves behind: which line served the confirm
// (shared, its own isolate's, or a fallback, with the reason), whether the shared
// line is left holding a phantom, and how long a follower behind it waits. The rules
// of the line are tested in test-confirm-queue.ts and the object's protocol in
// test-confirm-line-object.ts; this is the glue between the two.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-shared-confirm-line.ts
import {
  makeSharedConfirmLine,
  keyKindOf,
  CONFIRM_LINE_REACH_MS,
  type LineServed,
  type LineNamespace,
  type SwitchReading,
} from "../src/lib/booking/shared-confirm-line.ts";
import { makeConfirmLineHost, CONFIRM_LINE_POLL_MS, CONFIRM_LINE_HEARTBEAT_MS, CONFIRM_LINE_ACK_MS } from "../src/lib/booking/confirm-line-object.ts";
import { makeConfirmQueue, isolateLine, type LineTurn } from "../src/lib/booking/confirm-queue.ts";
import { createAsserter } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();
const tick = () => new Promise((r) => setImmediate(r));

function world() {
  let now = 10_000;
  const pending: { at: number; fire: () => void; live: boolean }[] = [];
  const timer = (ms: number, fire: () => void) => {
    const t = { at: now + ms, fire, live: true };
    pending.push(t);
    return () => {
      t.live = false;
    };
  };
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      await tick();
      const due = pending.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = Math.max(now, due.at);
      due.live = false;
      due.fire();
    }
    now = until;
    await tick();
  };
  let ids = 0;
  const newId = () => `x${++ids}`;
  const makeHost = () => makeConfirmLineHost({ now: () => now, timer, leaseTimer: timer, newId });
  let host = makeHost();
  /** What the transport does to the next messages, by op. */
  const faults = new Map<string, "throw" | "late" | "hang">();
  const sent: string[] = [];
  const namespace: LineNamespace = {
    stubFor: () => ({
      async send(message) {
        const op = String(message.op);
        sent.push(op);
        const fault = faults.get(op);
        if (fault) faults.delete(op);
        if (fault === "throw") throw new Error("the object refused");
        if (fault === "hang") return new Promise(() => {});
        const answer = JSON.parse(await host.handle(message)) as Record<string, unknown>;
        // The object acted, but the answer reaches the caller after its deadline.
        if (fault === "late") return new Promise((r) => timer(CONFIRM_LINE_REACH_MS * 2, () => r(answer)));
        return answer;
      },
    }),
  };
  const client = (opts: { on?: SwitchReading; bound?: boolean } = {}) => {
    const served: LineServed[] = [];
    const reach: string[] = [];
    const fallback = isolateLine(makeConfirmQueue<string>({ timer, now: () => now }));
    const line = makeSharedConfirmLine<string>({
      namespace: opts.bound === false ? null : namespace,
      fallback,
      enabled: async () => opts.on ?? { on: true, source: "read" },
      record: (s) => served.push({ ...s }),
      onReachFailure: (reason) => reach.push(reason),
      now: () => now,
      timer,
      newId,
    });
    return { line, served, reach };
  };
  /** Runs `work` while moving the clock, until it settles or `limitMs` passes. */
  const settle = async <R>(work: Promise<R>, limitMs = 30_000, step = 100): Promise<R | "unsettled"> => {
    let out: R | "unsettled" = "unsettled";
    let done = false;
    void work.then((r) => {
      out = r;
      done = true;
    });
    for (let spent = 0; !done && spent < limitMs; spent += step) await advance(step);
    await tick();
    return out;
  };
  return { now: () => now, advance, settle, client, faults, sent, deploy: () => (host = makeHost()) };
}

const KEY = { group: "code:521", instant: "1791230400000" };
const lastServed = (s: LineServed[]) => s[s.length - 1];

async function main() {
  assert(keyKindOf("ladder:abc") === "ladder" && keyKindOf("code:521") === "code" && keyKindOf("link:u1") === "link", "key kind: read from the group's prefix");
  assert(keyKindOf("whatever") === "none", "key kind: anything else is none");

  // --- switched off: today's per isolate line, and it says why -------------------
  {
    const w = world();
    const off = w.client({ on: { on: false, source: "read" } });
    const t = await off.line.enter(KEY, 10_000);
    assert(t.kind === "lead", "off: the confirm still leads, on its own isolate's line");
    assert(lastServed(off.served)?.line === "isolate" && lastServed(off.served)?.reason === "off", `off: recorded as isolate, off (got ${JSON.stringify(lastServed(off.served))})`);
    assert(w.sent.length === 0, "off: nothing is sent to the shared object");
    const unread = w.client({ on: { on: false, source: "default" } });
    await unread.line.enter({ ...KEY, instant: "2" }, 10_000);
    assert(lastServed(unread.served)?.reason === "unread-default", "off: a switch it could not read is told apart from one that is off");
  }

  // --- switched on but not bound: the isolate's line, and a reach failure ----------
  {
    const w = world();
    const c = w.client({ bound: false });
    const t = await c.line.enter(KEY, 10_000);
    assert(t.kind === "lead", "unbound: the confirm still leads, on its isolate's line");
    assert(lastServed(c.served)?.line === "fallback" && lastServed(c.served)?.reason === "unbound", `unbound: recorded as a fallback for an unbound line (got ${JSON.stringify(lastServed(c.served))})`);
    assert(c.reach.includes("unbound"), "unbound: reported, since a switch that is on cannot be honoured");
  }

  // --- an idle line: lead, acknowledge at once, renew while working, report -------
  {
    const w = world();
    const c = w.client();
    const t = (await w.settle(c.line.enter(KEY, 10_000))) as LineTurn<string>;
    assert(t.kind === "lead", "idle: the confirm leads on the shared line");
    assert(lastServed(c.served)?.line === "shared" && lastServed(c.served)?.reason === "ok" && lastServed(c.served)?.key === "code", `idle: recorded as shared, ok, code (got ${JSON.stringify(lastServed(c.served))})`);
    assert(w.sent.filter((o) => o === "ack").length === 1, "idle: the lead is acknowledged once, at once");
    await w.advance(CONFIRM_LINE_HEARTBEAT_MS * 3 + 10);
    assert(w.sent.filter((o) => o === "renew").length >= 3, `idle: the lead renews on a heartbeat while it works (sent ${JSON.stringify(w.sent)})`);
    if (t.kind === "lead") {
      const picked = await w.settle(t.seat.claimFirst(["p0", "p1"]));
      assert(JSON.stringify(picked) === JSON.stringify({ pool: ["p0", "p1"], unclaimed: 2 }), "idle: a claim is answered by the shared line");
      await w.settle(t.done({ full: false }));
    }
    const before = w.sent.length;
    await w.advance(CONFIRM_LINE_HEARTBEAT_MS * 3);
    assert(w.sent.length === before, "idle: heartbeats stop once the turn has reported");
    assert(typeof lastServed(c.served)?.lineMs === "number", "idle: the time spent in line calls is recorded");
  }

  // --- two isolates, one line: the follower is refused from the leader's verdict ---
  {
    const w = world();
    const a = w.client();
    const b = w.client();
    const lead = (await w.settle(a.line.enter(KEY, 10_000))) as LineTurn<string>;
    if (lead.kind !== "lead") throw new Error("two isolates: A did not lead");
    await w.settle(lead.seat.claimFirst(["p0"]));
    const follower = b.line.enter(KEY, 10_000);
    await w.advance(200);
    await w.settle(lead.done({ full: true, refusal: "race", settled: "A booked p0" }));
    const r = (await w.settle(follower)) as LineTurn<string>;
    assert(r.kind === "refused" && r.settled === "A booked p0", `two isolates: B, on another isolate, is refused from A's verdict (got ${JSON.stringify(r)})`);
    assert(lastServed(b.served)?.line === "shared", "two isolates: B was served by the shared line");
  }

  // --- an enter answered after its caller gave up leaves no phantom behind ----------
  {
    const w = world();
    const late = w.client();
    const behind = w.client();
    w.faults.set("enter", "late");
    const t = (await w.settle(late.line.enter(KEY, 10_000))) as LineTurn<string>;
    assert(t.kind === "lead", "late enter: the confirm leads on its isolate's line instead");
    assert(lastServed(late.served)?.line === "fallback" && lastServed(late.served)?.reason === "reach-timeout", `late enter: recorded as a reach timeout (got ${JSON.stringify(lastServed(late.served))})`);
    assert(late.reach.includes("reach-timeout"), "late enter: reported");
    assert(w.sent.includes("abandon"), "late enter: the attempt the object answered too late is abandoned");
    const started = w.now();
    const next = (await w.settle(behind.line.enter(KEY, 10_000))) as LineTurn<string>;
    assert(next.kind === "lead", "late enter: the next confirm leads the shared line");
    assert(w.now() - started < CONFIRM_LINE_ACK_MS + CONFIRM_LINE_POLL_MS, `late enter: and does not wait out a phantom lead (waited ${w.now() - started}ms)`);
  }

  // --- a deploy mid wait: the follower re-enters the new instance ------------------
  {
    const w = world();
    const a = w.client();
    const b = w.client();
    const lead = (await w.settle(a.line.enter(KEY, 10_000))) as LineTurn<string>;
    if (lead.kind !== "lead") throw new Error("deploy: A did not lead");
    await w.settle(lead.seat.claimFirst(["p0"]));
    const follower = b.line.enter(KEY, 10_000);
    await w.advance(300);
    w.deploy(); // the old instance's lines are gone; the next poll meets a stranger
    const r = (await w.settle(follower)) as LineTurn<string>;
    assert(r.kind === "lead", `deploy: the follower leads on the new instance rather than waiting out its bound (got ${r.kind})`);
    assert(lastServed(b.served)?.line === "shared" && lastServed(b.served)?.reason === "gone", `deploy: recorded as shared after re-entering (got ${JSON.stringify(lastServed(b.served))})`);
    if (lead.kind === "lead") await w.settle(lead.done({ full: false })); // the old leader's report lands on the new instance
  }

  // --- lookahead: an idle line costs one enter, a busy one hands out a place --------
  {
    const w = world();
    const a = w.client();
    const look = await w.settle(a.line.lookahead(KEY, 10_000));
    assert(look === null, "lookahead: an idle line offers no lookahead");
    const t = (await w.settle(a.line.enter(KEY, 10_000))) as LineTurn<string>;
    assert(t.kind === "lead", "lookahead: the confirm then leads");
    assert(w.sent.filter((o) => o === "enter").length === 1, `lookahead: the lead found while looking is used, not a second enter (sent ${JSON.stringify(w.sent)})`);
    const b = w.client();
    const place = (await w.settle(b.line.lookahead(KEY, 10_000))) as (() => Promise<void>) | null;
    assert(typeof place === "function", "lookahead: a busy line hands out a place");
    if (place) await w.settle(place());
    assert(w.sent.includes("giveBack"), "lookahead: the place is given back");
    if (t.kind === "lead") await w.settle(t.done({ full: false }));
  }

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
