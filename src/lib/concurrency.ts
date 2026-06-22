/**
 * Runs `task` over `items` with at most `limit` in flight at once, preserving
 * input order in the returned results. Bounds outbound fan-out so callers stay
 * under Cloudflare's simultaneous-connection ceiling while still beating a fully
 * serial loop. Shared by the completion-sweep webhook fan-out and verify-on-book's
 * free/busy calls (#224).
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await task(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
