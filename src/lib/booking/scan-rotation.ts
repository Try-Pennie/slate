/**
 * Rotating scan offset for the bounded self-heal sweeps (#512).
 *
 * `reconcileMissingBusyBlocks` (#431) and `reconcileCancelledBusyBlocks` (#428)
 * each scan at most `limit` rows per tick. At 100 to 200 agents there can be more
 * than `limit` upcoming rows, and a fixed scan only ever sees the first page, so a
 * tail row that genuinely lost (or kept a stale) busy_block would never be looked
 * at. This drives a persisted offset that cycles across ticks: a full page means
 * there may be more behind it (advance), a short page means the end is reached
 * (wrap to 0). Every matching row is therefore covered within ceil(N / limit)
 * ticks, while a backlog that fits in one page never leaves offset 0, so the
 * common case is byte-for-byte the old fixed scan.
 *
 * Pure and IO-free: the selfheal lane persists the returned value and reads it
 * back next tick. The lane holds a single lock, so no two ticks race the cursor.
 */
export function nextScanOffset(offset: number, scanned: number, limit: number): number {
  // A page that did not fill the cap means we reached the end of the matching
  // set at this offset, so restart from the priority page. This also covers the
  // exact-multiple boundary: the page at offset === N returns 0 rows and wraps,
  // so the offset can never advance past the data forever.
  if (scanned < limit) return 0;
  return offset + limit;
}
