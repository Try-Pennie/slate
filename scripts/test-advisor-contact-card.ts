// The advisor contact card attached to the 24 hour reminder (#1334). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-advisor-contact-card.ts
//
// Tapping it opens "Add to Contacts", and a call from a saved, named contact gets
// past call screening. What this pins:
//  - the ONLY phone on the card is the calling number, never a texting line;
//  - the name carries "Pennie", so the caller ID says who is calling;
//  - vCard escaping, CRLF line ends and line folding, so a name with a comma or a
//    long address cannot corrupt the card;
//  - the file name is plain ASCII, since it rides in a MIME header.
import { advisorContactCard } from "../src/lib/booking/advisor-contact-card.ts";
import { assert, eq, finish } from "./lib/harness.ts";

{
  const card = advisorContactCard({
    agentName: "Jordan Lee",
    agentEmail: "jordan@trypennie.com",
    callingNumber: "+12197588170",
  });
  eq(card.mimeType, "text/vcard", "a vCard media type, which phones open as a contact");
  assert(/^[A-Za-z0-9 ]+\.vcf$/.test(card.filename), `a plain file name (${card.filename})`);
  assert(card.filename.includes("Jordan Lee"), "named for the advisor, so the lead knows what it is");
  const lines = card.content.split("\r\n");
  eq(lines[0], "BEGIN:VCARD", "a vCard");
  eq(lines[1], "VERSION:3.0", "version 3.0, which iOS, Android and Gmail all read");
  assert(lines.includes("END:VCARD"), "closed");
  assert(card.content.endsWith("END:VCARD\r\n"), "ends with the closing line and CRLF");
  assert(!/[^\r]\n/.test(card.content), "every line ends CRLF, as the format requires");
  assert(lines.includes("FN:Jordan Lee (Pennie)"), "the display name carries Pennie, so caller ID says who it is");
  assert(lines.includes("N:;Jordan Lee (Pennie);;;"), "and the structured name matches it");
  assert(lines.includes("ORG:Pennie"), "the organisation is Pennie");
  assert(lines.includes("EMAIL;TYPE=INTERNET,WORK:jordan@trypennie.com"), "the advisor's address, which the reminder comes from");
  const tels = lines.filter((l) => l.startsWith("TEL"));
  eq(tels.length, 1, "exactly one phone number on the card");
  eq(tels[0], "TEL;TYPE=WORK,VOICE:+12197588170", "and it is the calling number");
}

// Escaping: a comma or semicolon in a value would split the field in a reader.
{
  const card = advisorContactCard({
    agentName: "Lee, Jordan; Jr\\",
    agentEmail: "jordan@trypennie.com",
    callingNumber: "+12197588170",
  });
  assert(card.content.includes("FN:Lee\\, Jordan\\; Jr\\\\ (Pennie)"), "commas, semicolons and backslashes are escaped");
  assert(/^[A-Za-z0-9 ]+\.vcf$/.test(card.filename), `punctuation never reaches the file name (${card.filename})`);
}

// Folding: no line over 75 octets, continued with a leading space.
{
  const long = "A".repeat(140);
  const card = advisorContactCard({ agentName: long, agentEmail: "x@trypennie.com", callingNumber: "+12197588170" });
  const lines = card.content.split("\r\n");
  assert(lines.every((l) => new TextEncoder().encode(l).length <= 75), "no physical line exceeds 75 octets");
  const unfolded = card.content.replace(/\r\n /g, "");
  assert(unfolded.includes(`FN:${long} (Pennie)`), "and unfolding restores the full value");
}

// No real name: the card is named plainly "Pennie", and an address is NEVER shown as
// a name, in the card or in its file name (a lead would save a contact called
// "jordan@trypennie.com (Pennie)" otherwise).
for (const agentName of [null, "", "   ", "jordan@trypennie.com"]) {
  const card = advisorContactCard({ agentName, agentEmail: "jordan@trypennie.com", callingNumber: "+12197588170" });
  const lines = card.content.split("\r\n");
  const label = JSON.stringify(agentName);
  assert(lines.includes("FN:Pennie"), `${label}: the contact is named Pennie`);
  assert(lines.includes("N:;Pennie;;;"), `${label}: in the structured name too`);
  eq(card.filename, "Pennie.vcf", `${label}: and the file is Pennie.vcf`);
  assert(
    lines.filter((l) => l.includes("@")).every((l) => l.startsWith("EMAIL")),
    `${label}: the address appears only as the email`,
  );
}

// A name that is nothing but punctuation still gets a usable file name.
{
  const card = advisorContactCard({ agentName: "!!!", agentEmail: "x@trypennie.com", callingNumber: "+12197588170" });
  eq(card.filename, "Pennie advisor.vcf", "falls back to a generic name rather than an empty one");
}

finish();
