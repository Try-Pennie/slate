// Change only incidents post once and again only on a change (Dan, 2026-10-26: "I got a
// ton of this alert and they were all the same. Just page once per call."). The set is one
// named list beside the catalog (`CHANGE_ONLY_KEYS`), so this guard holds it to what it
// claims:
//
//   1. every entry names a key the catalog holds, so a rename cannot leave an entry that
//      silently matches nothing and puts the old repeat back;
//   2. every entry is an INCIDENT: a condition already has the change rule, and its
//      reminder is part of how its all clear is read, so listing one would change it;
//   3. a sent member takes the change rule, and its hold is the change only interval
//      whatever cooldown it is handed, so no stored or coded cooldown can repeat it;
//   4. nothing outside the set moves: an ordinary incident keeps its own cooldown, a
//      lookalike family is not a member, and a condition keeps its reminder.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-change-only-alerts.ts
import { CHANGE_ONLY_KEYS, alertEntry, isChangeOnly } from "../src/lib/notify/alert-catalog.ts";
import {
  CHANGE_ONLY_HOLD_MS,
  CONDITION_REPEAT_MS,
  isRepeatRuled,
  reminderIntervalMs,
} from "../src/lib/notify/repeat-policy.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const HOUR = 60 * 60_000;

assert(CHANGE_ONLY_KEYS.length >= 1, `the change only set is populated (${CHANGE_ONLY_KEYS.length})`);
eq(new Set(CHANGE_ONLY_KEYS).size, CHANGE_ONLY_KEYS.length, "no key is listed twice");

// 1 and 2.
for (const key of CHANGE_ONLY_KEYS) {
  const entry = alertEntry(key);
  assert(entry !== undefined, `change only key "${key}" is in the alert catalog`);
  eq(entry?.kind, "incident", `change only key "${key}" is an incident`);
}

// 3: a sent member.
const member = "booking_below_lead_tier:5f1c2d3e-0000-4000-8000-000000000001";
assert(isChangeOnly(member), "a member of the below tier family is change only");
assert(isRepeatRuled(member), "so the dispatcher's change rule applies to it");
for (const cooldown of [5 * 60_000, 6 * HOUR, CONDITION_REPEAT_MS, 30 * 24 * HOUR]) {
  eq(reminderIntervalMs(member, cooldown), CHANGE_ONLY_HOLD_MS, `handed ${cooldown / HOUR}h, it holds for the change only interval`);
}
assert(CHANGE_ONLY_HOLD_MS >= 365 * 24 * HOUR, "the hold outlasts any call a member is about");
assert(Number.isFinite(CHANGE_ONLY_HOLD_MS), "the hold is finite, so a failed send's retry stamp can be worked out from it");

// 4: nothing else moves.
assert(!isChangeOnly("booking_below_lead_tier"), "the bare family prefix is not a sent key");
assert(!isChangeOnly("booking_below_lead_tierX:abc"), "a lookalike family is not a member");
assert(!isChangeOnly("booking_offsite_origin:abc"), "another per booking incident is not a member");
assert(!isRepeatRuled("booking_offsite_origin:abc"), "and keeps no change rule");
eq(reminderIntervalMs("booking_offsite_origin:abc", 7 * 24 * HOUR), 7 * 24 * HOUR, "so its own cooldown still decides");
assert(!isChangeOnly("cross_system_booking:abc"), "a per booking condition is not a member");
eq(reminderIntervalMs("cross_system_booking:abc", CONDITION_REPEAT_MS), CONDITION_REPEAT_MS, "and keeps its daily reminder");

finish();
