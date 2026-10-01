// Tests for the pure MIME assembly used by the Gmail sender.
// Run: node --experimental-strip-types scripts/test-email-mime.ts
import { buildMimeMessage, base64Mime, quotedPrintable, plainTextToHtml } from "../src/lib/notify/email-mime.ts";
import { assert, eq, finish } from "./lib/harness.ts";

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

// ---- #2895: an HTML alternative, derived from the same plain text ----------------
// Mail clients show text/plain in a fixed width column, so a reminder read with its
// sentences broken mid line, and Regal's conversation view dropped the blank lines
// altogether. The fix sends multipart/alternative: the unchanged text part FIRST
// (the fallback) and an HTML part SECOND (what clients prefer to render), and the
// HTML is DERIVED from the text so the words live in one place (L41).
//
// What this can prove is the structure Slate SENDS. What arrives is decided by the
// Gmail API, which on 2026-09-29 was measured rewriting a single part message into
// a hard wrapped text/plain one, so delivery is confirmed by a real send, not here.

/** Split a message or part into its header block and its body. */
function splitHead(raw: string): { headers: string; body: string } {
  const at = raw.indexOf("\r\n\r\n");
  return { headers: raw.slice(0, at), body: raw.slice(at + 4) };
}

/** An independent multipart reader: every part between exact delimiter lines. */
function parts(body: string, boundary: string): { headers: string; body: string }[] {
  const out: string[][] = [];
  let current: string[] | null = null;
  let closed = false;
  for (const line of body.split("\r\n")) {
    if (line === `--${boundary}--`) {
      if (current) out.push(current);
      current = null;
      closed = true;
      break;
    }
    if (line === `--${boundary}`) {
      if (current) out.push(current);
      current = [];
      continue;
    }
    if (current) current.push(line);
  }
  assert(closed, `the ${boundary} envelope is closed with its final delimiter`);
  return out.map((l) => splitHead(l.join("\r\n")));
}

function boundaryOf(headers: string, type: string): string {
  const m = headers.match(new RegExp(`Content-Type: ${type}; boundary="([^"]+)"`));
  assert(m !== null, `declares Content-Type ${type} with a boundary`);
  return m ? m[1] : "";
}

const REMINDER_BODY = [
  "Hi, this is a reminder that your call with David Haggerty at Pennie is today at 5:10pm EDT.",
  "",
  "We will call you on the number you gave us, so there is nothing you need to set up.",
  "",
  "If that time no longer works, you can pick another or cancel here: https://slate.trypennie.app/booking/manage/RShnO4RXlgClwSS4B2WEAUQ2",
  "",
  "If it is easier, just reply to this email and it will reach me directly.",
  "",
  "David Haggerty",
  "Pennie",
].join("\n");

/** The text part exactly as Slate sent it before #2895, rebuilt from its pieces. */
const TEXT_PART_BEFORE =
  'Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n' +
  quotedPrintable(REMINDER_BODY);

const REMINDER_HTML_BODY = [
  "<p>Hi, this is a reminder that your call with David Haggerty at Pennie is today at 5:10pm EDT.</p>",
  "<p>We will call you on the number you gave us, so there is nothing you need to set up.</p>",
  '<p>If that time no longer works, you can pick another or cancel here: <a href="https://slate.trypennie.app/booking/manage/RShnO4RXlgClwSS4B2WEAUQ2">https://slate.trypennie.app/booking/manage/RShnO4RXlgClwSS4B2WEAUQ2</a></p>',
  "<p>If it is easier, just reply to this email and it will reach me directly.</p>",
  "<p>David Haggerty<br>\nPennie</p>",
].join("\n");

function checkAlternative(alt: { headers: string; body: string }[], label: string): void {
  assert(alt.length === 2, `${label}: the alternative holds exactly two parts (got ${alt.length})`);
  const [text, html] = alt;
  if (!text || !html) return;
  assert(/^Content-Type: text\/plain; charset="UTF-8"$/m.test(text.headers), `${label}: the FIRST alternative is text/plain UTF-8, the fallback`);
  assert(`${text.headers}\r\n\r\n${text.body}` === TEXT_PART_BEFORE, `${label}: the text part is byte identical to what was sent before`);
  assert(decodeQuotedPrintable(text.body) === REMINDER_BODY, `${label}: the decoded text is the body exactly`);
  assert(/^Content-Type: text\/html; charset="UTF-8"$/m.test(html.headers), `${label}: the SECOND alternative is text/html UTF-8, the one clients prefer`);
  assert(/^Content-Transfer-Encoding: quoted-printable$/m.test(html.headers), `${label}: the html part is quoted-printable`);
  const longest = Math.max(...html.body.split("\r\n").map((l) => l.length));
  assert(longest <= 76, `${label}: no html line on the wire is over 76 characters (longest ${longest})`);
  const decoded = decodeQuotedPrintable(html.body);
  assert(decoded === plainTextToHtml(REMINDER_BODY), `${label}: the html part decodes to the html derived from the body`);
  assert(decoded.includes(REMINDER_HTML_BODY), `${label}: the html carries one <p> per paragraph and the manage link`);
}

{
  // No attachment (the reminder): multipart/alternative at the top.
  const raw = buildMimeMessage({ from: "a@x.com", to: ["b@y.com"], subject: "s", body: REMINDER_BODY }, "RB");
  const { headers, body } = splitHead(raw);
  assert(/^MIME-Version: 1\.0$/m.test(headers), "#2895: still MIME 1.0");
  assert(!/multipart\/mixed/.test(headers), "#2895: without attachments there is no mixed wrapper");
  checkAlternative(parts(body, boundaryOf(headers, "multipart/alternative")), "#2895 no attachment");
}

{
  // With an attachment (the OOO approvals digest): mixed, holding the alternative
  // first and the attachment after it.
  const csv = "h1,h2\nv1,v2";
  const raw = buildMimeMessage(
    {
      from: "a@x.com",
      to: ["b@y.com"],
      subject: "s",
      body: REMINDER_BODY,
      attachments: [{ filename: "a.csv", content: csv, mimeType: "text/csv" }],
    },
    "MB",
  );
  const { headers, body } = splitHead(raw);
  const outer = boundaryOf(headers, "multipart/mixed");
  const top = parts(body, outer);
  assert(top.length === 2, `#2895 attachment: mixed holds the alternative plus one attachment (got ${top.length})`);
  const inner = boundaryOf(top[0]?.headers ?? "", "multipart/alternative");
  assert(inner !== "" && !inner.startsWith(outer) && !outer.startsWith(inner), "#2895 attachment: neither boundary is a prefix of the other, so no delimiter can be misread");
  checkAlternative(parts(top[0]?.body ?? "", inner), "#2895 attachment");
  assert(/Content-Disposition: attachment; filename="a.csv"/.test(top[1]?.headers ?? ""), "#2895 attachment: the attachment follows the alternative");
  assert((top[1]?.body ?? "").trim() === base64Mime(csv), "#2895 attachment: the attachment body is unchanged");
}

// ---- plainTextToHtml: paragraphs, line breaks, links, and escaping ---------------
{
  const html = plainTextToHtml("One line\nsecond line\n\nNext paragraph");
  assert(html.includes("<p>One line<br>\nsecond line</p>"), "#2895: a single line break inside a paragraph becomes <br>");
  assert(html.includes("<p>Next paragraph</p>"), "#2895: a blank line starts a new <p>");
  assert((html.match(/<p>/g) ?? []).length === 2, "#2895: one <p> per paragraph");
  assert(/<meta charset="utf-8">/i.test(html), "#2895: the document declares UTF-8");
  assert(!/<img|<style|style=|<link|<script|<font/i.test(html), "#2895: no images, styling, fonts or scripts");
}
{
  const html = plainTextToHtml("a\n\n\n\n  \nb");
  assert((html.match(/<p>/g) ?? []).length === 2, "#2895: a run of blank or whitespace lines is one paragraph break, never an empty <p>");
}
{
  const url = "https://slate.trypennie.app/booking/manage/RShnO4RXlgClwSS4B2WEAUQ2";
  const html = plainTextToHtml(`cancel here: ${url}`);
  assert(html.includes(`cancel here: <a href="${url}">${url}</a>`), "#2895: a URL becomes a link to itself");
  const trailing = plainTextToHtml(`See ${url}.`);
  assert(trailing.includes(`<a href="${url}">${url}</a>.`), "#2895: sentence punctuation after a URL stays outside the link");
}
{
  // A value from outside (an advisor name, a URL) must never become markup.
  const html = plainTextToHtml(`Hi <script>alert("x")</script> & 'Tom' > "Jo"`);
  assert(!html.includes("<script>"), "#2895: a tag in the text is escaped, not rendered");
  assert(
    html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Tom&#39; &gt; &quot;Jo&quot;"),
    "#2895: < > & and both quotes are escaped",
  );
  const link = plainTextToHtml(`https://x.com/a?b=1&c=2"onmouseover="bad`);
  assert(!link.includes('"onmouseover="'), "#2895: a quote cannot close the href and add an attribute");
  assert(link.includes('href="https://x.com/a?b=1&amp;c=2'), "#2895: an ampersand inside a link is escaped in the href");
  const js = plainTextToHtml("javascript:alert(1)");
  assert(!js.includes("<a"), "#2895: only http and https become links");
  const angle = plainTextToHtml("https://x.com/<b>x</b>");
  assert(!angle.includes("<b>") && angle.includes('<a href="https://x.com/">'), "#2895: markup after a URL is escaped and outside the link");
  const name = plainTextToHtml("Your call with <img src=x onerror=alert(1)> at Pennie");
  assert(!name.includes("<img") && name.includes("&lt;img src=x onerror=alert(1)&gt;"), "#2895: an advisor name carrying markup is escaped");
}
{
  // Non ASCII survives the html part too.
  const body = "José’s call… done";
  const raw = buildMimeMessage({ from: "a@x.com", to: ["b@y.com"], subject: "s", body }, "U");
  const alt = parts(splitHead(raw).body, "U");
  assert(decodeQuotedPrintable(alt[1]?.body ?? "").includes("José’s call… done"), "#2895: non ASCII survives the html part");
}

// ---- #2985: the sender's display name ------------------------------------------
// The reminder arrived showing the bare address as its sender. The From header now
// carries a display name, encoded per RFC 5322 (quoted when it holds a special) and
// RFC 2047 (encoded words for non ASCII), and a name can never add a header.

/** The headers of a message, unfolded (RFC 5322 2.2.3), one entry per header. */
function headerLines(raw: string): string[] {
  return splitHead(raw).headers.replace(/\r\n[ \t]/g, " ").split("\r\n");
}
function fromHeader(fromName: string | undefined): { raw: string; from: string; lines: string[] } {
  const raw = buildMimeMessage(
    { from: "aromagnoli@trypennie.com", ...(fromName === undefined ? {} : { fromName }), to: ["lead@x.com"], subject: "s", body: "b" },
    "F",
  );
  const lines = headerLines(raw);
  return { raw, from: lines.find((l) => l.startsWith("From: ")) ?? "", lines };
}

/**
 * An independent RFC 2047 decoder for the display name, written from the RFC rather
 * than from the encoder (L70): every encoded word, B or Q, in UTF-8, with the
 * whitespace BETWEEN two adjacent encoded words dropped as 6.2 requires.
 */
function decodeEncodedWords(text: string): string {
  const joined = text.replace(/(\?=)\s+(=\?)/g, "$1$2");
  return joined.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset: string, enc: string, data: string) => {
    assert(charset.toUpperCase() === "UTF-8", "#2985: encoded words declare UTF-8");
    const bytes =
      enc.toUpperCase() === "B"
        ? Buffer.from(data, "base64")
        : Buffer.from(data.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
    return new TextDecoder().decode(bytes);
  });
}

{
  const { from } = fromHeader("Alex Romagnoli");
  eq(from, "From: Alex Romagnoli <aromagnoli@trypennie.com>", "#2985: a plain name reads Name <address>");
}
{
  const { from } = fromHeader("Romagnoli, Alex");
  eq(from, 'From: "Romagnoli, Alex" <aromagnoli@trypennie.com>', "#2985: a name with a comma is quoted, so it is not read as two addresses");
}
{
  const { from } = fromHeader('Alex "AJ" Romagnoli');
  eq(from, 'From: "Alex \\"AJ\\" Romagnoli" <aromagnoli@trypennie.com>', "#2985: a quote inside the name is escaped inside a quoted string");
  const back = fromHeader("C:\\path");
  eq(back.from, 'From: "C:\\\\path" <aromagnoli@trypennie.com>', "#2985: a backslash is escaped too");
  // A name that LOOKS like an encoded word goes inside quotes, where a client must
  // not decode it, so it cannot pose as a different name.
  eq(fromHeader("=?UTF-8?B?QQ==?=").from, 'From: "=?UTF-8?B?QQ==?=" <aromagnoli@trypennie.com>', "#2985: a name shaped like an encoded word is quoted");
}
{
  const name = "José Núñez";
  const { from } = fromHeader(name);
  assert(/^From: (=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= ?)+ <aromagnoli@trypennie\.com>$/.test(from), `#2985: a non ASCII name is RFC 2047 encoded (${from})`);
  eq(decodeEncodedWords(from.slice("From: ".length, from.lastIndexOf(" <"))), name, "#2985: and decodes back to the name");
  // A long non ASCII name: every encoded word stays inside RFC 2047's 75 characters.
  const long = "Ánđrëå Ŝøłøméñţšïñöþøúłøš Ŧëřñåñđëž ðë łå Çřůž Ÿ Ɓøñäπäřţë";
  const big = fromHeader(long);
  const words = big.from.match(/=\?[^?]+\?[BQ]\?[^?]*\?=/g) ?? [];
  assert(words.length > 1, "#2985: a long non ASCII name is split into several encoded words");
  assert(words.every((w) => w.length <= 75), "#2985: no encoded word exceeds 75 characters");
  eq(decodeEncodedWords(big.from.slice("From: ".length, big.from.lastIndexOf(" <"))), long, "#2985: and the split name decodes back whole");
}
{
  const { raw, from, lines } = fromHeader("Evil\r\nBcc: victim@x.com\nX-Injected: 1\r");
  assert(!lines.some((l) => /^bcc:/i.test(l) || /^x-injected:/i.test(l)), "#2985: CR and LF in a name can never add a header");
  assert(!/\r(?!\n)|(?<!\r)\n/.test(splitHead(raw).headers), "#2985: no bare CR or LF in the headers");
  assert(from.endsWith(" <aromagnoli@trypennie.com>") && from.includes("Evil"), "#2985: the name survives as one line on the From header");
}
{
  const none = fromHeader(undefined);
  eq(none.from, "From: aromagnoli@trypennie.com", "#2985: no name keeps the bare address");
  eq(fromHeader("   ").from, "From: aromagnoli@trypennie.com", "#2985: a blank name keeps the bare address");
  eq(fromHeader("\r\n").from, "From: aromagnoli@trypennie.com", "#2985: a name of only line breaks keeps the bare address");
}

finish();
