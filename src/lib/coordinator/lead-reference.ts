/**
 * The Lead a coordinator pasted (#4205): the Salesforce record link, or the 00Q id at
 * its end. Decided 2026-10-26 (Geoff): every call the coordinators take arrives with the
 * lead's Salesforce id, so this is the one way the page finds a customer.
 *
 * Only a LEAD id counts (`isLeadId`: the 00Q prefix, 15 or 18 characters). A Contact or
 * any other record is refused as not a lead id, because every customer is a Lead
 * (Sam, 2026-10-23) and the booking path matches calls on the Lead id. Pure.
 */
import { isLeadId } from "../salesforce/lead-xbc.ts";

export type LeadReference = { ok: true; leadId: string } | { ok: false; refusal: "not-a-lead-id" };

export function parseLeadReference(raw: string): LeadReference {
  const value = (raw ?? "").trim();
  if (isLeadId(value)) return { ok: true, leadId: value };
  if (/^https?:\/\//i.test(value)) {
    let path: string;
    try {
      path = new URL(value).pathname;
    } catch {
      return { ok: false, refusal: "not-a-lead-id" };
    }
    const id = path.split("/").find((segment) => isLeadId(segment));
    if (id) return { ok: true, leadId: id };
  }
  return { ok: false, refusal: "not-a-lead-id" };
}
