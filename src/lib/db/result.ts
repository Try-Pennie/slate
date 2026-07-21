/**
 * Fail-loud unwrap for a Supabase/PostgREST result (#277).
 *
 * Reads used to destructure `const { data } = await db...` and ignore `error`:
 * when a query failed (e.g. a missing column on a half-applied migration) `data`
 * came back null, the availability pool collapsed to empty and the booker
 * silently showed NO availability, or the SF roster sync (#963) treated the read
 * as an empty roster and re-inserted every agent. Either way a broken deploy
 * looked like a quiet day. Routing the critical reads through `unwrap` turns that
 * into a thrown error the caller (and our cron alerting) surfaces, instead of a
 * degrade.
 *
 * A null `data` with a null `error` is NOT a failure — it's "not found"
 * (`maybeSingle()`, an empty select). unwrap passes that through so the
 * caller's own null-handling still runs; it throws ONLY on a real `error`.
 *
 * Pure + dependency-free so it's node-testable (scripts/test-db-result.ts).
 */
export interface DbResult<T> {
  data: T;
  error: { message: string } | null;
}

export function unwrap<T>(res: DbResult<T>, context: string): T {
  if (res.error) {
    throw new Error(`read failed [${context}]: ${res.error.message}`);
  }
  return res.data;
}
