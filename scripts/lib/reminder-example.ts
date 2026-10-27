// The decisions behind `pnpm send:reminder-example`, kept pure so
// `scripts/test-reminder-example.ts` can drive them with no network.
//
// The command runs ONE booking through the real reminder lane (`runBookingReminders`)
// with ONE stored email (#4298), chosen by its slug, so the email it produces is the
// one a lead receives: the same subject, body, sender name and contact card, rendered
// from the same stored words by the same code. Only the booking is invented, and
// everything the lane would write about a booking is stubbed out, because there is no
// booking to write to.
import { DateTime } from "luxon";
import type { DueBooking, LaneEmail, ReminderDeps, ReminderRun } from "../../src/lib/booking/reminder-send.ts";
import type { MimeMessage } from "../../src/lib/notify/email-mime.ts";
import { isLeadId } from "../../src/lib/salesforce/lead-xbc.ts";
import { formatPhoneForDisplay } from "../../src/lib/phone-format.ts";

/** The only inbox domain an example may be sent to: it is never a lead's. */
const PENNIE_DOMAIN = "trypennie.com";

/** What `reminder_emails.slug` may be (migration 0211's check). */
const SLUG = /^[a-z][a-z0-9_]{0,39}$/;

export interface ExampleConfig {
  advisorEmail: string;
  to: string;
  /** The lead whose calling number goes on the card, or null for the advisor's latest. */
  leadId: string | null;
  /** The zone the call time is written in, as a lead's would be. */
  timezone: string;
  /** False previews the message and sends nothing. */
  send: boolean;
  /** Which stored email, by slug (#4285, #4298): `day` by default, `hour`, or any other. */
  kind: string;
  /** The lead's own number the email names (#4292), or null to show the fallback. */
  phone: string | null;
}

export type ConfigResult = { ok: true; config: ExampleConfig } | { ok: false; reason: string };

function pennieAddress(raw: string | undefined): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  return /^[a-z0-9._%+-]+@trypennie\.com$/.test(v) ? v : null;
}

export function readExampleConfig(env: Record<string, string | undefined>): ConfigResult {
  if (!env.REMINDER_EXAMPLE_ADVISOR?.trim()) {
    return { ok: false, reason: "Set REMINDER_EXAMPLE_ADVISOR to the advisor's email, the mailbox the reminder is sent from." };
  }
  const advisorEmail = pennieAddress(env.REMINDER_EXAMPLE_ADVISOR);
  if (!advisorEmail) {
    return { ok: false, reason: `REMINDER_EXAMPLE_ADVISOR must be one @${PENNIE_DOMAIN} address.` };
  }
  if (!env.REMINDER_EXAMPLE_TO?.trim()) {
    return { ok: false, reason: "Set REMINDER_EXAMPLE_TO to the inbox the example goes to." };
  }
  if (/[,;\s]/.test(env.REMINDER_EXAMPLE_TO.trim())) {
    return { ok: false, reason: "REMINDER_EXAMPLE_TO takes one address, not a list." };
  }
  const to = pennieAddress(env.REMINDER_EXAMPLE_TO);
  if (!to) {
    return {
      ok: false,
      reason: `REMINDER_EXAMPLE_TO must be one @${PENNIE_DOMAIN} address, so an example can never reach a lead or anybody outside Pennie.`,
    };
  }
  const leadRaw = env.REMINDER_EXAMPLE_LEAD?.trim() || null;
  if (leadRaw && !isLeadId(leadRaw)) {
    return { ok: false, reason: "REMINDER_EXAMPLE_LEAD must be a Salesforce lead id (it starts 00Q)." };
  }
  const timezone = env.REMINDER_EXAMPLE_TZ?.trim() || "America/New_York";
  if (!DateTime.now().setZone(timezone).isValid) {
    return { ok: false, reason: `REMINDER_EXAMPLE_TZ "${timezone}" is not a timezone this can write a time in.` };
  }
  const kind = env.REMINDER_EXAMPLE_KIND?.trim() || "day";
  if (!SLUG.test(kind)) {
    return { ok: false, reason: "REMINDER_EXAMPLE_KIND must be a stored email's slug, such as day or hour." };
  }
  const phone = env.REMINDER_EXAMPLE_PHONE?.trim() || null;
  if (phone && !formatPhoneForDisplay(phone)) {
    return { ok: false, reason: "REMINDER_EXAMPLE_PHONE must be a US phone number, such as (215) 555-0100." };
  }
  const sendRaw = env.SEND;
  if (sendRaw !== undefined && sendRaw !== "" && sendRaw !== "1") {
    return { ok: false, reason: "SEND must be 1 to send, or unset to preview." };
  }
  return { ok: true, config: { advisorEmail, to, leadId: leadRaw, timezone, send: sendRaw === "1", kind, phone } };
}

export interface ExampleAdvisor {
  id: string;
  name: string | null;
  email: string;
}

const HALF_HOUR_MS = 30 * 60_000;
const FIVE_MINUTES_MS = 5 * 60_000;
const HOUR_MS = 60 * 60_000;

/**
 * A booking the lane judges due right now for `email`, made three days ago (before any
 * window up to the 48 hour cap opened), with nothing sent. For an email two hours or
 * more ahead the call is an hour inside its lead, on a half hour (the 24 hour email's
 * call is about 23 hours out); for a shorter one it is up to five minutes inside its
 * lead, on five minutes (the 1 hour email's is 55 to 60 minutes out), so the 30 minute
 * cutoff lets it through as it would a real call.
 */
export function exampleBooking(
  cfg: ExampleConfig,
  advisor: ExampleAdvisor,
  leadId: string,
  nowMs: number,
  email: Pick<LaneEmail, "minutesBefore">,
): DueBooking {
  const leadMs = email.minutesBefore * 60_000;
  const startMs =
    leadMs >= 2 * HOUR_MS
      ? Math.floor((nowMs + leadMs - HOUR_MS) / HALF_HOUR_MS) * HALF_HOUR_MS
      : Math.floor((nowMs + leadMs) / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
  return {
    id: "reminder-example",
    startsAtIso: new Date(startMs).toISOString(),
    createdAtIso: new Date(nowMs - 3 * 24 * HOUR_MS).toISOString(),
    reminderSentForIso: null,
    reminderSentAtIso: null,
    hourReminderSentForIso: null,
    sends: [],
    onPlaceholder: false,
    status: "confirmed",
    attendeeEmail: cfg.to,
    attendeePhone: cfg.phone,
    agentEmail: advisor.email,
    agentName: advisor.name,
    timezone: cfg.timezone,
    // A placeholder: there is no booking behind it, so the link does not open one.
    manageUrl: "https://slate.trypennie.app/booking/manage/example",
    leadId,
    gcalEventId: null,
    agentId: advisor.id,
  };
}

export interface ExampleIo {
  config: ExampleConfig;
  /** The stored email to send, chosen by slug. */
  email: LaneEmail;
  booking: DueBooking;
  nowMs: number;
  readCallingNumbers: ReminderDeps["readCallingNumbers"];
  readAdvisorPhotos: ReminderDeps["readAdvisorPhotos"];
  sendEmail(msg: MimeMessage): Promise<string>;
  /** Shown the built message before it is (or is not) sent. */
  preview(msg: MimeMessage): void;
  warn: ReminderDeps["warn"];
}

/**
 * The lane's dependencies for one invented booking and one stored email. The reads
 * that shape the email (calling number, photo) are real; everything that would write
 * about a booking is a no op, and an alert is printed rather than paged.
 *
 * The email is handed to the lane switched ON and in effect since the epoch, whatever
 * its stored switch says, so an email can be read before it goes live: the example only
 * ever reaches a Pennie inbox.
 */
export function exampleDeps(io: ExampleIo): ReminderDeps {
  const email: LaneEmail = { ...io.email, enabled: true, effectiveFromIso: "1970-01-01T00:00:00Z" };
  return {
    now: () => io.nowMs,
    loadEmails: async () => [email],
    loadDue: async () => [io.booking],
    // Every record of the send is a no op: there is no booking to write to. The claim
    // and the mark answer as if they landed, so the lane goes on as for a real send.
    claimSend: async () => "claimed",
    markSendSent: async () => true,
    releaseSend: async () => false,
    failSend: async () => false,
    skipSend: async () => false,
    legacyClaim: async () => true,
    legacyRelease: async () => false,
    legacyMarkSent: async () => {},
    send: async (msg) => {
      io.preview(msg);
      return io.config.send ? io.sendEmail(msg) : "not-sent";
    },
    alert: async (_bookingId, _slug, text) => console.error(`(would have paged) ${text}`),
    alertUnrenderable: async (_slug, text) => console.error(`(would have paged) ${text}`),
    resolveRenderable: async () => {},
    notifyNoneEnabled: async (text) => console.error(text),
    readCallingNumbers: io.readCallingNumbers,
    refreshInvite: async () => {
      throw new Error("the reminder example never writes a calendar invite");
    },
    readInviteDescription: async () => null,
    readAdvisorPhotos: io.readAdvisorPhotos,
    warn: io.warn,
  };
}

export const EXAMPLE_EXIT = {
  ok: 0,
  config: 1,
  noAdvisor: 2,
  noLead: 3,
  sendFailed: 4,
  noCard: 5,
  noEmail: 6,
  unrenderable: 7,
} as const;

export function judgeExampleRun(run: ReminderRun, sent: boolean): { code: number; message: string } {
  if (run.unrenderable.length > 0) {
    return {
      code: EXAMPLE_EXIT.unrenderable,
      message: "The stored email cannot be rendered: its subject or body holds something that is not a fill-in. The reason is printed above.",
    };
  }
  if (run.failed > 0) {
    return { code: EXAMPLE_EXIT.sendFailed, message: "Gmail refused the send; the reason is printed above." };
  }
  if (run.sent !== 1) {
    return {
      code: EXAMPLE_EXIT.sendFailed,
      message: `The lane did not build the reminder (sent ${run.sent}, held ${run.held}, waiting ${run.waiting}, skipped ${run.skipped}).`,
    };
  }
  if (run.withCallingNumber !== 1) {
    return {
      code: EXAMPLE_EXIT.noCard,
      message: run.callingNumberUnread
        ? "Salesforce could not be read, so the reminder carries no calling number and no contact card."
        : "That lead has no calling number in Salesforce, or this email has its contact card switched off, so the reminder carries no card. Name another lead with REMINDER_EXAMPLE_LEAD.",
    };
  }
  const card = run.withPhoto === 1 ? "the advisor's photo" : "the Pennie logo";
  return {
    code: EXAMPLE_EXIT.ok,
    message: sent
      ? `Sent, with the contact card carrying ${card}.`
      : `Built, with the contact card carrying ${card}. Not sent: run again with SEND=1 to send it.`,
  };
}
