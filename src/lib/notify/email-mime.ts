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
 * Quoted-printable, for the TEXT part (#2625).
 *
 * The body used to go out as `7bit`, one long line per paragraph, and a mail hop
 * is free to hard wrap a line past 76 characters: a reminder arrived broken mid
 * sentence ("...at Pennie is" / "today at 6:50pm EDT."). Quoted-printable keeps
 * every line on the wire at 76 or under with SOFT breaks (`=` at the end of a
 * line), which every client removes again, so the reader sees the paragraphs
 * exactly as they were written. Real line breaks stay real (CRLF).
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

/**
 * Build a multipart/mixed message (text body + attachments). `boundary` is a
 * parameter so tests are deterministic; the caller passes a unique one in prod.
 * Encodes the Subject as RFC 2047 base64 so non-ASCII (e.g. a smart date) is safe.
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
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];

  const parts: string[] = [];
  parts.push(
    [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: quoted-printable",
      "",
      quotedPrintable(msg.body),
    ].join("\r\n"),
  );
  for (const att of msg.attachments ?? []) {
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
