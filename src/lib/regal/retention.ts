/**
 * Retention for the inbound Regal call feed (#2090).
 *
 * `regal_call_events` grows with call volume and nothing reads past a day of it:
 * the detector reads the last few minutes, and its two daily alarms read today.
 * So it is pruned from its first migration, on the 03:05 daily retention trigger
 * beside its siblings, rather than on the every minute one, which is the
 * invocation already short of CPU headroom.
 *
 * No mirror gate, unlike the Snowflake retention lanes: this table is not
 * mirrored and holds no lead data, so nothing needs archiving before a row goes.
 *
 * Pure apart from the injected delete, so the node suite drives it
 * (scripts/test-regal-call-retention.ts).
 */

/**
 * How long a received event is kept. Three days is the shortest window that
 * still lets somebody on a Monday morning read what arrived on the Friday
 * evening, which is the one question this table answers that the logs (seven
 * days, no alerting) answer less conveniently.
 */
export const REGAL_CALL_RETENTION_DAYS = 3;

const DAY_MS = 24 * 60 * 60_000;

/** Rows received strictly before this instant are deleted. */
export function regalCallCutoffIso(nowMs: number): string {
  return new Date(nowMs - REGAL_CALL_RETENTION_DAYS * DAY_MS).toISOString();
}

export interface RegalCallPruneDeps {
  nowMs: number;
  /** Deletes rows with `received_at` strictly before the cutoff and returns how
   *  many. THROWS on a database error: a failed delete scored as zero is
   *  indistinguishable from having had nothing to clean (#1165). */
  deleteReceivedBefore: (cutoffIso: string) => Promise<number>;
}

export async function pruneRegalCalls(
  deps: RegalCallPruneDeps,
): Promise<{ deleted: number; cutoff: string }> {
  const cutoff = regalCallCutoffIso(deps.nowMs);
  const deleted = await deps.deleteReceivedBefore(cutoff);
  return { deleted, cutoff };
}
