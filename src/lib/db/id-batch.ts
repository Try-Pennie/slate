/**
 * How many ids may travel in one PostgREST `in` filter (#1259).
 *
 * PostgREST puts `.in("id", ids)` in the QUERY STRING, so a batch of ids is a request
 * URL length problem before it is a row count problem, and an oversized batch is
 * REFUSED rather than merely slow. Measured against the real prod PostgREST on
 * 2026-08-04 with 36-character uuids: 350 ids (13,028 bytes) is accepted, 400
 * (14,878) is refused at the transport, 1,000 gives a 400 and 2,000 a 414. So the
 * ceiling sits between roughly 13 KB and 15 KB.
 *
 * This lives in one place, and every batching caller reads it, because the number was
 * already got wrong once: PR #1251 shipped a 500-id batch (18,578 bytes) that fails on
 * every request. It was justified by pointing at `WRITE_CHUNK` (500) in
 * `google/sync.ts`, which carries Google event ids of about 27 characters rather than
 * 36-character uuids, so the precedent did not transfer. A count that looks similar is
 * not the quantity that decides; bytes are.
 *
 * scripts/test-id-batch-url-budget.ts pins the measurements and, as its positive
 * control, proves the guard still rejects 500.
 */

/** Bytes a uuid contributes to the filter: 36 characters plus its comma. */
const BYTES_PER_ID = 37;
/** The `?select=...&id=in.(...)` envelope, generously rounded up. */
const FILTER_ENVELOPE_BYTES = 120;

/**
 * Ceiling for the id portion of one request URL. Deliberately well inside the size
 * measured working (13,028 bytes) rather than just under the first observed failure,
 * because the real limit is a platform detail that can tighten without notice.
 */
export const MAX_IN_FILTER_BYTES = 10_000;

/** Approximate bytes an `in` filter of `count` uuids occupies in the URL. */
export function inFilterBytes(count: number): number {
  return FILTER_ENVELOPE_BYTES + Math.max(0, count) * BYTES_PER_ID;
}

/**
 * A safe number of uuids to put in one `in` filter: 7,478 bytes, measured accepted,
 * and less than half the smallest size measured refused.
 *
 * Exported for the BYTE assertions in scripts/test-id-batch-url-budget.ts and for
 * nothing else. It is deliberately no longer a batching constant (#1321): batching
 * a set of ids by a row count shipped broken three times, every time because the
 * count was carried over from a call site whose ids were a different length, and an
 * oversized `in` filter is refused at the transport rather than merely slow. Since
 * `chunkIdsByUrlBudget` measures the ids it is actually given, there is no reason
 * left to reach for a count, so the name is no longer offered as one.
 *
 * Use `chunkIdsByUrlBudget` to split ids. Use a plain local number for a row
 * `.limit()`, where the constraint is subrequests and wall clock rather than URL
 * bytes, so the two can never be tuned against each other again.
 */
export const SAFE_UUID_BATCH_FOR_MEASUREMENT = 200;

/**
 * Bytes ONE id contributes to the filter: its URL-encoded length plus the comma that
 * separates it. Encoded, not raw, because a character needing escaping costs three
 * bytes in the URL and a raw-length budget would be optimistic exactly where it
 * matters.
 */
function idBytes(id: string): number {
  return encodeURIComponent(id).length + 1;
}

/** Approximate bytes an `in` filter of these SPECIFIC ids occupies in the URL. */
export function idFilterBytes(ids: string[]): number {
  let total = FILTER_ENVELOPE_BYTES;
  for (const id of ids) total += idBytes(id);
  return total;
}

/**
 * Split ids into batches that each fit the URL budget, measured from the ids
 * THEMSELVES rather than from an assumed length (#1268).
 *
 * `ID_BATCH_ROWS` is a count, and a count only works while every id is the same size.
 * It is calibrated for 36-character uuids. Google event ids are neither uuids nor one
 * length: measured in production, `bookings.gcal_event_id` averages 67 characters and
 * `busy_blocks.gcal_event_id` averaged 43 reaching 181 (#1268). A count tuned for the
 * average sends four times too many bytes on the outliers, and an oversized `in`
 * filter is REFUSED at the transport, not merely slow.
 *
 * That is the mistake this module already records once: 500 was carried over from a
 * 27-character precedent onto 36-character uuids and shipped broken (#1259). Measuring
 * removes the need to recalibrate per key type, so it cannot be carried over wrong
 * again.
 *
 * A single id larger than the entire budget still gets a batch of its own. Dropping it
 * would silently leave a row behind (for the delete callers, a stale busy block that
 * over-blocks an agent forever), and emitting nothing would loop. Sending it and
 * letting the transport refuse is the loud failure.
 */
export function chunkIdsByUrlBudget(
  ids: string[],
  maxBytes: number = MAX_IN_FILTER_BYTES,
): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let used = FILTER_ENVELOPE_BYTES;

  for (const id of ids) {
    const cost = idBytes(id);
    if (current.length > 0 && used + cost > maxBytes) {
      chunks.push(current);
      current = [];
      used = FILTER_ENVELOPE_BYTES;
    }
    current.push(id);
    used += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
