// Sanity test for the rate-limit helpers (#31). The atomic counter itself is
// a Postgres function (verified live); this covers the pure pieces.
// Run: node --experimental-strip-types scripts/test-rate-limit.ts
import {
  clientIp,
  BOOKING_RATE_RULES,
  DIRECT_BOOKING_API_RATE_RULES,
  ROUTING_RATE_RULES,
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

// Availability (#56) is now throttled at the edge by the AVAIL_RATE_LIMITER
// Workers binding (wrangler.jsonc), not a DB rule — nothing pure to assert here.

// Direct booking API (#355): a per-KEY ceiling, generously sized above the
// ~2000/day bot volume so it only trips on a runaway/leaked key, and keyed on
// distinct prefixes from the per-IP booking rules so the two counters never mix.
assert(
  DIRECT_BOOKING_API_RATE_RULES.every((r) => r.max > 0 && r.windowSeconds > 0),
  "direct-booking-api rules are positive",
);
{
  const hourly = DIRECT_BOOKING_API_RATE_RULES.find((r) => r.windowSeconds === 3600);
  assert(
    !!hourly && hourly.max >= 2000,
    "hourly ceiling sits well above the ~2000/day expected bot volume",
  );
}
{
  const apiPrefixes = new Set(DIRECT_BOOKING_API_RATE_RULES.map((r) => r.prefix));
  assert(
    BOOKING_RATE_RULES.every((r) => !apiPrefixes.has(r.prefix)),
    "per-key API counters use different prefixes than the per-IP booking counters",
  );
}

// Routing API (#596): the standalone routing preview is unauthenticated and
// DB-backed, so it gets its own per-IP ceiling with distinct prefixes. Tight
// enough to bound anonymous enumeration + DB load; a burst window plus an
// hourly cap, same shape as the booking rules.
assert(
  ROUTING_RATE_RULES.every((r) => r.max > 0 && r.windowSeconds > 0),
  "routing rules are positive",
);
{
  const [rBurst, rSustained] = [...ROUTING_RATE_RULES].sort(
    (a, b) => a.windowSeconds - b.windowSeconds,
  );
  assert(
    ROUTING_RATE_RULES.length >= 2 &&
      rBurst.windowSeconds < rSustained.windowSeconds &&
      rBurst.max < rSustained.max,
    "routing burst window is shorter and tighter than its sustained window",
  );
}
{
  const routingPrefixes = new Set(ROUTING_RATE_RULES.map((r) => r.prefix));
  assert(
    routingPrefixes.size === ROUTING_RATE_RULES.length,
    "routing rule prefixes are distinct (separate counters)",
  );
  assert(
    BOOKING_RATE_RULES.every((r) => !routingPrefixes.has(r.prefix)) &&
      DIRECT_BOOKING_API_RATE_RULES.every((r) => !routingPrefixes.has(r.prefix)),
    "routing counters use different prefixes than the booking counters",
  );
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
