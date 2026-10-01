// The contact card attached to the 24 hour reminder (#1334). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-advisor-contact-card.ts
//
// Tapping it opens "Add to Contacts", and a call from a saved, named contact gets
// past call screening. What this pins:
//  - the ONLY phone on the card is the calling number, never a texting line;
//  - the card is named after the advisor, "<name> (Pennie)", with ORG Pennie, and
//    plain "Pennie" when there is no real name (Dan reversed the Pennie only call
//    after showing the team, 2026-10-01);
//  - the advisor's photo, when there is one, is embedded as a folded base64 PHOTO
//    line of its real type, and its absence leaves no PHOTO line at all;
//  - vCard escaping, CRLF line ends and line folding;
//  - the file name is the advisor's name in plain ASCII, since it rides in a quoted
//    MIME header, and Pennie.vcf when nothing of the name survives that.
import { advisorContactCard } from "../src/lib/booking/advisor-contact-card.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const unfold = (content: string) => content.replace(/\r\n /g, "");

{
  const card = advisorContactCard({
    agentEmail: "jordan@trypennie.com",
    agentName: "Jordan Lee",
    callingNumber: "+12197588170",
    photo: null,
  });
  eq(card.mimeType, "text/vcard", "a vCard media type, which phones open as a contact");
  eq(card.filename, "Jordan Lee Pennie.vcf", "the file is named after the advisor");
  const lines = card.content.split("\r\n");
  eq(lines[0], "BEGIN:VCARD", "a vCard");
  eq(lines[1], "VERSION:3.0", "version 3.0, which iOS, Android and Gmail all read");
  assert(lines.includes("END:VCARD"), "closed");
  assert(card.content.endsWith("END:VCARD\r\n"), "ends with the closing line and CRLF");
  assert(!/[^\r]\n/.test(card.content), "every line ends CRLF, as the format requires");
  assert(lines.includes("FN:Jordan Lee (Pennie)"), "the contact is named after the advisor, with Pennie beside it");
  assert(lines.includes("N:;Jordan Lee (Pennie);;;"), "and the structured name matches it");
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
    agentName: null,
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
  assert(unfolded.includes("FN:Pennie"), `${type}: with no name the card is Pennie's, photo or not`);
  eq(unfolded[unfolded.length - 2], "END:VCARD", `${type}: the card still closes after the photo`);
}

// Escaping: a comma or semicolon in a value would split the field in a reader.
{
  const card = advisorContactCard({
    agentEmail: "a,b;c@trypennie.com",
    agentName: null,
    callingNumber: "+12197588170",
    photo: null,
  });
  assert(card.content.includes("EMAIL;TYPE=INTERNET,WORK:a\\,b\\;c@trypennie.com"), "commas and semicolons are escaped");
}

// Folding: no line over 75 octets, continued with a leading space.
{
  const long = `${"a".repeat(140)}@trypennie.com`;
  const card = advisorContactCard({ agentEmail: long, agentName: null, callingNumber: "+12197588170", photo: null });
  const lines = card.content.split("\r\n");
  assert(lines.every((l) => new TextEncoder().encode(l).length <= 75), "no physical line exceeds 75 octets");
  assert(unfold(card.content).includes(`EMAIL;TYPE=INTERNET,WORK:${long}`), "and unfolding restores the full value");
}

// No real name: the card stays Pennie's, and an address is never used as a name.
for (const agentName of [null, "", "   ", "jordan@trypennie.com"]) {
  const card = advisorContactCard({ agentEmail: "jordan@trypennie.com", agentName, callingNumber: "+12197588170", photo: null });
  const lines = card.content.split("\r\n");
  const label = JSON.stringify(agentName);
  assert(lines.includes("FN:Pennie") && lines.includes("N:;Pennie;;;"), `${label}: named Pennie`);
  assert(lines.includes("ORG:Pennie"), `${label}: ORG Pennie`);
  eq(card.filename, "Pennie.vcf", `${label}: Pennie.vcf`);
}

// A name carrying vCard specials is escaped on the card.
{
  const card = advisorContactCard({ agentEmail: "x@trypennie.com", agentName: "Lee, Jordan; Jr", callingNumber: "+12197588170", photo: null });
  assert(card.content.split("\r\n").includes("FN:Lee\\, Jordan\\; Jr (Pennie)"), "commas and semicolons in the name are escaped");
}

// The file name is safe ASCII: accents folded, anything a header or a file system
// would choke on dropped, and Pennie.vcf when nothing of the name survives.
{
  const file = (agentName: string) =>
    advisorContactCard({ agentEmail: "x@trypennie.com", agentName, callingNumber: "+12197588170", photo: null }).filename;
  eq(file("Alex Romagnoli"), "Alex Romagnoli Pennie.vcf", "a plain name");
  eq(file("José Núñez"), "Jose Nunez Pennie.vcf", "accents are folded to ASCII");
  eq(file('Jo "JJ" O\'Neil/Smith\\x'), "Jo JJ ONeilSmithx Pennie.vcf", "quotes, slashes and backslashes are dropped");
  eq(file("Mary-Jane  Watson"), "Mary-Jane Watson Pennie.vcf", "a hyphen inside a name is kept and spaces collapse");
  eq(file("李雷"), "Pennie.vcf", "a name with nothing ASCII left falls back to Pennie.vcf");
  const card = advisorContactCard({ agentEmail: "x@trypennie.com", agentName: "José Núñez", callingNumber: "+12197588170", photo: null });
  assert(card.content.split("\r\n").includes("FN:José Núñez (Pennie)"), "while the card itself keeps the name as written");
}

finish();
