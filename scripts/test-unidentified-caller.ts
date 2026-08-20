// What a rate limit does when it cannot tell who the caller is (#1557).
//
// `clientIp` returns a literal fallback when no address header is present, and
// that value is a SHARED BUCKET, not an address: every limit keyed on it counts
// unrelated callers against one counter, so a per-address ceiling silently
// becomes a global one, and the first thing a global-by-accident ceiling refuses
// is a real lead (L75). #1536 decided it for the burst ceiling alone. This is the
// decision for every address keyed limit, stated per limit rather than assumed.
//
// The answer is deliberately NOT the same everywhere: refusing an unidentifiable
// caller is right for the client error beacon (dropping a report costs a log
// line) and wrong for the booking confirm (it refuses a customer). So what is
// tested here is that each limit HAS an answer, that the answer is enforced at
// the key rather than at one call site somebody remembered, and that declining
// to judge is never silent, because behind Cloudflare this cannot happen and
// something in front of us that should not be there is itself news.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-unidentified-caller.ts
import {
  UNIDENTIFIED_IP,
  EDGE_LIMITERS,
  CLIENT_ERROR_ADDRESS_POLICY,
  BOOKING_LIMITER,
  BOOKING_API_IP_LIMITER,
  ROUTING_LIMITER,
  AVAILABILITY_LIMITER,
  judgeCaller,
  rateLimitKey,
  type AddressLimitPolicy,
} from "../src/lib/rate-limit-core.ts";
import { unidentifiedCallerAlert } from "../src/lib/rate-limit-core.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

/** Em/en dash detector built from escapes, so this file holds no literal dash. */
const DASHES = new RegExp("[\\u2013\\u2014]");

const root = join(import.meta.dirname, "..");

// --- every address keyed limit has stated an answer ----------------------------
// Enumerated from the limiter table rather than from a hand kept list, so a
// seventh limiter is covered by construction: a list somebody has to remember to
// extend only ever checks the entries that were already safe (L96).
{
  const addressLimits: AddressLimitPolicy[] = [
    ...EDGE_LIMITERS.filter((l) => l.keyKind === "ip"),
    CLIENT_ERROR_ADDRESS_POLICY,
  ];
  assert(addressLimits.length >= 5, "the address keyed limits are enumerated, not listed by hand");

  for (const limit of addressLimits) {
    assert(
      limit.onUnidentified === "serve" || limit.onUnidentified === "refuse",
      `${limit.area} states what it does with an unidentifiable caller`,
    );
    // The reason has to name what STILL bounds the caller when we decline to
    // judge, or "serve" is indistinguishable from having no ceiling at all.
    assert(
      limit.unidentifiedWhy.length > 40,
      `${limit.area} says why, and what still bounds an unidentifiable caller`,
    );
    assert(!DASHES.test(limit.unidentifiedWhy), `${limit.area}'s reason has no dashes`);
  }

  // The two the issue names, so an accidental flip of either is a failing test
  // rather than a silent change of who gets refused.
  assert(
    BOOKING_LIMITER.onUnidentified === "serve",
    "the public booking confirm serves a caller it cannot identify: refusing one refuses a customer",
  );
  assert(
    CLIENT_ERROR_ADDRESS_POLICY.onUnidentified === "refuse",
    "the client error beacon refuses one: dropping a report costs a log line, and it is a public path to Slack",
  );
  assert(ROUTING_LIMITER.onUnidentified === "serve", "the routing lookup sits in the lead path too");
  assert(
    AVAILABILITY_LIMITER.onUnidentified === "serve",
    "availability is a cached read in front of a lead",
  );
  assert(
    BOOKING_API_IP_LIMITER.onUnidentified === "serve",
    "the API address backstop declines to judge, and the per key ceiling still bounds the caller",
  );
}

// --- the verdict, and the key it is enforced at --------------------------------
{
  for (const limit of [BOOKING_LIMITER, CLIENT_ERROR_ADDRESS_POLICY]) {
    assert(
      judgeCaller(limit, "203.0.113.9") === "identified",
      `${limit.area}: a real address is judged normally`,
    );
  }
  assert(
    judgeCaller(BOOKING_LIMITER, UNIDENTIFIED_IP) === "serve-unjudged",
    "a serve limit does not COUNT an unidentifiable caller, rather than counting them together",
  );
  assert(
    judgeCaller(CLIENT_ERROR_ADDRESS_POLICY, UNIDENTIFIED_IP) === "refuse",
    "a refuse limit turns an unidentifiable caller away",
  );

  // The whole defect is the shared bucket, so the key an address limit builds must
  // never be the fallback value: `serve-unjudged` means no counter is touched.
  assert(
    rateLimitKey({ kind: "address", ip: "203.0.113.9", policy: BOOKING_LIMITER }) === "203.0.113.9",
    "an identified address keys on itself",
  );
  assert(
    rateLimitKey({ kind: "address", ip: "203.0.113.9", keyPrefix: "ip:", policy: BOOKING_API_IP_LIMITER }) ===
      "ip:203.0.113.9",
    "the API backstop keeps its own key space",
  );
  // An opaque key came from auth, so it can never be the address fallback, and an
  // address rule must not be applied to it: an integrator who happened to name a
  // key "unknown" would otherwise be the one caller never counted at all.
  assert(
    judgeCaller(null, UNIDENTIFIED_IP) === "identified",
    "an opaque key is not an address, so the address rule never applies to it",
  );
  assert(
    rateLimitKey({ kind: "opaque", key: `key:${UNIDENTIFIED_IP}` }) === "key:unknown",
    "an opaque key is used verbatim, fallback shaped or not",
  );
}

// --- declining to judge is never silent ----------------------------------------
// Behind Cloudflare `cf-connecting-ip` is always set, so reaching the fallback at
// all means something is in front of us that should not be. A limit that quietly
// stopped applying would look exactly like a limit nobody was hitting.
{
  const text = unidentifiedCallerAlert(BOOKING_LIMITER);
  assert(text.length > 80, "the report says which ceiling stopped applying and to what");
  assert(text.includes(BOOKING_LIMITER.friendly), "it names the endpoint in plain language");
  assert(!DASHES.test(text), "the report has no dashes");
  assert(!/^Slate\b/.test(text), "it does not open by repeating the app name Slack already shows");
  assert(
    !text.includes(UNIDENTIFIED_IP) || !/\bunknown:/.test(text),
    "it does not paste the internal key value at a reader",
  );

  const refusing = unidentifiedCallerAlert(CLIENT_ERROR_ADDRESS_POLICY);
  assert(
    refusing !== text,
    "a limit that REFUSED and one that served say different things: the reader has to know whether anything was turned away",
  );
}

// --- built is not wired (L3) ---------------------------------------------------
// Every assertion above holds if no route consults any of it, and the symptom
// would be the original defect with a green suite. The enforcement primitives are
// what the routes reach through, so the check is that they carry the decision.
{
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const limit = strip(readFileSync(join(root, "src", "lib", "rate-limit.ts"), "utf8"));
  assert(limit.includes("judgeCaller("), "the enforcement primitives ask for the caller's verdict");
  assert(
    limit.includes("unidentifiedCallerAlert("),
    "and report it, rather than declining to judge in silence",
  );

  // The beacon is the one limit that REFUSES, and it is the one where a missed
  // wiring is invisible: a dropped report and a report nobody sent look the same.
  const beacon = strip(readFileSync(join(root, "src", "app", "api", "client-errors", "route.ts"), "utf8"));
  assert(
    beacon.includes("CLIENT_ERROR_ADDRESS_POLICY"),
    "the beacon passes its own policy rather than a bare address",
  );

  // Every route that limits by address names the policy it is enforcing, so a
  // route cannot quietly borrow another endpoint's answer. `tsc` already refuses
  // a bare address (the parameter is a descriptor, not a string); this is the
  // half a type cannot state, which is that the descriptor carries the RIGHT
  // limit's decision.
  for (const [file, policy] of [
    [["src", "app", "booking", "route.ts"], "BOOKING_LIMITER"],
    [["src", "app", "api", "routing", "route.ts"], "ROUTING_LIMITER"],
    [["src", "lib", "booking", "route-auth.ts"], "BOOKING_API_IP_LIMITER"],
    [["src", "app", "api", "client-errors", "route.ts"], "CLIENT_ERROR_ADDRESS_POLICY"],
  ] as [string[], string][]) {
    const code = strip(readFileSync(join(root, ...file), "utf8"));
    assert(
      code.includes(policy),
      `${file.join("/")} enforces ${policy}'s own answer for an unidentifiable caller`,
    );
  }
}

finish();
