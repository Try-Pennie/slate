// TDD test for parseStampMs (#1169): stored monitoring timestamps must parse to
// finite epoch ms or null, NEVER NaN. Every NaN that escaped a Date.parse at a
// monitoring comparison landed on the HEALTHY side (NaN compares false), so a
// corrupt stamp silently disabled the dead-man's switch, alert cooldowns, or the
// Google watch renewal. Callers map null to their own fail-safe side.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-parse-stamp.ts
import { parseStampMs } from "../src/lib/date/stamp.ts";
import { assert, finish } from "./lib/harness.ts";

const iso = "2026-07-29T12:00:00.000Z";
assert(parseStampMs(iso) === Date.parse(iso), "a valid ISO stamp parses to its epoch ms");
assert(
  parseStampMs("2026-07-29 08:00:00+00") === Date.parse("2026-07-29 08:00:00+00"),
  "a Postgres-style timestamptz parses",
);

assert(parseStampMs(null) === null, "null -> null (no stamp)");
assert(parseStampMs(undefined) === null, "undefined -> null (no stamp)");
assert(parseStampMs("") === null, "empty string -> null, not NaN");
assert(parseStampMs("not-a-timestamp") === null, "garbage -> null, not NaN");
assert(parseStampMs("2026-13-99T99:99:99Z") === null, "impossible date -> null, not NaN");

// The contract that matters: the result is either null or a FINITE number, so no
// caller can ever receive a NaN that compares false against every threshold.
for (const input of [iso, null, undefined, "", "garbage"]) {
  const out = parseStampMs(input as string | null | undefined);
  assert(out === null || Number.isFinite(out), `never NaN (input=${JSON.stringify(input)})`);
}

finish();
