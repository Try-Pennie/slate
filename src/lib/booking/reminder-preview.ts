import { renderReminder, type ReminderTemplate, type TemplateProblem } from "./reminder-template.ts";
import { realAdvisorName } from "./advisor-contact-card.ts";
import { REMINDER_EMAIL_MAX_MINUTES, REMINDER_EMAIL_MIN_MINUTES, type ReminderCopyInput } from "./reminder.ts";

/**
 * The sample calls the reminder email editor previews and tests against (#4299).
 *
 * ONE list, read by the live preview on /admin/reminder-emails and by "Send me a test",
 * so the email an admin receives is the one they were looking at. Every value is
 * invented and fixed: a preview or a test never reads a real booking, and a fixed
 * clock means the same draft always previews the same way (`renderReminder` takes its
 * clock in the input, #2497).
 *
 * Pure: no database, no clock, no network, so the editor can import it client side.
 */

/** The sample call: Thursday 5 November 2026 at 2:30pm in New York. */
export const SAMPLE_CALL_STARTS_AT = "2026-11-05T19:30:00.000Z";
export const SAMPLE_LEAD_ZONE = "America/New_York";
export const SAMPLE_MANAGE_URL = "https://slate.trypennie.app/booking/manage/sample";
/** 555 numbers, so a sample can never be anybody's real line. */
export const SAMPLE_LEAD_PHONE = "+12155550100";
export const SAMPLE_CALLING_NUMBER = "+12155550199";
export const SAMPLE_ADVISOR = { name: "Sam Rivera", mailbox: "sam.rivera@trypennie.com" } as const;
/** The placeholder advisor's seat (#4206), whose mailbox a placeholder call's email comes from. */
export const SAMPLE_PLACEHOLDER = { name: "Marcia", mailbox: "scheduling@trypennie.com" } as const;
/** The name an inbox shows when the advisor has none on record, as the lane sends it. */
export const SENDER_NAME_WHEN_NAMELESS = "Pennie";

export type PreviewCaseId = "calling_known" | "calling_unknown" | "no_lead_number" | "no_advisor_name" | "placeholder";

export interface PreviewCase {
  id: PreviewCaseId;
  /** Names the call, in the domain's words. */
  label: string;
  /** Everything about the call except the clock, which follows the email's timing. */
  call: Omit<ReminderCopyInput, "nowMs">;
  /** The mailbox the lead's email comes from. */
  mailbox: string;
}

const base = {
  agentName: SAMPLE_ADVISOR.name as string | null,
  startsAtIso: SAMPLE_CALL_STARTS_AT,
  timezone: SAMPLE_LEAD_ZONE,
  manageUrl: SAMPLE_MANAGE_URL,
  callingNumber: SAMPLE_CALLING_NUMBER as string | null,
  leadPhone: SAMPLE_LEAD_PHONE as string | null,
  onPlaceholder: false,
};

/** In the order the editor shows them: the ordinary call first. */
export const PREVIEW_CASES: readonly PreviewCase[] = [
  { id: "calling_known", label: "We know the number we call from", call: base, mailbox: SAMPLE_ADVISOR.mailbox },
  {
    id: "calling_unknown",
    label: "We do not know the number we call from",
    call: { ...base, callingNumber: null },
    mailbox: SAMPLE_ADVISOR.mailbox,
  },
  { id: "no_lead_number", label: "The lead gave no number", call: { ...base, leadPhone: null }, mailbox: SAMPLE_ADVISOR.mailbox },
  {
    id: "no_advisor_name",
    label: "The advisor has no name on record",
    call: { ...base, agentName: null },
    mailbox: SAMPLE_ADVISOR.mailbox,
  },
  {
    id: "placeholder",
    label: "A call on the placeholder advisor",
    call: { ...base, agentName: SAMPLE_PLACEHOLDER.name, onPlaceholder: true },
    mailbox: SAMPLE_PLACEHOLDER.mailbox,
  },
];

export function previewCase(id: string): PreviewCase | null {
  return PREVIEW_CASES.find((c) => c.id === id) ?? null;
}

/** What the editor holds of an email, saved or not. */
export interface ReminderDraft extends ReminderTemplate {
  /** Whether a call on the placeholder advisor gets this email at all. */
  placeholderSends: boolean;
}

export type ReminderPreview =
  | {
      kind: "rendered";
      fromName: string;
      fromAddress: string;
      subject: string;
      body: string;
      cardAttached: boolean;
    }
  | { kind: "refused"; problems: TemplateProblem[] }
  /** A placeholder call, with this email switched off for placeholder calls. */
  | { kind: "not_sent" };

/**
 * The email the lead in `c` receives from `draft`, as it would be sent, or why not.
 * The clock is the moment the email goes out, `minutesBefore` ahead of the sample call.
 */
export function previewReminder(draft: ReminderDraft, c: PreviewCase): ReminderPreview {
  if (c.call.onPlaceholder && !draft.placeholderSends) return { kind: "not_sent" };
  const startsMs = Date.parse(c.call.startsAtIso);
  const rendered = renderReminder(draft, { ...c.call, nowMs: startsMs - draft.minutesBefore * 60_000 });
  if (!rendered.ok) return { kind: "refused", problems: rendered.problems };
  return {
    kind: "rendered",
    fromName: realAdvisorName(c.call.agentName) ?? SENDER_NAME_WHEN_NAMELESS,
    fromAddress: c.mailbox,
    subject: rendered.subject,
    body: rendered.body,
    cardAttached: rendered.cardAttached,
  };
}

/** One stored minutes value, as the editor's two boxes show it. */
export function splitMinutes(total: number): { hours: number; minutes: number } {
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

/**
 * The editor's two boxes as one minutes value, or a sentence saying why not. Whole
 * numbers only, minutes under 60, and the total inside the bounds the database holds.
 */
export function joinMinutes(hoursRaw: string, minutesRaw: string): { ok: true; total: number } | { ok: false; reason: string } {
  const h = hoursRaw.trim() === "" ? 0 : Number(hoursRaw.trim());
  const m = minutesRaw.trim() === "" ? 0 : Number(minutesRaw.trim());
  if (!Number.isInteger(h) || h < 0 || !Number.isInteger(m) || m < 0) {
    return { ok: false, reason: "The timing must be whole hours and minutes." };
  }
  if (m > 59) return { ok: false, reason: "The minutes must be under 60. Put whole hours in the hours box." };
  const total = h * 60 + m;
  if (total < REMINDER_EMAIL_MIN_MINUTES || total > REMINDER_EMAIL_MAX_MINUTES) {
    return { ok: false, reason: `The timing must be between ${timingWords(REMINDER_EMAIL_MIN_MINUTES)} and ${timingWords(REMINDER_EMAIL_MAX_MINUTES)} before the call.` };
  }
  return { ok: true, total };
}

/** "24 hours", "1 hour 30 minutes", "30 minutes". */
export function timingWords(total: number): string {
  const { hours, minutes } = splitMinutes(total);
  const h = hours === 0 ? "" : `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const m = minutes === 0 ? "" : `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  return [h, m].filter(Boolean).join(" ") || "0 minutes";
}
