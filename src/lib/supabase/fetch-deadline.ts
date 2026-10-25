import { fetchWithDeadline } from "@/lib/fetch-within-deadline";

/**
 * The deadline on ONE request a server Supabase client sends (#3102).
 *
 * Sized for the cron lanes, which share the secret key client: the slowest
 * statement measured on production is 7.9 seconds, so 15 leaves a slow but
 * healthy query room and still ends a request that never comes back. The confirm
 * path is NOT bounded by this number alone, because it makes many requests in a
 * row: it runs inside a call budget (`BOOKING_CONFIRM_BUDGET_MS`) that caps every
 * request to what the whole confirm has left.
 */
export const SUPABASE_FETCH_TIMEOUT_MS = 15_000;

/**
 * The middleware's session refresh. It runs on the edge before any route, so
 * there is no budget to consult, and it is kept apart from `supabaseFetch` so the
 * middleware bundle never reaches the async context module that budgets need.
 */
export const supabaseEdgeFetch = fetchWithDeadline(
  // deadline-ok: the inner fetch of fetchWithDeadline, bounded by SUPABASE_FETCH_TIMEOUT_MS
  (input, init) => fetch(input, init),
  SUPABASE_FETCH_TIMEOUT_MS,
  "supabase auth",
);
