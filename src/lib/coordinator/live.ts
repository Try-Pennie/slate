/**
 * The real dependencies of the coordinator booking page's three operations (#4205):
 * the customer lookup (`customer.ts`), the placeholder count (`placeholder-calls.ts`)
 * and placing a call (`place-call.ts`). Every reader is the one the rest of Slate uses,
 * so nothing here is a second copy of a rule. Server only.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrapCount } from "@/lib/db/result";
import { readLeadWithPlace } from "@/lib/salesforce/lead-contact";
import { readOneLeadXbc, type LeadFieldRecord, type LeadSoqlRunner } from "@/lib/salesforce/lead-xbc";
import { resolveBucketByCode } from "@/lib/availability/service";
import { loadBusinessHours } from "@/lib/booking/business-hours-load";
import { readBookingHorizonDays } from "@/lib/booking/settings";
import { findActiveBookingsForPerson } from "@/lib/booking/service";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import { findPlaceholderAdvisor, placeBookingForCoordinator } from "@/lib/booking/placed-booking-service";
import type { CustomerDeps, LookupDeps } from "@/lib/coordinator/customer";
import type { PlaceholderCallsDeps } from "@/lib/coordinator/placeholder-calls";
import { findCustomer } from "@/lib/coordinator/customer";
import type { PlaceCallDeps } from "@/lib/coordinator/place-call";

/**
 * One Salesforce token for every query one operation makes, fetched on first use: a
 * lookup reads the Lead and then its score, and a second token exchange per lookup
 * would double the calls against the org's daily allowance for nothing.
 */
function soqlRunner(): LeadSoqlRunner {
  let session: Promise<{ token: string; instanceUrl: string }> | null = null;
  return async (soql) => {
    const { sfToken, querySoqlAll } = await import("@/lib/salesforce/rest");
    session ??= sfToken();
    const { token, instanceUrl } = await session;
    return querySoqlAll<LeadFieldRecord>(instanceUrl, token, soql);
  };
}

export function customerDeps(): CustomerDeps {
  const run = soqlRunner();
  return {
    readLead: (id) => readLeadWithPlace(id, run),
    readLeadXbc: (id) => readOneLeadXbc(id, run),
    resolveBucketByCode,
  };
}

export function lookupDeps(): LookupDeps {
  return {
    ...customerDeps(),
    findActiveBookingsForPerson,
    businessHours: loadBusinessHours,
    horizonDays: readBookingHorizonDays,
    now: () => Date.now(),
  };
}

/** Active calls on one advisor overlapping [startIso, endIso). THROWS on a failed read. */
async function countOverlapping(userId: string, startIso: string, endIso: string): Promise<number> {
  return unwrapCount(
    await supabaseAdmin()
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("assigned_user_id", userId)
      .in("status", ["confirmed", "rescheduled"])
      .lt("starts_at", endIso)
      .gt("ends_at", startIso),
    "placeholder calls at a time",
  );
}

export function placeholderCallsDeps(): PlaceholderCallsDeps {
  return { resolveBucketByCode, findPlaceholder: findPlaceholderAdvisor, countOverlapping };
}

export function placeCallDeps(): PlaceCallDeps {
  const customers = customerDeps();
  return {
    findCustomer: (reference) => findCustomer(reference, customers),
    place: placeBookingForCoordinator,
    rescheduleReasons: async () => (await loadReasonOptions()).reschedule.selectable,
    mintSubmissionId: () => crypto.randomUUID(),
  };
}
