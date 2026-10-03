import { fetchWithBudget } from "@/lib/call-budget";
import { SUPABASE_FETCH_TIMEOUT_MS } from "@/lib/supabase/fetch-deadline";

export { SUPABASE_FETCH_TIMEOUT_MS };

/**
 * The fetch the server Supabase clients are built with: the secret key client and
 * the cookie bound one. Each request waits for the smaller of
 * `SUPABASE_FETCH_TIMEOUT_MS` and what the enclosing call budget has left, so a
 * confirm's sequential reads share one expiry (#3102). Reads the global `fetch`
 * per request rather than capturing it once, so a test that stubs it is honoured.
 */
export const supabaseFetch = fetchWithBudget(
  (input, init) => fetch(input, init),
  SUPABASE_FETCH_TIMEOUT_MS,
  "supabase",
);
