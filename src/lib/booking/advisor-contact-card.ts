/**
 * The advisor's contact card, attached to the 24 hour reminder (#1334).
 *
 * Call screening silences a call from a number the lead has never seen. Tapping a
 * `.vcf` attachment opens "Add to Contacts" on an iPhone and in Gmail on Android,
 * and a call from a saved, named contact is let through. The reminder already
 * waits for the owner hand-back (#2633), so the card names the advisor who will
 * actually call.
 *
 * The phone on the card is the CALLING number and nothing else. The Sendblue
 * texting line is deliberately absent: texting lines change often (Dan,
 * 2026-09-30), and a saved texting number that later changes would send the lead's
 * texts to a line that no longer reaches us.
 *
 * vCard 3.0 (RFC 2426), the version iOS, Android and Gmail all read. Pure, so
 * `scripts/test-advisor-contact-card.ts` pins the exact lines.
 */
import type { MailAttachment } from "../notify/email-mime.ts";

export interface AdvisorCardInput {
  agentName: string;
  /** The mailbox the reminder is sent from, so a reply and the card agree. */
  agentEmail: string;
  /** E.164, already validated (`callingNumberOf`). */
  callingNumber: string;
}

/** Escape a vCard text value: backslash, comma, semicolon and newline. */
function escapeValue(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/\r?\n/g, "\\n");
}

/** The longest physical line the format allows, in octets. */
const LINE_OCTETS = 75;

/**
 * Fold a content line at 75 octets, continuing with a single space, never splitting
 * a multi byte character.
 */
function fold(line: string): string {
  const out: string[] = [];
  let current = "";
  let currentBytes = 0;
  const encoder = new TextEncoder();
  for (const ch of line) {
    const bytes = encoder.encode(ch).length;
    // A continuation line spends one octet on its leading space.
    const limit = out.length === 0 ? LINE_OCTETS : LINE_OCTETS - 1;
    if (currentBytes + bytes > limit) {
      out.push(current);
      current = "";
      currentBytes = 0;
    }
    current += ch;
    currentBytes += bytes;
  }
  out.push(current);
  return out.map((l, i) => (i === 0 ? l : ` ${l}`)).join("\r\n");
}

/** A file name that is safe inside a quoted MIME header: ASCII letters, digits, spaces. */
function cardFilename(agentName: string): string {
  const safe = agentName.replace(/[^A-Za-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  return safe ? `${safe} Pennie.vcf` : "Pennie advisor.vcf";
}

export function advisorContactCard(input: AdvisorCardInput): MailAttachment {
  // The name carries Pennie, so the caller ID reads as who is calling and from where
  // rather than as a stranger's name.
  const display = escapeValue(`${input.agentName} (Pennie)`);
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:;${display};;;`,
    `FN:${display}`,
    "ORG:Pennie",
    `TEL;TYPE=WORK,VOICE:${input.callingNumber}`,
    `EMAIL;TYPE=INTERNET,WORK:${escapeValue(input.agentEmail)}`,
    "END:VCARD",
  ];
  return {
    filename: cardFilename(input.agentName),
    content: `${lines.map(fold).join("\r\n")}\r\n`,
    mimeType: "text/vcard",
  };
}
