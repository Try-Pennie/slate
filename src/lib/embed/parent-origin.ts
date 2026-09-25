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

/** A web origin (http or https, no path), or null for anything else. */
export function httpOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export interface OriginMismatch {
  /** The origin the host passed as `parentOrigin`, where the Booker posts. */
  declared: string;
  /** The origin the browser says actually framed the Booker. */
  framedBy: string;
}

/**
 * Whether the host declared a different origin from the one that framed us (#2641).
 *
 * The Booker posts to the DECLARED origin, and the browser silently drops a post
 * whose target is not the real parent: the iframe keeps its fallback height and
 * the host never hears about the booking, with nothing logged on either side. So
 * the pair is reported. ORIGINS only, never the referrer's path or query, which on
 * a booking page can carry a lead's details. Null when either side cannot be
 * read, because nothing can be told from one value.
 */
export function parentOriginMismatch(
  parentOrigin: string | null | undefined,
  referrer: string | null | undefined,
): OriginMismatch | null {
  const declared = httpOrigin(parentOrigin);
  const framedBy = httpOrigin(referrer);
  if (!declared || !framedBy || declared === framedBy) return null;
  return { declared, framedBy };
}

/** The mismatch as the beacon sends it. One format, read back by the parser below. */
export function originMismatchMessage(m: OriginMismatch): string {
  return `declared ${m.declared}, framed by ${m.framedBy}`;
}

/**
 * The pair back out of a reported message, or null for anything that is not
 * exactly two differing bare origins. The report endpoint is public, so whatever
 * it accepts can reach Slack: it rebuilds the pair from what parses rather than
 * forwarding text somebody posted.
 */
export function parseOriginMismatchMessage(message: string): OriginMismatch | null {
  const match = /^declared (\S+), framed by (\S+)$/.exec(message);
  if (!match) return null;
  const [, declaredRaw, framedByRaw] = match;
  const declared = httpOrigin(declaredRaw);
  const framedBy = httpOrigin(framedByRaw);
  if (!declared || !framedBy || declared !== declaredRaw || framedBy !== framedByRaw) return null;
  if (declared === framedBy) return null;
  return { declared, framedBy };
}
