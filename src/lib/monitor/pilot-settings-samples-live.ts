import type { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { parseStampMs } from "@/lib/date/stamp";
import { pilotSettingsCache } from "@/lib/salesforce/pilot-settings";
import { runPilotSettingsSample, type PilotSettingsOutcome, type PilotSettingsRow } from "./pilot-settings-samples";

/**
 * The monitor lane's pilot split reading (#3641), bound to the real systems: the
 * isolate's shared settings cache, which the per page alarm reads on the same tick,
 * so in business hours a reading usually costs no Salesforce call of its own, and the
 * `pilot_settings_samples` table. The decisions live in `runPilotSettingsSample`; this
 * is only the wiring, tested by `pilot-settings-samples-live.test.ts`.
 */
export function runPilotSettingsSampleLive(db: ReturnType<typeof supabaseAdmin>, nowMs: number): Promise<PilotSettingsOutcome> {
  return runPilotSettingsSample({
    nowMs,
    lastSampledAtMs: async () => {
      const row = unwrap(
        await db
          .from("pilot_settings_samples")
          .select("sampled_at")
          .order("sampled_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        "pilot settings last sample",
      ) as { sampled_at: string } | null;
      // An unreadable stamp takes a reading rather than skipping one.
      return row ? parseStampMs(row.sampled_at) : null;
    },
    readSettings: () => pilotSettingsCache.readTimed(nowMs),
    insert: async (row: PilotSettingsRow) => {
      unwrap(await db.from("pilot_settings_samples").insert(row).select("sampled_at"), "pilot settings samples");
    },
  });
}
