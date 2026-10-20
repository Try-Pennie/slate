// The buffer breach guard (#3040): two active calls on one advisor sitting closer
// than the call type's buffers.
//
// Production held 57 such pairs, all booked while the Senior Loan Advisor Call's
// buffers were still 0 and 0, and nothing said so for eighteen days. No booking path
// bypasses the buffers today, but a forced reassign stacks calls on purpose and an
// event type's buffer can be raised under bookings that already exist, so the monitor
// lane measures the result directly. This suite pins the judge (which pairs count,
// and which of them page) and the runner (what it sends, and that a failed read
// clears nothing).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-buffer-breach.ts
import {
  BUFFER_BREACH_KEY,
  bufferBreachRepeat,
  bookingsForBufferCheck,
  formatBufferBreachAlert,
  formatBufferBreachRecovery,
  judgeBufferBreaches,
  runBufferBreachCheck,
  type BufferedBooking,
} from "../src/lib/monitor/buffer-breach.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-10-23T16:00:00.000Z");

/** A 20 minute call starting `atMin` minutes after T0, with the live 10 and 10 buffers. */
function call(id: string, advisorId: string, atMin: number, over: Partial<BufferedBooking> = {}): BufferedBooking {
  return {
    id,
    advisorId,
    advisorName: `Advisor ${advisorId}`,
    startsMs: T0 + atMin * MIN,
    endsMs: T0 + (atMin + 20) * MIN,
    bufferBeforeMin: 10,
    bufferAfterMin: 10,
    inTestBucket: false,
    allowDoubleBook: false,
    ...over,
  };
}

const ids = (pairs: { earlier: BufferedBooking; later: BufferedBooking }[]) =>
  pairs.map((p) => `${p.earlier.id}>${p.later.id}`);

// --- the judge -----------------------------------------------------------------

// Back to back with 10 minute buffers is a breach; the gap and what was needed ride
// on the pair so the page can say both.
{
  const j = judgeBufferBreaches([call("a", "u1", 0), call("b", "u1", 20)]);
  eq(ids(j.breaches), ["a>b"], "a call starting as the previous one ends breaches a 10 minute buffer");
  eq(j.breaches[0]?.gapMin, 0, "the gap is zero minutes");
  eq(j.breaches[0]?.requiredMin, 10, "and ten were needed");
  eq(j.forced.length, 0, "nothing was forced");
  eq(j.examined, 2, "both bookings were examined");
}

// The exact boundary: a gap EQUAL to the buffer is what the slot rule allows, so it
// must never page; one minute less is a breach.
{
  eq(judgeBufferBreaches([call("a", "u1", 0), call("b", "u1", 30)]).breaches.length, 0, "a gap equal to the buffer is fine");
  eq(ids(judgeBufferBreaches([call("a", "u1", 0), call("b", "u1", 29)]).breaches), ["a>b"], "a gap one minute short breaches");
}

// An outright overlap counts, even with no buffers at all, and its gap is negative.
{
  const j = judgeBufferBreaches([
    call("a", "u1", 0, { bufferBeforeMin: 0, bufferAfterMin: 0 }),
    call("b", "u1", 10, { bufferBeforeMin: 0, bufferAfterMin: 0 }),
  ]);
  eq(ids(j.breaches), ["a>b"], "two calls overlapping by ten minutes breach even with zero buffers");
  eq(j.breaches[0]?.gapMin, -10, "the gap of an overlap is negative");
}

// With zero buffers, back to back is allowed: that is how the 57 pairs were booked,
// and the rule as it stood then permitted them.
{
  const j = judgeBufferBreaches([
    call("a", "u1", 0, { bufferBeforeMin: 0, bufferAfterMin: 0 }),
    call("b", "u1", 20, { bufferBeforeMin: 0, bufferAfterMin: 0 }),
  ]);
  eq(j.breaches.length, 0, "back to back calls with zero buffers are not a breach");
}

// Different event types: the needed gap is the LARGER of the earlier call's after
// buffer and the later call's before buffer, in either order.
{
  const earlierAfter15 = judgeBufferBreaches([
    call("a", "u1", 0, { bufferAfterMin: 15, bufferBeforeMin: 0 }),
    call("b", "u1", 32, { bufferBeforeMin: 5, bufferAfterMin: 0 }),
  ]);
  eq(ids(earlierAfter15.breaches), ["a>b"], "a 12 minute gap breaches the earlier call's 15 minute after buffer");
  eq(earlierAfter15.breaches[0]?.requiredMin, 15, "the earlier call's after buffer is the one needed");

  const laterBefore15 = judgeBufferBreaches([
    call("a", "u1", 0, { bufferAfterMin: 5, bufferBeforeMin: 0 }),
    call("b", "u1", 32, { bufferBeforeMin: 15, bufferAfterMin: 0 }),
  ]);
  eq(ids(laterBefore15.breaches), ["a>b"], "a 12 minute gap breaches the later call's 15 minute before buffer");
  eq(laterBefore15.breaches[0]?.requiredMin, 15, "the later call's before buffer is the one needed");

  // The earlier call's BEFORE buffer and the later call's AFTER buffer face away from
  // the gap, so a large value there must not count.
  const facingAway = judgeBufferBreaches([
    call("a", "u1", 0, { bufferBeforeMin: 60, bufferAfterMin: 5 }),
    call("b", "u1", 32, { bufferBeforeMin: 5, bufferAfterMin: 60 }),
  ]);
  eq(facingAway.breaches.length, 0, "buffers on the far side of each call do not count against the gap between them");

  // Passed out of order, the judge still finds which call is earlier.
  const reversed = judgeBufferBreaches([
    call("b", "u1", 32, { bufferBeforeMin: 15, bufferAfterMin: 0 }),
    call("a", "u1", 0, { bufferAfterMin: 5, bufferBeforeMin: 0 }),
  ]);
  eq(ids(reversed.breaches), ["a>b"], "the earlier call is found whatever order the read returned them in");
}

// Two advisors at the same time are not a pair.
{
  const j = judgeBufferBreaches([call("a", "u1", 0), call("b", "u2", 0), call("c", "u2", 40)]);
  eq(j.breaches.length, 0, "calls on different advisors never pair, even at the same minute");
}

// A long call overlapping one that is not its immediate neighbour is still found.
{
  const j = judgeBufferBreaches([
    call("long", "u1", 0, { endsMs: T0 + 120 * MIN }),
    call("mid", "u1", 30),
    call("late", "u1", 55),
  ]);
  eq(ids(j.breaches).sort(), ["long>late", "long>mid", "mid>late"].sort(), "every pair inside a buffer is found, not only neighbours");
}

// Test buckets are excluded outright; allow_double_book pairs are FORCED, which are
// counted and never page.
{
  const j = judgeBufferBreaches([
    call("t1", "u1", 0, { inTestBucket: true }),
    call("t2", "u1", 20),
    call("f1", "u2", 0),
    call("f2", "u2", 20, { allowDoubleBook: true }),
    call("r1", "u3", 0),
    call("r2", "u3", 20),
  ]);
  eq(ids(j.breaches), ["r1>r2"], "only the real unforced pair is a breach");
  eq(ids(j.forced), ["f1>f2"], "a pair where either call was forced is counted as forced");
  eq(j.examined, 6, "every booking read is counted as examined, test ones included");
}

// A forced pair that is also on a test bucket is neither: test bookings are out of scope.
{
  const j = judgeBufferBreaches([call("a", "u1", 0, { inTestBucket: true, allowDoubleBook: true }), call("b", "u1", 20)]);
  eq(j.breaches.length + j.forced.length, 0, "a test bucket booking pairs with nothing");
}

// --- turning the three reads into bookings --------------------------------------
{
  const rows = [
    {
      id: "a",
      assigned_user_id: "u1",
      agent_name: "Dana",
      starts_at: "2026-10-23T16:00:00.000Z",
      ends_at: "2026-10-23T16:20:00.000Z",
      event_type_id: "et1",
      bucket_id: "b-real",
      allow_double_book: false,
    },
    {
      id: "b",
      assigned_user_id: null,
      agent_name: null,
      starts_at: "2026-10-23T16:20:00.000Z",
      ends_at: "2026-10-23T16:40:00.000Z",
      event_type_id: "et1",
      bucket_id: "b-test",
      allow_double_book: true,
    },
  ];
  const eventTypes = [{ id: "et1", buffer_before_min: 10, buffer_after_min: 5 }];
  const buckets = [
    { id: "b-real", is_test: false },
    { id: "b-test", is_test: true },
  ];
  const out = bookingsForBufferCheck(rows, eventTypes, buckets);
  eq(out.unassigned, 1, "a booking with no advisor is counted, not judged");
  eq(out.bookings.length, 1, "the assigned booking is judged");
  eq(out.bookings[0]?.bufferBeforeMin, 10, "its before buffer comes from its event type");
  eq(out.bookings[0]?.bufferAfterMin, 5, "and so does its after buffer");
  eq(out.bookings[0]?.inTestBucket, false, "its bucket's test flag is carried");

  // A booking whose event type or bucket the reads did not return cannot be judged,
  // and judging it with a guessed zero buffer would hide exactly what this looks for.
  let threw = false;
  try {
    bookingsForBufferCheck(rows, [], buckets);
  } catch {
    threw = true;
  }
  assert(threw, "a booking whose event type was not read fails the read rather than judging with no buffer");
  threw = false;
  try {
    bookingsForBufferCheck(rows, eventTypes, []);
  } catch {
    threw = true;
  }
  assert(threw, "a booking whose bucket was not read fails the read rather than guessing it real or test");
  threw = false;
  try {
    bookingsForBufferCheck([{ ...rows[0]!, starts_at: "not a time" }], eventTypes, buckets);
  } catch {
    threw = true;
  }
  assert(threw, "a booking with an unreadable start fails the read, since NaN would compare as no breach");
}

// --- the copy ----------------------------------------------------------------------
{
  const j = judgeBufferBreaches([call("a1", "u1", 0), call("b2", "u1", 20)]);
  const text = formatBufferBreachAlert(j.breaches, (id) => `https://example.test/admin/bookings/${id}`);
  assert(text.includes("a1") && text.includes("b2"), "the page names both bookings by id");
  assert(text.includes("https://example.test/admin/bookings/a1"), "and links each one");
  assert(text.includes("Advisor u1"), "and names the advisor");
  assert(!/^Slate/.test(text), "it never opens with the word Slate");
  assert(!/@/.test(text), "it carries no contact detail");
  const recovery = formatBufferBreachRecovery();
  assert(!/^Slate/.test(recovery) && /No action is needed/.test(recovery), "the all clear stands the reader down");

  const many = judgeBufferBreaches(
    Array.from({ length: 30 }, (_, i) => call(`c${i}`, `u${Math.floor(i / 2)}`, (i % 2) * 20)),
  );
  eq(many.breaches.length, 15, "fifteen advisors with one pair each");
  const long = formatBufferBreachAlert(many.breaches, (id) => `/b/${id}`);
  assert(/and 5 more/.test(long), "a long list is capped and says how many it left out");
}

// --- the repeat subjects ------------------------------------------------------------
{
  const j = judgeBufferBreaches([call("a", "u1", 0), call("b", "u1", 20)]);
  const r = bufferBreachRepeat(j.breaches);
  eq(r.subjects, ["a+b"], "each pair is one subject, named by both booking ids");
}

// --- the runner ---------------------------------------------------------------------
type Sent = { key: string; text: string; subjects?: readonly string[] };

async function runWith(load: () => Promise<BufferedBooking[]>) {
  const sent: Sent[] = [];
  const resolved: { key: string; text: string }[] = [];
  let result: Awaited<ReturnType<typeof runBufferBreachCheck>> | null = null;
  let error: unknown = null;
  try {
    result = await runBufferBreachCheck({
      load: async () => ({ bookings: await load(), unassigned: 0 }),
      notify: async (key, _ms, text, repeat) => {
        sent.push({ key, text, subjects: repeat?.subjects });
      },
      resolve: async (key, text) => {
        resolved.push({ key, text });
        return true;
      },
      cooldownMs: 60_000,
      bookingUrl: (id) => `/admin/bookings/${id}`,
    });
  } catch (err) {
    error = err;
  }
  return { sent, resolved, result, error };
}

// A breach pages on the condition key with the pairs as subjects, and clears nothing.
{
  const r = await runWith(async () => [
    call("a", "u1", 0),
    call("b", "u1", 20),
    call("f1", "u2", 0),
    call("f2", "u2", 20, { allowDoubleBook: true }),
  ]);
  eq(r.sent.map((s) => s.key), [BUFFER_BREACH_KEY], "a breach pages once on booking_buffer_breach");
  eq(r.sent[0]?.subjects, ["a+b"], "naming the breaching pair, and not the forced one, as its subject");
  eq(r.resolved.length, 0, "a tick that found a breach clears nothing");
  eq(r.result?.examined, 4, "the result says how many bookings it examined");
  eq(r.result?.breaches, 1, "and how many pairs breach");
  eq(r.result?.forced, 1, "and how many were forced, which never page");
  eq(r.result?.forcedPairs, ["f1+f2"], "naming the forced pairs where an operator can read them");
}

// Only forced pairs: nothing pages, and the condition is measured clear.
{
  const r = await runWith(async () => [call("f1", "u2", 0), call("f2", "u2", 20, { allowDoubleBook: true })]);
  eq(r.sent.length, 0, "forced pairs alone never page");
  eq(r.resolved.map((x) => x.key), [BUFFER_BREACH_KEY], "a measured read with no breach settles the condition");
  eq(r.result?.forced, 1, "and still reports the forced pair");
}

// A measured empty read is a real all clear.
{
  const r = await runWith(async () => []);
  eq(r.sent.length, 0, "nothing to page on an empty book");
  eq(r.resolved.length, 1, "a measured read of zero bookings settles the condition");
  eq(r.result?.examined, 0, "and says it examined none, so a reader can tell it from a full book");
}

// A failed read must clear nothing and page nothing: it throws, so the step fails
// and the step failure streak speaks for it.
{
  const r = await runWith(async () => {
    throw new Error("bookings read failed: timeout");
  });
  assert(r.error instanceof Error, "a failed read throws out of the check, so the monitor step fails");
  eq(r.resolved.length, 0, "a failed read posts no all clear");
  eq(r.sent.length, 0, "and no page");
  eq(r.result, null, "and returns no result that could read as zero breaches");
}

// A failed send is contained: the result still reports what was measured.
{
  const result = await runBufferBreachCheck({
    load: async () => ({ bookings: [call("a", "u1", 0), call("b", "u1", 20)], unassigned: 2 }),
    notify: async () => {
      throw new Error("slack down");
    },
    resolve: async () => true,
    cooldownMs: 60_000,
    bookingUrl: (id) => id,
  });
  eq(result.breaches, 1, "a failed page still reports the breach it measured");
  eq(result.unassigned, 2, "and the unassigned bookings it could not pair");
  eq(result.examined, 4, "counted among those examined");
}

finish();
