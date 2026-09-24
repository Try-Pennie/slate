/**
 * Where a booking came from (#2072).
 *
 * cal.com recorded a booking's origin by WHICH event type took it: seven routing
 * forms, each feeding its own event type, kept apart only for tracking (BC,
 * 2026-09-08). Slate books every lead through one flow, so the page a lead booked
 * from rides on the link as `?source=<page>`, `/book` and `/booking/{id}` copy it
 * into `prefill` with every other param, and `createBooking` records it on
 * `bookings.source` through `readBookingSource`.
 *
 * Dan decided on 2026-09-24 to record the PAGE rather than reuse the event type
 * slugs, as long as reporting can still group by the old names. It can, because
 * each page feeds exactly one event type today, so `SOURCE_DETAILS` maps every
 * source onto its legacy name. It is a `Record` over the whole vocabulary, so
 * `tsc` refuses a source added without a mapping.
 *
 * Two values are OUTCOMES rather than pages, and they mean different things:
 *
 * - `not-given`: the link carried no source (older links, direct visits, the
 *   direct booking API). Recorded explicitly, so it is never an empty string
 *   standing in for several different things.
 * - `unrecognised`: the link named a page this list does not know. That is a
 *   broken link somebody should fix, so it is kept apart from `not-given`, and the
 *   raw value goes to the log rather than into the column (the column holds only
 *   this vocabulary, which is what the database CHECK enforces).
 *
 * A null column is a THIRD thing: a booking recorded before this field existed.
 *
 * The list, the database constraint (`bookings_source_check`) and this mapping
 * agree by test: `scripts/test-booking-source.ts`.
 */

/** The URL key a landing page sets. */
export const BOOKING_SOURCE_PARAM = "source";

/** The pages a link can name. */
export const PAGE_SOURCES = [
  "my-offers-result",
  "booking",
  "booking-agent-eligible",
  "booking-portal",
  "offerhub",
  "rml-portal",
  "email-booking",
  "guided-app",
  "agent-direct",
] as const;
export type PageSource = (typeof PAGE_SOURCES)[number];

export const SOURCE_NOT_GIVEN = "not-given";
export const SOURCE_UNRECOGNISED = "unrecognised";

/** Every value `bookings.source` can hold (besides null for older rows). */
export type BookingSource = PageSource | typeof SOURCE_NOT_GIVEN | typeof SOURCE_UNRECOGNISED;
export const BOOKING_SOURCES: readonly BookingSource[] = [
  ...PAGE_SOURCES,
  SOURCE_NOT_GIVEN,
  SOURCE_UNRECOGNISED,
];

/** The seven cal.com event types the routing forms booked into. */
export const LEGACY_EVENT_TYPES = ["review", "connect", "call", "income", "terms", "apply", "meet"] as const;
export type LegacyEventType = (typeof LEGACY_EVENT_TYPES)[number];

export interface SourceDetail {
  /** The page as an admin would recognise it. */
  page: string;
  /** The cal.com event type this page booked into, or null for an outcome. */
  legacyEventType: LegacyEventType | null;
}

/**
 * Each source's page and legacy cal.com event type, from the live routing forms
 * (org 19474) as recorded on #2072.
 */
export const SOURCE_DETAILS: Record<BookingSource, SourceDetail> = {
  "my-offers-result": { page: "/my-offers/result", legacyEventType: "review" },
  booking: { page: "/booking", legacyEventType: "review" },
  "booking-agent-eligible": { page: "/booking, eligible for the AI agent", legacyEventType: "connect" },
  "booking-portal": { page: "/booking/portal", legacyEventType: "call" },
  offerhub: { page: "/offerhub", legacyEventType: "call" },
  "rml-portal": { page: "/rml/portal", legacyEventType: "income" },
  "email-booking": { page: "Email booking link", legacyEventType: "terms" },
  "guided-app": { page: "Guided application completion", legacyEventType: "apply" },
  "agent-direct": { page: "An advisor's direct link", legacyEventType: "meet" },
  "not-given": { page: "No source on the link", legacyEventType: null },
  unrecognised: { page: "A source Slate does not know", legacyEventType: null },
};

/** How much of an unrecognised value is handed back for the log. */
const RAW_LOG_LIMIT = 100;

export interface SourceReading {
  source: BookingSource;
  /** The value the link carried, bounded, when it was not in the vocabulary. */
  unrecognisedRaw: string | null;
}

const PAGE_SET: ReadonlySet<string> = new Set(PAGE_SOURCES);

function isPageSource(value: string): value is PageSource {
  return PAGE_SET.has(value);
}

/**
 * Read the source a booking's link carried.
 *
 * Case and surrounding space are ignored, because `OfferHub` on a hand typed link
 * is the same page and nothing about it needs fixing. Absent, empty or blank is
 * `not-given`. Anything else outside the page list, including a link that names
 * one of the two outcomes, is `unrecognised`.
 */
export function readBookingSource(prefill: Record<string, unknown> | null | undefined): SourceReading {
  const value = prefill?.[BOOKING_SOURCE_PARAM];
  if (value === undefined || value === null) return { source: SOURCE_NOT_GIVEN, unrecognisedRaw: null };
  if (typeof value !== "string") {
    return { source: SOURCE_UNRECOGNISED, unrecognisedRaw: String(value).slice(0, RAW_LOG_LIMIT) };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return { source: SOURCE_NOT_GIVEN, unrecognisedRaw: null };
  const normalized = trimmed.toLowerCase();
  if (isPageSource(normalized)) return { source: normalized, unrecognisedRaw: null };
  return { source: SOURCE_UNRECOGNISED, unrecognisedRaw: trimmed.slice(0, RAW_LOG_LIMIT) };
}

/**
 * One line describing a booking's source for an admin: the page and the cal.com
 * event type it would have booked into, so either name can be read. A null source
 * is a booking made before sources were recorded, which is not the same as a link
 * that carried none.
 */
export function bookingSourceLabel(source: BookingSource | null): string {
  if (source === null) return "Booked before sources were recorded";
  const detail = SOURCE_DETAILS[source];
  return detail.legacyEventType === null
    ? detail.page
    : `${detail.page}, cal.com event type ${detail.legacyEventType}`;
}
