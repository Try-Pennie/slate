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

/** One query's worth of Lead records: the id plus whichever field was asked for. */
export type LeadFieldRecord = { Id: string; [field: string]: unknown };

/** The XBC reader's records, kept as a name for the callers that already use it. */
export type LeadXbcRecord = LeadFieldRecord;

/** Runs one SOQL query to completion (every page) and THROWS on a refusal. */
export type LeadSoqlRunner = (soql: string) => Promise<LeadFieldRecord[]>;

/**
 * One Lead field's raw value per lead, keyed by `leadIdKey`, for the calling number
 * (#1334).
 *
 * Three answers per id, and the map keeps them apart:
 *  - a value: what Salesforce holds, verbatim (decoding is the caller's job);
 *  - null: Salesforce returned the lead and the field is empty;
 *  - missing: Salesforce returned no such lead.
 *
 * Chunked by ENCODED length through `chunkSoqlValues` (L81), since the limit that
 * refuses a long list is the byte cap on the GET URI, not a count of ids. Any
 * query that fails throws, so a partial map is never mistaken for a whole one.
 * `field` is a constant at every call site, never caller supplied text.
 */
export async function readLeadField(
  leadIds: string[],
  field: string,
  run: LeadSoqlRunner,
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  if (leadIds.length === 0) return out;
  for (const chunk of chunkSoqlValues(leadIds)) {
    const records = await run(`SELECT Id, ${field} FROM Lead WHERE Id IN (${sfInList(chunk)})`);
    for (const r of records) {
      const v = r[field];
      out.set(leadIdKey(r.Id), v === undefined ? null : v);
    }
  }
  return out;
}

/**
 * A lead's score as of now, and where it came from (#3501).
 *
 * `code` is the XBC on the submission the Lead names as current
 * (`Lead.Submission_Object_ID__c` to `Submission__c.XBC_SO__c`), which is the
 * score the lead's booking link carries. `Lead.XBC__c` is a COPY of it and can
 * lag: on 2026-10-07 a returning lead's new submission scored 111 while the Lead
 * still held 211 from July, and on 2026-10-03 a new lead's copy read 212 for 75
 * minutes against a submission of 112. Both were paged as re-scores that never
 * happened. The copy is read when the lead names no submission, Salesforce does
 * not return the one it names, or that submission carries no score (`lead`).
 * Measured 2026-10-07: all 2,790 leads with a scheduled Slate call named a
 * submission.
 *
 * NEWEST WINS (Dan, 2026-10-07). The copy is also read when it was EDITED after
 * the submission was made and now says something else (`lead-edit`), because that
 * edit is the later fact: on 2026-09-21 a Lead went 512 to 412, with its advisor
 * level, 49 seconds after a submission that still says 512. Judged by when each
 * value was written at its source (L751), from `LeadHistory`, and read only for
 * leads whose two scores disagree, so an agreeing roster costs no extra query. An
 * edit or a submission whose time cannot be read never overrides the submission.
 *
 * `submissionId` is the submission the Lead names, whichever source answered, so
 * a caller can tell a re-score of the booking's own submission from a newer one.
 */
export interface LeadScore {
  code: string | null;
  source: "submission" | "lead" | "lead-edit";
  submissionId: string | null;
}

/** A Salesforce timestamp as epoch ms, or null when it cannot be read: a NaN
 *  would make every comparison false and read as "not edited since". */
function stampMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function textOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * Each lead's `LeadScore`, keyed by `leadIdKey`; a lead Salesforce did not return
 * is missing. Two reads: the Leads, then the submissions they name, each chunked
 * like `readLeadField`, and either one refusing THROWS, so a partial answer is
 * never mistaken for a whole one. No submission named, no second query.
 */
export async function readLeadScores(
  leadIds: string[],
  run: LeadSoqlRunner,
): Promise<Map<string, LeadScore>> {
  const out = new Map<string, LeadScore>();
  if (leadIds.length === 0) return out;
  const leads: LeadFieldRecord[] = [];
  for (const chunk of chunkSoqlValues(leadIds)) {
    leads.push(...(await run(`SELECT Id, XBC__c, Submission_Object_ID__c FROM Lead WHERE Id IN (${sfInList(chunk)})`)));
  }
  const named = new Map<string, string>();
  for (const l of leads) {
    const sub = textOrNull(l.Submission_Object_ID__c);
    if (sub !== null && isSubmissionId(sub)) named.set(leadIdKey(sub), sub);
  }
  const submissions = new Map<string, { xbc: string | null; createdMs: number | null }>();
  if (named.size > 0) {
    for (const chunk of chunkSoqlValues([...named.values()])) {
      for (const s of await run(`SELECT Id, XBC_SO__c, CreatedDate FROM Submission__c WHERE Id IN (${sfInList(chunk)})`)) {
        submissions.set(leadIdKey(s.Id), { xbc: textOrNull(s.XBC_SO__c), createdMs: stampMs(s.CreatedDate) });
      }
    }
  }
  const submissionOf = (l: LeadFieldRecord) => {
    const id = textOrNull(l.Submission_Object_ID__c);
    return id === null ? undefined : submissions.get(leadIdKey(id));
  };

  // Newest wins, asked only where the two scores disagree.
  const disagree = leads.filter((l) => {
    const sub = submissionOf(l);
    const copy = textOrNull(l.XBC__c);
    return sub?.xbc != null && copy !== null && copy !== sub.xbc;
  });
  const lastEditMs = new Map<string, number>();
  if (disagree.length > 0) {
    for (const chunk of chunkSoqlValues(disagree.map((l) => l.Id))) {
      const rows = await run(
        `SELECT Id, LeadId, CreatedDate FROM LeadHistory WHERE Field = 'XBC__c' AND LeadId IN (${sfInList(chunk)})`,
      );
      for (const h of rows) {
        const at = stampMs(h.CreatedDate);
        if (typeof h.LeadId !== "string" || at === null) continue;
        const key = leadIdKey(h.LeadId);
        lastEditMs.set(key, Math.max(lastEditMs.get(key) ?? at, at));
      }
    }
  }

  for (const l of leads) {
    const key = leadIdKey(l.Id);
    const submissionId = textOrNull(l.Submission_Object_ID__c);
    const sub = submissionOf(l);
    const copy = textOrNull(l.XBC__c);
    if (sub?.xbc == null) {
      out.set(key, { code: copy, source: "lead", submissionId });
      continue;
    }
    const edited = lastEditMs.get(key);
    const editedSince = edited !== undefined && sub.createdMs !== null && edited > sub.createdMs;
    out.set(
      key,
      editedSince && copy !== null && copy !== sub.xbc
        ? { code: copy, source: "lead-edit", submissionId }
        : { code: sub.xbc, source: "submission", submissionId },
    );
  }
  return out;
}

/**
 * One lead's score, for the booking path (#2638): since #3502 the score on the
 * lead's CURRENT submission, through `readLeadScores`, so a codeless link routes
 * on the same score a link carrying one would have, and on the same one the
 * below tier check judges against. `Lead.XBC__c` is a copy that lags it, and is
 * read only when the lead names no submission with a score.
 *
 * Three answers: a string is the score Salesforce holds, null is a lead with
 * none, undefined is a lead Salesforce did not return. A refused query (the
 * Lead's or the submission's) THROWS, so a failed read is never mistaken for a
 * lead with no code, which would send them to the catch-all on exactly the read
 * that could not tell.
 */
export async function readOneLeadXbc(
  leadId: string,
  run: LeadSoqlRunner,
): Promise<string | null | undefined> {
  const map = await readLeadScores([leadId], run);
  const score = map.get(leadIdKey(leadId));
  return score === undefined ? undefined : score.code;
}

/**
 * `readOneLeadXbc` against the real org: one token exchange and up to two SOQL
 * queries (the Lead, then the submission it names), through the shared REST
 * client (`rest.ts`), so the retry and the refusal text are the ones every other
 * Salesforce reader uses. Throws on any refusal. Asked only when the link carried
 * no routable code.
 */
export async function readLeadXbcLive(leadId: string): Promise<string | null | undefined> {
  const { sfToken, querySoqlAll } = await import("@/lib/salesforce/rest");
  const { token, instanceUrl } = await sfToken();
  return readOneLeadXbc(leadId, (soql) => querySoqlAll<LeadFieldRecord>(instanceUrl, token, soql));
}

/** A Salesforce Submission id: the `a04` key prefix of `Submission__c`, 15 or 18 characters. */
export function isSubmissionId(id: string): boolean {
  return /^a04[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/.test(id);
}

/**
 * The Lead a Submission belongs to, for a booker confirm that arrived with no code
 * and no Lead id (#3246). trypennie's trigger always carries the submission id,
 * even on the iPhone Safari path that dropped the page's own query, and
 * `Submission__c.Lead__c` names the lead whose `XBC__c` the lead path then reads.
 *
 * Three answers: a Lead id; null for a submission naming no lead; undefined for a
 * submission Salesforce did not return. A refused query THROWS, so a failed read is
 * never mistaken for a submission with no lead.
 */
export async function readSubmissionLeadId(
  submissionId: string,
  run: LeadSoqlRunner,
): Promise<string | null | undefined> {
  const records = await run(`SELECT Id, Lead__c FROM Submission__c WHERE Id IN (${sfInList([submissionId])})`);
  const key = leadIdKey(submissionId);
  const hit = records.find((r) => leadIdKey(r.Id) === key);
  if (!hit) return undefined;
  const lead = hit.Lead__c;
  return typeof lead === "string" && lead.trim() !== "" ? lead.trim() : null;
}

/** `readSubmissionLeadId` against the real org, through the shared REST client. */
export async function readSubmissionLeadIdLive(submissionId: string): Promise<string | null | undefined> {
  const { sfToken, querySoqlAll } = await import("@/lib/salesforce/rest");
  const { token, instanceUrl } = await sfToken();
  return readSubmissionLeadId(submissionId, (soql) => querySoqlAll<LeadFieldRecord>(instanceUrl, token, soql));
}
