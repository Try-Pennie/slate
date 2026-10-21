/**
 * One Salesforce Lead's name, first name, email and phone (#3541).
 *
 * Read for a Marcia move (or a book landing on the call the lead already holds)
 * whose signed token lacks a field the lead's earlier Slate bookings do not hold
 * either (Dan, 2026-10-20: Regal, which feeds Marcia, may not hold them). A net new
 * book never reaches it: that is refused `lead_contact_missing` on the token alone.
 * `src/lib/mcp-booking/operations.ts` decides when it is asked, and holds whatever
 * comes back to the token's own rules before using it.
 *
 * The phone is `Phone`, falling to `MobilePhone` when that is empty, the order the
 * call me now reader already reads a Lead's numbers in (`call-me-now.ts`).
 *
 * Pure apart from the injected query, so `scripts/test-lead-contact.ts` drives it
 * without Salesforce. Nothing here logs a value.
 */
import { leadIdKey, type LeadFieldRecord, type LeadSoqlRunner } from "./lead-xbc.ts";
import { sfInList } from "./soql.ts";

/** The Lead fields read. A constant, never caller text. */
export const LEAD_CONTACT_SOQL_FIELDS = "Id, Name, FirstName, Email, Phone, MobilePhone";

export interface SalesforceLeadContact {
  name: string | null;
  firstName: string | null;
  email: string | null;
  phone: string | null;
}

/** A text field's value, or null for empty, spaces only, or anything not text. */
function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/**
 * The Lead's contact fields, or null when Salesforce returned no such lead. A refused
 * query THROWS, so a failed read is never mistaken for a lead with no details.
 */
export async function readLeadContact(leadId: string, run: LeadSoqlRunner): Promise<SalesforceLeadContact | null> {
  const records: LeadFieldRecord[] = await run(`SELECT ${LEAD_CONTACT_SOQL_FIELDS} FROM Lead WHERE Id IN (${sfInList([leadId])})`);
  // Salesforce answers with the 18 character id even when asked with 15.
  const hit = records.find((r) => typeof r.Id === "string" && leadIdKey(r.Id) === leadIdKey(leadId));
  if (!hit) return null;
  return {
    name: text(hit.Name),
    firstName: text(hit.FirstName),
    email: text(hit.Email),
    phone: text(hit.Phone) ?? text(hit.MobilePhone),
  };
}

/** `readLeadContact` against the real org, through the shared REST client. Throws on any refusal. */
export async function readLeadContactLive(leadId: string): Promise<SalesforceLeadContact | null> {
  const { sfToken, querySoqlAll } = await import("@/lib/salesforce/rest");
  const { token, instanceUrl } = await sfToken();
  return readLeadContact(leadId, (soql) => querySoqlAll<LeadFieldRecord>(instanceUrl, token, soql));
}
