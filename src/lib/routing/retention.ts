import { DateTime } from "luxon";

/** ISO timestamp `months` before `nowIso`; rows older than this are pruned. */
export function pruneCutoffIso(nowIso: string, months = 12): string {
  return DateTime.fromISO(nowIso, { zone: "utc" })
    .minus({ months })
    .toUTC()
    .toISO({ suppressMilliseconds: false })!;
}
