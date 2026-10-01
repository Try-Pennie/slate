// The contact card attached to the 24 hour reminder (#1334). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-advisor-contact-card.ts
//
// Tapping it opens "Add to Contacts", and a call from a saved, named contact gets
// past call screening. What this pins:
//  - the ONLY phone on the card is the calling number, never a texting line;
//  - the card is named "Pennie" for every lead and never names the advisor, because
//    a redistributed lead keeps the calling number and gets a different advisor
//    (Dan, 2026-10-01), so a saved advisor name would go wrong while the number
//    stays right;
//  - the advisor's photo, when there is one, is embedded as a folded base64 PHOTO
//    line of its real type, and its absence leaves no PHOTO line at all;
//  - vCard escaping, CRLF line ends and line folding;
//  - the file name is plain ASCII, since it rides in a MIME header.
import { advisorContactCard } from "../src/lib/booking/advisor-contact-card.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const unfold = (content: string) => content.replace(/\r\n /g, "");

{
  const card = advisorContactCard({
    agentEmail: "jordan@trypennie.com",
    callingNumber: "+12197588170",
    photo: null,
  });
  eq(card.mimeType, "text/vcard", "a vCard media type, which phones open as a contact");
  eq(card.filename, "Pennie.vcf", "the file is Pennie.vcf, never the advisor's name");
  const lines = card.content.split("\r\n");
  eq(lines[0], "BEGIN:VCARD", "a vCard");
  eq(lines[1], "VERSION:3.0", "version 3.0, which iOS, Android and Gmail all read");
  assert(lines.includes("END:VCARD"), "closed");
  assert(card.content.endsWith("END:VCARD\r\n"), "ends with the closing line and CRLF");
  assert(!/[^\r]\n/.test(card.content), "every line ends CRLF, as the format requires");
  assert(lines.includes("FN:Pennie"), "the contact is named Pennie, so it stays true after a redistribution");
  assert(lines.includes("N:;Pennie;;;"), "and the structured name matches it");
  assert(lines.includes("ORG:Pennie"), "the organisation is Pennie");
  assert(lines.includes("EMAIL;TYPE=INTERNET,WORK:jordan@trypennie.com"), "the address the reminder comes from");
  const tels = lines.filter((l) => l.startsWith("TEL"));
  eq(tels.length, 1, "exactly one phone number on the card");
  eq(tels[0], "TEL;TYPE=WORK,VOICE:+12197588170", "and it is the calling number");
  assert(!card.content.includes("PHOTO"), "no photo means no PHOTO line, rather than an empty one");
}

// The advisor's photo, embedded in the card (Dan, 2026-10-01), in its real type.
for (const type of ["JPEG", "PNG"] as const) {
  // Long enough to need folding several times over, like a real 15 KB photo.
  const base64 = "QUJD".repeat(200);
  const card = advisorContactCard({
    agentEmail: "jordan@trypennie.com",
    callingNumber: "+12197588170",
    photo: { type, base64 },
  });
  const lines = card.content.split("\r\n");
  assert(
    lines.every((l) => new TextEncoder().encode(l).length <= 75),
    `${type}: no physical line exceeds 75 octets, the photo included`,
  );
  const unfolded = unfold(card.content).split("\r\n");
  const photo = unfolded.filter((l) => l.startsWith("PHOTO"));
  eq(photo, [`PHOTO;ENCODING=b;TYPE=${type}:${base64}`], `${type}: one PHOTO line, of the image's real type, unfolding to the full data`);
  assert(unfolded.includes("FN:Pennie"), `${type}: the photo does not bring the advisor's name with it`);
  eq(unfolded[unfolded.length - 2], "END:VCARD", `${type}: the card still closes after the photo`);
}

// Escaping: a comma or semicolon in a value would split the field in a reader.
{
  const card = advisorContactCard({
    agentEmail: "a,b;c@trypennie.com",
    callingNumber: "+12197588170",
    photo: null,
  });
  assert(card.content.includes("EMAIL;TYPE=INTERNET,WORK:a\\,b\\;c@trypennie.com"), "commas and semicolons are escaped");
}

// Folding: no line over 75 octets, continued with a leading space.
{
  const long = `${"a".repeat(140)}@trypennie.com`;
  const card = advisorContactCard({ agentEmail: long, callingNumber: "+12197588170", photo: null });
  const lines = card.content.split("\r\n");
  assert(lines.every((l) => new TextEncoder().encode(l).length <= 75), "no physical line exceeds 75 octets");
  assert(unfold(card.content).includes(`EMAIL;TYPE=INTERNET,WORK:${long}`), "and unfolding restores the full value");
}

finish();
