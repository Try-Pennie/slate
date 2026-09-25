/**
 * The CURRENT `XBC__c` Salesforce holds for a set of leads (#2593).
 *
 * Read as it is now, not as it was when the lead booked, on purpose: a lead
 * re-scored after booking (the issue's 422 to 512 case, four minutes after the
 * first booking) is then caught by the same comparison that catches a lead booked
 * into the wrong pool in the first place.
 *
 * Pure apart from the injected query, so `scripts/test-below-lead-tier.ts` drives
 * the chunking and the id matching without Salesforce.
 */
import { chunkSoqlValues, sfInList } from "@/lib/salesforce/soql";

/**
 * A Salesforce id's case sensitive 15 character form.
 *
 * Slate stores whatever the landing page or the booking API sent, which can be
 * either spelling, and Salesforce ANSWERS with the 18 character one even when
 * asked with 15 (measured 2026-09-24). The first 15 characters are the id; the
 * last three are a case checksum, so they are the key both sides agree on.
 */
export function leadIdKey(id: string): string {
  return id.slice(0, 15);
}

/** A Salesforce LEAD id: the `00Q` key prefix, 15 or 18 characters. */
export function isLeadId(id: string): boolean {
  return /^00Q[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/.test(id);
}

/** One query's worth of records, shaped as this reader asks for them. */
export interface LeadXbcRecord {
  Id: string;
  XBC__c?: unknown;
}

/** Runs one SOQL query to completion (every page) and THROWS on a refusal. */
export type LeadSoqlRunner = (soql: string) => Promise<LeadXbcRecord[]>;

/**
 * The XBC value per lead, keyed by `leadIdKey`.
 *
 * Three answers per id, and the map keeps them apart:
 *  - a string: what Salesforce holds, verbatim (decoding is the caller's job);
 *  - null: Salesforce returned the lead and the field is empty;
 *  - missing: Salesforce returned no such lead.
 *
 * Chunked by ENCODED length through `chunkSoqlValues` (L81), since the limit that
 * refuses a long list is the byte cap on the GET URI, not a count of ids. Any
 * query that fails throws, so a partial map is never mistaken for a whole one.
 */
export async function readLeadXbcs(
  leadIds: string[],
  run: LeadSoqlRunner,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (leadIds.length === 0) return out;
  for (const chunk of chunkSoqlValues(leadIds)) {
    const records = await run(`SELECT Id, XBC__c FROM Lead WHERE Id IN (${sfInList(chunk)})`);
    for (const r of records) {
      const v = r.XBC__c;
      out.set(leadIdKey(r.Id), v === null || v === undefined ? null : String(v));
    }
  }
  return out;
}

/**
 * One lead's `XBC__c`, for the booking path (#2638).
 *
 * Same three answers as `readLeadXbcs`, spelled for one id: a string is what
 * Salesforce holds, null is a lead with the field empty, undefined is a lead
 * Salesforce did not return. A refused query THROWS, so a failed read is never
 * mistaken for a lead with no code, which would send them to the catch-all on
 * exactly the read that could not tell.
 */
export async function readOneLeadXbc(
  leadId: string,
  run: LeadSoqlRunner,
): Promise<string | null | undefined> {
  const map = await readLeadXbcs([leadId], run);
  const key = leadIdKey(leadId);
  return map.has(key) ? (map.get(key) ?? null) : undefined;
}

/**
 * `readOneLeadXbc` against the real org: one token exchange and one SOQL query,
 * through the shared REST client (`rest.ts`), so the retry and the refusal text
 * are the ones every other Salesforce reader uses. Throws on any refusal.
 */
export async function readLeadXbcLive(leadId: string): Promise<string | null | undefined> {
  const { sfToken, querySoqlAll } = await import("@/lib/salesforce/rest");
  const { token, instanceUrl } = await sfToken();
  return readOneLeadXbc(leadId, (soql) => querySoqlAll<LeadXbcRecord>(instanceUrl, token, soql));
}
