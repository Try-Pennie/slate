/**
 * The live wiring of the coordinator's booking operation (#4202, `placed-booking.ts`).
 *
 * Kept out of `service.ts` on purpose: it is a new entry point, and everything it needs
 * from there is already exported (`realDeps`, `pageBookingFailure`), so the booking
 * machinery it drives is the one every other path uses, and nothing here is a second
 * copy of it. The coordinator page (Phase 7) calls `placeBookingForCoordinator` from a
 * server action that has already authenticated the coordinator and holds their user id.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { log } from "@/lib/log";
import { deferWebhookSend } from "@/lib/after-response";
import type { User } from "@/lib/db/types";
import * as orchestration from "@/lib/booking/orchestration";
import { realDeps, pageBookingFailure } from "@/lib/booking/service";
import { readBookingHorizonDays, readPlaceholderBookingEnabled } from "@/lib/booking/settings";
import { placeBooking, type PlacedBookingDeps, type PlacedBookingInput, type PlacedBookingOutcome } from "@/lib/booking/placed-booking";

/**
 * The org's placeholder advisor in one world, or null when it has none or it has left
 * (a departed placeholder holds no new call). THROWS on a failed read: a null from an
 * unread table would refuse "no placeholder" against a read that never ran.
 */
export async function findPlaceholderAdvisor(orgId: string, isTest: boolean): Promise<User | null> {
  const row = unwrap(
    await supabaseAdmin()
      .from("users")
      // cap-safe: at most one placeholder per org and world (users_one_placeholder_per_org, 0207).
      .select("*")
      .eq("org_id", orgId)
      .eq("is_test", isTest)
      .eq("is_placeholder", true)
      .maybeSingle(),
    "placeholder advisor",
  ) as User | null;
  if (row && row.deactivated_at !== null) {
    log.warn("placed-booking", { msg: "the placeholder advisor has been deactivated, so no call can be placed on it", user_id: row.id });
    return null;
  }
  return row;
}

/** The real dependencies `placeBooking` runs on, over one booking deps object. */
export function placedBookingDeps(): PlacedBookingDeps {
  const deps = realDeps(deferWebhookSend);
  return {
    now: () => Date.now(),
    manageUrl: (token) => orchestration.manageUrlFor(deps.appBaseUrl(), token),
    placeholderEnabled: readPlaceholderBookingEnabled,
    horizonDays: readBookingHorizonDays,
    businessHours: () => deps.businessHours(),
    resolveBucketByCode: (code) => deps.resolveBucketByCode(code),
    findBookingByIdempotencyKey: (key) => deps.findBookingByIdempotencyKey(key),
    findActiveBookingsForPerson: (identity, world) => deps.findActiveBookingsForPerson(identity, world),
    findPlaceholder: findPlaceholderAdvisor,
    createBooking: (input, opts) => orchestration.createBooking(input, deps, opts),
    createPlaceholderBooking: (input) => orchestration.createPlaceholderBooking(input, deps),
    rescheduleBooking: ({ token, startIso, reason, actorUserId, zone, ontoPlaceholder }) =>
      orchestration.rescheduleBooking(token, startIso, reason, "admin", deps, Date.now(), { userId: actorUserId }, undefined, {
        leadZone: zone,
        ...(ontoPlaceholder ? { ontoPlaceholder } : {}),
      }),
  };
}

/**
 * Book, or move, the call a customer named, as the signed in coordinator. A failure
 * pages exactly as a failed booking does on every other path (`pageBookingFailure`),
 * a dependency that did not answer first becoming the retryable outage it is.
 */
export async function placeBookingForCoordinator(input: PlacedBookingInput): Promise<PlacedBookingOutcome> {
  try {
    return await placeBooking(input, placedBookingDeps());
  } catch (caught) {
    const err = orchestration.timeoutAsRetryable(caught);
    await pageBookingFailure(err);
    throw err;
  }
}
