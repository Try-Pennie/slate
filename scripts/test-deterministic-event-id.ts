// P4a (#439): the Google client event id must be a deterministic, valid base32hex
// id keyed on the idempotency key AND the assigned agent — so a same-key re-submit
// that lands on the SAME agent reuses the event (Google 409s), while two DIFFERENT
// agents get DIFFERENT ids (a Google client id is unique per calendar, so keying on
// the agent is what prevents the "same id on two calendars = duplicate" failure).
// Run: node --experimental-strip-types scripts/test-deterministic-event-id.ts
import { deterministicEventId } from "../src/lib/booking/core.ts";
import { assert, finish } from "./lib/harness.ts";

const KEY = "411|2026-06-08T13:00:00.000Z|k@x.com||";

async function run() {
  const id = await deterministicEventId(KEY, "agent-a");

  // Google client-id rules: chars are base32hex (lowercase a-v + digits 0-9),
  // length 5-1024.
  assert(/^[0-9a-v]+$/.test(id), "id uses only base32hex chars (0-9, a-v)");
  assert(id.length >= 5 && id.length <= 1024, "id length is within Google's 5-1024 bound");

  // Deterministic: same (key, agent) -> same id (so a retry reuses the event).
  const again = await deterministicEventId(KEY, "agent-a");
  assert(id === again, "same key + same agent -> identical id (retry reuses)");

  // Per-agent: same key, DIFFERENT agent -> DIFFERENT id (the duplicate guard).
  const otherAgent = await deterministicEventId(KEY, "agent-b");
  assert(id !== otherAgent, "same key, different agent -> different id");

  // Per-key: different key -> different id.
  const otherKey = await deterministicEventId("411|2026-06-08T14:00:00.000Z|k@x.com||", "agent-a");
  assert(id !== otherKey, "different key -> different id");
}

await run();

finish();
