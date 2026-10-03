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

/**
 * Shares one in flight load per key between concurrent callers (#3123).
 *
 * A per-isolate cache that only stores RESULTS lets a burst arriving while the
 * entry is missing or expired start one load per request: N reads of the same row,
 * or N token mints for the same identity. The returned function hands every caller
 * that arrives while a load for `key` is pending the SAME promise, and forgets it
 * once it settles either way, so a rejected load is never served to a later caller
 * and the next request after a failure retries at once.
 */
export function makeSharedInFlight<K, V>(): (key: K, load: () => Promise<V>) => Promise<V> {
  const pending = new Map<K, Promise<V>>();
  return (key, load) => {
    const existing = pending.get(key);
    if (existing) return existing;
    // An async wrapper, so a load that throws synchronously still becomes a
    // rejection and still reaches the cleanup below.
    const flight = (async () => load())().finally(() => {
      pending.delete(key);
    });
    pending.set(key, flight);
    return flight;
  };
}
