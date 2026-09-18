/**
 * Mark a response as one nothing may keep a copy of (#2561).
 *
 * The lead facing mutations (confirm, cancel, reschedule) each answer with
 * something true of ONE booking at ONE moment, and two of them carry the manage
 * URL that authorises a later cancel or reschedule. Without a directive, a shared
 * cache (a corporate proxy, an ISP one, a browser's back/forward store) decides
 * for itself how long to keep that, and the next reader can be handed it. The
 * refusals matter as much as the successes: a cached 429 or a cached "that slot
 * has gone" is an answer replayed to somebody it was never about.
 *
 * `no-store` rather than `no-cache`: `no-cache` permits storing the response and
 * only requires revalidation, which still leaves one lead's confirmation sitting
 * in a shared store.
 *
 * It STAMPS the response it is given and returns the same object, so a handler is
 * wrapped once at its export rather than each of its returns being remembered.
 * That is the point: `src/app/booking/route.ts` alone has thirteen of them, and a
 * fourteenth added later carries this by construction (L96). It is the same shape
 * as `stampSeenIp` in `src/lib/loadtest-echo.ts`, which wraps the same way for the
 * same reason.
 */
export const NO_STORE = "no-store";

export function noStore<T extends Response>(res: T): T {
  try {
    res.headers.set("cache-control", NO_STORE);
  } catch {
    // An immutable response head is not worth failing a booking over. Nothing in
    // Slate returns one on these paths today, and if something ever does, the
    // caching is a smaller harm than a confirmed booking answered as a 500.
  }
  return res;
}
