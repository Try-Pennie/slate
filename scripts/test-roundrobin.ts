// Sanity test for least-recently-booked round-robin ordering.
// Run: node --experimental-strip-types scripts/test-roundrobin.ts
import {
  orderByLeastRecentlyBooked,
  applyFallback,
  lastBookedFromResult,
} from "../src/lib/availability/roundrobin.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

const eq = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

// Oldest last-booking first; newest last.
assert(
  eq(orderByLeastRecentlyBooked(["a", "b", "c"], { a: 300, b: 100, c: 200 }), ["b", "c", "a"]),
  "orders by oldest last-booking first",
);

// Never-booked (missing or null) sorts before anyone with a booking.
assert(
  eq(orderByLeastRecentlyBooked(["a", "b", "c"], { a: 100, c: 50 }), ["b", "c", "a"]),
  "never-booked agent (missing) comes first",
);
assert(
  eq(orderByLeastRecentlyBooked(["a", "b"], { a: 100, b: null }), ["b", "a"]),
  "null last-booking is treated as never booked (first)",
);

// Multiple never-booked break ties deterministically by id.
assert(
  eq(orderByLeastRecentlyBooked(["c", "a", "b"], {}), ["a", "b", "c"]),
  "all never-booked: deterministic id tiebreak",
);

// Same timestamp breaks ties by id.
assert(
  eq(orderByLeastRecentlyBooked(["b", "a"], { a: 100, b: 100 }), ["a", "b"]),
  "equal timestamps: deterministic id tiebreak",
);

// Order is independent of input order (concurrent callers agree).
assert(
  eq(
    orderByLeastRecentlyBooked(["c", "b", "a"], { a: 300, b: 100, c: 200 }),
    orderByLeastRecentlyBooked(["a", "b", "c"], { a: 300, b: 100, c: 200 }),
  ),
  "result is independent of input ordering",
);

// Edge cases.
assert(eq(orderByLeastRecentlyBooked([], {}), []), "empty input yields empty");
assert(eq(orderByLeastRecentlyBooked(["solo"], {}), ["solo"]), "single candidate passes through");

// Does not mutate the input array.
const input = ["a", "b"];
orderByLeastRecentlyBooked(input, { a: 2, b: 1 });
assert(eq(input, ["a", "b"]), "input array is not mutated");

// --- applyFallback ---
assert(
  JSON.stringify(applyFallback(["a", "b"], "f", true)) === JSON.stringify({ ids: ["a", "b"], fallbackApplied: false }),
  "non-empty matched pool is used as-is (no fallback)",
);
assert(
  JSON.stringify(applyFallback([], "f", true)) === JSON.stringify({ ids: ["f"], fallbackApplied: true }),
  "empty pool with a fallback routes to the fallback agent",
);
assert(
  JSON.stringify(applyFallback([], null, true)) === JSON.stringify({ ids: [], fallbackApplied: false }),
  "empty pool with no fallback stays empty",
);

// --- applyFallback drops an INELIGIBLE fallback agent (#266) ---
// A bucket's fallback_user_id can point at an agent who is non-bookable or
// (with the offboarding lifecycle) deactivated. Routing must NOT hand a booking
// to such an agent just because the matched pool is empty.
assert(
  JSON.stringify(applyFallback([], "f", false)) === JSON.stringify({ ids: [], fallbackApplied: false }),
  "empty pool with an INELIGIBLE fallback routes to nobody",
);
assert(
  JSON.stringify(applyFallback([], "f", true)) === JSON.stringify({ ids: ["f"], fallbackApplied: true }),
  "empty pool with an ELIGIBLE fallback routes to the fallback agent",
);

// --- lastBookedFromResult (#277 ordering degrade) ---
// Builds the per-agent newest-booking map; degraded=false on a clean read.
{
  const { lastBookedAtMs, degraded } = lastBookedFromResult({
    data: [
      { assigned_user_id: "a", created_at: "2026-01-01T00:00:00Z" },
      { assigned_user_id: "a", created_at: "2026-03-01T00:00:00Z" },
      { assigned_user_id: "b", created_at: "2026-02-01T00:00:00Z" },
    ],
    error: null,
  });
  assert(degraded === false, "clean ordering read is not degraded");
  assert(
    lastBookedAtMs.a === Date.parse("2026-03-01T00:00:00Z"),
    "keeps the NEWEST booking per agent",
  );
  assert(lastBookedAtMs.b === Date.parse("2026-02-01T00:00:00Z"), "maps each agent");
}

// A FAILED ordering read must NOT throw (a booking must always go through, even
// if wildly unfair) — it returns an empty map (everyone treated never-booked)
// and flags `degraded` so the caller can fire the potentially-unfair alert.
{
  const { lastBookedAtMs, degraded } = lastBookedFromResult({
    data: null,
    error: { message: "boom" },
  });
  assert(degraded === true, "an errored ordering read is flagged degraded");
  assert(
    Object.keys(lastBookedAtMs).length === 0,
    "degraded read yields an empty map (ordering still produces a valid set)",
  );
}

// assigned_user_id is nullable in the schema; rows with a null assignee don't
// belong to any agent's recency and are skipped.
{
  const { lastBookedAtMs } = lastBookedFromResult({
    data: [
      { assigned_user_id: null, created_at: "2026-05-01T00:00:00Z" },
      { assigned_user_id: "a", created_at: "2026-01-01T00:00:00Z" },
    ],
    error: null,
  });
  assert(
    Object.keys(lastBookedAtMs).length === 1 && "a" in lastBookedAtMs,
    "rows with a null assigned_user_id are skipped",
  );
}

// Not-found / empty (no error) is a normal read, not degraded.
{
  const { degraded } = lastBookedFromResult({ data: null, error: null });
  assert(degraded === false, "empty result with no error is not degraded");
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
