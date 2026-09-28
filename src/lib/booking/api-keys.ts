import { bookingApiKeyFor } from "@/lib/env";
import {
  BOOKING_API_CALLERS,
  parseApiKeys,
  type ApiKey,
  type BookingApiCaller,
} from "@/lib/booking/api-auth";

/**
 * The booking API keys configured on this deployment, for the callers named
 * (#2645). The one place a key set is built from the environment: every route that
 * accepts a booking key calls this, so a caller added to `BOOKING_API_CALLERS` is
 * accepted everywhere at once rather than wherever somebody remembered to add it.
 *
 * `callers` narrows WHO may call a surface (the smoke endpoints pass
 * `CANARY_CALLERS`); it defaults to every caller.
 */
export function configuredBookingApiKeys(
  callers: readonly BookingApiCaller[] = BOOKING_API_CALLERS,
): ApiKey[] {
  return parseApiKeys(
    callers.map((caller) => ({
      caller,
      primary: bookingApiKeyFor(caller, "primary"),
      secondary: bookingApiKeyFor(caller, "secondary"),
    })),
  );
}
