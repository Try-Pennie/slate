/**
 * #3784: when Google and Supabase stall together, suspect the Cloudflare location
 * first. One predicate decides what a stall is, for the booking timeout page (one
 * confirm's own calls) and the Google breaker page (this isolate's recent calls), and
 * the colo every answer from a Cloudflare fronted service names is read off its
 * `cf-ray` by one helper.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-dependency-stall.ts
 */
import {
  DEPENDENCY_STALL_MS,
  STALLED_TOGETHER_WINDOW_MS,
  forgetDependencyCalls,
  isStall,
  noteDependencyCall,
  recentStall,
  stalledTogether,
} from "../src/lib/dependency-stall.ts";
import { coloFromRay } from "../src/lib/http/cf-ray.ts";
import { requestCfColo } from "../src/lib/http/request-cf-colo.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- what a stall is -------------------------------------------------------------
assert(!isStall(DEPENDENCY_STALL_MS - 1), "a call just under the threshold is not a stall");
assert(isStall(DEPENDENCY_STALL_MS), "a call at the threshold is a stall");
assert(!isStall(null), "no call made is not a stall (L90: absence is never a measurement)");

// --- both, or neither ------------------------------------------------------------
eq(stalledTogether({ google: 8_000, supabase: 3_100 }), { googleMs: 8_000, supabaseMs: 3_100 }, "both slow: stalled together, with each one's slowest call");
eq(stalledTogether({ google: 8_000, supabase: 40 }), null, "Google alone slow: not together, so Google keeps the blame");
eq(stalledTogether({ google: 300, supabase: 9_000 }), null, "Supabase alone slow: not together, so Supabase keeps the blame");
eq(stalledTogether({ google: 8_000, supabase: null }), null, "no Supabase call at all: nothing measured it, so not together");

// --- this isolate's memory of recent stalls (the breaker page reads it) -----------
{
  forgetDependencyCalls();
  const t0 = 1_000_000;
  noteDependencyCall("supabase bookings", 30, t0, "SEA");
  eq(recentStall("supabase", t0), null, "a quick answer is no stall");
  noteDependencyCall("supabase", 3_200, t0 + 1_000, null);
  eq(
    recentStall("supabase", t0 + 2_000),
    { ms: 3_200, at: t0 + 1_000, colo: "SEA" },
    "a slow call is remembered, with the colo this isolate's answers last came from (the stalled call itself may never have answered)",
  );
  eq(recentStall("google", t0 + 2_000), null, "a dependency is remembered by its own first word only");
  eq(
    recentStall("supabase", t0 + 1_000 + STALLED_TOGETHER_WINDOW_MS + 1),
    null,
    "a stall older than the window is not the same minutes",
  );
  noteDependencyCall("supabase", 2_500, t0 + 5_000, "PDX");
  eq(recentStall("supabase", t0 + 6_000)?.colo, "PDX", "the latest answer's colo is the one named");
  forgetDependencyCalls();
  eq(recentStall("supabase", t0 + 6_000), null, "forgetting clears the memory");
  noteDependencyCall("constructor", 9_000, t0, null);
  eq(recentStall("toString", t0), null, "a first word like an inherited name is just another dependency (L738)");
}

// --- the colo a cf-ray names -------------------------------------------------------
eq(coloFromRay("8f2c1a9b4d5e6f70-SEA"), "SEA", "a cf-ray's suffix is the colo");
eq(coloFromRay(" 8f2c1a9b4d5e6f70-EWR "), "EWR", "surrounding space is ignored");
eq(coloFromRay(null), null, "no header, no colo");
eq(coloFromRay("garbage"), null, "an unreadable ray is no colo, never a guess");

// --- request.cf.colo as the runtime reports it -------------------------------------
eq(requestCfColo(() => ({ colo: "ORD" })), "ORD", "request.cf.colo as given");
eq(requestCfColo(() => undefined), null, "no cf object (node, next dev): absent");
eq(requestCfColo(() => ({ colo: 12 })), null, "a colo that is not a string is absent");
eq(
  requestCfColo(() => {
    throw new Error("no context");
  }),
  null,
  "a context that cannot be read is absent, never a throw on the confirm path",
);
eq(requestCfColo(), null, "outside the Worker the real reader finds nothing and says so");

finish();
