/**
 * The operator worklist for pending Snowflake erasure purges (#1124): the shape
 * an admin screen renders, and the arithmetic behind it.
 *
 * PURE. The reads live in `erasure-worklist-load.ts` and the wording in
 * `erasure-worklist-copy.ts`, so `scripts/test-erasure-worklist.ts` drives the
 * real decisions rather than a second copy of them.
 *
 * The one rule everything here exists to hold: a residual that could not be
 * MEASURED is `null`, never `0`. An empty warehouse and an unanswered warehouse
 * render identically the moment they share a number, and the second is precisely
 * the state this worklist was built to make visible.
 */

import type { ErasureResidual } from "./erasure-audit";

/** One `pii.erasure` audit entry, with what Snowflake still holds for it. */
export interface ErasureWorklistEntry {
  /** The `audit_log` row id, which is the entry's stable identity. */
  auditId: string;
  createdAt: string;
  /**
   * The SHA-256 of the erased address, which is the ONLY identifier the trail
   * keeps: `erase_booking_pii` deliberately never records the cleartext email.
   * Null on a row written before the hash was recorded.
   */
  emailSha256: string | null;
  bookingIds: string[];
  /**
   * Per table warehouse residual for THIS entry's bookings, or null when it
   * could not be measured. Null is not zero.
   */
  residuals: ErasureResidual[] | null;
  /** Why `residuals` is null. Null exactly when it was measured. */
  unmeasuredReason: string | null;
}

/** What the whole `pii.erasure` trail covers, which is what a no body purge takes. */
export interface TrailScope {
  entryCount: number;
  bookingCount: number;
  /**
   * Bookings in the trail belonging to an org other than the reader's. The list
   * is scoped to the reader's org; the trail wide purge is not, so the number has
   * to be sayable rather than left implicit.
   */
  otherOrgBookingCount: number;
}

/** Whether Snowflake could be asked at all. */
export type WarehouseState =
  | { kind: "measured" }
  | { kind: "unconfigured" }
  | { kind: "unreadable"; reason: string };

/**
 * What the page has to render. An unreadable trail is its own kind, because a
 * trail read that failed must never arrive as an empty list of entries (L10).
 */
export type ErasureWorklistState =
  | { kind: "trail-unreadable"; reason: string }
  | {
      kind: "ready";
      entries: ErasureWorklistEntry[];
      trail: TrailScope;
      warehouse: WarehouseState;
    };

export type EntryStatus = "clean" | "outstanding" | "unknown";

/** Rows of residual PII across every table, or null when nothing was measured. */
export function entryResidualTotal(entry: ErasureWorklistEntry): number | null {
  if (entry.residuals === null) return null;
  return entry.residuals.reduce((sum, r) => sum + r.residual, 0);
}

export function entryStatus(entry: ErasureWorklistEntry): EntryStatus {
  const total = entryResidualTotal(entry);
  if (total === null) return "unknown";
  return total > 0 ? "outstanding" : "clean";
}

export interface WorklistSummary {
  entries: number;
  clean: number;
  outstanding: number;
  unknown: number;
  /**
   * Residual rows across the entries that WERE measured, or null when none of
   * them were. Zero here means measured and clean; null means nobody knows.
   */
  residualRows: number | null;
}

export function summarizeWorklist(entries: ErasureWorklistEntry[]): WorklistSummary {
  let clean = 0;
  let outstanding = 0;
  let unknown = 0;
  let rows = 0;
  let measuredAny = entries.length === 0;
  for (const e of entries) {
    const total = entryResidualTotal(e);
    if (total === null) {
      unknown += 1;
      continue;
    }
    measuredAny = true;
    rows += total;
    if (total > 0) outstanding += 1;
    else clean += 1;
  }
  return {
    entries: entries.length,
    clean,
    outstanding,
    unknown,
    residualRows: measuredAny ? rows : null,
  };
}

/**
 * How many entries the loader will attribute a residual to individually.
 *
 * Attribution costs one warehouse round trip per table per entry, so it only
 * runs when the trail wide measurement already said there IS something to
 * attribute. This bound stops a pathological trail turning one page load into
 * hundreds of Snowflake calls; entries past it report `unknown` with a reason
 * rather than a guess.
 */
export const MAX_ATTRIBUTED_ENTRIES = 25;

/**
 * Whether the loader must ask Snowflake about each entry separately.
 *
 * Only when the trail wide residual is a MEASURED, non zero number. A measured
 * zero already proves every entry is clean (each entry's bookings are a subset),
 * and an unmeasurable total cannot be attributed to anything, so neither case
 * spends a single extra call.
 */
export function needsPerEntryAttribution(trailResidualTotal: number | null): boolean {
  return trailResidualTotal !== null && trailResidualTotal > 0;
}
