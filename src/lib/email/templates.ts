/**
 * Branded HTML + plain-text bodies for the booking emails (created /
 * rescheduled / cancelled), built to the bulletproof-email playbook so they
 * survive real clients (Outlook desktop renders with Word):
 *
 * - XHTML 1.0 Transitional doctype, mso namespaces, table-only layout with a
 *   600px hybrid container (fluid + an mso conditional fixed-width wrapper).
 * - Every style is inline; the small <style> block only carries client resets
 *   and the under-480px mobile media query (clients may strip it entirely).
 * - bgcolor + width attributes alongside inline CSS for Outlook; font-family
 *   on every text element (Outlook falls back to Times New Roman otherwise).
 * - Bulletproof CTA: padded inline-block <a> in a sky bgcolor td (44px+ tap
 *   target; border-radius degrades to square in Outlook); the manage URL is
 *   also repeated as visible plain text for clients that mangle buttons.
 * - Hidden preheader, light color-scheme metas, no images, no webfonts
 *   (PP Mori with a system fallback stack).
 *
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
  /** Hidden inbox preview line: the time/date summary. */
  preheader: string;
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
        preheader: `Your call is confirmed for ${when}.`,
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
        preheader: `Your call now starts on ${when}.`,
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
        preheader: `Your call set for ${when} has been cancelled.`,
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

/** Inline text style fragments; font-family goes on EVERY text element. */
const BODY_TEXT = `font-family:${FONT_STACK};font-size:16px;line-height:26px;mso-line-height-rule:exactly;color:#343434;`;
const FOOTER_TEXT = `font-family:${FONT_STACK};font-size:13px;line-height:20px;mso-line-height-rule:exactly;color:#6B6B6B;`;

export function renderBookingEmail(p: BookingEmailPayload): RenderedEmail {
  const copy = copyFor(p);
  const lead = firstName(p.attendeeName);
  const greeting = lead ? `Hi ${lead},` : "Hi,";
  const manageUrl = p.manageUrl;
  const urlHtml = escapeHtml(manageUrl);

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

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${escapeHtml(copy.subject)}</title>
<!--[if mso]>
<noscript>
<xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
</noscript>
<![endif]-->
<style type="text/css">
body, table, td, a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
table, td { mso-table-lspace:0pt; mso-table-rspace:0pt; }
body { margin:0; padding:0; width:100% !important; }
a[x-apple-data-detectors] { color:inherit !important; text-decoration:none !important; }
@media only screen and (max-width:480px) {
  .sl-shell { padding:16px 8px !important; }
  .sl-inner { padding-left:24px !important; padding-right:24px !important; }
  .sl-btn-table { width:100% !important; }
  .sl-btn-cell { display:block !important; }
  .sl-btn { display:block !important; width:auto !important; text-align:center !important; padding-top:16px !important; padding-bottom:16px !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background-color:#F9F6F0;" bgcolor="#F9F6F0">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:#F9F6F0;">${escapeHtml(copy.preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F9F6F0" style="width:100%;background-color:#F9F6F0;">
<tr>
<td align="center" class="sl-shell" style="padding:32px 16px;">
<!--[if mso]>
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td>
<![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" align="center" bgcolor="#FFFFFF" style="width:100%;max-width:600px;background-color:#FFFFFF;border-radius:16px;">
<tr>
<td class="sl-inner" style="padding:40px 40px 8px 40px;">
<p style="margin:0 0 8px 0;font-family:${FONT_STACK};font-size:14px;line-height:20px;mso-line-height-rule:exactly;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#343434;">Pennie</p>
<h1 style="margin:0 0 24px 0;font-family:${FONT_STACK};font-size:26px;line-height:34px;mso-line-height-rule:exactly;font-weight:600;color:#343434;">${escapeHtml(copy.heading)}</h1>
<p style="margin:0 0 16px 0;${BODY_TEXT}">${escapeHtml(greeting)}</p>
<p style="margin:0 0 16px 0;${BODY_TEXT}">${escapeHtml(copy.body)}</p>
${copy.detail ? `<p style="margin:0 0 16px 0;${BODY_TEXT}">${escapeHtml(copy.detail)}</p>` : ""}
</td>
</tr>
<tr>
<td class="sl-inner" style="padding:8px 40px 8px 40px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="sl-btn-table">
<tr>
<td align="center" bgcolor="#82D0FF" class="sl-btn-cell" style="background-color:#82D0FF;border-radius:16px;">
<a href="${urlHtml}" target="_blank" class="sl-btn" style="display:inline-block;padding:14px 28px;font-family:${FONT_STACK};font-size:16px;line-height:16px;mso-line-height-rule:exactly;font-weight:600;color:#343434;text-decoration:none;border-radius:16px;">${escapeHtml(copy.cta)}</a>
</td>
</tr>
</table>
</td>
</tr>
<tr>
<td class="sl-inner" style="padding:16px 40px 36px 40px;">
<p style="margin:0 0 16px 0;${FOOTER_TEXT}">If the button does not work, copy and paste this link into your browser:<br />
<a href="${urlHtml}" target="_blank" style="font-family:${FONT_STACK};color:#343434;text-decoration:underline;word-break:break-all;">${urlHtml}</a></p>
<p style="margin:0;${FOOTER_TEXT}">Pennie · <a href="https://trypennie.com" target="_blank" style="font-family:${FONT_STACK};color:#6B6B6B;">trypennie.com</a></p>
</td>
</tr>
</table>
<!--[if mso]>
</td></tr></table>
<![endif]-->
</td>
</tr>
</table>
</body>
</html>
`;

  return { subject: copy.subject, html, text };
}
