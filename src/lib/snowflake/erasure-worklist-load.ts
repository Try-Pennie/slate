/**
 * Reading the erasure purge worklist (#1124).
 *
 * The IO half of `erasure-worklist.ts`. It reuses the two things that already
 * exist rather than growing a third opinion: the shared trail reader (#1128) for
 * WHICH bookings have been erased, and `residualsForBookingIds` for what the
 * warehouse still holds for them.
 *
 * Three reads can fail independently here, and every one of them has an empty
 * shaped answer that would render as a clean screen:
 *
 *   - the TRAIL read (throws, via `selectAllPages`) becomes its own kind, because
 *     an empty entry list reads as "nothing has ever been erased".
 *   - the warehouse CONFIG can be absent (nothing to measure) or half configured
 *     (throws). Those are different sentences: one is a deployment without a
 *     mirror, the other is a mirror nobody can reach.
 *   - the RESIDUAL read becomes `null` per entry, never `0`, because a zero here
 *     is the number that certifies a deletion request honored (#1197).
 *
 * Cost. The residual is measured ONCE over the union of the org's erased bookings
 * (four warehouse statements). A measured zero over the union proves every entry
 * is clean, since each entry's bookings are a subset of it, so the healthy case
 * never pays more. Only a non zero total triggers per entry attribution, which is
 * the case where an operator actually needs to know which erasure to act on.
 */

import { log } from "@/lib/log";
import { shortErrorReason } from "@/lib/notify/error-text";
import { compareStringsDesc } from "@/lib/compare";
import { readSnowflakeConfig } from "./config";
import { readErasureAuditRows, type ErasureAuditRow } from "./erasure-trail";
import { residualsForBookingIds } from "./erasure-audit";
import type { SnowflakeConfig } from "./client";
import type { ErasureResidual } from "./erasure-audit";
import {
  MAX_ATTRIBUTED_ENTRIES,
  needsPerEntryAttribution,
  type ErasureWorklistEntry,
  type ErasureWorklistState,
  type TrailScope,
  type WarehouseState,
} from "./erasure-worklist";

const bookingIdsOf = (row: ErasureAuditRow): string[] => row.details?.booking_ids ?? [];

/**
 * Newest erasure first. Sorted on the raw ISO string rather than a parsed date:
 * PostgREST returns `timestamptz` in a fixed offset ISO form, which sorts
 * lexicographically, and it keeps this file clear of the `Date.parse` NaN class
 * the guard in `scripts/test-date-parse-guard.ts` watches for in this directory.
 */
const newestFirst = (a: ErasureAuditRow, b: ErasureAuditRow): number =>
  compareStringsDesc(a.created_at, b.created_at);

function unmeasured(rows: ErasureAuditRow[], reason: string): ErasureWorklistEntry[] {
  return rows.map((r) => ({
    auditId: r.id,
    createdAt: r.created_at,
    emailSha256: r.details?.email_sha256 ?? null,
    bookingIds: bookingIdsOf(r),
    residuals: null,
    unmeasuredReason: reason,
  }));
}

/**
 * The worklist for one org.
 *
 * ORG SCOPING: only that org's `pii.erasure` rows are listed, so the ids a
 * per entry control can send are its own. The trail wide totals are reported for
 * the WHOLE trail, because that is genuinely what a no body purge covers, and the
 * copy says so rather than letting the reader assume the button matches the list.
 */
export async function loadErasureWorklist(
  orgId: string,
  /** #1961: the instant the page's ages are measured from. Taken here, beside
   *  the read it describes, because a render may not read a clock, and injected
   *  so a test can pin it rather than race it. */
  nowMs: number = Date.now(),
): Promise<ErasureWorklistState> {
  let rows: ErasureAuditRow[];
  try {
    rows = await readErasureAuditRows();
  } catch (err) {
    log.error("erasure-worklist", { msg: "trail read failed" }, err);
    return { kind: "trail-unreadable", reason: shortErrorReason(err) };
  }

  const mine = rows.filter((r) => r.org_id === orgId).sort(newestFirst);
  const myIds = [...new Set(mine.flatMap(bookingIdsOf))];
  const allIds = new Set(rows.flatMap(bookingIdsOf));
  const trail: TrailScope = {
    entryCount: rows.length,
    bookingCount: allIds.size,
    otherOrgBookingCount: [...allIds].filter((id) => !myIds.includes(id)).length,
  };

  let config: SnowflakeConfig | null;
  try {
    config = readSnowflakeConfig();
  } catch (err) {
    // Half configured (a key with no account). The mirror exists in intent, so
    // this is a read that failed, not an environment without a warehouse.
    const reason = shortErrorReason(err);
    return { kind: "ready", nowMs, trail, warehouse: { kind: "unreadable", reason }, entries: unmeasured(mine, reason) };
  }
  if (!config) {
    return {
      kind: "ready",
      nowMs,
      trail,
      warehouse: { kind: "unconfigured" },
      entries: unmeasured(mine, "the Snowflake mirror is not configured here"),
    };
  }
  if (myIds.length === 0) {
    return { kind: "ready", nowMs, trail, warehouse: { kind: "measured" }, entries: [] };
  }

  let union: ErasureResidual[];
  try {
    union = await residualsForBookingIds(config, myIds);
  } catch (err) {
    log.error("erasure-worklist", { msg: "residual read failed" }, err);
    const reason = shortErrorReason(err);
    return { kind: "ready", nowMs, trail, warehouse: { kind: "unreadable", reason }, entries: unmeasured(mine, reason) };
  }

  const total = union.reduce((sum, r) => sum + r.residual, 0);
  const warehouse: WarehouseState = { kind: "measured" };

  if (!needsPerEntryAttribution(total)) {
    // Measured zero over the union, so every subset is zero. Reported as a real
    // per table measurement rather than as an unknown, because it IS one.
    const allClean = union.map((r) => ({ table: r.table, residual: 0 }));
    return {
      kind: "ready",
      nowMs,
      trail,
      warehouse,
      entries: mine.map((r) => ({
        auditId: r.id,
        createdAt: r.created_at,
        emailSha256: r.details?.email_sha256 ?? null,
        bookingIds: bookingIdsOf(r),
        residuals: allClean,
        unmeasuredReason: null,
      })),
    };
  }

  const entries: ErasureWorklistEntry[] = [];
  for (const [i, r] of mine.entries()) {
    const base = {
      auditId: r.id,
      createdAt: r.created_at,
      emailSha256: r.details?.email_sha256 ?? null,
      bookingIds: bookingIdsOf(r),
    };
    if (i >= MAX_ATTRIBUTED_ENTRIES) {
      entries.push({
        ...base,
        residuals: null,
        unmeasuredReason: `only the ${MAX_ATTRIBUTED_ENTRIES} most recent erasures are measured individually on one load`,
      });
      continue;
    }
    if (base.bookingIds.length === 0) {
      entries.push({ ...base, residuals: [], unmeasuredReason: null });
      continue;
    }
    try {
      entries.push({
        ...base,
        residuals: await residualsForBookingIds(config, base.bookingIds),
        unmeasuredReason: null,
      });
    } catch (err) {
      // One entry's read failing must not take the page's other answers with it.
      log.error("erasure-worklist", { msg: "entry residual read failed", audit_id: r.id }, err);
      entries.push({ ...base, residuals: null, unmeasuredReason: shortErrorReason(err) });
    }
  }

  return { kind: "ready", nowMs, trail, warehouse, entries };
}
