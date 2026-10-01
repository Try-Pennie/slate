/**
 * The contact card attached to the 24 hour reminder (#1334).
 *
 * Call screening silences a call from a number the lead has never seen. Tapping a
 * `.vcf` attachment opens "Add to Contacts" on an iPhone and in Gmail on Android,
 * and a call from a saved, named contact is let through.
 *
 * The card is named "Pennie" for every lead and never names the advisor (Dan,
 * 2026-10-01). A lead can be redistributed to another advisor while the calling
 * number stays the same, so a contact saved under one advisor's name would go on
 * labelling calls from somebody else. The booked advisor's PHOTO is still on it,
 * because Dan chose a face over the Pennie logo.
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
 * presented as a person's name, in an email's greeting or signature. Used by the
 * reminder copy; the card itself never carries the advisor's name.
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

/**
 * Pennie's name on the card and its file, for every lead. Plain ASCII, since the
 * file name rides in a quoted MIME header.
 */
const CARD_NAME = "Pennie";

export function advisorContactCard(input: AdvisorCardInput): MailAttachment {
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:;${CARD_NAME};;;`,
    `FN:${CARD_NAME}`,
    "ORG:Pennie",
    `TEL;TYPE=WORK,VOICE:${input.callingNumber}`,
    `EMAIL;TYPE=INTERNET,WORK:${escapeValue(input.agentEmail)}`,
    // Folded like every other line. Absent, never empty, when there is no photo.
    ...(input.photo ? [`PHOTO;ENCODING=b;TYPE=${input.photo.type}:${input.photo.base64}`] : []),
    "END:VCARD",
  ];
  return {
    filename: `${CARD_NAME}.vcf`,
    content: `${lines.map(fold).join("\r\n")}\r\n`,
    mimeType: "text/vcard",
  };
}
