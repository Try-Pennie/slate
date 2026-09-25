/**
 * The code to route a lead on when their link carried none Slate can use (#2638).
 *
 * WHY. On trypennie.com the XBC exists only while the offers page is open, so a
 * lead who reaches booking another way arrives with a blank code. The catch-all
 * (#1908, `catchall.ts`) then sends them to the Low pool, and on 2026-09-21 that
 * booked an Ultra High lead with a Low agent. When the link NAMES the lead (the
 * 00Q Lead id the embed carries), the lead's own score is one Salesforce read
 * away: `XBC__c` on the Lead object, confirmed by a describe call against the
 * real org on 2026-09-25 (a 255 character string holding the three digit code,
 * the same field `lead-xbc.ts` already reads for the below tier check, #2593).
 *
 * THE ORDER, and each step's reason:
 *  1. A routable code on the link is used as sent, and Salesforce is not asked.
 *     The link is what the page scored a moment ago; a second opinion would add a
 *     network call to every booking and a way for the two to disagree.
 *  2. Otherwise, a Lead id on the link means Salesforce is asked, and a code it
 *     holds that `bucketSpecForXbc` decodes is routed on.
 *  3. Otherwise the catch-all applies, and the RECORD says why: no lead id, a
 *     lead Salesforce did not return, a lead with the field empty, or a value
 *     Slate cannot route (about 45 percent of leads carry a tier 0 code such as
 *     `012`, measured 2026-09-24; guessing what tier 0 means would be a second
 *     decoder).
 *  4. A Salesforce read that FAILS refuses, with `LeadCodeUnavailableError`.
 *     Falling through to the catch-all on a failed read is exactly the misroute
 *     this exists to stop, and it would look like a lead with no score.
 *
 * Salesforce can never route a lead into a test bucket: only the sixty XBC codes
 * count as a Salesforce answer, never the public test code a link may carry.
 *
 * Pure apart from the injected reader, so `scripts/test-routing-lead-code.ts`
 * drives every branch with no network.
 */
import { bucketSpecForXbc } from "@/lib/xbc";
import { isLeadId } from "@/lib/salesforce/lead-xbc";
import { CATCHALL_CODE, resolveRequestedCode, type CatchallReason } from "./catchall.ts";

/**
 * One lead's `XBC__c`: a string is what Salesforce holds, null is a lead with the
 * field empty, undefined is a lead Salesforce did not return. THROWS when the read
 * fails; it must never answer null for a query that did not run.
 */
export type LeadXbcReader = (leadId: string) => Promise<string | null | undefined>;

/** Why Salesforce could not supply a routable code, when it was the fallback. */
export type SalesforceCodeMiss = "no-lead-id" | "not-found" | "absent" | "unreadable";

/**
 * Where the routed code came from, as recorded on the booking's `routing_trace`
 * (`code_source`). Written only by the booker's confirm, which is the one caller
 * that knows what the link carried; absent on a booking means nobody said.
 */
export type RoutingCodeRecord =
  | { source: "link"; requested: string }
  | { source: "salesforce"; requested: string; salesforce_xbc: string }
  | {
      source: "catchall";
      requested: string;
      /** What was wrong with the link's own code (#1908). */
      reason: CatchallReason;
      /** Why Salesforce did not rescue it. */
      salesforce: SalesforceCodeMiss;
      /** What Salesforce held, verbatim, when it held something. */
      salesforce_xbc: string | null;
    };

export interface RoutingCodeResolution {
  code: string;
  source: RoutingCodeRecord["source"];
  record: RoutingCodeRecord;
}

/** The lead's routing code could not be read, so nothing was booked. Retriable. */
export class LeadCodeUnavailableError extends Error {
  constructor(cause: unknown) {
    super("We hit a temporary issue booking this time. Please try again in a moment.", { cause });
    this.name = "LeadCodeUnavailableError";
  }
}

export async function resolveRoutingCode(
  requested: string | null | undefined,
  leadId: string | null | undefined,
  readLeadXbc: LeadXbcReader,
): Promise<RoutingCodeResolution> {
  const raw = requested ?? "";
  const fromLink = resolveRequestedCode(raw);
  if (fromLink.kind === "valid") {
    return { code: fromLink.code, source: "link", record: { source: "link", requested: raw } };
  }

  const catchall = (salesforce: SalesforceCodeMiss, salesforceXbc: string | null): RoutingCodeResolution => ({
    code: CATCHALL_CODE,
    source: "catchall",
    record: {
      source: "catchall",
      requested: raw,
      reason: fromLink.reason,
      salesforce,
      salesforce_xbc: salesforceXbc,
    },
  });

  const id = (leadId ?? "").trim();
  if (!isLeadId(id)) return catchall("no-lead-id", null);

  let held: string | null | undefined;
  try {
    held = await readLeadXbc(id);
  } catch (err) {
    throw new LeadCodeUnavailableError(err);
  }
  if (held === undefined) return catchall("not-found", null);
  const value = (held ?? "").trim();
  if (value === "") return catchall("absent", null);
  if (bucketSpecForXbc(value) === null) return catchall("unreadable", held);
  return {
    code: value,
    source: "salesforce",
    record: { source: "salesforce", requested: raw, salesforce_xbc: value },
  };
}
