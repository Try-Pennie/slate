// Every scheduled workflow watched by CANARY_STALE_BOUNDS_MS gets its OWN words.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-canary-lane-copy.ts
//
// `canaryAlertText` and `canaryRecoveryText` branch on the lane name and FALL
// THROUGH to the booking smoke canary's wording. That fallback was correct while
// two of the three lanes were the booking canary; the moment a third scheduled
// workflow stamps into the same map, a stopped daily parity sweep pages as "the
// booking smoke canary has stopped" and sends the reader to re run the wrong
// workflow. One message answering for another is how somebody spends an afternoon
// on the wrong fault (L11), and it fails silently because both messages are true
// sentences about something.
import { CANARY_STALE_BOUNDS_MS } from "@/lib/monitor/health";
import { canaryAlertText, canaryRecoveryText } from "@/lib/monitor/lane-copy";
import { assert, eq, finish } from "./lib/harness.ts";

const lanes = Object.keys(CANARY_STALE_BOUNDS_MS);
assert(lanes.length > 0, "there are lanes to check");

const alerts = new Map<string, string>();
const clears = new Map<string, string>();
for (const lane of lanes) {
  const bound = CANARY_STALE_BOUNDS_MS[lane];
  const alert = canaryAlertText(
    { lane, ageMs: bound * 2, maxStaleMs: bound, unreadable: false },
    Math.round(bound / 60_000),
  );
  const clear = canaryRecoveryText(lane);
  for (const [what, text] of [["alert", alert], ["all clear", clear]] as const) {
    assert(text.trim().length > 0, `${lane} has ${what} copy`);
    assert(!/undefined|NaN|\[object/.test(text), `${lane}'s ${what} leaks nothing`);
    assert(!/[\u2014\u2013]/.test(text), `${lane}'s ${what} uses no dashes as punctuation`);
  }
  alerts.set(lane, alert);
  clears.set(lane, clear);
}

// The whole point: two lanes may not be told about with the same sentence, because
// the sentence names which workflow stopped and what to re run.
eq(new Set(alerts.values()).size, lanes.length, "no two lanes share the same page");
eq(new Set(clears.values()).size, lanes.length, "no two lanes share the same all clear");

finish();
