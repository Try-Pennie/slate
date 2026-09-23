/**
 * Pure logic for the client error beacon (#1368).
 *
 * A broken client bundle loses bookings SILENTLY: the customer sees a page that
 * does not work, and nothing server side ever hears about it. Every detector
 * Slate has is downstream of a request the browser managed to send, so the one
 * failure that removes all evidence of itself is the one with no detector. The
 * beacon reports it.
 *
 * That means a public, unauthenticated endpoint carrying free text out of a page
 * that holds a lead's name, email and phone. This module is what stands between
 * that and Slack, so two jobs:
 *
 *   1. Scrub contact data out of the text.
 *   2. Bound every field, because nothing arriving here is trusted.
 *
 * THE LIMIT OF THE SCRUB, stated plainly because discovering it later is how it
 * becomes an incident: this catches SHAPES. An email address, a phone number and
 * a long digit run all have a form a regex can recognise. A person's NAME does
 * not, so it cannot be caught this way, and a message that interpolates one
 * ("Jane Smith is not a valid ...") will carry it through.
 *
 * What bounds that residual risk is not this function, it is what the beacon
 * SENDS: the alert carries a page level signature and a short reason, the full
 * text goes to the log rather than to Slack, and the field caps below keep any
 * single report small. It is a real residual risk, not an eliminated one.
 *
 * Runs in BOTH the browser and the server on purpose. Scrubbing in the page means
 * contact data never crosses the network; scrubbing again on the server means a
 * forged or stale client cannot bypass it. No `@/` imports, so
 * scripts/test-client-error-scrub.ts drives it node-natively.
 */

/** Hard caps. A public endpoint accepts nothing unbounded. */
export const FIELD_LIMITS = {
  message: 500,
  stack: 2000,
  source: 300,
  page: 300,
  bucketCode: 16,
} as const;

/** Anything shaped like an email address. */
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/**
 * A phone number in the shapes a US lead actually types, plus E.164.
 *
 * Matched by GROUPING, not by "a long enough run of digits and separators". The
 * loose version ate dates: `2026-08-11` is digits and dashes too, and every
 * error the booker can throw mentions a slot time, so the filter stripped the
 * diagnosis out of exactly the messages this exists to catch. A minified stack
 * frame (`main-9f3c21.js:1:203458`) has the same problem.
 *
 * So each alternative pins a real phone shape: E.164 with its leading plus, the
 * 3+3+4 grouping a US number is written in, or a bare ten digit run. A date is
 * 4+2+2 and matches none of them.
 */
const PHONE =
  /(?:\+\d{10,15}\b)|(?:\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b)|(?:\b\d{10}\b)/g;

/** Any remaining long digit run: a card number, an account number, an SSN.
 *  Treated as identifying whether or not we can name what it is. */
const LONG_DIGITS = /\d{7,}/g;

/**
 * Remove contact data from a browser error string.
 *
 * Order matters: emails first (an address can contain digits that PHONE would
 * otherwise chew into), then phone shapes, then any long digit run left over.
 * Each leaves a marker, so a reader can tell that something was removed rather
 * than wondering whether the message was always that terse.
 */
export function scrubContactData(text: string): string {
  return text
    .replace(EMAIL, "[email]")
    .replace(PHONE, "[phone]")
    .replace(LONG_DIGITS, "[number]");
}

/**
 * `boundary` is a REACT ERROR BOUNDARY catch (#1974), not a window event.
 *
 * The other two arrive from listeners on the page. This one is reported
 * deliberately by the boundary itself, and it is the case that matters most on
 * the staff surfaces: a page that throws on render shows a person the error
 * screen and tells nobody, so one stray fault and a deploy that broke a page for
 * everybody arrive on the same path and look identical (L77).
 */
export type ClientErrorKind = "error" | "unhandledrejection" | "boundary" | "origin_mismatch";

export interface ClientErrorReport {
  kind: ClientErrorKind;
  message: string;
  stack: string | null;
  source: string | null;
  page: string;
  bucketCode: string | null;
  line: number | null;
  col: number | null;
}

/**
 * `origin_mismatch` is not an error at all (#2641): the embedding host declared a
 * different origin from the one that framed the Booker, so the browser drops every
 * message the Booker posts it. The page reports it once per load.
 */
const KINDS: ClientErrorKind[] = ["error", "unhandledrejection", "boundary", "origin_mismatch"];

/** Trim, scrub, and cap one string field. Returns null for nothing usable. */
function field(raw: unknown, limit: number): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return scrubContactData(trimmed).slice(0, limit);
}

/** A line or column number, or null. A non integer is DROPPED rather than
 *  coerced: reporting `NaN` or `0` as a real position is a small lie that costs
 *  a reader time at exactly the wrong moment. */
function position(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : null;
}

/**
 * Validate and normalize one posted report, or null when it is not usable.
 *
 * Refuses rather than repairs: an unknown `kind` becomes null instead of being
 * filed under a catch-all category, because a category nothing ever writes on
 * purpose is one nobody can interpret later.
 */
export function normalizeClientError(body: unknown): ClientErrorReport | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;

  const kind = KINDS.find((k) => k === b.kind);
  if (!kind) return null;

  const message = field(b.message, FIELD_LIMITS.message);
  if (!message) return null;

  const page = field(b.page, FIELD_LIMITS.page);
  if (!page) return null;

  return {
    kind,
    message,
    page,
    stack: field(b.stack, FIELD_LIMITS.stack),
    source: field(b.source, FIELD_LIMITS.source),
    bucketCode: field(b.bucketCode, FIELD_LIMITS.bucketCode),
    line: position(b.line),
    col: position(b.col),
  };
}

/**
 * The context the alert is throttled on.
 *
 * MUST be bounded and MUST NOT include attacker controlled free text. Keying on
 * the message would let anyone with a browser mint unlimited `alert_state` rows
 * and would defeat the very throttle that keeps one broken deploy from becoming
 * thousands of Slack messages.
 *
 * So it is keyed on the SURFACE, reduced to its first path segment: every bucket
 * of the booker collapses to one key, because a broken bundle breaks all of them
 * at once and sixty messages say no more than one.
 */
export function clientErrorSignature(input: { page: string; kind?: ClientErrorKind }): string {
  const first = input.page.replace(/[^a-zA-Z0-9/_-]/g, "").split("/").filter(Boolean)[0] ?? "root";
  // #1974: a BOUNDARY catch gets its own key space, so a broken admin page and a
  // broken booker bundle do not share a cooldown. They are different failures
  // with different audiences, and one silencing the other for the cooldown's
  // length is exactly the shape that leaves the second invisible for as long as
  // it lasts.
  const prefix = input.kind === "boundary" ? "boundary_error" : "client_error";
  return `${prefix}:${first.slice(0, 32)}`;
}
