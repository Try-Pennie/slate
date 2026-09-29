/**
 * Every system that holds a booking API key (#2645), one key each. If two callers
 * were ever handed the same value by mistake, the request is attributed to the one
 * declared first.
 *
 * Its own module, with no imports, because two different readers need it: the key
 * check (`api-auth.ts`, which re-exports it) and the booking source vocabulary
 * (`booking-source.ts`, #2876), which derives one `api-<caller>` source per caller
 * and is read by client components and by node scripts that must not reach the
 * auth module's aliases.
 */
export const BOOKING_API_CALLERS = ["regal", "trypennie", "canary"] as const;
export type BookingApiCaller = (typeof BOOKING_API_CALLERS)[number];
