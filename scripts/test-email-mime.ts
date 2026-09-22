// Tests for the pure MIME assembly used by the Gmail sender.
// Run: node --experimental-strip-types scripts/test-email-mime.ts
import { buildMimeMessage, base64Mime, quotedPrintable } from "../src/lib/notify/email-mime.ts";
import { assert, finish } from "./lib/harness.ts";

assert(base64Mime("hi") === "aGk=", "base64Mime encodes ascii");

const mime = buildMimeMessage(
  {
    from: "ooo@trypennie.com",
    to: ["a@x.com", "b@y.com"],
    bcc: ["boss@x.com"],
    replyTo: "systems@x.com",
    subject: "OOO approvals for June 7th, 2026",
    body: "1 request approved.",
    attachments: [{ filename: "260607 OOO Approvals.csv", content: "h1,h2\nv1,v2", mimeType: "text/csv" }],
  },
  "BND",
);

assert(mime.includes("From: ooo@trypennie.com"), "carries the From header");
assert(mime.includes("To: a@x.com, b@y.com"), "joins multiple recipients");
assert(mime.includes("Bcc: boss@x.com"), "carries the Bcc header");
assert(mime.includes("Reply-To: systems@x.com"), "carries the Reply-To header");
assert(mime.includes('Content-Type: multipart/mixed; boundary="BND"'), "declares the multipart boundary");
assert(mime.includes("Subject: =?UTF-8?B?"), "subject is RFC 2047 encoded");
assert(mime.includes('filename="260607 OOO Approvals.csv"'), "attachment keeps its filename");
assert(mime.includes(base64Mime("h1,h2\nv1,v2")), "attachment body is base64-encoded");
assert(mime.trimEnd().endsWith("--BND--"), "closes the multipart envelope");

// ---- #2625: the text part survives transit with its paragraphs intact --------
// A 7bit body keeps every paragraph as one long line, and a mail hop is free to
// hard wrap a line over 76 characters, which is how a reminder arrived broken mid
// sentence. Quoted-printable keeps every line on the wire short with SOFT breaks
// that every client removes again, so the reader gets the paragraphs as written.

// An independent decoder, written from RFC 2045 rather than from the encoder, so
// the round trip cannot agree with itself by construction (L70).
function decodeQuotedPrintable(wire: string): string {
  const joined = wire.replace(/=\r\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i];
    if (ch === "=" && /^[0-9A-F]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(ch.charCodeAt(0));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes)).replace(/\r\n/g, "\n");
}

function textPart(raw: string, boundary: string): { headers: string; wire: string } {
  const part = raw.split(`--${boundary}`)[1];
  const [headers, ...rest] = part.replace(/^\r\n/, "").split("\r\n\r\n");
  return { headers, wire: rest.join("\r\n\r\n").replace(/\r\n$/, "") };
}

{
  const body = [
    "Hi, this is a reminder that your call with Tony Rios at Pennie is today at 6:50pm EDT.",
    "",
    "We will call you on the number you gave us, so there is nothing you need to set up.",
    "",
    "If that time no longer works, you can pick another or cancel here: https://slate.trypennie.app/booking/manage/qQpqo7Iv5vFULHW2hK6XFqvD",
    "",
    "Tony Rios",
    "Pennie",
  ].join("\n");
  const raw = buildMimeMessage({ from: "a@x.com", to: ["b@y.com"], subject: "s", body }, "B2");
  const { headers, wire } = textPart(raw, "B2");

  assert(/Content-Transfer-Encoding: quoted-printable/.test(headers), "#2625: the text part is quoted-printable, not 7bit");
  const longest = Math.max(...wire.split("\r\n").map((l) => l.length));
  assert(longest <= 76, `#2625: no line on the wire is over 76 characters (longest ${longest})`);
  assert(decodeQuotedPrintable(wire) === body, "#2625: the reader gets every paragraph back exactly as written");
}

{
  // The characters a sentence routinely carries that quoted-printable must escape
  // or protect: an equals sign, non ASCII, and a line ending in a space.
  const body = "Rate = 5% for José’s plan \nnext line\n… done";
  const wire = quotedPrintable(body);
  assert(decodeQuotedPrintable(wire) === body, "#2625: equals, non ASCII and trailing space round trip");
  assert(!/ \r\n/.test(wire) && !/ $/.test(wire), "#2625: no line on the wire ends in bare whitespace, which a hop may strip");
  assert(Math.max(...wire.split("\r\n").map((l) => l.length)) <= 76, "#2625: escapes never push a line past 76");
}

{
  // A soft break must never split an escape: "=E2=80" cut after "=E" decodes to junk.
  const body = "x".repeat(73) + "’".repeat(10);
  const wire = quotedPrintable(body);
  assert(decodeQuotedPrintable(wire) === body, "#2625: a soft break never lands inside an escape");
}

finish();
