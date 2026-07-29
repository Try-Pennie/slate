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

export interface SlotHealthRow {
  bucket_code: string;
  payload: { slots?: string[] } | null;
  computed_at: string;
}

export interface SlotHealth {
  slotCount: number;
  /** Epoch ms of the last recompute; 0 when the stamp could not be read. */
  computedAtMs: number;
}

export function slotHealthByCode(rows: SlotHealthRow[]): Map<string, SlotHealth> {
  return new Map(
    rows.map((r) => [
      r.bucket_code,
      {
        slotCount: r.payload?.slots?.length ?? 0,
        computedAtMs: parseStampMs(r.computed_at) ?? 0,
      },
    ]),
  );
}
