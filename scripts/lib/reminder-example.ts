// The decisions behind `pnpm send:reminder-example`, kept pure so
// `scripts/test-reminder-example.ts` can drive them with no network.
//
// The command runs ONE booking through the real reminder lane (`runBookingReminders`),
// so the email it produces is the one a lead receives: the same subject, body, sender
// name and contact card, built by the same code. Only the booking is invented, and
// everything the lane would write about a booking is stubbed out, because there is no
// booking to write to.
import { DateTime } from "luxon";
import type { DueBooking, ReminderDeps, ReminderKind, ReminderRun } from "../../src/lib/booking/reminder-send.ts";
import type { MimeMessage } from "../../src/lib/notify/email-mime.ts";
import { isLeadId } from "../../src/lib/salesforce/lead-xbc.ts";

/** The only inbox domain an example may be sent to: it is never a lead's. */
const PENNIE_DOMAIN = "trypennie.com";

export interface ExampleConfig {
  advisorEmail: string;
  to: string;
  /** The lead whose calling number goes on the card, or null for the advisor's latest. */
  leadId: string | null;
  /** The zone the call time is written in, as a lead's would be. */
  timezone: string;
  /** False previews the message and sends nothing. */
  send: boolean;
  /** Which email (#4285): the 24 hour one, the default, or the 1 hour one (#4282). */
  kind: ReminderKind;
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
  const kindRaw = env.REMINDER_EXAMPLE_KIND?.trim() || "day";
  if (kindRaw !== "day" && kindRaw !== "hour") {
    return { ok: false, reason: "REMINDER_EXAMPLE_KIND must be day or hour." };
  }
  const sendRaw = env.SEND;
  if (sendRaw !== undefined && sendRaw !== "" && sendRaw !== "1") {
    return { ok: false, reason: "SEND must be 1 to send, or unset to preview." };
  }
  return { ok: true, config: { advisorEmail, to, leadId: leadRaw, timezone, send: sendRaw === "1", kind: kindRaw } };
}

export interface ExampleAdvisor {
  id: string;
  name: string | null;
  email: string;
}

const HALF_HOUR_MS = 30 * 60_000;

const FIVE_MINUTES_MS = 5 * 60_000;

/**
 * A booking the lane judges due right now, made two days ago. For the 24 hour email it
 * is about 23 hours out, on a half hour. For the 1 hour email (#4285) it is 55 to 60
 * minutes out, on five minutes, with its 24 hour email sent the day before, so the
 * two hour gap and the 30 minute cutoff both let it through as they would a real call.
 */
export function exampleBooking(cfg: ExampleConfig, advisor: ExampleAdvisor, leadId: string, nowMs: number): DueBooking {
  const startMs =
    cfg.kind === "hour"
      ? Math.floor((nowMs + 60 * 60_000) / FIVE_MINUTES_MS) * FIVE_MINUTES_MS
      : Math.floor((nowMs + 23 * 60 * 60_000) / HALF_HOUR_MS) * HALF_HOUR_MS;
  const startsAtIso = new Date(startMs).toISOString();
  return {
    id: "reminder-example",
    startsAtIso,
    createdAtIso: new Date(nowMs - 2 * 24 * 60 * 60_000).toISOString(),
    reminderSentForIso: cfg.kind === "hour" ? startsAtIso : null,
    reminderSentAtIso: cfg.kind === "hour" ? new Date(nowMs - 23 * 60 * 60_000).toISOString() : null,
    hourReminderSentForIso: null,
    onPlaceholder: false,
    status: "confirmed",
    attendeeEmail: cfg.to,
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
 * The lane's dependencies for one invented booking. The reads that shape the email
 * (calling number, photo) are real; everything that would write about a booking is
 * a no op or a refusal, and an alert is printed rather than paged.
 */
export function exampleDeps(io: ExampleIo): ReminderDeps {
  return {
    now: () => io.nowMs,
    loadDue: async () => [io.booking],
    claim: async () => true,
    // The claim above wrote nothing, so there is no row to hand back to.
    release: async () => false,
    // Nor a row to stamp a send time on (#4282).
    markSent: async () => {},
    send: async (msg) => {
      io.preview(msg);
      return io.config.send ? io.sendEmail(msg) : "not-sent";
    },
    alert: async (_bookingId, text) => console.error(`(would have paged) ${text}`),
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
} as const;

export function judgeExampleRun(run: ReminderRun, sent: boolean): { code: number; message: string } {
  if (run.failed > 0) {
    return { code: EXAMPLE_EXIT.sendFailed, message: "Gmail refused the send; the reason is printed above." };
  }
  if (run.sent !== 1) {
    return {
      code: EXAMPLE_EXIT.sendFailed,
      message: `The lane did not build the reminder (sent ${run.sent}, held ${run.held}, skipped ${run.skipped}).`,
    };
  }
  if (run.withCallingNumber !== 1) {
    return {
      code: EXAMPLE_EXIT.noCard,
      message: run.callingNumberUnread
        ? "Salesforce could not be read, so the reminder carries no calling number and no contact card."
        : "That lead has no calling number in Salesforce, so the reminder carries no contact card. Name another with REMINDER_EXAMPLE_LEAD.",
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
