// Golden-snapshot guard for the GET /api/availability response shape (#258).
//
// The cal.com drop-in embed reads this endpoint and depends on its EXACT
// response shape staying stable:
//
//   { bucket: { code }, orgName, eventType: { name, description, durationMin },
//     slots, emptyBecause, shownTier }
//
// A future refactor of the route could silently add, drop, or rename a field and
// break every embedded booker without any test noticing. This locks the contract
// two ways, both node-native with hand written fakes (no vi.mock), per the
// scripts/test-*.ts harness convention:
//
// On ADDING a field (emptyBecause arrived with #1328): the readers of this payload
// are Slate's own components, which ignore keys they do not know. widget.js only
// WARMS this endpoint (`mode: "no-cors"`, result discarded), so it never parses the
// body at all. An added field is therefore safe, while a rename or a removal still
// breaks a reader, and this guard is still the thing that makes the difference
// visible: the golden has to be edited deliberately, in the same change, with the
// reasoning attached.
//
// `slotsComputedAt` arrived with #3797: the stamp x-slots-computed-at already carries,
// in the body so the booker can hand it back with its confirm and a time refused at
// the free check can be judged a lost race. A freshness fact, not routing, and never
// rendered.
//
// `placeholderStarts` arrived with #4390: on a program lead's read only (the token in its
// header), the served starts only the placeholder advisor offers, so the confirm can tell
// them from the real slots. Never rendered, and ABSENT from every other response: the key
// is undefined there, which JSON leaves out, so an ordinary lead's body is byte for byte
// what it was (the golden below is unchanged).
//
// `shownTier` arrived with #3495: the tier whose times are on show, which the booker
// hands back with its confirm so the confirm records it instead of reading the cache
// for it. Dan, 2026-10-07, on #259: "I don't want the lead to see it. I don't care if
// it's in the background in a spot they'll never see". So it is the one routing fact
// the payload carries, never rendered; the routing block itself, and the effective
// code under a tier drop, still never leave the server.
//
//   Part A (runtime golden): builds the response from a faked slot-cache result
//   using the real filterSlotsFromNow, then deep-compares it to a frozen golden
//   object. Proves the field set/shape, that filterSlotsFromNow trimming is
//   applied, that the client-facing bucket.code is the REQUESTED code (not the
//   effective tier under fallback, #259/#601), and that routing internals never
//   leak into the payload.
//
//   Part B (route source guard): parses the actual success response literal in
//   src/app/api/availability/route.ts and asserts its nested key structure equals
//   the golden. This is what fails the build if a field is added, removed, or
//   renamed IN THE ROUTE, since Part A alone would keep passing against a stale
//   hand written projection.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-availability-response-shape.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { filterSlotsFromNow } from "../src/lib/availability/compute.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// The frozen contract. Keys are exact and ordered by level; the embed reads all
// of these and nothing else.
const GOLDEN_SHAPE = {
  top: ["bucket", "emptyBecause", "eventType", "orgName", "placeholderStarts", "shownTier", "slots", "slotsComputedAt"],
  bucket: ["code"],
  eventType: ["description", "durationMin", "name"],
};

// A clock and a min-notice that split the faked slots into one trimmed and two
// kept, so the golden proves filterSlotsFromNow actually runs.
const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const MIN_NOTICE_MIN = 120; // cutoff = 14:00Z

// A faithful hand written getBucketSlotsWithFallback() result. Note the tier
// fallback: the requested bucket ("411") had no slots, so the effective bucket
// ("415", one rung down) supplies them. result.bucket therefore carries the
// EFFECTIVE code, and the route must still report the REQUESTED code to the lead.
const fakeResult = {
  bucket: {
    id: "b-415",
    org_id: "org-1",
    code: "415",
    name: "Debt help tier 2",
    event_type_id: "et-1",
    assignment: "round_robin" as const,
    criteria: {},
    routing_form_id: null,
    fallback_user_id: null,
    is_test: false,
    created_at: "2026-01-01T00:00:00.000Z",
  },
  eventType: {
    id: "et-1",
    org_id: "org-1",
    name: "Debt consultation",
    description: "We will review your options together.",
    regal_type: "debt_consult",
    duration_min: 30,
    buffer_before_min: 0,
    buffer_after_min: 0,
    min_notice_min: MIN_NOTICE_MIN,
    daily_cap: null as number | null,
    slot_interval_min: 30,
    created_at: "2026-01-01T00:00:00.000Z",
  },
  orgName: "Pennie",
  // One before the cutoff (trimmed), one exactly at it (kept, boundary is >=),
  // one after (kept).
  slots: [
    "2026-06-10T13:00:00.000Z",
    "2026-06-10T14:00:00.000Z",
    "2026-06-10T15:00:00.000Z",
  ],
  computedAt: "2026-06-10T13:55:00.000Z" as string | null,
  routing: {
    requested_code: "411",
    effective_code: "415",
    tier_fallback: true,
    rungs_dropped: 1,
    requested_tier: "t1",
    booked_tier: "t2",
  },
};

// Mirrors the route's success projection EXACTLY (src/app/api/availability/route.ts).
// The route also runs filterSlotsFromNow the same way; Part B guards that this
// mirror has not drifted from the route source.
function buildResponseBody(result: typeof fakeResult, nowMs: number) {
  const slots = filterSlotsFromNow(result.slots, nowMs, result.eventType.min_notice_min);
  return {
    bucket: { code: result.routing.requested_code },
    orgName: result.orgName,
    eventType: {
      name: result.eventType.name,
      description: result.eventType.description,
      durationMin: result.eventType.duration_min,
    },
    slots,
    // #1328: null whenever there ARE slots, which is this fixture's case. The
    // reason itself is computed by emptyReason and tested in
    // scripts/test-empty-reason.ts; what belongs here is that the key exists and
    // that a populated response says nothing about emptiness.
    emptyBecause: slots.length === 0 ? { kind: "busy" as const } : null,
    // #3495: the tier whose times are on show, for the booker to hand back.
    shownTier: result.routing.booked_tier,
    // #3797: when the list was computed, for the booker to hand back.
    slotsComputedAt: result.computedAt ?? null,
    // #4390: undefined for an ordinary lead, so the serialized body leaves it out.
    placeholderStarts: undefined as string[] | undefined,
  };
}

// ---- Part A: runtime golden -------------------------------------------------

const GOLDEN_RESPONSE = {
  bucket: { code: "411" },
  orgName: "Pennie",
  eventType: {
    name: "Debt consultation",
    description: "We will review your options together.",
    durationMin: 30,
  },
  slots: ["2026-06-10T14:00:00.000Z", "2026-06-10T15:00:00.000Z"],
  emptyBecause: null,
  // The EFFECTIVE tier: the times on show are one rung down.
  shownTier: "t2",
  // #3797: the list's stamp, a freshness fact and not routing.
  slotsComputedAt: "2026-06-10T13:55:00.000Z",
};

const body = buildResponseBody(fakeResult, NOW_MS);

eq(JSON.stringify(body), JSON.stringify(GOLDEN_RESPONSE), "response body matches the frozen golden snapshot");

// Field set/shape, asserted level by level so an add/remove/rename is named.
eq(Object.keys(body).sort().join(","), GOLDEN_SHAPE.top.join(","), "top-level keys are exactly bucket, emptyBecause, eventType, orgName, placeholderStarts, shownTier, slots, slotsComputedAt");
assert(!JSON.stringify(body).includes("placeholderStarts"), "an ordinary lead's serialized body carries no placeholderStarts at all");
// A response WITH times must never carry a reason for emptiness: the booker keys
// its copy off this, and a stale "closed" beside a list of times would be absurd.
eq(body.emptyBecause, null, "a populated response says nothing about why it might be empty");
eq(Object.keys(body.bucket).sort().join(","), GOLDEN_SHAPE.bucket.join(","), "bucket has exactly { code }");
eq(Object.keys(body.eventType).sort().join(","), GOLDEN_SHAPE.eventType.join(","), "eventType has exactly { name, description, durationMin }");

// The privacy contract (#259/#601): routing internals never reach the client, and
// bucket.code is the REQUESTED code, not the effective tier under fallback.
assert(!("routing" in body), "routing meta is not present in the payload");
eq(body.bucket.code, "411", "bucket.code is the REQUESTED code, not the effective fallback tier");
// #3495: the tier on show is the one routing fact the payload carries. The effective
// code under the drop is not, anywhere in it.
assert(!JSON.stringify(body).includes(fakeResult.routing.effective_code), "the effective code under a tier drop appears nowhere in the payload");
eq(body.shownTier, "t2", "shownTier is the tier whose times are on show, one rung down here");

// filterSlotsFromNow trimming is preserved: the pre-cutoff slot is dropped, the
// boundary and future slots are kept, order intact.
eq(body.slots.length, 2, "one pre-cutoff slot was trimmed by filterSlotsFromNow");
assert(!body.slots.includes("2026-06-10T13:00:00.000Z"), "the pre-cutoff slot is gone");
assert(body.slots.includes("2026-06-10T14:00:00.000Z"), "the slot exactly at the cutoff is kept (>= boundary)");

// ---- Part B: route source guard --------------------------------------------

const routePath = fileURLToPath(new URL("../src/app/api/availability/route.ts", import.meta.url));
const routeSrc = readFileSync(routePath, "utf8");

// Split a brace/bracket-balanced string on its top-level commas.
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// Given source and the index of an opening brace, return the balanced { ... }.
function balancedObject(src: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  throw new Error("unbalanced object literal in route source");
}

// The property keys of an object literal `{ ... }`, at its top level only.
function objectKeys(objLiteral: string): string[] {
  const inner = objLiteral.slice(objLiteral.indexOf("{") + 1, objLiteral.lastIndexOf("}"));
  return splitTopLevel(inner)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.split(":")[0].trim());
}

// The success response is the last NextResponse.json(...) in the route (the error
// responses come earlier). Locate its object literal.
const jsonMarker = "NextResponse.json(";
const jsonIdx = routeSrc.lastIndexOf(jsonMarker);
assert(jsonIdx !== -1, "found a NextResponse.json call in the route");
const objOpen = routeSrc.indexOf("{", jsonIdx + jsonMarker.length);
const responseLiteral = balancedObject(routeSrc, objOpen);

// Sanity: confirm we grabbed the SUCCESS response, not an error one, before we
// trust its keys (a false negative here would silently stop guarding the shape).
assert(
  responseLiteral.includes("orgName") && responseLiteral.includes("slots") && !responseLiteral.includes("error"),
  "extracted the success response literal from the route",
);

const topKeys = objectKeys(responseLiteral);
eq(topKeys.slice().sort().join(","), GOLDEN_SHAPE.top.join(","), "route response top-level keys match the golden shape");

// Nested bucket and eventType object literals.
const bucketProp = splitTopLevel(responseLiteral.slice(responseLiteral.indexOf("{") + 1, responseLiteral.lastIndexOf("}")))
  .map((p) => p.trim())
  .find((p) => p.startsWith("bucket"));
const eventTypeProp = splitTopLevel(responseLiteral.slice(responseLiteral.indexOf("{") + 1, responseLiteral.lastIndexOf("}")))
  .map((p) => p.trim())
  .find((p) => p.startsWith("eventType"));

assert(!!bucketProp && !!eventTypeProp, "route response has bucket and eventType nested objects");

const bucketKeys = objectKeys(balancedObject(bucketProp!, bucketProp!.indexOf("{")));
const eventTypeKeys = objectKeys(balancedObject(eventTypeProp!, eventTypeProp!.indexOf("{")));

eq(bucketKeys.slice().sort().join(","), GOLDEN_SHAPE.bucket.join(","), "route bucket object has exactly { code }");
eq(eventTypeKeys.slice().sort().join(","), GOLDEN_SHAPE.eventType.join(","), "route eventType object has exactly { name, description, durationMin }");

// The mapping semantics the embed and #259 depend on: bucket.code comes from the
// REQUESTED routing code, and durationMin comes from the event type's duration.
assert(/bucket\s*:\s*{[^}]*routing\.requested_code/.test(responseLiteral), "route bucket.code maps from routing.requested_code");
assert(/durationMin\s*:\s*[^,]*duration_min/.test(responseLiteral), "route eventType.durationMin maps from duration_min");
assert(!/\brouting\s*:/.test(responseLiteral), "route response never includes a routing key");

finish();
