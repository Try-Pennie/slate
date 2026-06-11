// Sanity test for the rate-limit helpers (#31). The atomic counter itself is
// a Postgres function (verified live); this covers the pure pieces.
// Run: node --experimental-strip-types scripts/test-rate-limit.ts
import {
  clientIp,
  AVAILABILITY_RATE_RULES,
  BOOKING_RATE_RULES,
} from "../src/lib/rate-limit-core.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

const h = (entries: Record<string, string>) => new Headers(entries);

assert(
  clientIp(h({ "cf-connecting-ip": "203.0.113.7" })) === "203.0.113.7",
  "prefers cf-connecting-ip (Cloudflare sets it on every request)",
);
assert(
  clientIp(
    h({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "10.0.0.1" }),
  ) === "203.0.113.7",
  "cf-connecting-ip wins over x-forwarded-for",
);
assert(
  clientIp(h({ "x-forwarded-for": "198.51.100.4, 10.0.0.1, 10.0.0.2" })) ===
    "198.51.100.4",
  "x-forwarded-for uses the first hop (the client)",
);
assert(
  clientIp(h({ "x-forwarded-for": "  198.51.100.4  " })) === "198.51.100.4",
  "ips are trimmed",
);
assert(clientIp(h({})) === "unknown", "no headers -> a stable fallback key");

// Policy shape: a burst window plus a longer cap, burst strictly tighter.
assert(BOOKING_RATE_RULES.length >= 2, "at least two windows");
const [burst, sustained] = [...BOOKING_RATE_RULES].sort(
  (a, b) => a.windowSeconds - b.windowSeconds,
);
assert(
  burst.windowSeconds < sustained.windowSeconds &&
    burst.max < sustained.max,
  "burst window is shorter and tighter than the sustained window",
);
assert(
  BOOKING_RATE_RULES.every((r) => r.max > 0 && r.windowSeconds > 0),
  "all rules are positive",
);
assert(
  new Set(BOOKING_RATE_RULES.map((r) => r.prefix)).size ===
    BOOKING_RATE_RULES.length,
  "rule prefixes are distinct (separate counters)",
);

// --- availability policy (#56) ---
const [aBurst, aSustained] = [...AVAILABILITY_RATE_RULES].sort(
  (a, b) => a.windowSeconds - b.windowSeconds,
);
assert(
  aBurst.windowSeconds < aSustained.windowSeconds && aBurst.max < aSustained.max,
  "availability: burst window shorter and tighter than sustained",
);
assert(
  aBurst.max > BOOKING_RATE_RULES[0].max,
  "availability is looser than bookings (Booker refetches per month nav)",
);
assert(
  new Set([...AVAILABILITY_RATE_RULES, ...BOOKING_RATE_RULES].map((r) => r.prefix))
    .size === AVAILABILITY_RATE_RULES.length + BOOKING_RATE_RULES.length,
  "availability and booking counters never share keys",
);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
