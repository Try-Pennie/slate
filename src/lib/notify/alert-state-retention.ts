/**
 * Retention for the per booking rows in `alert_state` (#2726).
 *
 * An alert keyed by booking (`booking_offsite_origin:<id>`,
 * `stale_phone_invite:<id>`, `booking_below_lead_tier:<id>`) writes a cooldown row
 * and, once delivered, an `alert_firing:` marker. An incident never resolves, so
 * nothing ever deleted either, and the table grew with booking volume while the
 * capped read guard still listed it as roster bounded.
 *
 * Pruning, rather than moving those rows to a table of their own, because the rows
 * are only USEFUL while some check can still read the booking: every per booking
 * check reads recent or upcoming bookings (the off site check reads bookings made
 * in the last two hours, the below tier check reads upcoming calls, the phone
 * invite alert fires once at correction time). Once a booking has started and was
 * made longer ago than the grace window, no check can reach it again, so its rows
 * throttle and remember nothing. A second table would still need this same rule,
 * and would split one cooldown mechanism across two stores for every dispatcher.
 *
 * Both conditions, never just the start: the off site check reads by CREATION
 * time, so a booking made recently for a time already past must keep its stamp or
 * it would be paged again.
 *
 * The family list is derived from the alert catalog's `suffix: "booking"`
 * declarations, never kept beside it (L41), so a new per booking family is pruned
 * by construction. A booking the sweep cannot find (a deleted test fixture) or
 * whose times cannot be read keeps its rows: this only deletes rows for bookings
 * measured to be past.
 *
 * Pure apart from the injected reads and delete, so the node suite drives it
 * (`scripts/test-alert-state-retention.ts`).
 */
import { ALERT_CATALOG } from "@/lib/notify/alert-catalog";
import { parseStampMs } from "@/lib/date/stamp";

/**
 * How long after a booking both started and was made its rows are kept. A week is
 * far past every per booking check's own window (the widest is the off site
 * check's two hour lookback, pinned by the test) and leaves a paged booking's rows
 * readable for a week of looking back at what paged.
 */
export const BOOKING_ALERT_PRUNE_GRACE_DAYS = 7;

const DAY_MS = 24 * 60 * 60_000;
const FIRING_PREFIX = "alert_firing:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The alert families keyed by a booking id, from the catalog's declarations. */
export const BOOKING_KEYED_FAMILIES: readonly string[] = ALERT_CATALOG.filter(
  (e) => e.suffix === "booking" && e.key.endsWith(":*"),
).map((e) => e.key.slice(0, -2));

export function bookingAlertPruneCutoffIso(nowMs: number): string {
  return new Date(nowMs - BOOKING_ALERT_PRUNE_GRACE_DAYS * DAY_MS).toISOString();
}

export interface BookingAlertRow {
  /** The raw `alert_state` key, cooldown row or firing marker. */
  key: string;
  family: string;
  bookingId: string;
}

/**
 * Reads a key as a row of a booking keyed family, or null. Either the cooldown row
 * (`family:<uuid>`) or its firing marker (`alert_firing:family:<uuid>`), and the
 * suffix must be a uuid, so nothing that merely shares a prefix is ever touched.
 */
export function parseBookingAlertKey(
  key: string,
  families: readonly string[] = BOOKING_KEYED_FAMILIES,
): BookingAlertRow | null {
  const bare = key.startsWith(FIRING_PREFIX) ? key.slice(FIRING_PREFIX.length) : key;
  for (const family of families) {
    const prefix = `${family}:`;
    if (!bare.startsWith(prefix)) continue;
    const bookingId = bare.slice(prefix.length);
    return UUID.test(bookingId) ? { key, family, bookingId } : null;
  }
  return null;
}

export interface BookingTimes {
  startsAt: string;
  createdAt: string;
}

export interface BookingAlertPruneDeps {
  nowMs: number;
  /** Defaults to the catalog's booking keyed families. */
  families?: readonly string[];
  /** Every `alert_state` key of the family, cooldown rows and firing markers,
   *  read in full (paged). THROWS on a read error. */
  listFamilyKeys: (family: string) => Promise<string[]>;
  /** The start and creation time of each booking asked about that exists.
   *  THROWS on a read error: an unreadable list must not read as "no bookings". */
  loadBookings: (ids: string[]) => Promise<Map<string, BookingTimes>>;
  /** Deletes these keys and returns how many rows went. THROWS on a database
   *  error: a failed delete scored as zero reads as nothing to clean (#1165). */
  deleteKeys: (keys: string[]) => Promise<number>;
}

export interface BookingAlertPruneReport {
  cutoff: string;
  /** Per booking rows read, across every family. */
  scanned: number;
  /** Rows the database reports deleted. */
  deleted: number;
  /** Rows chosen for deletion, per family. */
  byFamily: Record<string, number>;
  kept: { notYetPast: number; noBooking: number; unreadable: number };
}

export async function pruneBookingAlertState(
  deps: BookingAlertPruneDeps,
): Promise<BookingAlertPruneReport> {
  const families = deps.families ?? BOOKING_KEYED_FAMILIES;
  const cutoff = bookingAlertPruneCutoffIso(deps.nowMs);
  const cutoffMs = deps.nowMs - BOOKING_ALERT_PRUNE_GRACE_DAYS * DAY_MS;

  const rows: BookingAlertRow[] = [];
  for (const family of families) {
    for (const key of await deps.listFamilyKeys(family)) {
      // Re-parsed against THIS family only: the read is a prefix match, and a
      // lookalike family or a non-uuid suffix must never reach the delete.
      const row = parseBookingAlertKey(key, [family]);
      if (row) rows.push(row);
    }
  }

  const kept = { notYetPast: 0, noBooking: 0, unreadable: 0 };
  const byFamily: Record<string, number> = {};
  if (rows.length === 0) return { cutoff, scanned: 0, deleted: 0, byFamily, kept };

  const bookings = await deps.loadBookings([...new Set(rows.map((r) => r.bookingId))]);
  const doomed: string[] = [];
  for (const row of rows) {
    const b = bookings.get(row.bookingId);
    if (!b) {
      kept.noBooking++;
      continue;
    }
    const startsMs = parseStampMs(b.startsAt);
    const createdMs = parseStampMs(b.createdAt);
    if (startsMs === null || createdMs === null) {
      kept.unreadable++;
      continue;
    }
    if (startsMs >= cutoffMs || createdMs >= cutoffMs) {
      kept.notYetPast++;
      continue;
    }
    doomed.push(row.key);
    byFamily[row.family] = (byFamily[row.family] ?? 0) + 1;
  }

  const deleted = doomed.length === 0 ? 0 : await deps.deleteKeys(doomed);
  return { cutoff, scanned: rows.length, deleted, byFamily, kept };
}
