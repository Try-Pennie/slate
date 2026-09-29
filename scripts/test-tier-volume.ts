// The low volume alarm for every tier judged beside Low (#2874). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-tier-volume.ts
//
// What this pins, each with a control (L159):
// - each tier is judged on its OWN count and its own key, so one tier going quiet
//   pages that tier and nothing else;
// - a tier whose count cannot be read clears nothing (#1134, #1152);
// - with no tier learned beside Low, nothing is read at all.
import { runTierVolumeChecks } from "../src/lib/monitor/tier-volume.ts";
import type { BusinessHoursConfig } from "../src/lib/monitor/booking-volume.ts";
import type { FloorCell, VolumeBaseline } from "../src/lib/monitor/volume-floors.ts";
import { MEASURED_VOLUME_BASELINE } from "../src/lib/monitor/volume-baseline.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const HOURS: BusinessHoursConfig = {
  zone: "America/New_York",
  rules: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_minute: 8 * 60, end_minute: 20 * 60 })),
  exceptions: [],
};
// A Tuesday, 2pm Eastern.
const NOW = Date.parse("2026-12-15T19:00:00Z");

function flat(floor30: number, floor120: number): VolumeBaseline {
  return {
    ...MEASURED_VOLUME_BASELINE,
    source: "slate",
    cells: Array.from({ length: 7 }, () =>
      Array.from({ length: 24 }, (): FloorCell => ({ floor30, floor120, typical120: floor120 * 3 })),
    ),
  };
}

function harness(opts: {
  baselines: Partial<Record<string, VolumeBaseline>>;
  counts: Record<string, number | null>;
}) {
  const sent: { key: string; text: string }[] = [];
  const resolved: { key: string; text: string }[] = [];
  const reads: string[] = [];
  const run = () =>
    runTierVolumeChecks({
      nowMs: NOW,
      businessHours: HOURS,
      baselines: opts.baselines,
      countSince: async (tier) => {
        reads.push(tier);
        return tier in opts.counts ? opts.counts[tier]! : 0;
      },
      armed: true,
      cooldownMs: 30 * 60_000,
      notify: async (key, _ms, text) => void sent.push({ key, text }),
      notifyCountUnreadable: async (key, _ms, text) => void sent.push({ key, text }),
      resolveRecovered: async (r) => {
        resolved.push(...r);
        return [];
      },
    });
  return { run, sent, resolved, reads };
}

// --- each tier on its own count and its own key ---
{
  const h = harness({ baselines: { "2": flat(1, 4), "3": flat(1, 4) }, counts: { "2": 0, "3": 12 } });
  const out = await h.run();
  eq(Object.keys(out).sort(), ["2", "3"], "every tier learned beside Low is judged");
  eq(h.sent.map((s) => s.key), ["low_tier_volume:2"], "only the quiet tier pages, on its own key");
  assert(/^Medium booking volume is low/.test(h.sent[0]?.text ?? ""), "naming it");
  assert(h.resolved.some((r) => r.key === "low_tier_volume:3"), "the healthy tier clears its own page");
  assert(!h.resolved.some((r) => r.key === "low_tier_volume:2"), "and the quiet one is not cleared");
  assert(!h.resolved.some((r) => r.key === "low_booking_volume"), "and nothing of Low's is touched by either");
}

// --- a tier whose count cannot be read clears nothing ---
{
  const h = harness({ baselines: { "4": flat(1, 4) }, counts: { "4": null } });
  const out = await h.run();
  eq(out["4"]?.status, "count-unreadable", "an unreadable count is its own outcome, never a low reading");
  eq(h.resolved.length, 0, "and it sends no all-clear of any kind");
  eq(h.sent.map((s) => s.key), ["volume_count_unreadable"], "it says the count could not be read, on that key");
  // Control: the same tier, readable and healthy, does clear.
  const ok = harness({ baselines: { "4": flat(1, 4) }, counts: { "4": 20 } });
  await ok.run();
  assert(ok.resolved.some((r) => r.key === "low_tier_volume:4"), "control: a readable healthy count clears the tier's page");
}

// --- nothing learned beside Low: nothing is read ---
{
  const h = harness({ baselines: {}, counts: {} });
  const out = await h.run();
  eq(Object.keys(out), [], "no tier is judged");
  eq(h.reads.length, 0, "and no count is read, so the lane pays nothing before a second tier is learned");
}

finish();
