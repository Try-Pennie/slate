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
  durableLineNamespace,
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
  /** What the transport does to the next messages, by op, and how many times (once unless set). */
  const faults = new Map<string, "throw" | "late" | "hang" | "bad" | "gone">();
  const faultTimes = new Map<string, number>();
  const sent: string[] = [];
  /** Every message as sent, for what a call carries beside its op (#3354). */
  const messages: Record<string, unknown>[] = [];
  const namespace: LineNamespace = {
    stubFor: () => ({
      async send(message) {
        const op = String(message.op);
        sent.push(op);
        messages.push({ ...message });
        const fault = faults.get(op);
        if (fault) {
          const left = (faultTimes.get(op) ?? 1) - 1;
          if (left > 0) faultTimes.set(op, left);
          else {
            faults.delete(op);
            faultTimes.delete(op);
          }
        }
        if (fault === "throw") throw new Error("the object refused");
        if (fault === "hang") return new Promise(() => {});
        // An answer the client has no meaning for (a version skew, a protocol fault).
        if (fault === "bad") return { kind: "bad", why: "injected" };
        // What a replaced instance answers.
        if (fault === "gone") return { kind: "gone" };
        const answer = JSON.parse(await host.handle(message)) as Record<string, unknown>;
        // The object acted, but the answer reaches the caller after its deadline.
        if (fault === "late") return new Promise((r) => timer(CONFIRM_LINE_REACH_MS * 2, () => r(answer)));
        return answer;
      },
    }),
  };
  const client = (opts: { on?: SwitchReading; bound?: boolean; trace?: string | null } = {}) => {
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
      trace: opts.trace ?? null,
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
  return { now: () => now, advance, settle, client, faults, faultTimes, sent, messages, deploy: () => (host = makeHost()) };
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

  // --- #3354: a traced confirm stamps every call, by the stage it was sent in -------
  // The load run joins the object's side of a confirm to the confirm's own line by this
  // trace, and splits the wait from the turn by the stage. Everything sent before the
  // turn is handed back is `wait` (the lookahead, the enter, every poll, the ack);
  // everything after is `turn` (the claims, the report, the heartbeat).
  {
    const w = world();
    const a = w.client({ trace: "tA" });
    const b = w.client({ trace: "tB" });
    const plain = w.client();
    const of = (trace: string) => w.messages.filter((m) => m.trace === trace).map((m) => `${String(m.op)}:${String(m.stage)}`);
    await w.settle(a.line.lookahead(KEY, 10_000));
    const lead = (await w.settle(a.line.enter(KEY, 10_000))) as LineTurn<string>;
    if (lead.kind !== "lead") throw new Error("trace: A did not lead");
    const follower = b.line.enter(KEY, 10_000);
    await w.advance(CONFIRM_LINE_HEARTBEAT_MS + 10);
    await w.settle(lead.seat.claimFirst(["p0"]));
    await w.settle(lead.done({ full: true, refusal: "race", settled: "A booked p0" }));
    await w.settle(follower);
    const aCalls = of("tA");
    assert(
      aCalls.slice(0, 2).join(",") === "enter:wait,ack:wait" && aCalls.includes("renew:turn") && aCalls.includes("claimFirst:turn") && aCalls[aCalls.length - 1] === "done:turn",
      `trace: the leader's lookahead and ack are sent waiting, its heartbeat, claims and report during its turn (got ${JSON.stringify(aCalls)})`,
    );
    const bCalls = of("tB");
    assert(bCalls[0] === "enter:wait" && bCalls.slice(1).every((c) => c === "poll:wait") && bCalls.length >= 2, `trace: a follower's enter and polls are all sent waiting (got ${JSON.stringify(bCalls)})`);
    assert(aCalls.length + bCalls.length === w.messages.length, "trace: every call either confirm sent carries its own trace");
    const before = w.messages.length;
    const own = (await w.settle(plain.line.enter({ ...KEY, instant: "9" }, 10_000))) as LineTurn<string>;
    if (own.kind === "lead") await w.settle(own.done({ full: false }));
    const untraced = w.messages.slice(before);
    assert(
      untraced.length > 0 && untraced.every((m) => !("trace" in m) && !("stage" in m)),
      `trace: a confirm with no trace sends neither field, which is every production confirm (got ${JSON.stringify(untraced)})`,
    );
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

  // --- #3351: an answer with no meaning is a protocol fault, never a deploy ---------
  // `gone` is the one reason that never pages, because it means a deploy. An answer the
  // client cannot read (a `bad`, an unknown kind, a version skew) is a fault somebody
  // must hear about, so it carries its own reason, which pages, and the follower gives
  // its place back rather than leaving a ticket for the sweep.
  {
    const w = world();
    const a = w.client();
    const b = w.client();
    const lead = (await w.settle(a.line.enter(KEY, 10_000))) as LineTurn<string>;
    if (lead.kind !== "lead") throw new Error("bad poll: A did not lead");
    w.faults.set("poll", "bad");
    const t = (await w.settle(b.line.enter(KEY, 10_000))) as LineTurn<string>;
    assert(t.kind === "lead", "bad poll: the follower carries on on its isolate's line");
    assert(lastServed(b.served)?.line === "fallback" && lastServed(b.served)?.reason === "bad-answer", `bad poll: recorded as a bad answer, not gone (got ${JSON.stringify(lastServed(b.served))})`);
    assert(b.reach.includes("bad-answer") && !b.reach.includes("gone"), `bad poll: reported as a bad answer (got ${JSON.stringify(b.reach)})`);
    assert(w.sent.includes("abandon"), `bad poll: the follower gives its place back (sent ${JSON.stringify(w.sent)})`);
    await w.settle(lead.done({ full: false }));
  }
  {
    const w = world();
    const c = w.client();
    w.faults.set("enter", "bad");
    await w.settle(c.line.enter(KEY, 10_000));
    assert(lastServed(c.served)?.reason === "bad-answer", `bad enter: an enter answered with no meaning is a bad answer too (got ${JSON.stringify(lastServed(c.served))})`);
    // A deploy that keeps answering `gone` past every re-entry is still a deploy: it is
    // counted as gone, the same on an enter as on a poll, and never pages.
    const d = w.client();
    w.faults.set("enter", "gone");
    w.faultTimes.set("enter", 10);
    await w.settle(d.line.enter(KEY, 10_000));
    assert(lastServed(d.served)?.line === "fallback" && lastServed(d.served)?.reason === "gone", `gone enter: retries spent on gone fall back as gone (got ${JSON.stringify(lastServed(d.served))})`);
  }

  // --- #3351: a follower that gives up after failed polls gives its place back -------
  // Its ticket may be promoted to lead on the object meanwhile. Without an abandon the
  // line holds that lead, which nobody will collect, for the ack window.
  {
    const w = world();
    const a = w.client();
    const b = w.client();
    const c = w.client();
    const lead = (await w.settle(a.line.enter(KEY, 10_000))) as LineTurn<string>;
    if (lead.kind !== "lead") throw new Error("failed polls: A did not lead");
    w.faults.set("poll", "throw");
    w.faultTimes.set("poll", 2);
    const bt = (await w.settle(b.line.enter(KEY, 10_000))) as LineTurn<string>;
    assert(lastServed(b.served)?.line === "fallback", `failed polls: the follower falls back (got ${JSON.stringify(lastServed(b.served))})`);
    assert(w.sent.includes("abandon"), `failed polls: and abandons its attempt (sent ${JSON.stringify(w.sent)})`);
    if (bt.kind === "lead") await w.settle(bt.done({ full: false }));
    const behind = c.line.enter(KEY, 10_000);
    await w.advance(100);
    await w.settle(lead.done({ full: false }));
    const started = w.now();
    const ct = (await w.settle(behind)) as LineTurn<string>;
    assert(ct.kind === "lead", `failed polls: the next confirm leads (got ${ct.kind})`);
    assert(w.now() - started < CONFIRM_LINE_ACK_MS, `failed polls: without waiting out a lead nobody collects (waited ${w.now() - started}ms)`);
    if (ct.kind === "lead") await w.settle(ct.done({ full: false }));
  }

  // --- #3351: a lookahead's answer nobody collected is given back when asked ---------
  // The lead or ticket a lookahead keeps for the enter that follows is orphaned when
  // the confirm ends before that enter. `release` abandons it; after an enter that
  // collected it, there is nothing to release and nothing is sent.
  {
    const w = world();
    const a = w.client();
    const b = w.client();
    assert((await w.settle(a.line.lookahead(KEY, 10_000))) === null, "release: an idle line's lookahead keeps its lead for the enter");
    await w.settle(a.line.release());
    assert(w.sent.includes("abandon"), `release: the uncollected lead is abandoned (sent ${JSON.stringify(w.sent)})`);
    const started = w.now();
    const t = (await w.settle(b.line.enter(KEY, 10_000))) as LineTurn<string>;
    assert(t.kind === "lead" && w.now() - started < CONFIRM_LINE_ACK_MS, `release: the next confirm leads at once (waited ${w.now() - started}ms)`);
    if (t.kind === "lead") await w.settle(t.done({ full: false }));
    const c = w.client();
    const other = { ...KEY, instant: "42" };
    await w.settle(c.line.lookahead(other, 10_000));
    const ct = (await w.settle(c.line.enter(other, 10_000))) as LineTurn<string>;
    const before = w.sent.length;
    await w.settle(c.line.release());
    assert(w.sent.length === before, "release: after an enter collected the lookahead's answer, nothing is sent");
    if (ct.kind === "lead") await w.settle(ct.done({ full: false }));
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

  // --- the real binding: one object per GROUP, near the database, JSON both ways ----
  {
    const asked: { name?: string; hint?: string; url?: string; body?: string }[] = [];
    const ns = {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }, opts?: { locationHint?: string }) => ({
        fetch: async (url: string, init: { method?: string; body?: string }) => {
          asked.push({ name: id.name, hint: opts?.locationHint, url, body: init.body });
          return new Response(JSON.stringify({ kind: "lead", turn: "t1" }), { headers: { "content-type": "application/json" } });
        },
      }),
    };
    const stub = durableLineNamespace(ns).stubFor("ladder:abc");
    const answer = await stub.send({ v: 1, op: "enter", attempt: "a", line: "100", waitMs: 1 });
    assert(answer.kind === "lead" && answer.turn === "t1", "binding: the object's JSON answer comes back parsed");
    assert(asked[0]?.name === "confirm-line:v1:ladder:abc", `binding: one object per group, named from the group (got ${asked[0]?.name})`);
    assert(asked[0]?.hint === "wnam", "binding: placed near the database, which smart placement puts the Worker beside");
    assert(JSON.parse(asked[0]?.body ?? "{}").op === "enter", "binding: the message is sent as the JSON body");
    const bad = durableLineNamespace({ ...ns, get: () => ({ fetch: async () => new Response("<html>", { status: 500 }) }) }).stubFor("code:1");
    let threw = false;
    try {
      await bad.send({ v: 1, op: "poll", ticket: "x" });
    } catch {
      threw = true;
    }
    assert(threw, "binding: an answer that is not the protocol's JSON is a failed call, never a guessed one");
  }

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
