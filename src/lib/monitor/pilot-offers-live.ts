import type { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { parseStampMs } from "@/lib/date/stamp";
import { calcomRoutedSlots } from "@/lib/calcom/client";
import { getBucketSlotsWithFallback } from "@/lib/availability/slot-cache";
import { filterSlotsFromNow } from "@/lib/availability/compute";
import {
  PILOT_OFFER_BUCKET,
  PILOT_OFFER_CALCOM_FORM,
  PILOT_OFFER_TIME_ZONE,
  pilotOfferRoutingFields,
  runPilotOfferSample,
  type PilotOfferOutcome,
  type PilotOfferRow,
} from "./pilot-offers";

/**
 * The monitor lane's pilot offer sample (#2927), bound to the real systems:
 * cal.com through its routing form, Slate through its booker's own read of the
 * bucket with the same notice filter the availability route applies, and the
 * `pilot_offer_samples` table. The decisions live in `runPilotOfferSample`; this
 * is only the wiring, tested by `pilot-offers-live.test.ts`.
 */
export function runPilotOfferSampleLive(db: ReturnType<typeof supabaseAdmin>, nowMs: number): Promise<PilotOfferOutcome> {
  return runPilotOfferSample({
    nowMs,
    bucketCode: PILOT_OFFER_BUCKET,
    calcomTimeZone: PILOT_OFFER_TIME_ZONE,
    lastSampledAtMs: async () => {
      const row = unwrap(
        await db
          .from("pilot_offer_samples")
          .select("sampled_at")
          .order("sampled_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        "pilot offer last sample",
      ) as { sampled_at: string } | null;
      // An unreadable stamp takes a sample rather than skipping one.
      return row ? parseStampMs(row.sampled_at) : null;
    },
    readCalcom: () =>
      calcomRoutedSlots(
        PILOT_OFFER_CALCOM_FORM,
        pilotOfferRoutingFields(PILOT_OFFER_BUCKET),
        {
          start: new Date(nowMs).toISOString(),
          end: new Date(nowMs + 24 * 3_600_000).toISOString(),
          timeZone: PILOT_OFFER_TIME_ZONE,
        },
      ),
    readSlate: async () => {
      const served = await getBucketSlotsWithFallback(PILOT_OFFER_BUCKET, new Date(nowMs).toISOString(), false, nowMs);
      if (!served) throw new Error(`bucket ${PILOT_OFFER_BUCKET} was not found`);
      return filterSlotsFromNow(served.slots, nowMs, served.eventType.min_notice_min);
    },
    insert: async (rows: PilotOfferRow[]) => {
      unwrap(await db.from("pilot_offer_samples").insert(rows).select("sampled_at"), "pilot offer samples");
    },
  });
}
