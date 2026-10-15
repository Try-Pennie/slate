// Waking a lead's confirm line while they read availability (#3775).
//
// A line object left idle for minutes took 766ms to answer its first call in load run
// 34, after 15 idle minutes, and that wait landed on the first lead to confirm. The
// availability read wakes the line the lead's confirm will join, in the background, so
// the object is back before the confirm arrives. The waker is what decides whether to
// send, and never throws: every way of not waking is a named outcome.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-confirm-line-wake.ts
import { makeLineWaker, CONFIRM_LINE_WAKE_EVERY_MS, CONFIRM_LINE_CALL_MS, type LineNamespace } from "../src/lib/booking/shared-confirm-line.ts";
import type { LineWakeTarget } from "../src/lib/booking/line-key.ts";
import { NoAnswerWithinError } from "../src/lib/read-within-deadline.ts";
import { codeLineGroup, ladderGroupOf, lineGroupToWake } from "../src/lib/booking/line-key.ts";
import { confirmQueueKey } from "../src/lib/booking/orchestration.ts";
import { assert, eq, finish } from "./lib/harness.ts";

type Message = Record<string, unknown>;

function world(
  opts: {
    on?: boolean;
    unbound?: boolean;
    answer?: (m: Message) => Promise<Message>;
    target?: (code: string) => Promise<LineWakeTarget>;
  } = {},
) {
  let now = 1_000_000;
  const pending: { at: number; fire: () => void; live: boolean }[] = [];
  const timer = (ms: number, fire: () => void) => {
    const t = { at: now + ms, fire, live: true };
    pending.push(t);
    return () => {
      t.live = false;
    };
  };
  const sent: { group: string; message: Message }[] = [];
  const resolved: string[] = [];
  const namespace: LineNamespace = {
    stubFor(group) {
      return {
        async send(message) {
          sent.push({ group, message });
          return opts.answer ? opts.answer(message) : { ok: true };
        },
      };
    },
  };
  const wake = makeLineWaker({
    namespace: () => (opts.unbound ? null : namespace),
    enabled: async () => ({ on: opts.on ?? true, source: "read" as const }),
    target: async (code) => {
      resolved.push(code);
      return opts.target ? opts.target(code) : { kind: "wake", group: `ladder:${code}` };
    },
    now: () => now,
    timer,
    everyMs: CONFIRM_LINE_WAKE_EVERY_MS,
    callMs: CONFIRM_LINE_CALL_MS,
  });
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      await new Promise((r) => setImmediate(r));
      const due = pending.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = Math.max(now, due.at);
      due.live = false;
      due.fire();
    }
    now = until;
  };
  return { wake, sent, resolved, advance };
}

async function main() {
  {
    const w = world();
    eq((await w.wake("220")).outcome, "woke", "wake: a line nobody woke recently is woken");
    eq(w.sent.length, 1, "wake: by one call");
    eq(w.sent[0]?.group, "ladder:220", "wake: to the object named by the line the code's confirm joins");
    eq(w.sent[0]?.message.op, "wake", "wake: with the wake op");
    eq(typeof w.sent[0]?.message.v, "number", "wake: in the line's protocol version");
    eq((await w.wake("220")).outcome, "recent", "wake: a second wake inside the window sends nothing");
    eq(w.sent.length, 1, "wake: still one call, so a burst of availability reads costs one wake per server");
    eq(w.resolved.length, 1, "wake: and the line is not even worked out again inside the window");
    eq((await w.wake("411")).outcome, "woke", "wake: another code is its own");
    await w.advance(CONFIRM_LINE_WAKE_EVERY_MS);
    eq((await w.wake("220")).outcome, "woke", "wake: once the window has passed, the line is woken again");
  }
  {
    // Review of #3775: availability reads arriving together must send one wake, so the
    // window is claimed before anything is awaited.
    const w = world();
    const both = await Promise.all([w.wake("220"), w.wake("220")]);
    eq(w.sent.length, 1, "wake: two reads at the same moment send one wake");
    eq(both.map((b) => b.outcome).sort(), ["recent", "woke"], "wake: one woke and the other was recent");
  }
  {
    // Review of #3775: with the line off, nothing about the line is worked out, so a
    // production availability read pays no grouping work while the switch is off.
    const w = world({ on: false });
    eq((await w.wake("220")).outcome, "off", "wake: with the shared line off, nothing is woken");
    eq(w.sent.length, 0, "wake: not one call while the line is off");
    eq(w.resolved.length, 0, "wake: and the line it would reach is never worked out");
  }
  {
    const w = world({ unbound: true });
    eq((await w.wake("220")).outcome, "unbound", "wake: no binding is said as unbound");
    eq(w.resolved.length, 0, "wake: with no line worked out");
  }
  {
    const w = world({
      target: async () => ({ kind: "unreadable", err: new Error("grouping unreadable") }),
    });
    const r = await w.wake("220");
    eq(r.outcome, "unreadable", "wake: a grouping that cannot be read is said as unreadable");
    assert(String(r.err).includes("grouping unreadable"), "wake: carrying the read's own error for the log");
    eq(w.sent.length, 0, "wake: and nothing is sent");
    eq((await w.wake("220")).outcome, "recent", "wake: and it is not tried again inside the window, so the warning is once a minute at most");
  }
  {
    const w = world({ target: async () => ({ kind: "unknown" }) });
    eq((await w.wake("220")).outcome, "unknown", "wake: a grouping that does not settle the line is said as unknown");
    eq(w.sent.length, 0, "wake: and nothing is sent");
  }
  {
    // An object running a build from before #3775 answers the line's own refusal.
    const w = world({ answer: async () => ({ kind: "bad", why: "unknown op" }) });
    eq((await w.wake("220")).outcome, "refused", "wake: an older object's refusal is said as refused, never as woken");
  }
  {
    const w = world({
      answer: async () => {
        throw new Error("the object is gone");
      },
    });
    const r = await w.wake("220");
    eq(r.outcome, "failed", "wake: a call that throws is said as failed, and the waker does not throw");
    assert(String(r.err).includes("the object is gone"), `wake: carrying the call's own error, so the log can tell it from a timeout (got ${String(r.err)})`);
  }
  {
    const w = world({ answer: () => new Promise<Message>(() => {}) });
    let out: { outcome: string; err?: unknown } | null = null;
    void w.wake("220").then((o) => (out = o));
    await w.advance(CONFIRM_LINE_CALL_MS - 1);
    eq(out, null, "wake: a slow object is waited on up to the call bound");
    await w.advance(1);
    const got = out as { outcome: string; err?: unknown } | null;
    eq(got?.outcome, "failed", "wake: and past it the wake is given up as failed, so nothing waits on it for ever");
    assert(got?.err instanceof NoAnswerWithinError, `wake: said as a timeout, not as a thrown call (got ${String(got?.err)})`);
  }

  // The line a wake reaches must be the line the confirm joins, so both take the group
  // from one function.
  {
    const ladderOf = (code: string) => (code === "220" ? "ladder:xyz" : null);
    for (const code of ["220", "411"]) {
      eq(
        codeLineGroup(code, ladderOf),
        confirmQueueKey(code, "2026-10-16T16:40:00.000Z", undefined, ladderOf).group,
        `group: a wake for code ${code} reaches the line its confirm joins`,
      );
    }
    eq(codeLineGroup("411"), "code:411", "group: with no ladder known, the code's own line");
  }

  // Which line to wake, from the grouping this server holds. A fresh server holds none,
  // and a fresh server is exactly where the slow first call lands, so it reads the
  // grouping first (in the background, as the confirm path already does) rather than
  // waking nothing or the wrong line.
  {
    let held = false;
    let warms = 0;
    const heldPeek = (code: string) => (code === "220" ? "pool-a" : null);
    const peek = (code: string) => (held ? heldPeek(code) : undefined);
    // The ladder group the confirm keys on, computed by the module's own rule.
    const ladder = ladderGroupOf("220", heldPeek);
    assert(ladder !== null && ladder.startsWith("ladder:"), `target fixture: code 220 has a ladder group (got ${ladder})`);
    const warm = async () => {
      warms++;
      held = true;
    };
    eq(await lineGroupToWake("220", peek, warm), { kind: "wake", group: ladder }, "target: a server holding no grouping reads it, then wakes the ladder line");
    eq(warms, 1, "target: by one read");
    eq(await lineGroupToWake("220", peek, warm), { kind: "wake", group: ladder }, "target: a server holding it wakes the ladder line straight away");
    eq(warms, 1, "target: with no second read");
    eq(await lineGroupToWake("411", peek, warm), { kind: "wake", group: "code:411" }, "target: a code the grouping does not list wakes its own line, the one its confirm joins");
  }
  {
    const peek = () => undefined;
    // Lessons check of #3775 (L11): a grouping that could not be READ and one read and
    // still not held both wake nothing, and are said as different things.
    const unreadable = await lineGroupToWake("220", peek, async () => {
      throw new Error("grouping unreadable");
    });
    eq(unreadable.kind, "unreadable", "target: a grouping that cannot be read wakes nothing, said as unreadable");
    assert(unreadable.kind === "unreadable" && String(unreadable.err).includes("grouping unreadable"), "target: carrying the read's own error for the log");
    eq(await lineGroupToWake("220", peek, async () => {}), { kind: "unknown" }, "target: one read and still not held wakes nothing, said as unknown");
  }
  finish();
}

void main();
