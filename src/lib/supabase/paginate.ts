/** PostgREST returns at most this many rows in one response. A read consumed as
 *  an aggregate must page past it or it silently truncates (#828, #35 / #166). */
export const PAGE_SIZE = 1000;

/**
 * Read every row of a query, page by page. PostgREST caps a single response at
 * 1,000 rows, and a silently truncated read that is consumed as an aggregate
 * over-states or under-states coverage: an agent whose 1,001st busy block was
 * dropped looks free and gets overbooked, an OOO insight silently under-counts.
 * Throws on a read error rather than returning a short list that reads as "that
 * is all the rows there are".
 *
 * `page(from, to)` must apply `.range(from, to)` to an otherwise-built query so
 * each call fetches one window; the caller owns the filters. `context` labels
 * the read in the thrown error so a failure is greppable to its call site.
 */
export async function selectAllPages<T>(
  context: string,
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: unknown[] | null; error?: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${context} read failed: ${error.message}`);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }
}
