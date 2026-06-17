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
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];

  const parts: string[] = [];
  parts.push(
    [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 7bit",
      "",
      msg.body,
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
