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
import { parseStampMs } from "@/lib/date/stamp";

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
      /**
       * The instant every age on the page is measured from (#1961).
       *
       * Taken by the LOADER, beside the read it describes, rather than in the
       * render. Rendering may not read a clock (the same fact would differ
       * between the server pass and the client one, and the compiler refuses
       * it), and the copy builders are pure by design so they cannot take one
       * themselves.
       */
      nowMs: number;
    };

/**
 * Pennie's stated response deadline for a verified deletion request, in days
 * (#1961). Recorded in `docs/pii-retention.md` section 9 as Pennie's own
 * position under the stricter CCPA reading, decided 2026-07-29 (#1074), not as
 * counsel's opinion.
 *
 * IT DOES NOT RUN FROM ANYTHING SLATE HOLDS. The clock starts at the person's
 * request, and the only date in the trail is when the Supabase half of the
 * erasure ran, which is necessarily later. So Slate can say how long a warehouse
 * copy has been outstanding and it CANNOT say when the deadline falls: any due
 * date computed from what is here would be later than the real one, which is the
 * one direction a compliance clock must never be wrong in. The age is reported
 * as a floor, and the shortfall is named on the page rather than papered over
 * (L589: a relative time must say what it is relative to).
 */
export const ERASURE_RESPONSE_DAYS = 45;

/** Whole days between an entry's erasure and now, or `null` when the stamp could
 *  not be read. Never a number on an unreadable stamp: a zero would read as
 *  "erased just now", which is the reassuring direction (L50). */
export function entryAgeDays(createdAt: string, nowMs: number): number | null {
  const ms = parseStampMs(createdAt);
  if (ms === null) return null;
  return Math.max(0, Math.floor((nowMs - ms) / 86_400_000));
}

/**
 * The entries in the order somebody should work them: what is OUTSTANDING first
 * and oldest first inside that, because the entry that has been waiting longest
 * is the one closest to a deadline.
 *
 * Ordered here rather than in the query, so it is pure and drivable, and because
 * a list rendered straight from a read appears in whatever order the store
 * happened to return (L343). An unreadable stamp sorts to the TOP of its group:
 * it cannot be shown to be young, and the safe reading of an unknown age on a
 * compliance clock is the alarming one.
 */
const GROUP_ORDER: Record<EntryStatus, number> = { outstanding: 0, unknown: 1, clean: 2 };

export function worklistOrder(
  entries: ErasureWorklistEntry[],
  nowMs: number,
): ErasureWorklistEntry[] {
  return [...entries].sort((a, b) => {
    const g = GROUP_ORDER[entryStatus(a)] - GROUP_ORDER[entryStatus(b)];
    if (g !== 0) return g;
    const ageA = entryAgeDays(a.createdAt, nowMs);
    const ageB = entryAgeDays(b.createdAt, nowMs);
    if (ageA === null && ageB === null) return a.auditId.localeCompare(b.auditId);
    if (ageA === null) return -1;
    if (ageB === null) return 1;
    return ageB - ageA || a.auditId.localeCompare(b.auditId);
  });
}

/** The longest a still outstanding entry has been waiting, or `null` when there
 *  is none, or when none of their stamps could be read. */
export function oldestOutstandingDays(
  entries: ErasureWorklistEntry[],
  nowMs: number,
): number | null {
  const ages = entries
    .filter((e) => entryStatus(e) === "outstanding")
    .map((e) => entryAgeDays(e.createdAt, nowMs))
    .filter((d): d is number => d !== null);
  return ages.length ? Math.max(...ages) : null;
}

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
  /** How long the longest still outstanding entry has waited, or `null` when
   *  there is none or no stamp among them could be read (#1961). */
  oldestOutstandingDays: number | null;
  clean: number;
  outstanding: number;
  unknown: number;
  /**
   * Residual rows across the entries that WERE measured, or null when none of
   * them were. Zero here means measured and clean; null means nobody knows.
   */
  residualRows: number | null;
}

export function summarizeWorklist(
  entries: ErasureWorklistEntry[],
  nowMs: number,
): WorklistSummary {
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
    oldestOutstandingDays: oldestOutstandingDays(entries, nowMs),
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
