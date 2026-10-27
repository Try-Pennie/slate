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
 *    routing cannot use goes to the catch all, as it does for every other lead.
 *
 * Each missing piece is its own refusal (L11), and a Salesforce read that FAILS is never
 * read as a lead with nothing in it. Nothing here logs a value (docs/pii.md).
 *
 * Pure apart from the injected deps (relative imports), so
 * `scripts/test-coordinator-lookup.ts` drives every branch; `live.ts` wires the real ones.
 */
import { parseLeadReference } from "./lead-reference.ts";
import { bookableHoursOn, type BookableHours } from "./bookable-hours.ts";
import { leadZone } from "../zip-zones/zip-zones.ts";
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
  /** `catchall` when the lead's score is one routing cannot use, as on the booker. */
  bucketSource: "salesforce" | "catchall";
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

export async function findCustomer(reference: string, deps: CustomerDeps): Promise<FoundCustomer> {
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

  let code: { code: string; source: "link" | "salesforce" | "catchall" };
  try {
    // No link code and no submission: the Lead id is what the coordinator has, so
    // routing reads the lead's own score, the booker's step 2.
    code = await resolveRoutingCode(null, lead.id, deps.readLeadXbc, { id: null, readLeadId: async () => undefined });
  } catch {
    return { ok: false, refusal: "salesforce-unreadable" };
  }
  const resolved = await deps.resolveBucketByCode(code.code);
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
      bucketSource: code.source === "catchall" ? "catchall" : "salesforce",
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
  | { ok: true; customer: Customer; existingCall: ExistingCallView; hours: BookableHours }
  | { ok: false; refusal: CustomerRefusal };

/**
 * Everything the page shows once a customer is found: who, their zone and bucket, their
 * call and what happens to it (judged by the same identity and match `placeBooking`
 * uses, so the page cannot promise a move the booking then refuses), and the hours a
 * call may start on `date` (the customer's local day; today there when absent).
 */
export async function lookupCustomer(input: { reference: string; date?: string }, deps: LookupDeps): Promise<CustomerLookup> {
  const found = await findCustomer(input.reference, deps);
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
  try {
    const rules = await deps.businessHours();
    const horizon = await deps.horizonDays();
    hours =
      horizon === null
        ? { ok: false, reason: "horizon-unreadable" }
        : bookableHoursOn({ hours: rules, zone: customer.zone, date, durationMin: customer.durationMin, nowMs, horizonDays: horizon });
  } catch {
    hours = { ok: false, reason: "hours-unreadable" };
  }
  return { ok: true, customer, existingCall, hours };
}
