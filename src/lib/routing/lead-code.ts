/**
 * The code to route a lead on when their link carried none Slate can use (#2638).
 *
 * WHY. On trypennie.com the XBC exists only while the offers page is open, so a
 * lead who reaches booking another way arrives with a blank code. The catch-all
 * (#1908, `catchall.ts`) then sends them to the Low pool, and on 2026-09-21 that
 * booked an Ultra High lead with a Low agent. When the link NAMES the lead (the
 * 00Q Lead id the embed carries), the lead's own score is a Salesforce read
 * away. Since #3502 that is the score on the lead's CURRENT submission
 * (`Submission__c.XBC_SO__c`), the same one a link carries when it carries one,
 * unless the Lead's own `XBC__c` was edited after that submission, which then
 * wins; `readLeadScores` in `lead-xbc.ts` decides, for this and for the below
 * tier check alike (#2593, #3501). The Lead's copy alone lagged: on 2026-10-07
 * it held a returning lead's July 211 against today's 111.
 *
 * THE ORDER, and each step's reason:
 *  1. A routable code on the link is used as sent, and Salesforce is not asked.
 *     The link is what the page scored a moment ago; a second opinion would add a
 *     network call to every booking and a way for the two to disagree.
 *  2. Otherwise, a Lead id on the link means Salesforce is asked, and a code it
 *     holds that `bucketSpecForXbc` decodes is routed on. Since #3502 that is the
 *     score on the lead's CURRENT submission (`readLeadScores`), the one a link
 *     carries when it carries one; `Lead.XBC__c` is a copy that lags it, and on
 *     2026-10-07 held a returning lead's July 211 against today's 111.
 *  3. Otherwise, a Salesforce Submission id (the `submissionId` trypennie's trigger
 *     always carries) is resolved to the Lead it names (`Submission__c.Lead__c`),
 *     and that lead is routed through step 2's read exactly (#3246). On iPhone
 *     Safari the widget could build the booker before the page's query was
 *     forwarded, so the link arrived with no code and no Lead id but still named
 *     the submission; four leads (512, 312, 112, 112) went to the catch-all that
 *     way. The record says the lead was found through the submission.
 *  4. Otherwise the catch-all applies, and the RECORD says why: no lead id, a
 *     lead Salesforce did not return, a lead with the field empty, or a value
 *     Slate cannot route (about 45 percent of leads carry a tier 0 code such as
 *     `012`, measured 2026-09-24; guessing what tier 0 means would be a second
 *     decoder).
 *  5. A Salesforce read that FAILS (the lead's or the submission's) refuses, with `LeadCodeUnavailableError`.
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
import { isLeadId, isSubmissionId } from "@/lib/salesforce/lead-xbc";
import { CATCHALL_CODE, resolveRequestedCode, type CatchallReason } from "./catchall.ts";

/**
 * One lead's score (`readOneLeadXbc`: the current submission's, or the Lead's
 * `XBC__c` where that was edited after it or there is no submission): a string is
 * what Salesforce holds, null is a lead with no score, undefined is a lead
 * Salesforce did not return. THROWS when any read fails; it must never answer
 * null for a query that did not run.
 */
export type LeadXbcReader = (leadId: string) => Promise<string | null | undefined>;

/**
 * The Lead a Submission names (#3246): a Lead id, null for a submission naming no
 * lead, undefined for a submission Salesforce did not return. THROWS when the read
 * fails, like `LeadXbcReader`.
 */
export type SubmissionLeadReader = (submissionId: string) => Promise<string | null | undefined>;

/**
 * The submission a link named, and how to find its lead. REQUIRED of every caller,
 * so a new one has to say what it knows; a caller with no submission passes
 * `id: null`.
 */
export interface SubmissionLookup {
  id: string | null | undefined;
  readLeadId: SubmissionLeadReader;
}

/** Why Salesforce could not supply a routable code, when it was the fallback. */
export type SalesforceCodeMiss =
  | "no-lead-id"
  | "not-found"
  | "absent"
  | "unreadable"
  /** #3246: the link's submission id names no submission Salesforce returned. */
  | "submission-not-found"
  /** #3246: the submission exists and names no lead. */
  | "submission-without-lead";

/**
 * Where the routed code came from, as recorded on the booking's `routing_trace`
 * (`code_source`). Written only by the booker's confirm, which is the one caller
 * that knows what the link carried; absent on a booking means nobody said.
 */
export type RoutingCodeRecord =
  | { source: "link"; requested: string }
  | {
      source: "salesforce";
      requested: string;
      salesforce_xbc: string;
      /** #3246: present when the lead was found through the link's submission. */
      via?: "submission";
      submission_id?: string;
    }
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
  submission: SubmissionLookup,
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

  let id = (leadId ?? "").trim();
  let viaSubmission: string | null = null;
  if (!isLeadId(id)) {
    const sub = (submission.id ?? "").trim();
    if (!isSubmissionId(sub)) return catchall("no-lead-id", null);
    let named: string | null | undefined;
    try {
      named = await submission.readLeadId(sub);
    } catch (err) {
      throw new LeadCodeUnavailableError(err);
    }
    if (named === undefined) return catchall("submission-not-found", null);
    if (named === null || !isLeadId(named.trim())) return catchall("submission-without-lead", null);
    id = named.trim();
    viaSubmission = sub;
  }

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
    record: viaSubmission
      ? { source: "salesforce", requested: raw, salesforce_xbc: value, via: "submission", submission_id: viaSubmission }
      : { source: "salesforce", requested: raw, salesforce_xbc: value },
  };
}
