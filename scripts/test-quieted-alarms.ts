/**
 * #1289: which alarms are currently QUIETER than their coded default.
 *
 * Two cooldowns were stretched to a weekly repeat on purpose while the routing
 * pool is off (#1272, #1283), and nothing in the product said so. An alarm
 * quieted for a good reason is indistinguishable from an alarm that was always
 * quiet, and both of these guard the pool the landing pages will point at.
 *
 * The rule that makes this trustworthy, and the reason it is tested rather than
 * eyeballed: it must agree with the resolver the ALERTS use, never hold a second
 * copy of the defaults or a second idea of which stored values count. A stored 0
 * or a stored -5 is ignored by `resolveCooldownMs`, which falls back to the
 * default, so those rows quiet nothing and must not be reported as if they did.
 * A list that disagrees with the resolver is worse than no list: it would send
 * someone to "fix" a value that is already at its default, or stay silent about
 * one that is genuinely muted.
 *
 * Run: node --experimental-strip-types scripts/test-quieted-alarms.ts
 */
import {
  quietedAlarms,
  resolveCooldownMs,
  formatMinutes,
  MONITOR_DEFAULTS,
} from "../src/lib/monitor/settings.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const defMin = (k: keyof typeof MONITOR_DEFAULTS.cooldownMs) =>
  MONITOR_DEFAULTS.cooldownMs[k] / 60_000;

const row = (key: string, cooldown_min: number | null, updated_at = "2026-08-05T10:00:00.000Z") => ({
  key,
  cooldown_min,
  updated_at,
  updated_by: null,
});

// --- The live state this issue was filed about ---
{
  const rows = [
    row("empty_tier", 10080, "2026-08-05T10:00:00.000Z"),
    row("availability_data_anomaly", 10080, "2026-08-04T09:00:00.000Z"),
  ];
  const quiet = quietedAlarms(rows);
  eq(quiet.length, 2, "both stretched alarms are reported");
  // Most-quieted first, so the worst offender leads however long the list gets. Since
  // #3801 the empty tier page is urgent (an hourly default) and the anomaly page daily,
  // so the same week stored on both puts the empty tier furthest above its default.
  eq(quiet[0].key, "empty_tier", "the one furthest above its default leads");
  eq(quiet[0].storedMinutes, 10080, "carries the stored value");
  eq(quiet[0].defaultMinutes, defMin("empty_tier"), "and the coded default");
  eq(quiet[0].updatedAt, "2026-08-05T10:00:00.000Z", "and when it changed");
  assert(quiet[0].label.length > 0, "and the label the settings screen shows");
}

// --- Agreement with the resolver the alerts use ---
{
  // Every value the resolver IGNORES must quiet nothing. Each of these rows
  // leaves the effective cooldown at the coded default, so reporting one would
  // send somebody to fix a setting that is already correct.
  for (const bad of [0, -5, 1.5, null]) {
    const rows = [row("empty_tier", bad as number | null)];
    const effective = resolveCooldownMs(rows).empty_tier;
    eq(
      effective,
      MONITOR_DEFAULTS.cooldownMs.empty_tier,
      `a stored ${String(bad)} leaves the alert at its default`,
    );
    eq(
      quietedAlarms(rows).length,
      0,
      `and a stored ${String(bad)} is therefore reported as quieting nothing`,
    );
  }
}

{
  // A value BELOW the default makes the alarm noisier, not quieter.
  const rows = [row("empty_tier", 1)];
  eq(quietedAlarms(rows).length, 0, "a shorter cooldown is not a quieted alarm");
}

{
  // Exactly the default is not quieter than the default.
  const k = "empty_tier" as const;
  const rows = [row(k, defMin(k))];
  eq(quietedAlarms(rows).length, 0, "a value equal to the default is not reported");
  eq(quietedAlarms([row(k, defMin(k) + 1)]).length, 1, "one minute above it is");
}

{
  eq(quietedAlarms([]).length, 0, "no stored rows means nothing is quieted");
}

{
  // A row for a key the code no longer sends must not appear: it quiets nothing,
  // because nothing reads it. A rename would otherwise leave a permanent entry
  // nobody can clear from the screen.
  const rows = [row("a_retired_key", 10080)];
  eq(quietedAlarms(rows).length, 0, "a stored row for an unknown key is ignored");
}

// The defaults come from MONITOR_DEFAULTS itself, so this cannot drift into a
// second copy: bump any default and the comparison moves with it.
{
  const k = "migration_version_lag" as const;
  const justOver = defMin(k) + 1;
  const quiet = quietedAlarms([row(k, justOver)]);
  eq(quiet[0]?.defaultMinutes, defMin(k), "the default reported is the coded one, not a literal");
}

// The panel is read by a person deciding whether to act, and 10080 against 360
// makes them do arithmetic to see that one is a week and the other six hours.
{
  eq(formatMinutes(10080), "7 days", "a weekly repeat reads as days");
  eq(formatMinutes(1440), "1 day", "singular where it should be");
  eq(formatMinutes(360), "6 hours", "hours where they divide cleanly");
  eq(formatMinutes(60), "1 hour", "singular hour");
  eq(formatMinutes(30), "30 minutes", "minutes below an hour");
  eq(formatMinutes(1), "1 minute", "singular minute");
  // Never rounded into a different value: 90 is not "1 hour", and 1501 is not
  // "25 hours". Anything that divides cleanly takes the larger unit, so 1500 IS
  // 25 hours, which reads better than the raw figure.
  eq(formatMinutes(90), "90 minutes", "a value that does not divide stays in minutes");
  eq(formatMinutes(1500), "25 hours", "a clean multiple of an hour takes hours");
  eq(formatMinutes(1501), "1501 minutes", "and one that divides into nothing stays raw");
}

finish();
