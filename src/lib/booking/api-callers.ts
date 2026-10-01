/**
 * Every system that holds a booking API key (#2645), one key each. If two callers
 * were ever handed the same value by mistake, the request is attributed to the one
 * declared first.
 *
 * Its own module, with no imports, because two different readers need it: the key
 * check (`api-auth.ts`, which re-exports it) and the booking source vocabulary
 * (`booking-source.ts`, #2876), which derives one `api-<caller>` source per caller
 * that may book and is read by client components and by node scripts that must not
 * reach the auth module's aliases.
 *
 * `marcia` (#2940) is Pennie's Pipedream SMS workflow. It cancels a lead's booking
 * when the lead opts out or asks to cancel by text, and does nothing else, so its key
 * opens the cancel alone (`CANCEL_ONLY_CALLERS`).
 */
export const BOOKING_API_CALLERS = ["regal", "trypennie", "canary", "marcia"] as const;
export type BookingApiCaller = (typeof BOOKING_API_CALLERS)[number];

/**
 * Callers whose key is accepted by the cancel (`POST /api/bookings/cancel` and its
 * `DELETE /api/bookings` twin) and by no other route (#2940). A cancel is the only
 * thing Marcia does, and a key that can also book or read every lead's bookings would
 * be a wider grant than that job needs, held by a third party workflow.
 */
export const CANCEL_ONLY_CALLERS = ["marcia"] as const satisfies readonly BookingApiCaller[];
export type CancelOnlyCaller = (typeof CANCEL_ONLY_CALLERS)[number];

/** A caller whose key opens the whole booking API. */
export type FullApiCaller = Exclude<BookingApiCaller, CancelOnlyCaller>;

const CANCEL_ONLY: ReadonlySet<string> = new Set(CANCEL_ONLY_CALLERS);

/**
 * Every caller but the cancel only ones, derived rather than typed out. This is the
 * DEFAULT key set every key authed route builds (`configuredBookingApiKeys`), so a
 * route nobody thought about refuses a cancel only key rather than admitting it.
 */
export const FULL_API_CALLERS: readonly FullApiCaller[] = BOOKING_API_CALLERS.filter(
  (c): c is FullApiCaller => !CANCEL_ONLY.has(c),
);
