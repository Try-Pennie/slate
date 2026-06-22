// Sanity test for the pure booking cores: slot window, verify-on-book
// selection, and the write-through busy block.
// Run: node --experimental-strip-types scripts/test-booking.ts
import {
  bookingWindow,
  busyBlockFor,
  eventDescription,
  idempotencyKeyFor,
  joinBookingContexts,
  selectAgent,
} from "../src/lib/booking/core.ts";
import type { Booking, Bucket, EventType } from "../src/lib/db/types.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

// --- bookingWindow ---
const w = bookingWindow("2026-06-08T13:00:00.000Z", 30);
assert(w.startIso === "2026-06-08T13:00:00.000Z", "start normalized to ISO");
assert(w.endIso === "2026-06-08T13:30:00.000Z", "end is start + 30m");

const w2 = bookingWindow("2026-06-08T09:00:00-04:00", 20);
assert(w2.startIso === "2026-06-08T13:00:00.000Z", "non-UTC start normalized to UTC");
assert(w2.endIso === "2026-06-08T13:20:00.000Z", "end adds duration to normalized start");

// --- busyBlockFor ---
const block = busyBlockFor(
  "u1",
  "2026-06-08T13:00:00.000Z",
  "2026-06-08T13:30:00.000Z",
  "bk1",
);
assert(
  JSON.stringify(block) ===
    JSON.stringify({
      user_id: "u1",
      starts_at: "2026-06-08T13:00:00.000Z",
      ends_at: "2026-06-08T13:30:00.000Z",
      source: "slate",
      booking_id: "bk1",
    }),
  "write-through block has the expected shape (source=slate)",
);

// --- idempotencyKeyFor ---
const k1 = idempotencyKeyFor({
  bucketCode: "411",
  startIso: "2026-06-08T13:00:00.000Z",
  email: "K@X.com",
  phone: "+1 203 561 5295",
  salesforceId: "sf1",
});
const k2 = idempotencyKeyFor({
  bucketCode: "411",
  startIso: "2026-06-08T13:00:00.000Z",
  email: "k@x.com ",
  phone: "+12035615295",
  salesforceId: "sf1",
});
assert(k1 !== null && k1 === k2, "idempotency key stable across email case + phone whitespace");
assert(
  idempotencyKeyFor({ bucketCode: "411", startIso: "2026-06-08T14:00:00.000Z", phone: "+12035615295" }) !==
    idempotencyKeyFor({ bucketCode: "411", startIso: "2026-06-08T13:00:00.000Z", phone: "+12035615295" }),
  "different slot yields a different key",
);
assert(
  idempotencyKeyFor({ bucketCode: "411", startIso: "2026-06-08T13:00:00.000Z" }) === null,
  "no attendee identity yields null (no dedup)",
);
assert(
  idempotencyKeyFor({ bucketCode: "411", startIso: "2026-06-08T13:00:00.000Z", salesforceId: "sf1" }) !== null,
  "salesforceId alone is enough identity",
);

// --- selectAgent (verify-on-book, wave-batched) ---
// "c" has an empty email, "d" has none; the rest resolve to real addresses.
// selectAgent now verifies candidates in round-robin WAVES of `batchSize`, each
// wave a single batched verifyFree(emails) call, and returns the first free
// candidate in round-robin order — bounding latency to ~one wave in the common
// case instead of one serial Google call per candidate.
const emailOf: Record<string, string | null> = { a: "a@x", b: "b@x", c: "", d: null };
// Batched email resolver: userId[] -> Map(userId -> email), skipping emailless.
const loadEmails = async (ids: string[]) => {
  const m = new Map<string, string>();
  for (const id of ids) {
    const e = emailOf[id];
    if (e) m.set(id, e);
  }
  return m;
};

// verifyFree now reports both the free subset AND which emails could NOT be
// verified (read errors / outage), so selectAgent can tell a genuinely-full slot
// apart from "couldn't check" (#319). `unverified` defaults to none.
function batchVerifier(free: Set<string>, unverified: Set<string> = new Set()) {
  const waves: string[][] = [];
  return {
    fn: async (emails: string[]) => {
      waves.push(emails);
      return {
        free: new Set(emails.filter((e) => free.has(e))),
        unverified: new Set(emails.filter((e) => unverified.has(e))),
      };
    },
    waves: () => waves,
    waveCount: () => waves.length,
  };
}

async function run() {
  // First free candidate wins; one wave covers both, so a single verify call.
  let v = batchVerifier(new Set(["a@x", "b@x"]));
  let r = await selectAgent(["a", "b"], loadEmails, v.fn, 50);
  assert(r.assignment?.userId === "a" && r.assignment?.email === "a@x", "first free candidate wins");
  assert(v.waveCount() === 1, "one wave when batchSize covers all candidates");

  // Candidate with an empty email is skipped (not passed to verifyFree).
  v = batchVerifier(new Set(["a@x"]));
  r = await selectAgent(["c", "a"], loadEmails, v.fn, 50);
  assert(r.assignment?.userId === "a", "candidate with empty email is skipped");
  assert(
    JSON.stringify(v.waves()[0]) === JSON.stringify(["a@x"]),
    "emailless candidate is not sent to verifyFree",
  );

  // Candidate with a null email is skipped.
  v = batchVerifier(new Set(["a@x"]));
  r = await selectAgent(["d", "a"], loadEmails, v.fn, 50);
  assert(r.assignment?.userId === "a", "candidate with null email is skipped");

  // Walks past a busy candidate to the next free one (same wave).
  v = batchVerifier(new Set(["b@x"]));
  r = await selectAgent(["a", "b"], loadEmails, v.fn, 50);
  assert(r.assignment?.userId === "b", "walks past busy candidate to next free");

  // No free candidate yields a null assignment (caller maps to SlotUnavailable).
  v = batchVerifier(new Set());
  r = await selectAgent(["a", "b"], loadEmails, v.fn, 50);
  assert(r.assignment === null, "no free candidate yields a null assignment");
  assert(r.anyUnverified === false, "all-busy failure is NOT flagged unverified");

  // Round-robin order is respected when several are free.
  v = batchVerifier(new Set(["a@x", "b@x"]));
  r = await selectAgent(["b", "a"], loadEmails, v.fn, 50);
  assert(r.assignment?.userId === "b", "returns first free in candidate order");

  // Empty candidate list yields null with zero verify calls.
  v = batchVerifier(new Set(["a@x"]));
  r = await selectAgent([], loadEmails, v.fn, 50);
  assert(r.assignment === null && v.waveCount() === 0, "empty candidate list yields null, no verify");

  // Wave batching: free agent in the first wave → later waves never verified.
  v = batchVerifier(new Set(["a@x", "b@x"]));
  r = await selectAgent(["a", "b", "c", "d", "a", "b"], loadEmails, v.fn, 2);
  assert(r.assignment?.userId === "a", "first wave's free agent wins");
  assert(v.waveCount() === 1, "stops after the first wave that has a free agent");
  assert(v.waves()[0].length === 2, "a wave carries at most batchSize emails");

  // Wave batching: whole first wave busy → advance to the next wave.
  // Wave 1 = [a,b] (both busy), wave 2 = [a] again but now free.
  let wavesSeen = 0;
  const toggling = async (emails: string[]) => {
    wavesSeen++;
    const free = wavesSeen === 1 ? new Set<string>() : new Set(["a@x"]);
    return {
      free: new Set(emails.filter((e) => free.has(e))),
      unverified: new Set<string>(),
    };
  };
  r = await selectAgent(["a", "b", "a", "b"], loadEmails, toggling, 2);
  assert(wavesSeen === 2, "advances to the next wave when the first is all busy");
  assert(r.assignment?.userId === "a", "returns a free agent found in a later wave");

  // Outage signal: nobody free AND a candidate couldn't be verified → anyUnverified.
  v = batchVerifier(new Set(), new Set(["a@x"]));
  r = await selectAgent(["a", "b"], loadEmails, v.fn, 50);
  assert(r.assignment === null, "couldn't-verify-anyone still yields a null assignment");
  assert(r.anyUnverified === true, "an unverifiable candidate flags anyUnverified");

  // A successful assignment doesn't care about earlier unverified candidates.
  v = batchVerifier(new Set(["b@x"]), new Set(["a@x"]));
  r = await selectAgent(["a", "b"], loadEmails, v.fn, 50);
  assert(r.assignment?.userId === "b", "an unverifiable candidate is skipped for a free one");
}

await run();

// --- eventDescription (#64: invite carries the manage link) ---
const desc = eventDescription("+12035615295", "https://slate.trypennie.app/booking/manage/tok123");
assert(
  desc === "Booked via Pennie. Phone: +12035615295\nReschedule or cancel: https://slate.trypennie.app/booking/manage/tok123",
  "description carries phone and the manage link",
);
assert(
  eventDescription(null, "https://x/m/t") === "Booked via Pennie.\nReschedule or cancel: https://x/m/t",
  "no phone -> still carries the manage link",
);
assert(!desc.includes(" - ") && !desc.includes("\u2014"), "lead-facing copy has no dashes");

// --- joinBookingContexts (#164: in-memory join replaces the per-booking N+1) ---
{
  const b = (id: string, k: string, e: string) =>
    ({ id, bucket_id: k, event_type_id: e }) as unknown as Booking;
  const bookings = [b("b1", "k1", "e1"), b("b2", "k2", "e1")];
  const buckets = [{ id: "k1" }, { id: "k2" }] as unknown as Bucket[];
  const ets = [{ id: "e1" }] as unknown as EventType[];

  const joined = joinBookingContexts(bookings, buckets, ets);
  assert(joined.length === 2, "join: pairs every booking with its bucket + event type");
  assert(
    joined[0].booking.id === "b1" && joined[0].bucket.id === "k1" && joined[0].eventType.id === "e1",
    "join: b1 -> k1/e1",
  );
  assert(
    joined[1].bucket.id === "k2" && joined[1].eventType.id === "e1",
    "join: b2 reuses the shared event type e1",
  );

  const orphan = joinBookingContexts([b("b3", "missing", "e1")], buckets, ets);
  assert(orphan.length === 0, "join: drops a booking whose bucket isn't in the fetched set");
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
