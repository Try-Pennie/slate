/**
 * The origin the embedded Booker targets for its outbound postMessages (#593).
 *
 * The Booker must never post to "*": the slate:bookingSuccessful payload carries
 * lead PII, and a wildcard target lets any origin the parent later navigates to
 * receive it. widget.js passes its own origin as `parentOrigin`; the referrer is
 * a fallback (the browser's authoritative statement of who framed us, though a
 * host's Referrer-Policy can strip it). Returns null when neither yields a real
 * origin — callers MUST skip the post in that case rather than broadcast.
 */
export function embedParentOrigin(
  parentOrigin: string | null | undefined,
  referrer: string | null | undefined,
): string | null {
  for (const candidate of [parentOrigin, referrer]) {
    if (!candidate) continue;
    try {
      const { origin } = new URL(candidate);
      // file:// and other opaque contexts surface the string "null" — reject it.
      if (origin && origin !== "null") return origin;
    } catch {
      /* not an absolute URL; try the next candidate */
    }
  }
  return null;
}
