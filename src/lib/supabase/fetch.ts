import { fetchWithBudget } from "@/lib/call-budget";
import type { FetchLike } from "@/lib/fetch-within-deadline";
import { SUPABASE_FETCH_TIMEOUT_MS } from "@/lib/supabase/fetch-deadline";

export { SUPABASE_FETCH_TIMEOUT_MS };

/**
 * The Supabase deadline laid over any fetch. Each request waits for the smaller
 * of `SUPABASE_FETCH_TIMEOUT_MS` and what the enclosing call budget has left, so
 * a confirm's sequential reads share one expiry (#3102).
 *
 * The deadline goes OUTSIDE whatever `inner` is. A load run's fault injector
 * (#3104) belongs inside it, as `supabaseFetchOver(faulting)`, so an injected
 * hang is cut by the same deadline a real one is and the run judges what
 * production would do.
 */
export function supabaseFetchOver(inner: FetchLike): FetchLike {
  return fetchWithBudget(inner, SUPABASE_FETCH_TIMEOUT_MS, "supabase");
}

/**
 * The fetch the server Supabase clients are built with: the secret key client and
 * the cookie bound one. Reads the global `fetch` per request rather than
 * capturing it once, so a test that stubs it is honoured.
 */
// deadline-ok: the inner fetch of supabaseFetchOver, bounded by SUPABASE_FETCH_TIMEOUT_MS
export const supabaseFetch = supabaseFetchOver((input, init) => fetch(input, init));
