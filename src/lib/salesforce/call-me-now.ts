/**
 * Call me now on the inline booker (#3718): a lead asks for an advisor to call them
 * straight away instead of booking a time.
 *
 * It does exactly what trypennie.com does for the same button, and only that: it sets
 * the Lead's `CallMeNow__c` and `Call_Me_Now_Pending__c`, and Salesforce takes it from
 * there. It is Slate's first Salesforce WRITE; everything else here only reads.
 *
 * Two things trypennie's own endpoint does not do, on purpose:
 *  - nothing is written for a lead id the visitor cannot tie to themselves. The page
 *    prefills the lead's email or phone, and one of them must match the Lead, because
 *    the id alone sits in page URLs and anyone holding one could otherwise send an
 *    advisor to call a stranger. The switch is not even read for a mismatch, so a
 *    guessed id learns nothing.
 *  - a lead with a call already pending is told so rather than asked for a second.
 *
 * Whether the button is OFFERED follows trypennie's `calculateBookingPageVariant`
 * exactly (the one `WebsiteConfiguration__c` record: `IsActiveAlternate__c` on,
 * `PageAlternate__c` "Call Me Now Button", the Lead's `ADV__c` at or over
 * `MinimumAdv__c`), so the button appears at the same times as on the site. One
 * deliberate difference: anything unreadable HIDES it, where trypennie's `Number("")`
 * would read a blank minimum as zero and show it.
 *
 * A refusal and a failure stay apart (`retryCanHelp`): Try again can change a failed
 * read or write, and can never change a refusal (L111).
 *
 * Pure apart from the injected reads and write, so `scripts/test-call-me-now.ts`
 * drives every outcome without Salesforce.
 */
import { isLeadId } from "./lead-xbc.ts";
import { shortErrorReason } from "../notify/error-text.ts";

/** The `PageAlternate__c` value that means "show Call me now" on trypennie. */
export const CALL_ME_NOW_ALTERNATE = "Call Me Now Button";

/** The configuration record's three fields, each null when unreadable. */
export interface CallMeNowSwitch {
  isActiveAlternate: boolean | null;
  pageAlternate: string | null;
  minimumAdv: number | null;
}

/** What the decision needs from the Lead. */
export interface CallMeNowLead {
  email: string | null;
  /** Every phone the Lead holds (Home, Mobile), as stored. */
  phones: string[];
  adv: number | null;
  pending: boolean | null;
}

export type CallMeNowRefusal = "not-a-lead" | "no-such-lead" | "no-contact" | "contact-mismatch" | "not-offered";

export type CallMeNowFailedStage = "lead-read" | "switch-read" | "write";

export type CallMeNowOutcome =
  | { kind: "requested" }
  | { kind: "already-requested" }
  | { kind: "refused"; reason: CallMeNowRefusal }
  | { kind: "failed"; stage: CallMeNowFailedStage; error: unknown };

export type CallMeNowCheck =
  | { kind: "offered" }
  | { kind: "refused"; reason: CallMeNowRefusal }
  | { kind: "failed"; stage: CallMeNowFailedStage; error: unknown };

export interface CallMeNowInput {
  leadId: string;
  email: string | null;
  phone: string | null;
}

export interface CallMeNowDeps {
  /** The Lead, or null when Salesforce holds no such lead. Throws on a refusal. */
  readLead(leadId: string): Promise<CallMeNowLead | null>;
  /** The configuration record. Throws on a refusal. */
  readSwitch(): Promise<CallMeNowSwitch>;
  /** Sets both Call me now fields on the Lead. Throws on a refusal. */
  writeRequested(leadId: string): Promise<void>;
}

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The configuration record as Salesforce sends it. `MinimumAdv__c` is a text field. */
export function switchFromRecord(r: Record<string, unknown>): CallMeNowSwitch {
  const min = typeof r.MinimumAdv__c === "string" && r.MinimumAdv__c.trim() !== "" ? Number(r.MinimumAdv__c) : null;
  return {
    isActiveAlternate: typeof r.IsActiveAlternate__c === "boolean" ? r.IsActiveAlternate__c : null,
    pageAlternate: typeof r.PageAlternate__c === "string" ? r.PageAlternate__c : null,
    minimumAdv: finite(min),
  };
}

/** The fields `LEAD_SOQL_FIELDS` asks for, read without guessing. */
export function leadFromRecord(r: Record<string, unknown>): CallMeNowLead {
  const phones = [r.Phone, r.MobilePhone].filter((p): p is string => typeof p === "string" && p.trim() !== "");
  return {
    email: typeof r.Email === "string" && r.Email.trim() !== "" ? r.Email : null,
    phones,
    adv: finite(r.ADV__c),
    pending: typeof r.Call_Me_Now_Pending__c === "boolean" ? r.Call_Me_Now_Pending__c : null,
  };
}

/** The Lead fields the decision reads. A constant, never caller text. */
export const LEAD_SOQL_FIELDS = "Id, Email, Phone, MobilePhone, ADV__c, Call_Me_Now_Pending__c";

/** The configuration record's fields. */
export const SWITCH_SOQL = "SELECT IsActiveAlternate__c, PageAlternate__c, MinimumAdv__c FROM WebsiteConfiguration__c";

/** trypennie's rule, with anything unreadable hiding the button. */
export function callMeNowOffered(sw: CallMeNowSwitch, adv: number | null): boolean {
  if (sw.isActiveAlternate !== true || sw.pageAlternate !== CALL_ME_NOW_ALTERNATE) return false;
  if (sw.minimumAdv === null || adv === null) return false;
  return sw.minimumAdv <= adv;
}

const normalEmail = (e: string | null): string => (e ?? "").trim().toLowerCase();

/** A US phone's ten digits, or null when it does not have exactly ten (after a leading 1). */
function tenDigits(p: string | null): string | null {
  const d = (p ?? "").replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return ten.length === 10 ? ten : null;
}

/** Whether the email or phone the page passed belongs to this Lead. Blanks never match. */
export function contactMatchesLead(given: { email: string | null; phone: string | null }, lead: CallMeNowLead): boolean {
  const email = normalEmail(given.email);
  if (email !== "" && email === normalEmail(lead.email)) return true;
  const phone = tenDigits(given.phone);
  return phone !== null && lead.phones.some((p) => tenDigits(p) === phone);
}

const hasContact = (i: CallMeNowInput): boolean => normalEmail(i.email) !== "" || (i.phone ?? "").trim() !== "";

/**
 * Everything short of the write: the lead exists, the visitor is that lead, and the
 * button is offered. Returns the lead when all three hold.
 */
async function vet(
  input: CallMeNowInput,
  deps: CallMeNowDeps,
): Promise<{ lead: CallMeNowLead } | Exclude<CallMeNowCheck, { kind: "offered" }>> {
  if (!isLeadId(input.leadId)) return { kind: "refused", reason: "not-a-lead" };
  if (!hasContact(input)) return { kind: "refused", reason: "no-contact" };
  let lead: CallMeNowLead | null;
  try {
    lead = await deps.readLead(input.leadId);
  } catch (error) {
    return { kind: "failed", stage: "lead-read", error };
  }
  if (lead === null) return { kind: "refused", reason: "no-such-lead" };
  if (!contactMatchesLead(input, lead)) return { kind: "refused", reason: "contact-mismatch" };
  let sw: CallMeNowSwitch;
  try {
    sw = await deps.readSwitch();
  } catch (error) {
    return { kind: "failed", stage: "switch-read", error };
  }
  if (!callMeNowOffered(sw, lead.adv)) return { kind: "refused", reason: "not-offered" };
  return { lead };
}

/** Whether to show the button. Writes nothing. */
export async function checkCallMeNow(input: CallMeNowInput, deps: CallMeNowDeps): Promise<CallMeNowCheck> {
  const v = await vet(input, deps);
  return "lead" in v ? { kind: "offered" } : v;
}

/** The press: vets the lead, then writes both fields unless a call is already pending. */
export async function requestCallMeNow(input: CallMeNowInput, deps: CallMeNowDeps): Promise<CallMeNowOutcome> {
  const v = await vet(input, deps);
  if (!("lead" in v)) return v;
  if (v.lead.pending === true) return { kind: "already-requested" };
  // A Salesforce checkbox is never empty, so null here is a read that went wrong rather
  // than a lead with nothing pending: a failed read, with Try again, never a second ask.
  if (v.lead.pending === null) {
    return { kind: "failed", stage: "lead-read", error: new Error("Call_Me_Now_Pending__c came back unreadable") };
  }
  try {
    await deps.writeRequested(input.leadId);
  } catch (error) {
    return { kind: "failed", stage: "write", error };
  }
  return { kind: "requested" };
}

/** Try again is offered only where retrying could change the answer. */
export function retryCanHelp(outcome: CallMeNowOutcome): boolean {
  return outcome.kind === "failed";
}

const STAGE_WORDS: Record<CallMeNowFailedStage, string> = {
  "lead-read": "reading the lead",
  "switch-read": "reading the Call me now switch",
  write: "marking the lead for a call",
};

/**
 * The page when a press did not go through. The lead id is safe to show; the error is
 * reduced to its short reason (the full text is in the log line beside it). Built here
 * so `pnpm preview:alerts` renders the words that ship.
 */
export function formatCallMeNowFailedAlert(f: {
  stage: CallMeNowFailedStage;
  leadId: string;
  error: unknown;
  /** A press the lead made, or the check that decides whether the button shows. */
  when?: "press" | "check";
}): string {
  const reason = `Salesforce failed while ${STAGE_WORDS[f.stage]} (${shortErrorReason(f.error)})`;
  if (f.when === "check") {
    return (
      `The Call me now button was hidden for lead ${f.leadId}: ${reason}. ` +
      `They can still book a time. While this lasts the button is hidden for every lead, so nobody can press it.`
    );
  }
  return (
    `Call me now did not go through for lead ${f.leadId}: ${reason}. ` +
    `The lead was shown a notice with Try again and the times to book, so nobody has been asked to call them yet. ` +
    `If they do not book or try again, call them from Salesforce.`
  );
}
