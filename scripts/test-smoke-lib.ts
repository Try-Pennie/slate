// Unit coverage for the shared smoke-script helpers (#530 / AUD-023).
// The smoke scripts themselves hit production and are hand-run, but the plumbing
// they share (request helpers + the pass/fail checker) is pure enough to test
// here with a stubbed fetch, so a drift in one place is caught in CI.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-smoke-lib.ts
import { tokenFrom, jpost, slots, createChecker } from "./smoke-lib.ts";
import { assert, finish } from "./lib/harness.ts";

// A recording fetch stub. Each call shifts the next queued response off.
type Rec = { url: string; init: RequestInit };
function stubFetch(responses: Array<{ status: number; json: unknown }>) {
  const calls: Rec[] = [];
  const queue = [...responses];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = queue.shift() ?? { status: 200, json: {} };
    return {
      status: r.status,
      json: async () => {
        if (r.json === "INVALID") throw new Error("bad json");
        return r.json;
      },
    };
  }) as unknown as typeof fetch;
  return calls;
}

process.env.SLATE_BASE_URL = "https://test.example/";
process.env.BOOKING_API_KEY_CANARY = "test-key";

// --- tokenFrom: pure last-path-segment extraction ---
assert(tokenFrom("https://x/manage/abc123") === "abc123", "tokenFrom returns the last path segment");
assert(tokenFrom(undefined) === "", "tokenFrom is safe on undefined");
assert(tokenFrom(null) === "", "tokenFrom is safe on null");

// --- jpost: base+path, JSON body, auth header only when asked ---
{
  const calls = stubFetch([{ status: 201, json: { ok: true } }]);
  const r = await jpost("/api/bookings", { a: 1 });
  assert(r.status === 201 && (r.body as { ok?: boolean }).ok === true, "jpost returns status + parsed body");
  assert(calls[0].url === "https://test.example/api/bookings", "jpost strips the trailing slash off base and joins path");
  const h = calls[0].init.headers as Record<string, string>;
  assert(h["content-type"] === "application/json", "jpost sets JSON content-type");
  assert(h.authorization === undefined, "jpost omits the auth header by default");
  assert(calls[0].init.method === "POST" && calls[0].init.body === JSON.stringify({ a: 1 }), "jpost POSTs the JSON body");
}
{
  const calls = stubFetch([{ status: 200, json: {} }]);
  await jpost("/api/x", {}, true);
  const h = calls[0].init.headers as Record<string, string>;
  assert(h.authorization === "Bearer test-key", "jpost adds the bearer auth header when auth=true");
}
{
  stubFetch([{ status: 200, json: "INVALID" }]);
  const r = await jpost("/api/x", {});
  assert(JSON.stringify(r.body) === "{}", "jpost falls back to {} when the response is not JSON");
}

// --- slots: parameterized by bucket; [] on any non-200 or missing field ---
{
  const calls = stubFetch([{ status: 200, json: { slots: ["s1", "s2"] } }]);
  const s = await slots("SMOKE");
  assert(JSON.stringify(s) === JSON.stringify(["s1", "s2"]), "slots returns the slot array on 200");
  assert(calls[0].url === "https://test.example/api/availability?bucket=SMOKE", "slots queries the availability endpoint for the given bucket");
  assert((calls[0].init.headers as Record<string, string>).authorization === "Bearer test-key", "slots sends the bearer key");
}
{
  stubFetch([{ status: 500, json: { slots: ["nope"] } }]);
  assert((await slots("SMOKE")).length === 0, "slots returns [] on a non-200 status");
}
{
  stubFetch([{ status: 200, json: {} }]);
  assert((await slots("SMOKE")).length === 0, "slots returns [] when the body has no slots field");
}

// --- createChecker: isolated pass/fail counting ---
{
  const { check, failed } = createChecker({ name: "The test smoke" });
  check(true, "a pass");
  assert(failed() === 0, "createChecker: a passing check leaves the count at 0");
  check(false, "a fail");
  assert(failed() === 1, "createChecker: a failing check increments the count");
  const other = createChecker({ name: "The test smoke" });
  assert(other.failed() === 0, "createChecker: each checker is independent");
}

finish();
