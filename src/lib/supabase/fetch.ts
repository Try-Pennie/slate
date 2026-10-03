import { fetchWithDeadline } from "@/lib/fetch-within-deadline";

/**
 * The deadline on every request the server clients send (#3102).
 *
 * The secret key client serves the confirm path and every cron lane, so this is
 * one number, sized from both ends. Below the booker's own 20 second abort
 * (`REQUEST_TIMEOUT_MS`), so a hung database answers the lead with our retryable
 * 503 rather than leaving the browser to give up on its own; and nearly twice the
 * 8 seconds the Google calls on that path get, because the cron lanes share this
 * client and a slow but healthy query must not be the thing it cuts. What it is
 * for is the request that never comes back at all.
 */
export const SUPABASE_FETCH_TIMEOUT_MS = 15_000;

/**
 * The fetch every server Supabase client is built with: the secret key client, the
 * cookie bound one, and the middleware's session refresh. Reads the global `fetch`
 * per request rather than capturing it once, so a test that stubs it is honoured.
 */
export const supabaseFetch = fetchWithDeadline(
  (input, init) => fetch(input, init),
  SUPABASE_FETCH_TIMEOUT_MS,
  "supabase",
);
