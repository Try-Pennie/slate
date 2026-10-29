import { createHmac } from "node:crypto";
import { timingSafeEqual } from "./bearer-auth.ts";

/**
 * The one signer for the short lived values a page mints and Slate's own routes verify:
 * the public test bucket's pass (#2666) and the program lead token (#4389).
 *
 * An HMAC SHA256, as hex, over a CONTEXT and the value's fields joined by dots. The
 * context is the domain separation: each use names its own versioned context, so a
 * value made for one can never verify as another even under one secret. The fields are
 * signed in the same order they are written into the value, so every one of them is
 * under the signature and a relabelled field is a forgery.
 *
 * Shared rather than copied (#4389), so a fix to how these are signed or compared
 * reaches every use at once. Formats that belong to someone else (Slack's request
 * signature, the outbound webhook header, Marcia's JWTs) keep their own code, because
 * their shape is set by the other side.
 */
export function fieldsSignature(secret: string, context: string, fields: readonly string[]): string {
  return createHmac("sha256", secret).update([context, ...fields].join(".")).digest("hex");
}

/** Whether `signature` is the one `fieldsSignature` makes, compared in constant time. */
export function fieldsSignatureMatches(
  secret: string,
  context: string,
  fields: readonly string[],
  signature: string,
): boolean {
  if (!signature) return false;
  return timingSafeEqual(signature, fieldsSignature(secret, context, fields));
}
