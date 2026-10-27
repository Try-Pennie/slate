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
 * One Lead's record with `fields`, or null when Salesforce returned no such lead. A
 * refused query THROWS. Salesforce answers with the 18 character id even when asked
 * with 15, so the match is on the id's key.
 */
async function readOneLead(leadId: string, fields: string, run: LeadSoqlRunner): Promise<LeadFieldRecord | null> {
  const records: LeadFieldRecord[] = await run(`SELECT ${fields} FROM Lead WHERE Id IN (${sfInList([leadId])})`);
  return records.find((r) => typeof r.Id === "string" && leadIdKey(r.Id) === leadIdKey(leadId)) ?? null;
}

/**
 * The Lead's contact fields, or null when Salesforce returned no such lead. A refused
 * query THROWS, so a failed read is never mistaken for a lead with no details.
 */
export async function readLeadContact(leadId: string, run: LeadSoqlRunner): Promise<SalesforceLeadContact | null> {
  const hit = await readOneLead(leadId, LEAD_CONTACT_SOQL_FIELDS, run);
  if (!hit) return null;
  return {
    name: text(hit.Name),
    firstName: text(hit.FirstName),
    email: text(hit.Email),
    phone: text(hit.Phone) ?? text(hit.MobilePhone),
  };
}

/**
 * The Lead fields the coordinator page reads (#4205): the contact fields plus where the
 * customer lives, which is the only source of their time zone (the Lead has no zone
 * field; `src/lib/zip-zones/zip-zones.ts` derives it). A constant, never caller text.
 */
export const LEAD_PLACE_SOQL_FIELDS = `${LEAD_CONTACT_SOQL_FIELDS}, PostalCode, State`;

export interface SalesforceLeadWithPlace extends SalesforceLeadContact {
  /** The id as Salesforce answers it: the 18 character spelling. */
  id: string;
  postalCode: string | null;
  state: string | null;
}

/**
 * One Lead's contact and place fields in one query, or null when Salesforce returned no
 * such lead. A refused query THROWS. Nothing here logs a value.
 */
export async function readLeadWithPlace(leadId: string, run: LeadSoqlRunner): Promise<SalesforceLeadWithPlace | null> {
  const hit = await readOneLead(leadId, LEAD_PLACE_SOQL_FIELDS, run);
  if (!hit) return null;
  return {
    id: hit.Id,
    name: text(hit.Name),
    firstName: text(hit.FirstName),
    email: text(hit.Email),
    phone: text(hit.Phone) ?? text(hit.MobilePhone),
    postalCode: text(hit.PostalCode),
    state: text(hit.State),
  };
}

/** `readLeadContact` against the real org, through the shared REST client. Throws on any refusal. */
export async function readLeadContactLive(leadId: string): Promise<SalesforceLeadContact | null> {
  const { sfToken, querySoqlAll } = await import("@/lib/salesforce/rest");
  const { token, instanceUrl } = await sfToken();
  return readLeadContact(leadId, (soql) => querySoqlAll<LeadFieldRecord>(instanceUrl, token, soql));
}
