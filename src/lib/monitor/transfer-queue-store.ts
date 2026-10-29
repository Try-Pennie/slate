/**
 * The transfer queue probe's per business day tallies, `transfer_queue_days` (#4380,
 * migration 0213). The write is the one RPC, an atomic upsert, so overlapping ticks each
 * count once (assume it runs twice). Both THROW on failure: the probe never judges a day
 * it could not read, and the lane's step failing streak pages a read that stays broken.
 * Server only.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import type { TransferQueueDayRow } from "@/lib/monitor/transfer-queue-probe";

export async function recordTransferQueueReading(day: string, free: number, reached: boolean): Promise<void> {
  const { error } = await supabaseAdmin().rpc("record_transfer_queue_reading", { p_day: day, p_free: free, p_reached: reached });
  if (error) throw new Error(`record_transfer_queue_reading failed: ${error.message}`);
}

/** At most two days: the last whole business day and today. */
export async function loadTransferQueueDays(days: string[]): Promise<TransferQueueDayRow[]> {
  return unwrap(
    await supabaseAdmin()
      .from("transfer_queue_days")
      .select("day, readings, reached, most_free, first_read_at, last_read_at")
      // in-chunk-ok: the last whole business day and today, two dates, never a paged list.
      .in("day", days)
      .limit(days.length),
    "transfer_queue_days",
  ) as TransferQueueDayRow[];
}
