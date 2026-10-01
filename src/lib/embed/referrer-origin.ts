/**
 * The origin of the page that FRAMED the booker, as the browser reports it (#2728).
 *
 * `prefill.parentOrigin` is what a host DECLARES, and widget.js always declares its
 * own page, so a booking that carries none came from a host that framed `/book`
 * itself. Those are exactly the test pages the off site check (#2715) exists to
 * notice, and it could not see them: nothing stored the referrer on a booking. So
 * the booker sends it with the confirm and the booking records it beside
 * `parentOrigin`.
 *
 * Two halves, and the server does not trust the client's:
 *  - `referrerOriginForConfirm` is what the booker sends: the referrer's ORIGIN
 *    only, never its path or query, which on a booking page can carry a lead's
 *    details, and only when the booker is framed. A booker opened as its own page
 *    has a referrer too, but it is whatever LINKED to it (an email, a search), not a
 *    host page, and judging that would page about real leads.
 *  - `readReferrerOrigin` is what the server stores: whatever arrived, reduced to a
 *    bare web origin again, and null for anything that is not one. A malformed value
 *    is dropped, never stored raw, and `bookings_referrer_origin_check` refuses a value
 *    carrying a path at the database as well.
 *
 * Pure and relative imports only, because the booker, the create path and the node
 * suites all load it.
 */
import { hostReferrerOrigin, httpOrigin } from "./parent-origin.ts";

/**
 * Longer than any real referrer's origin can usefully be, and the database
 * constraint's own ceiling. A value past it is dropped before it is parsed.
 */
export const REFERRER_ORIGIN_MAX_CHARS = 2048;

/** What the booker sends on the confirm, or null to send nothing. */
export function referrerOriginForConfirm(input: {
  referrer: string | null | undefined;
  /** The booker's own origin. A referrer on it names Slate, not a host. */
  ownOrigin: string;
  /** Whether the booker is inside a frame at all. */
  framed: boolean;
}): string | null {
  if (!input.framed) return null;
  return hostReferrerOrigin(input.referrer, input.ownOrigin);
}

/** What the server stores on `bookings.referrer_origin`: a bare web origin or null. */
export function readReferrerOrigin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > REFERRER_ORIGIN_MAX_CHARS) return null;
  return httpOrigin(trimmed);
}

/**
 * Whether the booker is inside a frame. Reading `window.top` from a cross origin
 * frame is allowed, but a comparison that throws for any reason is treated as
 * framed, since only a frame can make it throw.
 */
export function isFramed(win: { self: unknown; top: unknown }): boolean {
  try {
    return win.self !== win.top;
  } catch {
    return true;
  }
}
