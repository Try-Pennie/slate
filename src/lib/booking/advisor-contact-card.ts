/**
 * The contact card attached to the 24 hour reminder (#1334).
 *
 * Call screening silences a call from a number the lead has never seen. Tapping a
 * `.vcf` attachment opens "Add to Contacts" on an iPhone and in Gmail on Android,
 * and a call from a saved, named contact is let through.
 *
 * The card is named after the booked advisor, "<name> (Pennie)", with ORG Pennie,
 * and its file after them too (Dan, 2026-10-01, reversing a Pennie only card after
 * showing the team). With no real name on record it is plain "Pennie". The
 * advisor's PHOTO is on it, or the Pennie logo when there is none.
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

/**
 * The advisor's name as something a lead can be shown, or null when there is none.
 * Blank and anything shaped like an address count as none: an address is never
 * presented as a person's name, in an email's greeting, signature, sender or on
 * the contact card.
 */
export function realAdvisorName(raw: string | null | undefined): string | null {
  const name = (raw ?? "").trim();
  if (!name || name.includes("@")) return null;
  return name;
}

/** An image to embed in the card, already fetched and checked (`advisor-card-photo.ts`). */
export interface CardPhoto {
  /** The image's REAL type, judged from its bytes as well as its label. */
  type: "JPEG" | "PNG";
  /** The image bytes, base64, unfolded. */
  base64: string;
}

export interface AdvisorCardInput {
  /** The mailbox the reminder is sent from, so a reply and the card agree. */
  agentEmail: string;
  /**
   * The advisor's name as stored, judged here by `realAdvisorName`. REQUIRED rather
   * than optional, so `tsc` names every caller that has to decide (L168).
   */
  agentName: string | null;
  /** E.164, already validated (`callingNumberOf`). */
  callingNumber: string;
  /** The booked advisor's photo, or null for a card with no PHOTO line. */
  photo: CardPhoto | null;
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

/** The card's name and file name when the advisor has no real name on record. */
const CARD_NAME = "Pennie";

/**
 * The file name, in plain ASCII because it rides in a quoted MIME header: accents
 * folded to their base letter, anything but letters, digits, spaces and hyphens
 * dropped (a quote would end the header value, a slash is a path), spaces
 * collapsed. Pennie.vcf when nothing of the name survives.
 */
function cardFilename(name: string | null): string {
  const safe = (name ?? "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 -]/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
  return safe ? `${safe} ${CARD_NAME}.vcf` : `${CARD_NAME}.vcf`;
}

export function advisorContactCard(input: AdvisorCardInput): MailAttachment {
  const name = realAdvisorName(input.agentName);
  const display = escapeValue(name ? `${name} (${CARD_NAME})` : CARD_NAME);
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:;${display};;;`,
    `FN:${display}`,
    "ORG:Pennie",
    `TEL;TYPE=WORK,VOICE:${input.callingNumber}`,
    `EMAIL;TYPE=INTERNET,WORK:${escapeValue(input.agentEmail)}`,
    // Folded like every other line. Absent, never empty, when there is no photo.
    ...(input.photo ? [`PHOTO;ENCODING=b;TYPE=${input.photo.type}:${input.photo.base64}`] : []),
    "END:VCARD",
  ];
  return {
    filename: cardFilename(name),
    content: `${lines.map(fold).join("\r\n")}\r\n`,
    mimeType: "text/vcard",
  };
}
