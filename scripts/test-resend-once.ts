// A request whose connection dropped is sent once more, and only once (#3566).
//
// The booker's confirm and the load driver share this rule, so a lead and the load
// run meet the same thing: a press that never got any reply goes again after a short
// pause, and a second drop is the answer. Nothing else is resent: an answer of any
// status, and a request cut off by the caller's own timeout, come back as they are.
//
// No wall clock: the pause is handed in, and the test records what it was asked for.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-resend-once.ts
import { resendOnce, RESEND_PAUSE_MS } from "../src/lib/resend-once.ts";
import { assert, finish } from "./lib/harness.ts";

type Reply = { status: number; tag: string };
const dropped = (r: Reply) => r.status === 0;

function sender(replies: Reply[]) {
  const sent: string[] = [];
  const pauses: number[] = [];
  let i = 0;
  return {
    sent,
    pauses,
    send: async () => {
      const r = replies[Math.min(i, replies.length - 1)]!;
      i += 1;
      sent.push(r.tag);
      return r;
    },
    pause: async (ms: number) => {
      pauses.push(ms);
    },
  };
}

// An answer on the first send is the answer: nothing is resent, nothing paused.
{
  const s = sender([{ status: 200, tag: "first" }]);
  const r = await resendOnce(s.send, dropped, s.pause);
  assert(s.sent.length === 1, `an answered request is sent once (sent ${s.sent.length})`);
  assert(s.pauses.length === 0, "and nothing pauses");
  assert(r.result.tag === "first" && r.firstFailure === null, "and the answer comes back with no failure beside it");
}

// Any status is an answer, a refusal included: a 409 or a 500 is never resent.
{
  for (const status of [409, 429, 500, 503]) {
    const s = sender([{ status, tag: "refused" }, { status: 200, tag: "second" }]);
    const r = await resendOnce(s.send, dropped, s.pause);
    assert(s.sent.length === 1 && r.result.status === status, `a ${status} is an answer, so it is not resent`);
  }
}

// A dropped connection is sent again once, after the pause, and the second answer stands.
{
  const s = sender([{ status: 0, tag: "dropped" }, { status: 200, tag: "second" }]);
  const r = await resendOnce(s.send, dropped, s.pause);
  assert(s.sent.join(",") === "dropped,second", `a dropped request is sent again (sent ${s.sent.join(",")})`);
  assert(s.pauses.length === 1 && s.pauses[0] === RESEND_PAUSE_MS, `after one pause of ${RESEND_PAUSE_MS}ms (got ${s.pauses.join(",")})`);
  assert(r.result.tag === "second", "and the resend's answer is the result");
  assert(r.firstFailure?.tag === "dropped", "with the first failure kept beside it, so a caller can report it");
}

// Two drops in a row is the end: never a third send.
{
  const s = sender([{ status: 0, tag: "one" }, { status: 0, tag: "two" }, { status: 200, tag: "three" }]);
  const r = await resendOnce(s.send, dropped, s.pause);
  assert(s.sent.length === 2, `a request that drops twice is sent exactly twice (sent ${s.sent.length})`);
  assert(r.result.tag === "two" && r.result.status === 0, "and the second drop is the answer");
  assert(r.firstFailure?.tag === "one", "with the first drop kept beside it");
}

// The pause is short enough that a lead does not notice it, and long enough to be one.
assert(RESEND_PAUSE_MS > 0 && RESEND_PAUSE_MS <= 1000, `the pause is a moment, not a wait (${RESEND_PAUSE_MS}ms)`);

finish();
