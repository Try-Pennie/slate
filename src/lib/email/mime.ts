import type { IcsMethod } from "./ics.ts";

/**
 * Hand-rolled RFC 822/2045 MIME builder for the branded booking email — no
 * mail deps (Cloudflare Workers). Structure:
 *
 *   multipart/mixed
 *     multipart/alternative
 *       text/plain;    charset=UTF-8
 *       text/html;     charset=UTF-8
 *       text/calendar; charset=UTF-8; method=REQUEST|CANCEL   (inline invite)
 *     application/ics  (invite.ics attachment, base64)
 *
 * All bodies are base64-encoded so UTF-8 and long lines are always safe.
 * Boundaries are fixed strings: deterministic for tests, and collision-proof
 * because every body is base64 (whose alphabet can't produce a boundary line).
 *
 * Pure module (relative imports only) — exercised by scripts/test-mime.ts.
 */

export interface BuildMimeInput {
  from: string;
  fromName: string;
  to: string;
  toName: string;
  subject: string;
  html: string;
  text: string;
  ics: string;
  icsMethod: IcsMethod;
}

const MIXED_BOUNDARY = "----=_slate_mixed";
const ALT_BOUNDARY = "----=_slate_alt";
const CRLF = "\r\n";

/** Base64 of UTF-8 text, wrapped at 76 chars per RFC 2045. */
export function base64Wrapped(value: string): string {
  const b64 = Buffer.from(value, "utf-8").toString("base64");
  return b64.replace(/(.{76})(?=.)/g, `$1${CRLF}`);
}

/** RFC 2047 encoded-word when the value has non-ASCII; plain otherwise. */
export function encodeHeaderValue(value: string): string {
  const hasNonAscii = [...value].some((ch) => (ch.codePointAt(0) ?? 0) > 127);
  if (!hasNonAscii) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

/** `"Name" <addr>` with the display name quoted and encoded if needed. */
function mailbox(name: string, email: string): string {
  if (!name) return email;
  const encoded = encodeHeaderValue(name);
  const display =
    encoded === name ? `"${name.replace(/(["\\])/g, "\\$1")}"` : encoded;
  return `${display} <${email}>`;
}

export function buildMime(input: BuildMimeInput): string {
  const lines = [
    `From: ${mailbox(input.fromName, input.from)}`,
    `To: ${mailbox(input.toName, input.to)}`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${MIXED_BOUNDARY}"`,
    "",
    `--${MIXED_BOUNDARY}`,
    `Content-Type: multipart/alternative; boundary="${ALT_BOUNDARY}"`,
    "",
    `--${ALT_BOUNDARY}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Wrapped(input.text),
    "",
    `--${ALT_BOUNDARY}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Wrapped(input.html),
    "",
    `--${ALT_BOUNDARY}`,
    `Content-Type: text/calendar; charset=UTF-8; method=${input.icsMethod}`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Wrapped(input.ics),
    "",
    `--${ALT_BOUNDARY}--`,
    "",
    `--${MIXED_BOUNDARY}`,
    'Content-Type: application/ics; name="invite.ics"',
    'Content-Disposition: attachment; filename="invite.ics"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Wrapped(input.ics),
    "",
    `--${MIXED_BOUNDARY}--`,
    "",
  ];
  return lines.join(CRLF);
}
