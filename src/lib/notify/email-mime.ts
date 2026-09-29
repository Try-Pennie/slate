/**
 * Pure RFC 2822 MIME assembly for the Gmail send API (no IO), so the message
 * shape is unit-testable. `src/lib/notify/email.ts` base64url-encodes the
 * result and POSTs it; the digest route builds the body + CSV attachment.
 */

export interface MailAttachment {
  filename: string;
  /** Raw (un-encoded) file contents. */
  content: string;
  mimeType: string;
}

export interface MimeMessage {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  /** Plain-text body. */
  body: string;
  attachments?: MailAttachment[];
}

/** Standard base64 (NOT url-safe), 76-char wrapped, for MIME attachment bodies. */
export function base64Mime(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return (btoa(bin).match(/.{1,76}/g) ?? []).join("\r\n");
}

/** The longest line quoted-printable may put on the wire (RFC 2045 6.7). */
const QP_LINE = 76;

/**
 * Quoted-printable, for the text and html parts (#2625, #2895).
 *
 * The body used to go out as `7bit`, one long line per paragraph, and a mail hop
 * is free to hard wrap a line past 76 characters. Quoted-printable keeps every
 * line Slate PUTS ON THE WIRE at 76 or under with SOFT breaks (`=` at the end of
 * a line), which a decoder removes again. Real line breaks stay real (CRLF).
 *
 * That is a claim about what Slate sends, not about what arrives. On 2026-09-29 a
 * reminder sent through the Gmail API arrived re-encoded: one top level
 * `text/plain` with no transfer encoding, hard wrapped near 72 characters on word
 * boundaries, so the reader still saw sentences broken mid line (#2895). The fix
 * for how a reader sees the paragraphs is the html alternative below, which
 * clients render as flowing text; the text part stays as the fallback and may
 * still arrive wrapped. Judge delivery by a real send's raw source (L726).
 *
 * Escaped: every non ASCII byte (UTF-8, so a curly quote survives), `=` itself,
 * and a space or tab at the end of a line, which a hop may otherwise strip. A soft
 * break never lands inside an escape, which would decode to junk.
 */
export function quotedPrintable(input: string): string {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  return lines.map(encodeQpLine).join("\r\n");
}

function encodeQpLine(line: string): string {
  const bytes = new TextEncoder().encode(line);
  const tokens: string[] = [];
  bytes.forEach((b, i) => {
    const last = i === bytes.length - 1;
    const printable = b >= 33 && b <= 126 && b !== 61;
    const space = b === 32 || b === 9;
    if (printable || (space && !last)) tokens.push(String.fromCharCode(b));
    else tokens.push(`=${b.toString(16).toUpperCase().padStart(2, "0")}`);
  });
  const out: string[] = [];
  let current = "";
  for (const token of tokens) {
    // Leave room for the "=" that marks a soft break.
    if (current.length + token.length > QP_LINE - 1) {
      out.push(`${current}=`);
      current = "";
    }
    current += token;
  }
  out.push(current);
  return out.join("\r\n");
}

/** Escape every character HTML gives a meaning to, quotes included (attribute safe). */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * An http or https URL, stopping at whitespace, angle brackets and quotes, so a
 * quote can never close the href it lands in.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
/** Sentence punctuation that ends a sentence rather than the URL before it. */
const URL_TRAILING = /[.,;:!?)\]]+$/;

function linkifyLine(line: string): string {
  let out = "";
  let last = 0;
  for (const match of line.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const url = match[0].replace(URL_TRAILING, "");
    out += escapeHtml(line.slice(last, start));
    const safe = escapeHtml(url);
    out += `<a href="${safe}">${safe}</a>`;
    last = start + url.length;
  }
  return out + escapeHtml(line.slice(last));
}

/**
 * The html alternative, DERIVED from the plain text body (#2895) so the words live
 * in one place (L41). Mail clients show text/plain in a fixed width column, and
 * some viewers (Regal's conversation view) drop its blank lines, so a reader saw
 * sentences broken mid line or paragraphs run together. Html flows.
 *
 * One `<p>` per blank line separated paragraph, a single line break inside one is
 * a `<br>`, an http or https URL is a link to itself, and every other character is
 * escaped, so a value carried in the copy (an advisor's name, a URL) can never
 * become markup. Deliberately nothing else: no styling, images, fonts or tracking.
 */
export function plainTextToHtml(text: string): string {
  // A blank or whitespace only line ends a paragraph; a run of them is one break.
  const paragraphs: string[][] = [];
  let current: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (line.trim() === "") {
      if (current.length > 0) paragraphs.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) paragraphs.push(current);
  const body = paragraphs.map((lines) => `<p>${lines.map(linkifyLine).join("<br>\n")}</p>`);
  return [
    "<!DOCTYPE html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8">',
    "</head>",
    "<body>",
    ...body,
    "</body>",
    "</html>",
  ].join("\n");
}

/** A part's header lines, a blank line, then its body. */
function part(headers: string[], body: string): string {
  return [...headers, "", body].join("\r\n");
}

/**
 * The text and html alternatives, text FIRST: RFC 2046 orders alternatives from
 * plainest to richest, and a client shows the last one it can render.
 */
function alternativeBody(body: string, boundary: string): string {
  return [
    `--${boundary}`,
    part(['Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: quoted-printable"], quotedPrintable(body)),
    `--${boundary}`,
    part(['Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: quoted-printable"], quotedPrintable(plainTextToHtml(body))),
    `--${boundary}--`,
  ].join("\r\n");
}

/**
 * Build the message. `boundary` is a parameter so tests are deterministic; the
 * caller passes a unique one in prod. Encodes the Subject as RFC 2047 base64 so
 * non-ASCII (e.g. a smart date) is safe.
 *
 * Structure (#2895):
 *   no attachments:   multipart/alternative (text/plain, text/html)
 *   with attachments: multipart/mixed (multipart/alternative (text, html), attachment...)
 *
 * The nested alternative's boundary is `alt_<boundary>`, which the outer delimiter
 * is not a prefix of, so a parser can never read an inner delimiter as an outer one.
 */
export function buildMimeMessage(msg: MimeMessage, boundary: string): string {
  const encodedSubject = `=?UTF-8?B?${btoa(
    String.fromCharCode(...new TextEncoder().encode(msg.subject)),
  )}?=`;
  const headers = [
    `From: ${msg.from}`,
    `To: ${msg.to.join(", ")}`,
    ...(msg.cc?.length ? [`Cc: ${msg.cc.join(", ")}`] : []),
    ...(msg.bcc?.length ? [`Bcc: ${msg.bcc.join(", ")}`] : []),
    ...(msg.replyTo ? [`Reply-To: ${msg.replyTo}`] : []),
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
  ];
  const attachments = msg.attachments ?? [];

  if (attachments.length === 0) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    return `${headers.join("\r\n")}\r\n\r\n${alternativeBody(msg.body, boundary)}`;
  }

  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const altBoundary = `alt_${boundary}`;
  const parts: string[] = [];
  parts.push(
    [
      `--${boundary}`,
      part([`Content-Type: multipart/alternative; boundary="${altBoundary}"`], alternativeBody(msg.body, altBoundary)),
    ].join("\r\n"),
  );
  for (const att of attachments) {
    parts.push(
      [
        `--${boundary}`,
        `Content-Type: ${att.mimeType}; name="${att.filename}"`,
        `Content-Disposition: attachment; filename="${att.filename}"`,
        "Content-Transfer-Encoding: base64",
        "",
        base64Mime(att.content),
      ].join("\r\n"),
    );
  }
  parts.push(`--${boundary}--`);

  return `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`;
}
