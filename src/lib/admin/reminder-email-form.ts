import { describeTemplateProblem, validateTemplate } from "../booking/reminder-template.ts";
import { joinMinutes, timingWords } from "../booking/reminder-preview.ts";
import type { ReminderEmailCopy, ReminderLateBooking } from "../db/types.ts";

/**
 * The reminder email editor's rules (#4299), shared by the page that draws it and the
 * server action that saves it, so the picker can only offer what the save accepts
 * (L611). Pure, so the editor imports it client side.
 */

/** What an email does about a call booked after its window has opened. Picker order. */
export const LATE_BOOKING_CHOICES: readonly { value: ReminderLateBooking; label: string }[] = [
  { value: "send_now", label: "Send it right away" },
  { value: "skip", label: "Skip it for that call" },
];

export function lateBookingLabel(value: ReminderLateBooking): string {
  return LATE_BOOKING_CHOICES.find((c) => c.value === value)?.label ?? value;
}

function isLateBooking(v: string): v is ReminderLateBooking {
  return LATE_BOOKING_CHOICES.some((c) => c.value === v);
}

/** The editor's field names, one list for the form and the action. */
export const REMINDER_FIELDS = {
  id: "reminder_email_id",
  loadedUpdatedAt: "loaded_updated_at",
  name: "name",
  hours: "timing_hours",
  minutes: "timing_minutes",
  lateBooking: "late_booking",
  enabled: "enabled",
  subject: "subject",
  body: "body",
  cardBlock: "card_block",
  placeholderSends: "placeholder_sends",
  version: "version",
  previewCase: "preview_case",
  /** Posted by the confirm that asks about calls already inside the window. */
  confirmWindow: "confirm_window",
} as const;

/** The value that confirm posts. */
export const CONFIRM_WINDOW_YES = "yes";

export const REMINDER_NAME_MAX = 80;

/** The columns the page and the actions read of an email, one list for both. */
export const REMINDER_EMAIL_COLUMNS =
  "id, slug, name, minutes_before, late_booking, enabled, subject, body, card_block, placeholder_sends, updated_at";

/** A reminder email as the editor submits it, before anything is written. */
export interface ReminderEmailInput {
  name: string;
  minutesBefore: number;
  lateBooking: ReminderLateBooking;
  enabled: boolean;
  subject: string;
  body: string;
  cardBlock: boolean;
  placeholderSends: boolean;
}

type Read = (field: string) => string | null;

/** A switch posts "true" when on. Anything else is off. */
const on = (raw: string | null) => raw === "true";

/**
 * The submitted email, or every reason it cannot be saved, in the order the editor
 * shows the fields. Fill-in problems name each fill-in (`describeTemplateProblem`).
 */
export function parseReminderEmailForm(read: Read): { ok: true; value: ReminderEmailInput } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const name = (read(REMINDER_FIELDS.name) ?? "").trim();
  if (name === "") reasons.push("Give the email a name.");
  else if (name.length > REMINDER_NAME_MAX) reasons.push(`The name must be ${REMINDER_NAME_MAX} characters or fewer.`);

  const timing = joinMinutes(read(REMINDER_FIELDS.hours) ?? "", read(REMINDER_FIELDS.minutes) ?? "");
  if (!timing.ok) reasons.push(timing.reason);

  const late = read(REMINDER_FIELDS.lateBooking) ?? "";
  if (!isLateBooking(late)) reasons.push("Choose what happens to a call booked after this email's time.");

  // Line endings as a browser posts them (CRLF) are stored as LF, so the body the
  // lead receives is the one the preview drew.
  const subject = (read(REMINDER_FIELDS.subject) ?? "").replace(/\r\n?/g, "\n");
  const body = (read(REMINDER_FIELDS.body) ?? "").replace(/\r\n?/g, "\n");
  for (const p of validateTemplate(subject, body)) reasons.push(describeTemplateProblem(p));

  if (reasons.length > 0 || !timing.ok || !isLateBooking(late)) return { ok: false, reasons };
  return {
    ok: true,
    value: {
      name,
      minutesBefore: timing.total,
      lateBooking: late,
      enabled: on(read(REMINDER_FIELDS.enabled)),
      subject,
      body,
      cardBlock: on(read(REMINDER_FIELDS.cardBlock)),
      placeholderSends: on(read(REMINDER_FIELDS.placeholderSends)),
    },
  };
}

/**
 * The stable key a new email is stored under, from its name: lower case letters,
 * digits and underscores, starting with a letter, at most 40 characters, and not one
 * already taken (a number is added until it is free). Never changes once created.
 */
export function slugForNewEmail(name: string, taken: ReadonlySet<string>): string {
  let stem = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[0-9_]+/, "");
  if (stem === "") stem = "reminder";
  stem = stem.slice(0, 34).replace(/_+$/, "");
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** What decides whether a save has to warn about calls already inside the window. */
export interface WindowState {
  enabled: boolean;
  minutesBefore: number;
}

/**
 * Whether saving `next` over `loaded` opens a fresh window: switching the email on, or
 * retiming it while it is on. Calls whose window had already opened by then are
 * skipped (migration 0211 stamps `effective_from`), so the save asks first.
 */
export function opensFreshWindow(loaded: WindowState | null, next: WindowState): boolean {
  if (!next.enabled) return false;
  if (!loaded) return true;
  return !loaded.enabled || loaded.minutesBefore !== next.minutesBefore;
}

/** The consequence sentence for that question, built from the state it changes. */
export function freshWindowMessage(name: string, loaded: WindowState | null, next: WindowState): string {
  const when = timingWords(next.minutesBefore);
  const what = loaded && loaded.enabled ? `Moving "${name}" to ${when} before the call` : `Switching "${name}" on`;
  return `${what} starts it from now. A call that is already less than ${when} away will not get it.`;
}

/** The copy fields a restore brings back, in the order the editor shows them. */
const COPY_FIELDS: readonly { key: keyof ReminderEmailCopy; label: string }[] = [
  { key: "subject", label: "the subject" },
  { key: "body", label: "the body" },
  { key: "card_block", label: "the contact card switch" },
  { key: "placeholder_sends", label: "whether placeholder calls get it" },
];

/** Which copy fields restoring `snapshot` over `current` changes, as words. */
export function restoreChanges(current: ReminderEmailCopy, snapshot: ReminderEmailCopy): string[] {
  return COPY_FIELDS.filter((f) => current[f.key] !== snapshot[f.key]).map((f) => f.label);
}

/** Reads a stored version's snapshot, refusing anything that is not a whole copy. */
export function readSnapshot(raw: unknown): ReminderEmailCopy | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.subject !== "string" || typeof s.body !== "string") return null;
  if (typeof s.card_block !== "boolean" || typeof s.placeholder_sends !== "boolean") return null;
  return { subject: s.subject, body: s.body, card_block: s.card_block, placeholder_sends: s.placeholder_sends };
}

/** "a, b and c". */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
