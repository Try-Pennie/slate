/**
 * Per-bucket cached-slot health, keyed by bucket code (#1171).
 *
 * Extracted from the monitor route so it has a suite of its own. It was the one
 * site changed by #1169/PR #1170 with no site-level test, which is exactly the
 * shape of gap that lets a fix quietly regress: the route composed it inline, so
 * nothing anywhere asserted what an unreadable `computed_at` does.
 *
 * The fail-safe direction is the whole point. `computedAtMs` feeds a freshness
 * comparison downstream, and NaN compares false against every threshold, so a
 * raw parse of an unreadable stamp would read as FRESH and the availability
 * canary would stay silent about a cache that had stopped recomputing. An
 * unreadable stamp therefore maps to epoch 0: maximally stale, which pages.
 *
 * No `@/` imports, so the node suite can drive it directly.
 */
import { parseStampMs } from "../date/stamp.ts";
import { slotsWithinBusinessHours, type BusinessHoursRules } from "../availability/compute.ts";

export interface SlotHealthRow {
  bucket_code: string;
  payload: { slots?: string[]; eventType?: { duration_min?: number } } | null;
  computed_at: string;
}

export interface SlotHealth {
  /**
   * How many slots a lead is actually being OFFERED: the stored payload filtered
   * through the org's current hours, exactly as the read path filters it (#1296).
   *
   * `null` means the count could not be measured, which is NOT zero. The detector
   * downstream pages on a confident zero, so a row we cannot judge has to say so
   * rather than contribute a number it did not earn.
   */
  slotCount: number | null;
  /** Epoch ms of the last recompute; 0 when the stamp could not be read. */
  computedAtMs: number;
  /**
   * The EARLIEST time this bucket is offering, epoch ms, after the same org hours
   * filter `slotCount` is taken through (#2505).
   *
   * `null` means no time is being offered, which the debt tier alarm reads as a
   * finding. It is NOT the same as `slotCount: null`, which means the row could
   * not be judged at all: the alarm reads that one as unmeasured and concludes
   * nothing. Both live here rather than in a second reader, so the alarm and the
   * availability probe can never disagree about what is being offered (L107).
   *
   * A slot whose stamp cannot be read is DROPPED rather than counted as the
   * earliest, because `Date.parse` gives NaN and every comparison with NaN is
   * false, so a NaN would sort its way to the front and report an offered time
   * that nobody can book (L50, and the #1171 class this file already guards).
   */
  firstSlotMs: number | null;
}

/**
 * The earliest readable instant in a served slot list, or null.
 *
 * An unreadable stamp is dropped rather than carried: `parseStampMs` returns null
 * for one, and treating that as 0 would report the epoch as the next available
 * time, which is an offered time nobody can book (L50).
 */
function earliestSlotMs(served: string[] | null): number | null {
  if (served === null) return null;
  let earliest: number | null = null;
  for (const iso of served) {
    const ms = parseStampMs(iso);
    if (ms === null) continue;
    if (earliest === null || ms < earliest) earliest = ms;
  }
  return earliest;
}

/**
 * #1296: count what is SERVED, not what is stored.
 *
 * The read path filters cached slots against the org's current hours, so for up to
 * one recompute cycle after an edit the stored payload holds slots no lead is being
 * offered. A probe counting the raw payload would be measuring a list nobody sees.
 *
 * A payload with no `eventType.duration_min` cannot be judged against the org's
 * window at all, because a slot has to FIT inside it and there is no length to fit.
 * Counting it raw would over-report and counting it zero would page about a bucket
 * that is very likely fine, so it reads as `null` (unknown) and the detector leaves
 * it alone. Every row this codebase writes carries the duration; this covers a
 * legacy or malformed one.
 */
export function slotHealthByCode(
  rows: SlotHealthRow[],
  businessHours: BusinessHoursRules,
): Map<string, SlotHealth> {
  return new Map(
    rows.map((r) => {
      const slots = r.payload?.slots;
      const durationMin = r.payload?.eventType?.duration_min;
      const measurable = slots !== undefined && typeof durationMin === "number";
      const served = measurable ? slotsWithinBusinessHours(slots, durationMin, businessHours) : null;
      return [
        r.bucket_code,
        {
          slotCount: measurable
            ? served!.length
            : slots === undefined
              ? 0
              : null,
          computedAtMs: parseStampMs(r.computed_at) ?? 0,
          firstSlotMs: earliestSlotMs(served),
        },
      ];
    }),
  );
}
