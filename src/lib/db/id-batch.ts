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
 * Ids per batched read or write against a uuid key. 200 is 7,478 bytes, measured
 * accepted, and less than half the smallest size measured refused, so there is room
 * for a longer base URL or an extra filter without going near the edge.
 */
export const ID_BATCH_ROWS = 200;
