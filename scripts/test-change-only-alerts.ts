// Change only incidents post once and again only on a change (Dan, 2026-10-26: "I got a
// ton of this alert and they were all the same. Just page once per call."). The set is one
// named list beside the catalog (`CHANGE_ONLY_KEYS`), so this guard holds it to what it
// claims:
//
//   1. every entry names a key the catalog holds, so a rename cannot leave an entry that
//      silently matches nothing and puts the old repeat back;
//   2. every entry is an INCIDENT, or a CONDITION named in `CHANGE_ONLY_CONDITIONS` with the
//      decision behind dropping its reminder (Dan, 2026-10-26, the demotion backstop: "every
//      call only pages once. i don't need an hourly update about this unless it resolves");
//      a condition keeps its all clear either way;
//   3. a sent member takes the change rule, and its hold is the change only interval
//      whatever cooldown it is handed, so no stored or coded cooldown can repeat it;
//   4. nothing outside the set moves: an ordinary incident keeps its own cooldown, a
//      lookalike family is not a member, and a condition keeps its reminder;
//   5. a batch window (`changeBatchMs`) belongs only to a change only key, and holds a new
//      subject until the window since the last post has run, unless the send marks it urgent.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-change-only-alerts.ts
import {
  CHANGE_ONLY_CONDITIONS,
  CHANGE_ONLY_KEYS,
  alertEntry,
  isChangeOnly,
} from "../src/lib/notify/alert-catalog.ts";
import {
  CHANGE_BATCH_MS,
  CHANGE_ONLY_HOLD_MS,
  CONDITION_REPEAT_MS,
  changeBatchMs,
  freshSubjects,
  heldForBatch,
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
  const allowed = entry?.kind === "incident" || (entry?.kind === "condition" && CHANGE_ONLY_CONDITIONS.includes(key));
  assert(allowed, `change only key "${key}" is an incident, or a condition named with its decision (${entry?.kind})`);
}
for (const key of CHANGE_ONLY_CONDITIONS) {
  assert(CHANGE_ONLY_KEYS.includes(key), `change only condition "${key}" is in the change only set`);
  eq(alertEntry(key)?.kind, "condition", `change only condition "${key}" is a condition`);
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

// 3, for a condition: the demotion backstop takes the change rule with no reminder,
// whatever the settings page or a coded cooldown hands it.
assert(isChangeOnly("demoted_agent_bookings"), "the demotion backstop is change only");
for (const cooldown of [5 * 60_000, CONDITION_REPEAT_MS]) {
  eq(reminderIntervalMs("demoted_agent_bookings", cooldown), CHANGE_ONLY_HOLD_MS, `the demotion backstop handed ${cooldown / HOUR}h never reminds`);
}
assert(!isChangeOnly("inactive_agent_bookings"), "the departed agent backstop beside it is not");
eq(reminderIntervalMs("inactive_agent_bookings", CONDITION_REPEAT_MS), CONDITION_REPEAT_MS, "and keeps its daily reminder");

// 5: the batch window.
for (const key of Object.keys(CHANGE_BATCH_MS)) {
  assert(CHANGE_ONLY_KEYS.includes(key), `batched key "${key}" is change only, so nothing but a new subject posts it`);
}
eq(changeBatchMs("demoted_agent_bookings"), 3 * HOUR, "the demotion backstop collects new calls for three hours (Dan, 2026-10-26)");
eq(changeBatchMs("booking_below_lead_tier:abc"), null, "the below tier page has no batch");
eq(changeBatchMs("inactive_agent_bookings"), null, "nor does a key outside the set");

eq(freshSubjects(["booking:a", "booking:b"], ["booking:b", "booking:c"]), ["booking:c"], "fresh is what the last post did not name");
eq(freshSubjects(null, ["booking:a"]), ["booking:a"], "with nothing recorded, everything is fresh");

const T = Date.UTC(2026, 9, 26, 23, 0);
const batch = { batchMs: 3 * HOUR, fresh: ["booking:c"], urgent: [] as string[] };
assert(heldForBatch({ ...batch, lastPostMs: T, nowMs: T + 2 * HOUR }), "a new call two hours after a post waits");
assert(!heldForBatch({ ...batch, lastPostMs: T, nowMs: T + 3 * HOUR }), "and posts once three hours have run");
assert(!heldForBatch({ ...batch, urgent: ["booking:c"], lastPostMs: T, nowMs: T + 10 * 60_000 }), "an urgent new call posts at once");
assert(
  heldForBatch({ ...batch, urgent: ["booking:a"], lastPostMs: T, nowMs: T + HOUR }),
  "an urgent call that was already told does not carry a new one past the batch",
);
assert(!heldForBatch({ ...batch, lastPostMs: null, nowMs: T }), "a last post nobody can date holds nothing (the loud side)");
assert(!heldForBatch({ ...batch, fresh: [], lastPostMs: T, nowMs: T + HOUR }), "nothing fresh is not the batch's to hold");

finish();
