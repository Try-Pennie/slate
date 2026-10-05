/** PostgREST returns at most this many rows in one response. A read consumed as
 *  an aggregate must page past it or it silently truncates (#828, #35 / #166). */
export const PAGE_SIZE = 1000;

/** One page's answer, as a PostgREST builder resolves. */
export interface PageResult {
  data: unknown[] | null;
  error?: { message: string } | null;
}

/**
 * The query `selectAllPages` pages: a built, filtered select with no `.range()`
 * yet. The helper orders it and cuts each page itself, so a caller cannot page
 * a query without a total order.
 */
export interface PageableQuery {
  order(column: string, options?: { ascending?: boolean }): PageableQuery;
  range(from: number, to: number): PromiseLike<PageResult>;
}

/**
 * Read every row of a query, page by page. PostgREST caps a single response at
 * 1,000 rows, and a silently truncated read that is consumed as an aggregate
 * over-states or under-states coverage: an agent whose 1,001st busy block was
 * dropped looks free and gets overbooked, an OOO insight silently under-counts.
 * Throws on a read error rather than returning a short list that reads as "that
 * is all the rows there are".
 *
 * Pages are cut with OFFSET, which partitions the result only under a TOTAL
 * order (#3273). Postgres owes no row order to a query that asks for none, so
 * each page could come back in its own order, overlapping one page and skipping
 * rows of another. Measured on production 2026-10-05: the availability busy read
 * returned 2,392 rows for a 43 advisor pool of which only 1,826 were distinct,
 * and the skipped meetings offered a sold out Monday as open.
 *
 * So the order is not the caller's choice to leave out. `uniqueKey` names a
 * column (or columns) unique across the table, normally the primary key, and is
 * appended after any order the query already carries: the caller's order still
 * decides the sequence, the key only breaks its ties. `build` returns the query
 * WITHOUT `.range()`; it is called once per page, so it must build afresh.
 *
 * `context` labels the read in the thrown error so a failure is greppable to its
 * call site.
 */
export async function selectAllPages<T>(
  context: string,
  uniqueKey: string | readonly string[],
  build: () => PageableQuery,
): Promise<T[]> {
  const keys = typeof uniqueKey === "string" ? [uniqueKey] : [...uniqueKey];
  if (keys.length === 0 || keys.some((k) => k.trim() === "")) {
    throw new Error(`${context}: selectAllPages needs a unique key to order pages by`);
  }
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let q = build();
    for (const k of keys) q = q.order(k, { ascending: true });
    const { data, error } = await q.range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${context} read failed: ${error.message}`);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }
}
