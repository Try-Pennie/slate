/**
 * Who the customer on the phone is, for the coordinator booking page (#4205, Phase 7 of
 * milestone 75). Plan: https://claude.ai/artifact/XbByMLoaMrBufMr6Chmct1
 *
 * From the Lead link or id the coordinator pasted (`parseLeadReference`), read through
 * the existing Salesforce readers:
 *
 *  - the contact details (`readLeadWithPlace`, beside `readLeadContact`);
 *  - the ZONE, from the Lead's zip and then its state (`leadZone`), never from the
 *    coordinator and never defaulted (Sam and Dan, 2026-10-23 and 26);
 *  - the BUCKET, exactly as the booker routes a link that carried no code
 *    (`resolveRoutingCode`): the score on the lead's current submission, and a score
 *    routing cannot use goes to the catch all, as it does for every other lead. The one
 *    exception is a TEST coordinator (their own users row is `is_test`, the drill
 *    account), who always books the partner test bucket whatever the score (Dan,
 *    2026-10-27), so a drill booking never lands on a real bucket as a real lead. Who is
 *    a test coordinator is decided by the server action from the signed in person
 *    (`CustomerRouting`), never by anything the page sends.
 *
 * Each missing piece is its own refusal (L11), and a Salesforce read that FAILS is never
 * read as a lead with nothing in it. Nothing here logs a value (docs/pii.md).
 *
 * Pure apart from the injected deps (relative imports), so
 * `scripts/test-coordinator-lookup.ts` drives every branch; `live.ts` wires the real ones.
 */
import { parseLeadReference } from "./lead-reference.ts";
import { bookableHoursOn, offeredDays, type BookableHours, type OfferedDays } from "./bookable-hours.ts";
import { leadZone } from "../zip-zones/zip-zones.ts";
import { PARTNER_BUCKET_CODE } from "../embed/public-test-bucket.ts";
import { resolveRoutingCode } from "../routing/lead-code.ts";
import { findPersonMatch, type PersonIdentity, type NamedWorld } from "../booking/person-dedupe.ts";
import { placedCallSummary, placedIdentity, looseMatchKind, type PlacedCallSummary } from "../booking/placed-booking.ts";
import type { BusinessHoursRules } from "../availability/compute.ts";
import type { SalesforceLeadWithPlace } from "../salesforce/lead-contact.ts";
import type { Booking, Bucket, EventType } from "../db/types.ts";
import { DateTime } from "luxon";

export const CUSTOMER_REFUSALS = [
  "not-a-lead-id",
  "no-such-lead",
  "salesforce-unreadable",
  "no-bucket",
  "bucket-unreadable",
  "zone-unknown",
] as const;
export type CustomerRefusal = (typeof CUSTOMER_REFUSALS)[number];

export interface Customer {
  /** The Lead id as Salesforce spells it (18 characters), which bookings store. */
  salesforceLeadId: string;
  name: string | null;
  firstName: string | null;
  email: string | null;
  phone: string | null;
  /** The customer's IANA zone, from the Lead. */
  zone: string;
  zoneFrom: "zip" | "state";
  bucketCode: string;
  /**
   * `catchall` when the lead's score is one routing cannot use, as on the booker;
   * `test-coordinator` when a test coordinator's booking went to the partner test bucket instead.
   */
  bucketSource: "salesforce" | "catchall" | "test-coordinator";
  bucketIsTest: boolean;
  durationMin: number;
}

export interface CustomerDeps {
  /** The Lead, or null when Salesforce returned none. THROWS on a failed read. */
  readLead(leadId: string): Promise<SalesforceLeadWithPlace | null>;
  /** The lead's score (`readOneLeadXbc`). THROWS on a failed read. */
  readLeadXbc(leadId: string): Promise<string | null | undefined>;
  resolveBucketByCode(code: string): Promise<{ bucket: Bucket; eventType: EventType } | null>;
}

export type FoundCustomer = { ok: true; customer: Customer } | { ok: false; refusal: CustomerRefusal };

/**
 * How the customer's bucket is decided, from the SIGNED IN coordinator (the server action
 * reads it off their own users row). Required, so every caller has to say which.
 */
export interface CustomerRouting {
  /** The coordinator is a test account (`users.is_test`): book the partner test bucket, whatever the Lead's score. */
  testCoordinator: boolean;
}

export async function findCustomer(reference: string, deps: CustomerDeps, routing: CustomerRouting): Promise<FoundCustomer> {
  const ref = parseLeadReference(reference);
  if (!ref.ok) return { ok: false, refusal: ref.refusal };

  let lead: SalesforceLeadWithPlace | null;
  try {
    lead = await deps.readLead(ref.leadId);
  } catch {
    return { ok: false, refusal: "salesforce-unreadable" };
  }
  if (!lead) return { ok: false, refusal: "no-such-lead" };

  const zone = leadZone({ postalCode: lead.postalCode, state: lead.state });
  if (!zone.ok) return { ok: false, refusal: "zone-unknown" };

  let code: { code: string; source: "link" | "salesforce" | "catchall" | "test-coordinator" };
  if (routing.testCoordinator) {
    // The drill account: the score is never asked, so nothing about the Lead can send
    // the booking to a real bucket.
    code = { code: PARTNER_BUCKET_CODE, source: "test-coordinator" };
  } else {
    try {
      // No link code and no submission: the Lead id is what the coordinator has, so
      // routing reads the lead's own score, the booker's step 2.
      code = await resolveRoutingCode(null, lead.id, deps.readLeadXbc, { id: null, readLeadId: async () => undefined });
    } catch {
      return { ok: false, refusal: "salesforce-unreadable" };
    }
  }
  let resolved: Awaited<ReturnType<CustomerDeps["resolveBucketByCode"]>>;
  try {
    resolved = await deps.resolveBucketByCode(code.code);
  } catch {
    // An outage, never "no such bucket": the coordinator can try again.
    return { ok: false, refusal: "bucket-unreadable" };
  }
  if (!resolved) return { ok: false, refusal: "no-bucket" };

  return {
    ok: true,
    customer: {
      salesforceLeadId: lead.id,
      name: lead.name,
      firstName: lead.firstName,
      email: lead.email,
      phone: lead.phone,
      zone: zone.zone,
      zoneFrom: zone.from,
      bucketCode: resolved.bucket.code,
      bucketSource: code.source === "catchall" || code.source === "test-coordinator" ? code.source : "salesforce",
      bucketIsTest: resolved.bucket.is_test,
      durationMin: resolved.eventType.duration_min,
    },
  };
}

/** The customer's existing active call, and what placing a call will do to it. */
export type ExistingCallView =
  | { kind: "none" }
  /** Read failed: said as unknown, never as "no call". Placing refuses too. */
  | { kind: "unreadable" }
  | { kind: "found"; call: PlacedCallSummary; happens: "moves-when-confirmed" }
  | { kind: "found"; call: PlacedCallSummary; happens: "refused-loose-match"; matchedOn: "email-and-phone" | "email-or-phone" };

export interface LookupDeps extends CustomerDeps {
  /** The person's active calls in one world (`findActiveBookingsForPerson`). THROWS on a failed read. */
  findActiveBookingsForPerson(identity: PersonIdentity, world: NamedWorld): Promise<Booking[]>;
  /** THROWS when unreadable. */
  businessHours(): Promise<BusinessHoursRules>;
  /** Null when the read failed. */
  horizonDays(): Promise<number | null>;
  now(): number;
}

export type CustomerLookup =
  | {
      ok: true;
      customer: Customer;
      existingCall: ExistingCallView;
      hours: BookableHours;
      /** The page's day row and its time buttons, judged by the same predicate as `hours`. */
      days: OfferedDays;
    }
  | { ok: false; refusal: CustomerRefusal };

/**
 * Everything the page shows once a customer is found: who, their zone and bucket, their
 * call and what happens to it (judged by the same identity and match `placeBooking`
 * uses, so the page cannot promise a move the booking then refuses), and the hours a
 * call may start on `date` (the customer's local day; today there when absent).
 */
export async function lookupCustomer(
  input: { reference: string; date?: string },
  deps: LookupDeps,
  routing: CustomerRouting,
): Promise<CustomerLookup> {
  const found = await findCustomer(input.reference, deps, routing);
  if (!found.ok) return found;
  const { customer } = found;

  let existingCall: ExistingCallView;
  try {
    const identity = placedIdentity(customer.salesforceLeadId, { email: customer.email ?? undefined, phone: customer.phone ?? undefined });
    const calls = await deps.findActiveBookingsForPerson(identity, { isTest: customer.bucketIsTest });
    const match = findPersonMatch(identity, calls);
    existingCall = !match
      ? { kind: "none" }
      : match.strength === "strong"
        ? { kind: "found", call: placedCallSummary(match.booking), happens: "moves-when-confirmed" }
        : { kind: "found", call: placedCallSummary(match.booking), happens: "refused-loose-match", matchedOn: looseMatchKind(match.strength) };
  } catch {
    existingCall = { kind: "unreadable" };
  }

  const nowMs = deps.now();
  const date = input.date ?? DateTime.fromMillis(nowMs, { zone: customer.zone }).toISODate() ?? "";
  let hours: BookableHours;
  let days: OfferedDays;
  try {
    const rules = await deps.businessHours();
    const horizon = await deps.horizonDays();
    if (horizon === null) {
      hours = { ok: false, reason: "horizon-unreadable" };
      days = { ok: false, reason: "horizon-unreadable" };
    } else {
      const startRules = { hours: rules, zone: customer.zone, durationMin: customer.durationMin, nowMs, horizonDays: horizon };
      hours = bookableHoursOn({ ...startRules, date });
      days = { ok: true, days: offeredDays(startRules) };
    }
  } catch {
    // Unreadable hours are said as such, never as a row of closed days.
    hours = { ok: false, reason: "hours-unreadable" };
    days = { ok: false, reason: "hours-unreadable" };
  }
  return { ok: true, customer, existingCall, hours, days };
}
