// Sanity test for least-recently-booked round-robin ordering.
// Run: node --experimental-strip-types scripts/test-roundrobin.ts
import { orderByLeastRecentlyBooked } from "../src/lib/availability/roundrobin.ts";

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

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
