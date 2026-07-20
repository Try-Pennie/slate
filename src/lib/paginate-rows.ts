/**
 * In-memory pagination of an already-loaded list, for server-rendered tables that
 * hold the full set for other reasons but should not render every row at once
 * (the admin agents table, #94: the roster is loaded whole for the bucket/depth
 * editors, but the DOM stays bounded).
 *
 * `page` is 1-based and clamped into range, so an out-of-range or garbage page
 * (a hand-edited URL) resolves to a valid one instead of an empty table.
 */
export interface PagedRows<T> {
  items: T[];
  /** The clamped, 1-based page actually shown. */
  page: number;
  /** Total number of pages (at least 1, even when empty). */
  pageCount: number;
  /** Total items across all pages. */
  total: number;
  pageSize: number;
  /** 1-based index of the first item shown (0 when empty). */
  start: number;
  /** 1-based index of the last item shown (0 when empty). */
  end: number;
}

export function paginateRows<T>(all: T[], requestedPage: number, pageSize: number): PagedRows<T> {
  const size = Math.max(1, Math.floor(pageSize));
  const total = all.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.max(1, Math.floor(requestedPage) || 1), pageCount);
  const startIdx = (page - 1) * size;
  const items = all.slice(startIdx, startIdx + size);
  return {
    items,
    page,
    pageCount,
    total,
    pageSize: size,
    start: total === 0 ? 0 : startIdx + 1,
    end: startIdx + items.length,
  };
}
