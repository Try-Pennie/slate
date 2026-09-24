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
