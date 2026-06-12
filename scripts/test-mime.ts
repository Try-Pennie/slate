// MIME builder tests: multipart structure, deterministic boundaries, part
// headers, base64 bodies decoding back to the inputs, and header encoding.
// Run: node --experimental-strip-types scripts/test-mime.ts
import { base64Wrapped, buildMime, encodeHeaderValue } from "../src/lib/email/mime.ts";
import { buildIcs } from "../src/lib/email/ics.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

const ics = buildIcs({
  method: "REQUEST",
  uid: "evt1@google.com",
  sequence: 0,
  organizerEmail: "agent@trypennie.com",
  organizerName: "Avery Agent",
  attendeeEmail: "lead@example.com",
  attendeeName: "Kris Lead",
  startIso: "2026-06-15T20:00:00.000Z",
  endIso: "2026-06-15T20:30:00.000Z",
  nowIso: "2026-06-10T12:00:00.000Z",
  summary: "Senior Loan Advisor Call",
});

const html = "<html><body><p>Your call is confirmed — wait, no dash. ✓</p></body></html>";
const text = "Your call is confirmed.\nPennie · trypennie.com";

const mime = buildMime({
  from: "agent@trypennie.com",
  fromName: "Avery Agent",
  to: "lead@example.com",
  toName: "Kris Lead",
  subject: "Your call with Avery is confirmed",
  html,
  text,
  ics,
  icsMethod: "REQUEST",
});

function decodeBase64Block(block: string): string {
  return Buffer.from(block.replace(/\r\n/g, ""), "base64").toString("utf-8");
}

/** Splits a multipart body into its parts by boundary. */
function partsOf(body: string, boundary: string): string[] {
  return body
    .split(`--${boundary}`)
    .slice(1)
    .filter((p) => !p.startsWith("--"))
    .map((p) => p.replace(/^\r\n/, ""));
}

// --- top-level structure ---
{
  assert(mime.startsWith('From: "Avery Agent" <agent@trypennie.com>'), "From header with display name");
  assert(mime.includes('To: "Kris Lead" <lead@example.com>'), "To header with display name");
  assert(mime.includes("Subject: Your call with Avery is confirmed"), "ASCII subject stays plain");
  assert(mime.includes("MIME-Version: 1.0"), "MIME-Version header");
  assert(
    mime.includes('Content-Type: multipart/mixed; boundary="----=_slate_mixed"'),
    "outer multipart/mixed with the deterministic boundary",
  );
  assert(!/(^|[^\r])\n/.test(mime), "every newline is CRLF");
  // Deterministic output: same input, same bytes.
  const again = buildMime({
    from: "agent@trypennie.com",
    fromName: "Avery Agent",
    to: "lead@example.com",
    toName: "Kris Lead",
    subject: "Your call with Avery is confirmed",
    html,
    text,
    ics,
    icsMethod: "REQUEST",
  });
  assert(again === mime, "deterministic: identical input produces identical MIME");
}

// --- parts ---
{
  const body = mime.slice(mime.indexOf("\r\n\r\n") + 4);
  const mixed = partsOf(body, "----=_slate_mixed");
  assert(mixed.length === 2, "mixed: two parts (alternative + ics attachment)");

  const [alternative, attachment] = mixed;
  assert(
    alternative.includes('Content-Type: multipart/alternative; boundary="----=_slate_alt"'),
    "first mixed part is multipart/alternative",
  );

  const alt = partsOf(alternative.slice(alternative.indexOf("\r\n\r\n") + 4), "----=_slate_alt");
  assert(alt.length === 3, "alternative: three parts (plain, html, calendar)");

  const [plainPart, htmlPart, calPart] = alt;
  assert(plainPart.includes("Content-Type: text/plain; charset=UTF-8"), "plain part header");
  assert(
    decodeBase64Block(plainPart.split("\r\n\r\n")[1]) === text,
    "plain part base64 decodes to the text body",
  );
  assert(htmlPart.includes("Content-Type: text/html; charset=UTF-8"), "html part header");
  assert(
    decodeBase64Block(htmlPart.split("\r\n\r\n")[1]) === html,
    "html part base64 decodes to the html body (UTF-8 intact)",
  );
  assert(
    calPart.includes("Content-Type: text/calendar; charset=UTF-8; method=REQUEST"),
    "calendar part declares method=REQUEST",
  );
  assert(
    decodeBase64Block(calPart.split("\r\n\r\n")[1]) === ics,
    "calendar part base64 decodes to the ICS",
  );

  assert(
    attachment.includes('Content-Type: application/ics; name="invite.ics"') &&
      attachment.includes('Content-Disposition: attachment; filename="invite.ics"'),
    "attachment: application/ics named invite.ics",
  );
  assert(
    decodeBase64Block(attachment.split("\r\n\r\n")[1]) === ics,
    "attachment base64 decodes to the ICS",
  );
  assert(mime.trimEnd().endsWith("------=_slate_mixed--"), "closing mixed boundary present");
}

// --- CANCEL method flows through ---
{
  const cancelMime = buildMime({
    from: "agent@trypennie.com",
    fromName: "Avery Agent",
    to: "lead@example.com",
    toName: "Kris Lead",
    subject: "Your call has been cancelled",
    html,
    text,
    ics,
    icsMethod: "CANCEL",
  });
  assert(
    cancelMime.includes("Content-Type: text/calendar; charset=UTF-8; method=CANCEL"),
    "calendar part declares method=CANCEL for cancellations",
  );
}

// --- header encoding ---
{
  assert(encodeHeaderValue("plain ascii") === "plain ascii", "ascii header value untouched");
  const encoded = encodeHeaderValue("Renée Müller");
  assert(
    /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/.test(encoded) &&
      Buffer.from(encoded.slice(10, -2), "base64").toString("utf-8") === "Renée Müller",
    "non-ascii header value becomes an RFC 2047 encoded-word",
  );
  const m = buildMime({
    from: "agent@trypennie.com",
    fromName: "Renée Müller",
    to: "lead@example.com",
    toName: "Kris",
    subject: "Çağrınız onaylandı",
    html,
    text,
    ics,
    icsMethod: "REQUEST",
  });
  assert(m.includes("Subject: =?UTF-8?B?"), "non-ascii subject is encoded-word, not corrupted");
  assert(m.includes("=?UTF-8?B?") && m.includes("<agent@trypennie.com>"), "non-ascii From name encoded");
}

// --- base64 wrapping ---
{
  const wrapped = base64Wrapped("x".repeat(500));
  assert(
    wrapped.split("\r\n").every((l) => l.length <= 76),
    "base64 bodies wrap at 76 chars",
  );
  assert(
    Buffer.from(wrapped.replace(/\r\n/g, ""), "base64").toString("utf-8") === "x".repeat(500),
    "wrapped base64 round-trips",
  );
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
