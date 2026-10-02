import { BACKEND, DEBT_TIER, LEGAL, seederOwnsCode } from "@/lib/xbc";
import { poolKeyFor } from "@/lib/availability/pool-key";
import { poolLabel } from "@/lib/availability/pool-label";
import type { Bucket } from "@/lib/db/types";

/**
 * One row of the buckets table (#1896).
 *
 * ## What the table replaced, and why a table
 *
 * Sixty `BucketForm`s stacked in one vertical scroll, every field permanently
 * editable, the same two explanatory paragraphs repeated inside each one, and
 * nothing aligning between them. Answering "which pools can take a booking" or
 * "what is the Achieve column look like at tier 4" meant scrolling sixty forms
 * and holding the answer in your head.
 *
 * The pools are a MATRIX and always were: an XBC code is three digits, one per
 * dimension, and `bucketSpecForXbc` decodes them into the debt tier, the backend
 * service and the legal parameter. A seeded bucket's NAME is exactly those three
 * joined ("Low | Both | Legal"), so a name column would be the same information
 * again, unaligned and unsortable. The three become three columns instead, and
 * the code's natural order is the matrix's order, which is why the table needs no
 * sort controls: sorting by code already groups by tier, then backend, then
 * legal (L578: a list of records laid out as flow rows has no columns at all,
 * because each field's position is set by the width of everything before it).
 *
 * A HAND MADE bucket has no such decomposition, so it shows its own name across
 * those cells and says it is custom. That is the same distinction #2006 drew for
 * what is editable, from the same predicate, rather than a second rule about
 * what a code looks like (L41).
 *
 * ## Not measured is not zero
 *
 * `eligible` carries `null` for a depth the page could not measure, and every
 * derived judgement below refuses on it rather than treating it as zero. Zero is
 * the alarming value here (#1929: a bucket absent from a healthy depth map was
 * painted red with "bookings will fail" on every view, for months), so an
 * unmeasured row must never fall into the trouble set and must never be counted
 * as healthy either.
 */
export interface BucketRow {
  id: string;
  code: string;
  name: string;
  /** The three dimensions the code decodes to, or `null` for a bucket the
   *  seeder does not own, which has no decomposition. */
  matrix: { tier: string; backend: string; legal: string } | null;
  /** Bookable agents this pool's criteria and members reach, or `null` when that
   *  was not measured. Never 0 for unmeasured. */
  eligible: number | null;
  hasFallback: boolean;
  /**
   * The staffed pool this bucket's leads go to when nobody here matches, in
   * words, or null when the routing ladder reaches nobody (Dan, 2026-10-02).
   * Only meaningful when `eligible` is 0.
   */
  overflowTo: string | null;
  /** How many people are named on this bucket by hand. */
  manualMembers: number;
  /**
   * The POOL this bucket routes through (#2237).
   *
   * Sixty codes resolve to fifteen, so six adjacent rows are routinely ONE
   * routing decision shown six times. The table keeps a row per bucket, because
   * each is a real record somebody edits here and collapsing them would take
   * that away; the column is what lets a reader see the six are one.
   *
   * `label` is null for a bucket whose criteria are not the routing matrix. The
   * KEY is still meaningful there: two hand made buckets with identical criteria
   * are still one pool, they just have no name for it.
   */
  pool: { key: string; label: string | null };
}

export function bucketRow(
  bucket: Bucket,
  eligible: number | undefined,
  /**
   * The people named on this bucket by hand, as IDS rather than a count.
   *
   * The count is all the table shows, but membership changes WHO a bucket routes
   * to, so it is part of the pool's identity: two buckets alike in every other
   * way and differing by one manual member are two pools, and a count could not
   * tell them apart.
   */
  manualMemberIds: string[],
  /** Where the routing ladder sends this bucket's leads when nobody here matches. */
  overflowTo: string | null = null,
): BucketRow {
  const [adv, bes, leg] = bucket.code.split("");
  const tier = adv ? DEBT_TIER[adv] : undefined;
  const backend = bes ? BACKEND[bes] : undefined;
  const legal = leg ? LEGAL[leg] : undefined;
  return {
    id: bucket.id,
    code: bucket.code,
    name: bucket.name,
    // Decoded only for a code the seeder owns. A hand made bucket can carry any
    // code, and reading three digits out of one that merely LOOKS like an XBC
    // would label it with a tier nobody chose.
    matrix:
      seederOwnsCode(bucket.code) && tier && backend && legal
        ? { tier: tier.label, backend: backend.label, legal: legal.label }
        : null,
    eligible: eligible === undefined ? null : eligible,
    hasFallback: bucket.fallback_user_id !== null,
    overflowTo,
    manualMembers: manualMemberIds.length,
    // The same key the recompute lane and the staffing depth group on, so no two
    // surfaces can disagree about which codes are one pool.
    pool: {
      key: poolKeyFor({
        orgId: bucket.org_id,
        eventTypeId: bucket.event_type_id,
        criteria: bucket.criteria ?? null,
        fallbackUserId: bucket.fallback_user_id,
        memberIds: manualMemberIds,
      }),
      label: poolLabel(bucket.criteria ?? null),
    },
  };
}

/**
 * The rows in the order that makes the table a matrix (#1896).
 *
 * A read with no `order` returns rows in whatever order the store felt like
 * (L343), and measured against production that was 100, 101, 102, 110, 111,
 * then 500: the tiers interleaved, which destroys the one arrangement that makes
 * sixty pools legible. Sorting by code groups by debt tier, then backend, then
 * legal, because that is what the three digits ARE.
 *
 * Sorted HERE rather than in the query, so the order is pure, drivable, and
 * cannot be lost the next time somebody edits the read. It is also why the table
 * offers no sort controls: a sortable column would offer to undo this.
 *
 * A hand made pool has no position in the matrix, so it goes after all of it
 * rather than interleaving on a code that means nothing in that scheme.
 */
export function sortBucketRows(rows: BucketRow[]): BucketRow[] {
  return [...rows].sort(
    (a, b) =>
      Number(a.matrix === null) - Number(b.matrix === null) ||
      a.code.localeCompare(b.code, "en") ||
      a.id.localeCompare(b.id),
  );
}

/** Whether the manual members column carries any information at all.
 *
 *  Routing here is by ATTRIBUTE, so on production every one of the sixty pools
 *  has zero hand picked members, and a column reading 0 sixty times down is a
 *  column of noise that pushes the ones that vary further right. It appears when
 *  somebody has actually named a person on a pool. */
export function showsManualMembers(rows: BucketRow[]): boolean {
  return rows.some((r) => r.manualMembers > 0);
}

/** What a row's state IS, which is the one thing worth scanning sixty rows for. */
export type BucketHealth =
  /** Nobody can take a booking here and nothing catches it. */
  | "blocked"
  /** Nobody matches, but a fallback agent does catch it. */
  | "fallback-only"
  /** Nobody matches, and the routing ladder carries its leads to a staffed pool. */
  | "overflows"
  /** Somebody matches. */
  | "staffed"
  /** The depth was not measured, so this row says nothing either way. */
  | "unmeasured";

export function bucketHealth(row: BucketRow): BucketHealth {
  if (row.eligible === null) return "unmeasured";
  if (row.eligible > 0) return "staffed";
  if (row.hasFallback) return "fallback-only";
  return row.overflowTo ? "overflows" : "blocked";
}

/**
 * Rows whose text matches what somebody typed.
 *
 * Matched against the code, the name and the three decoded labels, so typing
 * "achieve" or "very high" finds a column of the matrix and typing "412" finds
 * one pool. Case folded, and an empty query matches everything rather than
 * nothing, because a blank filter box means no filter.
 */
export function bucketRowMatches(row: BucketRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    row.code,
    row.name,
    row.matrix?.tier ?? "",
    row.matrix?.backend ?? "",
    row.matrix?.legal ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

export interface BucketFilter {
  query: string;
  /** Show only the pools that can take no booking at all. */
  blockedOnly: boolean;
}

export function filterBucketRows(rows: BucketRow[], filter: BucketFilter): BucketRow[] {
  return rows.filter(
    (r) =>
      bucketRowMatches(r, filter.query) &&
      (!filter.blockedOnly || bucketHealth(r) === "blocked"),
  );
}

/** The one line above the table. Each state is counted separately and a state
 *  nobody measured is never folded into a healthy one (L11). */
export function bucketTableSummary(rows: BucketRow[]): string {
  if (rows.length === 0) return "No buckets yet.";
  const blocked = rows.filter((r) => bucketHealth(r) === "blocked").length;
  const unmeasured = rows.filter((r) => bucketHealth(r) === "unmeasured").length;
  const overflowing = rows.filter((r) => bucketHealth(r) === "overflows").length;
  // Two facts, not one (#2237). This used to print the row count under the word
  // "pools", which on the live matrix said "60 pools" about fifteen of them: the
  // exact confusion this issue was opened about, on the screen somebody reads to
  // understand the routing.
  const poolCount = new Set(rows.map((r) => r.pool.key)).size;
  const buckets = `${rows.length} bucket${rows.length === 1 ? "" : "s"}`;
  const pools =
    poolCount === rows.length
      ? buckets
      : `${buckets} across ${poolCount} routing pool${poolCount === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (blocked > 0) {
    parts.push(`${blocked} can take no booking at all`);
  }
  if (overflowing > 0) {
    parts.push(
      `${overflowing} ${overflowing === 1 ? "sends its" : "send their"} leads to another pool`,
    );
  }
  if (unmeasured > 0) {
    parts.push(`${unmeasured} could not be measured`);
  }
  if (parts.length === 0) return `${pools}, every one of them staffed.`;
  return `${pools}, ${parts.join(", and ")}.`;
}

/** What one row's staffing says, in words, for the cell and for assistive tech. */
export function bucketHealthLabel(row: BucketRow): string {
  switch (bucketHealth(row)) {
    case "unmeasured":
      return "Not measured";
    case "blocked":
      return "Nobody, and no fallback";
    case "fallback-only":
      return "Fallback only";
    case "overflows":
      return `Nobody; goes to ${row.overflowTo}`;
    case "staffed":
      return `${row.eligible} agent${row.eligible === 1 ? "" : "s"}`;
  }
}

/** What the table says when a filter has hidden everything, which is a different
 *  fact from having no buckets (L10). */
export function noMatchText(filter: BucketFilter, total: number): string {
  if (filter.blockedOnly && !filter.query.trim()) {
    return `Every one of the ${total} pools can take a booking.`;
  }
  if (filter.blockedOnly) {
    return `No pool matching that text is short of agents. ${total} pools in all.`;
  }
  return `No pool matches that text. ${total} pools in all.`;
}
