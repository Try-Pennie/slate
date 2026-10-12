// The monitor lane's quarter hourly reading of the pilot split settings (#3641). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-pilot-settings-samples.ts
//
// Salesforce keeps no history of SlatePilotActive__c, SlatePilotPercent__c or
// SlatePilotTiers__c, so `pnpm report:pilot-compare` could only ASSUME the split held.
// Every quarter hour the lane stores what Salesforce held and when it was read. A failed
// read is stored as a failure with its reason and NO values, never as a split, because a
// guessed reading would vouch for a window nobody looked at (L90). No network, no
// Salesforce, no real clock: every instant is passed in.
import { readFileSync } from "node:fs";
import { assert, eq, finish } from "./lib/harness.ts";
import { runPilotSettingsSample, type PilotSettingsRow } from "../src/lib/monitor/pilot-settings-samples.ts";
import { PILOT_OFFER_INTERVAL_MS } from "../src/lib/monitor/pilot-offers.ts";
import type { PilotSettings } from "../src/lib/salesforce/pilot-settings.ts";

const NOW = Date.parse("2026-10-13T14:00:00.000Z");
const SETTINGS: PilotSettings = { active: true, percent: 50, tiers: "1;2;3;4;5", lastModified: "2026-10-12T15:00:04.000+0000" };

function fake(opts: { last?: number | null; read?: () => Promise<{ settings: PilotSettings; readAtMs: number }>; insertThrows?: boolean } = {}) {
  const state = { reads: 0, inserted: [] as PilotSettingsRow[] };
  const deps = {
    nowMs: NOW,
    lastSampledAtMs: async () => (opts.last === undefined ? null : opts.last),
    readSettings: async () => {
      state.reads++;
      return opts.read ? opts.read() : { settings: SETTINGS, readAtMs: NOW - 3 * 60_000 };
    },
    insert: async (row: PilotSettingsRow) => {
      if (opts.insertThrows) throw new Error("insert refused");
      state.inserted.push(row);
    },
  };
  return { state, deps };
}

{
  // Not due: nothing is read and nothing is stored.
  const { state, deps } = fake({ last: NOW - 5 * 60_000 });
  eq(await runPilotSettingsSample(deps), { sampled: false }, "five minutes after the last reading, none is due");
  eq([state.reads, state.inserted.length], [0, 0], "and Salesforce is not asked");
}
{
  // Due: one row with what Salesforce held and WHEN it was read, which is earlier than
  // the sample when the reading came from the per isolate cache.
  const { state, deps } = fake({ last: NOW - PILOT_OFFER_INTERVAL_MS });
  eq(await runPilotSettingsSample(deps), { sampled: true, ok: true }, "a quarter hour on, a reading is taken");
  eq(
    state.inserted,
    [
      {
        sampled_at: new Date(NOW).toISOString(),
        ok: true,
        read_at: new Date(NOW - 3 * 60_000).toISOString(),
        active: true,
        percent: 50,
        tiers: "1;2;3;4;5",
        record_modified_at: "2026-10-12T15:00:04.000Z",
        error: null,
      },
    ],
    "the row carries the split, when Salesforce was actually read, and when the record was last edited",
  );
}
{
  // Never sampled before: due at once.
  const { state, deps } = fake({ last: null });
  await runPilotSettingsSample(deps);
  eq(state.inserted.length, 1, "with no reading stored yet, one is taken");
}
{
  // A failed read is stored as a failure with no values.
  const { state, deps } = fake({ read: async () => { throw new Error("Salesforce answered 503"); } });
  eq(await runPilotSettingsSample(deps), { sampled: true, ok: false }, "a failed read is still a sample");
  const row = state.inserted[0]!;
  eq(
    [row.ok, row.read_at, row.active, row.percent, row.tiers, row.record_modified_at],
    [false, null, null, null, null, null],
    "and carries no values at all, never a guessed split",
  );
  eq(row.error, "Salesforce answered 503", "and says why");
}
{
  // An edit time Salesforce sent that cannot be read is a failure: the report finds
  // edits by it, so storing the split without it would vouch for a span unseen.
  const { state, deps } = fake({ read: async () => ({ settings: { ...SETTINGS, lastModified: "yesterday" }, readAtMs: NOW }) });
  await runPilotSettingsSample(deps);
  const row = state.inserted[0]!;
  assert(!row.ok && row.active === null, "an unreadable last edit time is stored as a failure");
  assert(/last edit/.test(row.error ?? ""), "naming the edit time as the reason");
}
{
  // No edit time at all: the same, since nothing could then show an edit.
  const { state, deps } = fake({ read: async () => ({ settings: { ...SETTINGS, lastModified: null }, readAtMs: NOW }) });
  await runPilotSettingsSample(deps);
  assert(!state.inserted[0]!.ok, "a reading with no last edit time is stored as a failure");
}
{
  // Salesforce sent a field that could not be read: the reading is kept, with that
  // field null, because null is what was read and the report treats it as not the split.
  const { state, deps } = fake({ read: async () => ({ settings: { ...SETTINGS, percent: null }, readAtMs: NOW }) });
  await runPilotSettingsSample(deps);
  const row = state.inserted[0]!;
  eq([row.ok, row.percent], [true, null], "an unreadable percent is stored as read, null");
}
{
  // Only a failure to STORE throws, so the lane's step streak pages on it.
  const { deps } = fake({ insertThrows: true });
  let threw = false;
  await runPilotSettingsSample(deps).catch(() => (threw = true));
  assert(threw, "a refused insert throws");
}

{
  // The monitor lane runs it on every tick, inside its own failure boundary, at the
  // tick's clock. The route has no behaviour test beyond its auth, so the wiring is
  // pinned on the source, the way scripts/test-monitor-step-coverage.ts pins its steps.
  const route = readFileSync(new URL("../src/app/api/cron/monitor/route.ts", import.meta.url), "utf8");
  assert(
    route.includes('await steps.run("pilot_settings", null, () => runPilotSettingsSampleLive(db, now));'),
    "the monitor lane runs the reading as its own step, at the tick's clock",
  );
  const step = route.indexOf('steps.run("pilot_settings"');
  const offers = route.indexOf('steps.run("pilot_offers"');
  assert(offers > 0 && step > offers && route.slice(offers, step).split("\n").length < 15, "beside the offer samples, outside any business hours gate");
}

finish();
