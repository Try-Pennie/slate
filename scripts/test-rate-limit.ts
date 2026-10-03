// Sanity test for the rate-limit helpers (#31). The atomic counter itself is
// a Postgres function (verified live); this covers the pure pieces.
// Run: node --experimental-strip-types scripts/test-rate-limit.ts
import {
  clientIp,
  BOOKING_HOURLY_RATE_RULES,
  BOOKING_CONTACT_HOURLY_RATE_RULES,
  contactRateKeys,
  DIRECT_BOOKING_API_HOURLY_RATE_RULES,
  DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES,
  DIRECT_BOOKING_API_READ_HOURLY_RATE_RULES,
  ROUTING_HOURLY_RATE_RULES,
  friendlyRateArea,
  limiterFailOpenAlert,
  limiterBlockedAlert,
  refundFailedAlert,
} from "../src/lib/rate-limit-core.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const READ_PREFIXES = DIRECT_BOOKING_API_READ_HOURLY_RATE_RULES.map((r) => r.prefix);

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

// #3107: an IPv6 caller is keyed on its /64, because one ordinary allocation is a whole
// /64 and a counter on the full /128 is a fresh counter per address the caller rotates to.
{
  const ip6 = (v: string) => clientIp(h({ "cf-connecting-ip": v }));
  eq(
    ip6("2001:db8:1234:5678::1"),
    ip6("2001:db8:1234:5678:ffff:eeee:dddd:cccc"),
    "two addresses in one /64 share a counter",
  );
  assert(
    ip6("2001:db8:1234:5678::1") !== ip6("2001:db8:1234:5679::1"),
    "addresses in neighbouring /64s keep separate counters",
  );
  eq(ip6("2001:db8:1234:5678::1"), "2001:db8:1234:5678::/64", "the key names the /64");
  eq(
    ip6("2001:0DB8:1234:5678:0:0:0:1"),
    ip6("2001:db8:1234:5678::9"),
    "case, leading zeros and the compressed form all read as one /64",
  );
  eq(ip6("2001:db8::1"), "2001:db8:0:0::/64", "a :: inside the first four groups expands");
  eq(ip6("::1"), "0:0:0:0::/64", "a leading :: expands");
  eq(ip6("fe80::1%eth0"), "fe80:0:0:0::/64", "a zone id is dropped");
  eq(ip6("[2001:db8::1]"), "2001:db8:0:0::/64", "brackets are dropped");
  eq(ip6("::ffff:203.0.113.7"), "203.0.113.7", "an IPv4 mapped address keys as its IPv4");
  eq(ip6("0:0:0:0:0:ffff:203.0.113.7"), "203.0.113.7", "so does its long form");
  eq(
    clientIp(h({ "x-forwarded-for": "2001:db8:1:2::3, 10.0.0.1" })),
    "2001:db8:1:2::/64",
    "the forwarded-for fallback is normalized too",
  );
  eq(ip6("not-an-address"), "not-an-address", "something unreadable is passed through as is");
  eq(ip6("203.0.113.7"), "203.0.113.7", "IPv4 is untouched");
}

// Policy shape (#237): the per-minute burst window moved to the edge limiter
// (BOOKING_RATE_LIMITER, wrangler.jsonc); only the strict hourly anti-spam cap
// remains a DB rule here.
assert(BOOKING_HOURLY_RATE_RULES.length === 1, "one DB rule remains: the hourly cap");
const hourlyCap = BOOKING_HOURLY_RATE_RULES[0];
assert(
  hourlyCap.windowSeconds === 3600 && hourlyCap.max === 10,
  "the DB rule is the 10/hour cap",
);
assert(
  BOOKING_HOURLY_RATE_RULES.every((r) => r.max > 0 && r.windowSeconds > 0),
  "all rules are positive",
);
assert(
  new Set(BOOKING_HOURLY_RATE_RULES.map((r) => r.prefix)).size ===
    BOOKING_HOURLY_RATE_RULES.length,
  "rule prefixes are distinct (separate counters)",
);

// Per-contact hourly cap (#1033): a second bound on the public booker keyed on
// the attendee's contact rather than their IP, so a distributed bot reusing one
// fake identity across many IPs is capped by the identity it reuses. It rides the
// same rate_limit_hit machinery as the IP cap, just with a contact-derived key.
assert(
  BOOKING_CONTACT_HOURLY_RATE_RULES.length === 1,
  "one per-contact rule: the hourly cap",
);
{
  const contactCap = BOOKING_CONTACT_HOURLY_RATE_RULES[0];
  assert(contactCap.windowSeconds === 3600, "the per-contact rule is an hourly window");
  assert(
    contactCap.max > 0 && contactCap.max <= 10,
    "per-contact cap is generous enough for a retrying lead but well below abuse (<=10/hr)",
  );
  // Distinct prefix from the per-IP cap so the two counters never draw on each
  // other: a lead near their IP cap must not also spend contact budget, and a
  // shared-IP office must not collapse both caps into one.
  const ipPrefixes = new Set(BOOKING_HOURLY_RATE_RULES.map((r) => r.prefix));
  assert(
    BOOKING_CONTACT_HOURLY_RATE_RULES.every((r) => !ipPrefixes.has(r.prefix)),
    "per-contact counters use a distinct prefix from the per-IP booking counters",
  );
  // A block here is expected day-to-day (a spammy visitor), so it must NOT page,
  // exactly like the per-IP public-booking cap.
  assert(
    BOOKING_CONTACT_HOURLY_RATE_RULES.every((r) => !r.alertOnBlock),
    "a per-contact block does not alert (an expected event, like the per-IP cap)",
  );
}

// contactRateKeys normalizes the attendee into stable, discriminated keys so the
// SAME person is one counter regardless of formatting: email lowercased+trimmed,
// phone reduced to digits (matching how numbers are normalized for webhooks).
{
  const keys = contactRateKeys({ email: "  Dana@Example.COM ", phone: "(203) 561-5295" });
  assert(keys.includes("email:dana@example.com"), "email key is lowercased and trimmed");
  assert(keys.includes("phone:2035615295"), "phone key is digits only");
  assert(keys.length === 2, "a full contact yields exactly two keys (email + phone)");

  // The two keys are discriminated so an email can never collide with a phone.
  assert(
    keys.every((k) => k.startsWith("email:") || k.startsWith("phone:")),
    "keys are discriminated by kind",
  );

  // Same person, different formatting -> the same keys (one counter).
  const keys2 = contactRateKeys({ email: "dana@example.com", phone: "+1 203 561 5295" });
  assert(
    keys2.includes("email:dana@example.com") && keys2.includes("phone:12035615295"),
    "a leading country code is kept as digits (never silently dropped)",
  );

  // Missing / blank fields are skipped rather than producing an empty-keyed counter
  // that every blank-field bot would share.
  eq(contactRateKeys({ email: "a@b.co", phone: "  " }).length, 1, "blank phone is skipped");
  eq(contactRateKeys({ email: "", phone: "" }).length, 0, "all-blank contact yields no keys");
  eq(contactRateKeys({}).length, 0, "empty attendee yields no keys");
}

// Availability (#56) is now throttled at the edge by the AVAIL_RATE_LIMITER
// Workers binding (wrangler.jsonc), not a DB rule — nothing pure to assert here.

// Direct booking API (#355): a per-KEY ceiling, generously sized above the
// ~2000/day bot volume so it only trips on a runaway/leaked key, and keyed on
// distinct prefixes from the per-IP booking rules so the two counters never mix.
// The per-minute burst window moved to the edge (BOOKINGAPI_RATE_LIMITER, #961);
// only the hourly cap remains a DB rule here.
assert(
  DIRECT_BOOKING_API_HOURLY_RATE_RULES.every((r) => r.max > 0 && r.windowSeconds > 0),
  "direct-booking-api rules are positive",
);
assert(
  DIRECT_BOOKING_API_HOURLY_RATE_RULES.every((r) => r.windowSeconds === 3600),
  "only the hourly window remains in the DB; the per-minute burst moved to the edge (#961)",
);
{
  const hourly = DIRECT_BOOKING_API_HOURLY_RATE_RULES.find((r) => r.windowSeconds === 3600);
  assert(
    !!hourly && hourly.max >= 2000,
    "hourly ceiling sits well above the ~2000/day expected bot volume",
  );
}
{
  const apiPrefixes = new Set(DIRECT_BOOKING_API_HOURLY_RATE_RULES.map((r) => r.prefix));
  assert(
    BOOKING_HOURLY_RATE_RULES.every((r) => !apiPrefixes.has(r.prefix)),
    "per-key API counters use different prefixes than the per-IP booking counters",
  );
}

// Routing API (#596): the standalone routing preview is unauthenticated and
// DB-backed, so it gets its own per-IP throttle with distinct prefixes. The
// per-minute burst window moved to the edge (ROUTING_RATE_LIMITER, #961); only the
// hourly cap remains a DB rule here.
assert(
  ROUTING_HOURLY_RATE_RULES.every((r) => r.max > 0 && r.windowSeconds > 0),
  "routing rules are positive",
);
assert(
  ROUTING_HOURLY_RATE_RULES.every((r) => r.windowSeconds === 3600),
  "only the hourly routing window remains in the DB; the per-minute burst moved to the edge (#961)",
);
{
  const routingPrefixes = new Set(ROUTING_HOURLY_RATE_RULES.map((r) => r.prefix));
  assert(
    routingPrefixes.size === ROUTING_HOURLY_RATE_RULES.length,
    "routing rule prefixes are distinct (separate counters)",
  );
  assert(
    BOOKING_HOURLY_RATE_RULES.every((r) => !routingPrefixes.has(r.prefix)) &&
      DIRECT_BOOKING_API_HOURLY_RATE_RULES.every((r) => !routingPrefixes.has(r.prefix)),
    "routing counters use different prefixes than the booking counters",
  );
}

// #597: the direct booking API was capped PER KEY only, so a leaked integrator key
// had a 6000/hr ceiling and no secondary bound. The per-IP ceiling is the backstop:
// it only buys anything if it is genuinely LOWER than the per-key ceiling, otherwise
// the key limit trips first and the IP rule is decoration. The per-minute backstop
// moved to the edge (BOOKINGAPI_IP_RATE_LIMITER, #961); the hourly backstop stays here.
{
  const keyHourly = DIRECT_BOOKING_API_HOURLY_RATE_RULES.find((r) => r.windowSeconds === 3600)!;
  const ipHourly = DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES.find((r) => r.windowSeconds === 3600)!;

  assert(
    DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES.every((r) => r.windowSeconds === 3600),
    "only the hourly per-IP backstop remains in the DB; the per-minute backstop moved to the edge (#961)",
  );
  assert(
    ipHourly.max < keyHourly.max,
    "per-IP hourly ceiling is BELOW the per-key ceiling, so it actually bounds a leaked key (#597)",
  );

  // The auto-booker does roughly 2000/day (~83/hr). The ceiling must clear that with
  // real headroom or a burst throttles genuine bookings, which is worse than the risk
  // being mitigated.
  assert(
    ipHourly.max >= 1000,
    "per-IP hourly ceiling leaves headroom over the auto-booker's real volume (~83/hr) (#597)",
  );
  assert(ipHourly.max === 1200, "per-IP hourly ceiling is 1200/hr (#597)");
  // The hourly backstop keeps alerting on block: a block still means the ceiling is
  // too tight or a key leaked, the same signal the moved per-minute backstop carries
  // at the edge.
  assert(
    ipHourly.alertOnBlock === true,
    "per-IP hourly backstop alerts on block (a block is itself a signal, #796)",
  );

  // Separate buckets: an IP counter must never draw down the key's budget or vice
  // versa, or one flood would trip both and the two ceilings collapse into one.
  const keyPrefixes = DIRECT_BOOKING_API_HOURLY_RATE_RULES.map((r) => r.prefix);
  const ipPrefixes = DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES.map((r) => r.prefix);
  assert(
    ipPrefixes.every((p) => !keyPrefixes.includes(p)),
    "per-IP counters use distinct prefixes from the per-key counters (#597)",
  );
  assert(
    ipPrefixes.every((p) => !READ_PREFIXES.includes(p)),
    "per-IP counters do not collide with the read counters (#597)",
  );
}

// Human-readable alert copy: a limiter alert lands in Slack in front of a
// non-technical on-call. It must describe the impact in plain language and must
// NEVER dump a code identifier or a raw Error (that detail belongs in the logs).
// This regression exists because the availability fail-open alert used to
// interpolate String(err), which in dev is a Next.js config stack trace nobody
// on-call can read.
{
  // Internal key prefixes map to a plain area name.
  eq(friendlyRateArea("book:h"), "public booking", "book prefix -> public booking");
  eq(friendlyRateArea("bookapi:ip:m"), "booking API", "bookapi prefix -> booking API");
  eq(friendlyRateArea("routing:h"), "routing lookup", "routing prefix -> routing lookup");
  eq(friendlyRateArea("mystery:x"), "a Slate endpoint", "unknown prefix -> a safe generic");

  // Tokens that must never appear in any human-facing alert.
  const CODE_TOKENS = [
    "getCloudflareContext",
    "initOpenNext",
    "rate_limit_hit",
    "rate_limit_refund",
    "AVAIL_RATE_LIMITER",
    "BOOKING_RATE_LIMITER",
    "Error:",
    "undefined",
    "book:h",
    "bookapi",
    "routing:",
    "::",
    "{",
    "}",
    String.fromCharCode(0x2014), // em dash
    String.fromCharCode(0x2013), // en dash
  ];
  const clean = (label: string, text: string) => {
    for (const t of CODE_TOKENS) {
      assert(!text.includes(t), `${label} alert is free of the code token ${JSON.stringify(t)}`);
    }
    assert(
      !/^\s*Slate\b/i.test(text),
      `${label} alert does not open with a redundant Slate label (the app name says it)`,
    );
    assert(text.length > 40, `${label} alert actually explains something`);
  };

  const failOpen = limiterFailOpenAlert("booking availability");
  clean("fail-open", failOpen);
  assert(/availab/i.test(failOpen), "fail-open alert names the affected area in plain words");

  const blocked = limiterBlockedAlert("booking API", "203.0.113.7", 60, 60);
  clean("blocked", blocked);
  assert(blocked.includes("203.0.113.7"), "blocked alert keeps the human-meaningful IP");
  assert(blocked.includes("per minute"), "blocked alert states the window in plain words");

  const refund = refundFailedAlert("booking API");
  clean("refund", refund);
}

finish();
