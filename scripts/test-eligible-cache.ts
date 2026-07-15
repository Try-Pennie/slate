// Tests the pure helpers for the 60s eligible-agent-set cache (#421).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-eligible-cache.ts
import { eligibleCacheKey, ELIGIBLE_TTL_SECONDS } from "../src/lib/availability/eligible-cache-key.ts";
import { eligibleAgentIdsCached } from "../src/lib/availability/eligible-cache.ts";
import type { Bucket } from "../src/lib/db/types.ts";
import { assert, finish } from "./lib/harness.ts";

// --- Cache key: pure derivation from bucket id ---
assert(typeof eligibleCacheKey("bucket-abc") === "string", "eligibleCacheKey returns a string");
assert(eligibleCacheKey("bucket-abc").includes("bucket-abc"), "cache key embeds the bucket id");
assert(
  eligibleCacheKey("bucket-abc") !== eligibleCacheKey("bucket-xyz"),
  "different bucket ids produce different keys",
);
assert(eligibleCacheKey("id-1") === eligibleCacheKey("id-1"), "same id always yields the same key");

// --- TTL constant ---
assert(typeof ELIGIBLE_TTL_SECONDS === "number", "ELIGIBLE_TTL_SECONDS is a number");
assert(ELIGIBLE_TTL_SECONDS === 60, "TTL is 60 seconds");

// --- Null cache (test env): falls through to the live resolver ---
// In Node.js there is no globalThis.caches.default, so the cache path is skipped
// and the resolver is always called. Inject a mock resolver to verify.
{
  let resolverCalls = 0;
  const fakeResult = { ids: ["user-1", "user-2"], fallbackApplied: false };
  const fakeBucket = {
    id: "test-bucket-001",
    code: "411",
    org_id: "org-1",
    name: "Test",
    event_type_id: "evt-1",
    assignment: "round_robin",
    criteria: {},
    routing_form_id: null,
    fallback_user_id: null,
    is_test: false,
    created_at: new Date().toISOString(),
  } as Bucket;

  const result = await eligibleAgentIdsCached(fakeBucket, async () => {
    resolverCalls++;
    return fakeResult;
  });

  assert(resolverCalls === 1, "null cache falls through to the live resolver (called once)");
  assert(JSON.stringify(result.ids) === JSON.stringify(fakeResult.ids), "live resolver ids are returned");
  assert(result.fallbackApplied === false, "live resolver fallbackApplied is preserved");
}

// --- Second call also uses the resolver (no caches.default in Node.js) ---
{
  let calls = 0;
  const bucket = {
    id: "test-bucket-002",
    code: "412",
    org_id: "org-1",
    name: "Test2",
    event_type_id: "evt-1",
    assignment: "round_robin",
    criteria: {},
    routing_form_id: null,
    fallback_user_id: null,
    is_test: false,
    created_at: new Date().toISOString(),
  } as Bucket;
  const resolver = async () => { calls++; return { ids: ["u3"], fallbackApplied: true }; };
  await eligibleAgentIdsCached(bucket, resolver);
  await eligibleAgentIdsCached(bucket, resolver);
  assert(calls === 2, "without CF cache both calls resolve live (consistent test-env behavior)");
}

// --- Different bucket ids use different keys (cache isolation) ---
assert(
  eligibleCacheKey("aaaa-1111-2222") !== eligibleCacheKey("bbbb-3333-4444"),
  "bucket id isolation: different uuid-style ids have different keys",
);

finish();
