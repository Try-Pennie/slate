/**
 * What the pilot split settings were, read every quarter hour (#3641).
 *
 * Salesforce keeps no history of SlatePilotActive__c, SlatePilotPercent__c or
 * SlatePilotTiers__c, and none will be turned on (Dan, 2026-10-01, #2946), so
 * `pnpm report:pilot-compare` could only ASSUME the split held at 50 on tiers 1 to 5
 * across its window. On 2026-10-12 the record that holds them was edited and nothing
 * could say whether the split was touched. So the monitor lane stores what Salesforce
 * held, when it was actually read, and when the record was last edited.
 *
 * The edit time is what makes a gap checkable: a reading whose record was last edited
 * before the previous reading proves nothing changed in between, however long the gap.
 * That is why a reading with no readable edit time is stored as a FAILURE rather than
 * as a split: without it the report could not tell an untouched span from an unseen one.
 *
 * A failed read is a row with ok false, its reason, and NO values, never a guessed
 * split (L90). Pure and injected, so every path is driven by
 * `scripts/test-pilot-settings-samples.ts`. Retires with the parallel run at cutover
 * (#65).
 */
import { parseStampMs } from "@/lib/date/stamp";
import type { PilotSettings } from "@/lib/salesforce/pilot-settings";
import { pilotOfferSampleDue, reasonOf } from "./pilot-offers";

/** One stored reading. `ok` false carries an error and no values. */
// A type alias rather than an interface: the typed Supabase client needs a type
// assignable to a string keyed record, which an interface is not.
export type PilotSettingsRow = {
  sampled_at: string;
  ok: boolean;
  /** When Salesforce was read, earlier than the sample when the reading was a cached one. */
  read_at: string | null;
  active: boolean | null;
  percent: number | null;
  tiers: string | null;
  /** The configuration record's LastModifiedDate: any field, not only the pilot ones. */
  record_modified_at: string | null;
  error: string | null;
};

export interface PilotSettingsSampleDeps {
  nowMs: number;
  /** When the newest stored reading was taken, or null when there is none. */
  lastSampledAtMs: () => Promise<number | null>;
  /** The settings, and when Salesforce was actually read for them. */
  readSettings: () => Promise<{ settings: PilotSettings; readAtMs: number }>;
  insert: (row: PilotSettingsRow) => Promise<void>;
}

export type PilotSettingsOutcome = { sampled: false } | { sampled: true; ok: boolean };

/**
 * Take one reading when one is due, on the same quarter hour cadence as the offer
 * samples. Only a failure to STORE throws, so the lane's step streak pages on it.
 */
export async function runPilotSettingsSample(deps: PilotSettingsSampleDeps): Promise<PilotSettingsOutcome> {
  if (!pilotOfferSampleDue(await deps.lastSampledAtMs(), deps.nowMs)) return { sampled: false };
  const sampledAt = new Date(deps.nowMs).toISOString();
  const failed = (error: string): PilotSettingsRow => ({
    sampled_at: sampledAt,
    ok: false,
    read_at: null,
    active: null,
    percent: null,
    tiers: null,
    record_modified_at: null,
    error,
  });

  let row: PilotSettingsRow;
  try {
    const { settings, readAtMs } = await deps.readSettings();
    const modifiedMs = parseStampMs(settings.lastModified);
    row =
      modifiedMs === null
        ? failed(`the record's last edit time could not be read (${String(settings.lastModified).slice(0, 40)}), so an edit could not be seen`)
        : {
            sampled_at: sampledAt,
            ok: true,
            read_at: new Date(readAtMs).toISOString(),
            active: settings.active,
            percent: settings.percent,
            tiers: settings.tiers,
            record_modified_at: new Date(modifiedMs).toISOString(),
            error: null,
          };
  } catch (err) {
    row = failed(reasonOf(err));
  }
  await deps.insert(row);
  return { sampled: true, ok: row.ok };
}
