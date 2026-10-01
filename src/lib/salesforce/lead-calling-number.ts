/**
 * The number Pennie will call a booked lead FROM (#1334).
 *
 * Call screening (iOS, carrier filters) silences a call from a number the lead has
 * never seen, so a lead misses the call they booked. The calling number is fixed
 * per lead before the call: Regal campaign #278 dials from the line matching the
 * contact's sub brand, and journey 362 hands that line to a Pipedream workflow
 * which writes it to Salesforce Lead `AssignedRegalPhone__c` about a minute after
 * the lead is created. Slate cannot read Regal contacts, so Salesforce is where
 * Slate reads it.
 *
 * It is the CALLING number only. Texts go out on a Sendblue line, which changes
 * often, and a text to the calling line reaches nobody; nothing here reads or
 * shows the texting line.
 *
 * When the field is empty, unreadable, or the read fails, the answer is null and
 * every surface says NOTHING about a number. A wrong number is worse than none
 * (L75), so a value that does not parse as a phone number is null too rather than
 * printed as found.
 *
 * Pure apart from the injected query, so `scripts/test-lead-calling-number.ts`
 * drives it without Salesforce.
 */
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { isLeadId, leadIdKey, readLeadField, type LeadSoqlRunner } from "./lead-xbc.ts";
// The deadline lives in a neutral module (#2982): it bounds reads well beyond
// Salesforce, so its home is not this file.
import { readWithinDeadline, realTimer, type ScheduleTimer } from "../read-within-deadline.ts";

/** The Lead field the Pipedream workflow writes (verified live 2026-09-30). */
export const CALLING_NUMBER_FIELD = "AssignedRegalPhone__c";

/**
 * How long anything a LEAD is waiting on (the manage page, their own phone
 * correction) waits for the number before going on without it. A slow Salesforce
 * must cost them the line about the number, never the page or the save.
 */
export const CALLING_NUMBER_DEADLINE_MS = 2_500;

/**
 * A stored value as a calling number in E.164, or null. Strict on purpose: only a
 * value libphonenumber calls VALID survives, unlike `toE164`, which hands an
 * unparseable value back as typed (right for a number a lead gave us, wrong for one
 * we would tell a lead to save).
 */
export function callingNumberOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = parsePhoneNumberFromString(trimmed, "US");
  return parsed?.isValid() ? parsed.number : null;
}

/**
 * The calling number per lead, keyed by `leadIdKey`: a number, null for a lead
 * whose field is empty or unreadable, and NO entry for a lead Salesforce did not
 * return. A refused query throws, so a failed read is never mistaken for a set of
 * leads with no number.
 */
export async function readLeadCallingNumbers(
  leadIds: string[],
  run: LeadSoqlRunner,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const [key, v] of await readLeadField(leadIds, CALLING_NUMBER_FIELD, run)) {
    out.set(key, callingNumberOf(v));
  }
  return out;
}

/**
 * One lead's calling number, or null for every way of not having one: not a Lead
 * id (never asked), no such lead, an empty or unreadable field. Its callers only
 * show or omit, so those collapse; a refused query still THROWS, so a caller that
 * counts failures can.
 */
export async function readOneCallingNumber(
  leadId: string | null,
  run: LeadSoqlRunner,
): Promise<string | null> {
  if (!leadId || !isLeadId(leadId)) return null;
  const map = await readLeadCallingNumbers([leadId], run);
  return map.get(leadIdKey(leadId)) ?? null;
}

/**
 * THE way a surface a lead is waiting on reads the calling number: under
 * `CALLING_NUMBER_DEADLINE_MS`, null on a refusal or a timeout, and each of those
 * REPORTED through `onUnread`, so "nobody had a number" and "Salesforce was slow or
 * down" stay apart in the logs (L11). Used by the manage page and the phone
 * correction, so the bound lives once. The timer is CLEARED however the race ends,
 * so a fast read leaves nothing holding the isolate for the full wait; it is
 * injected so a test never waits for real (L524).
 */
export function callingNumberWithinDeadline(
  read: () => Promise<string | null>,
  onUnread: (err: unknown) => void,
  timer: ScheduleTimer = realTimer,
): Promise<string | null> {
  return readWithinDeadline(read, CALLING_NUMBER_DEADLINE_MS, onUnread, timer);
}

/** A runner against the real org: one token exchange, through the shared client. */
export async function liveLeadSoqlRunner(): Promise<LeadSoqlRunner> {
  const { sfToken, querySoqlAll } = await import("@/lib/salesforce/rest");
  const { token, instanceUrl } = await sfToken();
  return (soql) => querySoqlAll(instanceUrl, token, soql);
}

/** `readLeadCallingNumbers` against the real org. Throws on any refusal. */
export async function readLeadCallingNumbersLive(leadIds: string[]): Promise<Map<string, string | null>> {
  const ids = leadIds.filter(isLeadId);
  if (ids.length === 0) return new Map();
  return readLeadCallingNumbers(ids, await liveLeadSoqlRunner());
}

/** `readOneCallingNumber` against the real org. Throws on a refusal. */
export async function readCallingNumberLive(leadId: string | null): Promise<string | null> {
  if (!leadId || !isLeadId(leadId)) return null;
  return readOneCallingNumber(leadId, await liveLeadSoqlRunner());
}
