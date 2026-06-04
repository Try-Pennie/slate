// Sanity test for the pure booking cores: slot window, verify-on-book
// selection, and the write-through busy block.
// Run: node --experimental-strip-types scripts/test-booking.ts
import {
  bookingWindow,
  busyBlockFor,
  idempotencyKeyFor,
  selectAgent,
} from "../src/lib/booking/core.ts";

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

// --- selectAgent (verify-on-book) ---
// "c" has an empty email, "d" has none; the rest resolve to real addresses.
const emailOf: Record<string, string | null> = { a: "a@x", b: "b@x", c: "", d: null };
const loadEmail = async (id: string) => emailOf[id] ?? null;

function freeChecker(free: Set<string>) {
  let calls = 0;
  return {
    fn: async (email: string) => {
      calls++;
      return free.has(email);
    },
    calls: () => calls,
  };
}

async function run() {
  // First free candidate wins, and we stop checking after it (one check).
  let fc = freeChecker(new Set(["a@x", "b@x"]));
  let r = await selectAgent(["a", "b"], loadEmail, fc.fn);
  assert(r?.userId === "a" && r?.email === "a@x", "first free candidate wins");
  assert(fc.calls() === 1, "stops at first free — one isFree check");

  // Candidate with an empty email is skipped (no free-check spent on it).
  fc = freeChecker(new Set(["a@x"]));
  r = await selectAgent(["c", "a"], loadEmail, fc.fn);
  assert(r?.userId === "a", "candidate with empty email is skipped");
  assert(fc.calls() === 1, "no isFree check for an emailless candidate");

  // Candidate with a null email is skipped.
  fc = freeChecker(new Set(["a@x"]));
  r = await selectAgent(["d", "a"], loadEmail, fc.fn);
  assert(r?.userId === "a", "candidate with null email is skipped");

  // Walks past a busy candidate to the next free one.
  fc = freeChecker(new Set(["b@x"]));
  r = await selectAgent(["a", "b"], loadEmail, fc.fn);
  assert(r?.userId === "b", "walks past busy candidate to next free");
  assert(fc.calls() === 2, "checks each candidate in order until first free");

  // No free candidate yields null (caller turns this into SlotUnavailable).
  fc = freeChecker(new Set());
  r = await selectAgent(["a", "b"], loadEmail, fc.fn);
  assert(r === null, "no free candidate yields null");
  assert(fc.calls() === 2, "checks all candidates when none is free");

  // Round-robin order is respected when several are free.
  fc = freeChecker(new Set(["a@x", "b@x"]));
  r = await selectAgent(["b", "a"], loadEmail, fc.fn);
  assert(r?.userId === "b", "returns first free in candidate order");

  // Empty candidate list yields null with zero checks.
  fc = freeChecker(new Set(["a@x"]));
  r = await selectAgent([], loadEmail, fc.fn);
  assert(r === null && fc.calls() === 0, "empty candidate list yields null, no checks");
}

await run();

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
