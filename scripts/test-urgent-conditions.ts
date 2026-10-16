// #3801 (Dan, 2026-10-16): the conditions whose meaning is that leads are being lost
// or turned away right now keep an HOURLY repeat; every other condition goes to the
// 24 hour repeat. The set is one named list beside the catalog
// (`URGENT_CONDITION_KEYS`), so this guard holds it to what it claims:
//
//   1. every entry names a key the catalog actually holds, so a rename cannot leave
//      an entry that silently matches nothing and drops a live outage to daily;
//   2. every entry is a CONDITION, because the repeat rule never applies to an
//      incident or an info key, so one listed here would read as urgent and change
//      nothing;
//   3. the tunable members' coded defaults are the hourly repeat, and every other
//      tunable condition's is a day or longer, so the defaults and the set agree;
//   4. the dispatcher answers hourly for an urgent key nobody can tune, and a day for
//      a condition that is not urgent, whatever coded cooldown it is handed.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-urgent-conditions.ts
import {
  ALERT_CATALOG,
  URGENT_CONDITION_KEYS,
  alertEntry,
  isUrgentCondition,
} from "../src/lib/notify/alert-catalog.ts";
import {
  CONDITION_REPEAT_MS,
  URGENT_CONDITION_REPEAT_MS,
  reminderIntervalMs,
  settingKeyFor,
} from "../src/lib/notify/repeat-policy.ts";
import { ALERT_KEYS } from "../src/lib/monitor/alert-keys.ts";
import { MONITOR_DEFAULTS } from "../src/lib/monitor/settings.ts";
import { assert, eq, finish } from "./lib/harness.ts";

assert(URGENT_CONDITION_KEYS.length >= 5, `the urgent set is populated (${URGENT_CONDITION_KEYS.length})`);
eq(new Set(URGENT_CONDITION_KEYS).size, URGENT_CONDITION_KEYS.length, "no key is listed twice");

for (const key of URGENT_CONDITION_KEYS) {
  const entry = alertEntry(key);
  assert(entry !== undefined, `urgent key "${key}" is in the alert catalog`);
  eq(entry?.kind, "condition", `urgent key "${key}" is a condition`);
}

// The sent form of a family member is urgent too, and a neighbour sharing a prefix is not.
assert(isUrgentCondition("empty_tier:low"), "a member of an urgent family is urgent");
assert(!isUrgentCondition("empty_tier"), "the bare family prefix is not a sent key");
assert(!isUrgentCondition("coverage_needs_human"), "a condition outside the set is not urgent");
assert(!isUrgentCondition("verify_on_book_outage"), "an incident is never urgent, even one named in the decision");

// 3: the tunable defaults agree with the set.
const sentFormOf = (settingKey: string): string => {
  const family = ALERT_CATALOG.find((e) => e.key === `${settingKey}:*`);
  return family ? `${settingKey}:x` : settingKey;
};
for (const key of ALERT_KEYS) {
  const sent = sentFormOf(key);
  const entry = ALERT_CATALOG.find((e) => e.key === key || e.key === `${key}:*`);
  if (entry?.kind !== "condition") continue;
  const coded = MONITOR_DEFAULTS.cooldownMs[key];
  if (isUrgentCondition(sent)) {
    eq(coded, URGENT_CONDITION_REPEAT_MS, `urgent condition ${key} defaults to the hourly repeat`);
  } else {
    // 23 hours is the advisor photo refresh's deliberate "next morning's run" interval.
    assert(
      coded >= CONDITION_REPEAT_MS - 60 * 60_000,
      `condition ${key} defaults to a day or longer (got ${coded / 3_600_000}h)`,
    );
  }
}

// 4: the floor for conditions nobody can tune.
eq(settingKeyFor("cron_lane_stale:smoke-canary"), null, "a stale lane is not tunable");
eq(reminderIntervalMs("cron_lane_stale:smoke-canary", 60 * 60_000), CONDITION_REPEAT_MS, "an hourly coded lane interval reads as a day");
eq(reminderIntervalMs("cron_lane_stale:smoke-canary", 7 * 24 * 3_600_000), 7 * 24 * 3_600_000, "a longer coded interval is kept");
eq(settingKeyFor("booking_api_credential"), "booking_failure_rate", "the booking API pages borrow the failure rate setting");
eq(reminderIntervalMs("booking_api_credential", 2 * 3_600_000), 2 * 3_600_000, "so a stored value there still decides");
eq(reminderIntervalMs("verify_on_book_outage", 15 * 60_000), 15 * 60_000, "an incident keeps its own throttle");
eq(reminderIntervalMs("not_a_catalog_key", 5 * 60_000), 5 * 60_000, "an unclassified key keeps what it is handed");

finish();
