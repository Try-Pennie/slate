/**
 * Branded HTML + plain-text bodies for the booking emails (created /
 * rescheduled / cancelled). Email-client constraints: inline CSS only, no
 * webfont loading (PP Mori with a system fallback stack), table layout.
 * Copy rules: warm plain Pennie voice, no dashes, never guarantee outcomes.
 *
 * Pure module (relative imports only) — exercised by
 * scripts/test-email-templates.ts.
 */

export type BookingEmailKind = "created" | "rescheduled" | "cancelled";

export interface BookingEmailPayload {
  kind: BookingEmailKind;
  agentName: string | null;
  attendeeName: string | null;
  eventTypeName: string;
  /** Slot start; rendered in the lead's timezone. */
  startIso: string;
  /** The lead's IANA timezone (booking.timezone). */
  timezone: string;
  durationMin: number;
  manageUrl: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** "EST"/"EDT" → "ET" etc.; other abbreviations pass through. */
function friendlyZone(abbrev: string): string {
  const m = /^([ECMPA])[SD]T$/.exec(abbrev);
  return m ? `${m[1]}T` : abbrev;
}

/** e.g. "Friday, June 20 at 1:00pm ET" in the lead's timezone. */
export function formatLeadTime(startIso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).formatToParts(new Date(startIso));
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const ampm = get("dayPeriod").toLowerCase();
  const zone = friendlyZone(get("timeZoneName"));
  return `${get("weekday")}, ${get("month")} ${get("day")} at ${get("hour")}:${get("minute")}${ampm} ${zone}`;
}

function firstName(name: string | null): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first || null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface Copy {
  subject: string;
  heading: string;
  body: string;
  detail: string | null;
  cta: string;
}

function copyFor(p: BookingEmailPayload): Copy {
  const agent = firstName(p.agentName);
  const agentLabel = agent ?? "Your Pennie advisor";
  const when = formatLeadTime(p.startIso, p.timezone);
  const duration = `${p.durationMin} minutes`;

  switch (p.kind) {
    case "created":
      return {
        subject: agent
          ? `Your call with ${agent} is confirmed`
          : "Your call is confirmed",
        heading: "You're all set",
        body: agent
          ? `${agent} from Pennie will call you on ${when}. The call takes about ${duration}, and it's a chance to talk through your options together.`
          : `A Pennie advisor will call you on ${when}. The call takes about ${duration}, and it's a chance to talk through your options together.`,
        detail: `${agentLabel} will call you at the number you provided. No need to prepare anything.`,
        cta: "Manage my booking",
      };
    case "rescheduled":
      return {
        subject: "Your call has a new time",
        heading: "Your call has moved",
        body: agent
          ? `Your call with ${agent} from Pennie now starts on ${when}. It still takes about ${duration}.`
          : `Your call with Pennie now starts on ${when}. It still takes about ${duration}.`,
        detail: `${agentLabel} will call you at the number you provided.`,
        cta: "Manage my booking",
      };
    case "cancelled":
      return {
        subject: "Your call has been cancelled",
        heading: "Your call is cancelled",
        body: agent
          ? `Your call with ${agent} from Pennie, set for ${when}, has been cancelled. Nothing else is needed from you.`
          : `Your Pennie call set for ${when} has been cancelled. Nothing else is needed from you.`,
        detail:
          "Still want to talk through your options? You can pick a new time whenever you're ready.",
        cta: "Manage my booking",
      };
  }
}

const FONT_STACK =
  "'PP Mori', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function renderBookingEmail(p: BookingEmailPayload): RenderedEmail {
  const copy = copyFor(p);
  const lead = firstName(p.attendeeName);
  const greeting = lead ? `Hi ${lead},` : "Hi,";
  const manageUrl = p.manageUrl;

  const text = [
    greeting,
    "",
    copy.body,
    ...(copy.detail ? ["", copy.detail] : []),
    "",
    `${copy.cta}: ${manageUrl}`,
    "",
    "Pennie · trypennie.com",
    "",
  ].join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(copy.subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#F9F6F0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F9F6F0;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#FFFFFF;border-radius:16px;">
<tr><td style="padding:40px 40px 32px 40px;font-family:${FONT_STACK};color:#343434;">
<p style="margin:0 0 8px 0;font-size:14px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#343434;">Pennie</p>
<h1 style="margin:0 0 24px 0;font-size:26px;line-height:1.25;font-weight:600;color:#343434;">${escapeHtml(copy.heading)}</h1>
<p style="margin:0 0 16px 0;font-size:16px;line-height:1.6;">${escapeHtml(greeting)}</p>
<p style="margin:0 0 16px 0;font-size:16px;line-height:1.6;">${escapeHtml(copy.body)}</p>
${copy.detail ? `<p style="margin:0 0 24px 0;font-size:16px;line-height:1.6;">${escapeHtml(copy.detail)}</p>` : ""}
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 8px 0;">
<tr><td style="border-radius:16px;background-color:#82D0FF;">
<a href="${escapeHtml(manageUrl)}" style="display:inline-block;padding:14px 28px;font-family:${FONT_STACK};font-size:16px;font-weight:600;color:#343434;text-decoration:none;border-radius:16px;">${escapeHtml(copy.cta)}</a>
</td></tr>
</table>
</td></tr>
<tr><td style="padding:0 40px 36px 40px;font-family:${FONT_STACK};">
<p style="margin:0;font-size:13px;line-height:1.6;color:#6B6B6B;">Pennie · <a href="https://trypennie.com" style="color:#6B6B6B;">trypennie.com</a></p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;

  return { subject: copy.subject, html, text };
}
