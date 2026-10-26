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
 * - `not-given`: the link carried no source (older links, direct visits).
 *   Recorded explicitly, so it is never an empty string standing in for several
 *   different things.
 * - `unrecognised`: the link named a page this list does not know. That is a
 *   broken link somebody should fix, so it is kept apart from `not-given`, and the
 *   raw value goes to the log rather than into the column (the column holds only
 *   this vocabulary, which is what the database CHECK enforces).
 *
 * A null column is a THIRD thing: a booking recorded before this field existed.
 *
 * The booking API is a FOURTH (#2876). A call that names no page records WHO made
 * it, `api-<caller>`, one value per caller that may BOOK (`FULL_API_CALLERS`),
 * derived from that list so a caller added there gets its source by construction.
 * A cancel only caller (Marcia's booking API key, #2940) can never create a booking
 * through the API, so its KEY has no `api-` source and the constraint needs none.
 * Marcia booking through her booking MCP endpoint (#3543) is a different door and
 * records `mcp-marcia`, the FIFTH kind: one `mcp-<channel>` per MCP channel. Both
 * kinds are machine sources (`isMachineSource`). An API booking used to
 * record `not-given`, which the per page volume alarm reads as a booking that could
 * be any page's, so a steady stream of Regal or trypennie API bookings excused a
 * landing page gone dark. A machine source is not page traffic and is not unsourced
 * (`page-volume.ts`). A page the caller DOES name still wins, being the finer fact.
 *
 * The SIXTH kind is a person's door (#4200): `coordinator`, the booking page a
 * scheduling coordinator uses while on the phone with the customer. It is not a
 * machine, but it is not a landing page either, so it is a STAFF source
 * (`STAFF_SOURCES`), and machine and staff sources together are the NON PAGE sources
 * (`isNonPageSource`) the per page volume alarm leaves out of page traffic.
 *
 * The list, the database constraint (`bookings_source_check`) and this mapping
 * agree by test: `scripts/test-booking-source.ts`.
 */

import { FULL_API_CALLERS, type FullApiCaller } from "./api-callers.ts";
import { AUDIT_CHANNELS, type AuditChannel } from "../audit-channel.ts";

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
  // #2873: the trypennie surfaces that move to Slate with #2870.
  "pennie",
  "review-terms",
  "my-offers-result-2",
  "income-landing",
] as const;
export type PageSource = (typeof PAGE_SOURCES)[number];

export const SOURCE_NOT_GIVEN = "not-given";
export const SOURCE_UNRECOGNISED = "unrecognised";

/** What a booking API call naming no page records: its caller (#2876). */
export type ApiSource = `api-${FullApiCaller}`;

export function apiSourceFor(caller: FullApiCaller): ApiSource {
  return `api-${caller}`;
}

/** One per caller that may book, derived from the caller list rather than typed out. */
export const API_SOURCES: readonly ApiSource[] = FULL_API_CALLERS.map(apiSourceFor);

const API_SET: ReadonlySet<string> = new Set(API_SOURCES);

/** Whether a stored source names a booking API caller rather than a page or an outcome. */
export function isApiSource(source: string | null): source is ApiSource {
  return source !== null && API_SET.has(source);
}

/**
 * What a booking made through an MCP channel records (#3543): `mcp-<channel>`, one
 * per machine channel (`AUDIT_CHANNELS`, today only Marcia), derived from that list.
 * Like an API source it is not page traffic and is not unsourced, and it is set only
 * by the channel's own server code, never read off a link.
 */
export type McpSource = `mcp-${AuditChannel}`;

export function mcpSourceFor(channel: AuditChannel): McpSource {
  return `mcp-${channel}`;
}

export const MCP_SOURCES: readonly McpSource[] = AUDIT_CHANNELS.map(mcpSourceFor);

/** A source a machine caller records, through the booking API or an MCP channel. */
export type MachineSource = ApiSource | McpSource;
export const MACHINE_SOURCES: readonly MachineSource[] = [...API_SOURCES, ...MCP_SOURCES];
const MACHINE_SET: ReadonlySet<string> = new Set(MACHINE_SOURCES);

/** Whether a stored source names a machine caller (API or MCP) rather than a page or an outcome. */
export function isMachineSource(source: string | null): source is MachineSource {
  return source !== null && MACHINE_SET.has(source);
}

/**
 * A source a PERSON records on Pennie's side (#4200), set only by that page's own
 * server code, never read off a link.
 */
export const STAFF_SOURCES = ["coordinator"] as const;
export type StaffSource = (typeof STAFF_SOURCES)[number];
export const SOURCE_COORDINATOR: StaffSource = "coordinator";

/** Every source that names no landing page: the machine callers and the staff pages. */
export type NonPageSource = MachineSource | StaffSource;
export const NON_PAGE_SOURCES: readonly NonPageSource[] = [...MACHINE_SOURCES, ...STAFF_SOURCES];
const NON_PAGE_SET: ReadonlySet<string> = new Set(NON_PAGE_SOURCES);

/** Whether a stored source names a machine caller or a staff page, so no landing page sent it. */
export function isNonPageSource(source: string | null): source is NonPageSource {
  return source !== null && NON_PAGE_SET.has(source);
}

/** Every value `bookings.source` can hold (besides null for older rows). */
export type BookingSource = PageSource | typeof SOURCE_NOT_GIVEN | typeof SOURCE_UNRECOGNISED | NonPageSource;
export const BOOKING_SOURCES: readonly BookingSource[] = [
  ...PAGE_SOURCES,
  SOURCE_NOT_GIVEN,
  SOURCE_UNRECOGNISED,
  ...NON_PAGE_SOURCES,
];

/** The seven cal.com event types the routing forms booked into. */
export const LEGACY_EVENT_TYPES = ["review", "connect", "call", "income", "terms", "apply", "meet"] as const;
export type LegacyEventType = (typeof LEGACY_EVENT_TYPES)[number];

/**
 * The landing pages' production host (#3033): trypennie's own robots.txt names
 * its sitemap there, and its structured data falls back to it
 * (Halo-lab-Trypennie/trypennie `src/app/robots/route.ts`,
 * `src/components/StructuredData/OrganizationSchema.tsx`).
 */
export const LANDING_HOST = "https://trypennie.com";

/**
 * What stands in a page link for the id a lead brings to it. Every booking page on
 * trypennie is addressed by one, a Salesforce Submission or Prospect id, so no
 * bare address shows a booker. Capitals with no space, so Slack links the whole
 * address and a reader sees at once which part is theirs to fill in.
 */
export const SUBMISSION_ID = "SUBMISSION_ID";
export const PROSPECT_ID = "PROSPECT_ID";

/** One address a page is opened at, for a reader checking it (#3033). */
export interface PageLink {
  /** The full address on `LANDING_HOST`, with `SUBMISSION_ID` or `PROSPECT_ID` where the lead's id goes. */
  url: string;
  /** Which id the address takes. */
  id: "submission" | "prospect";
  /** Which lead shows this page's booker, where two pages share the address. */
  only?: string;
}

export interface SourceDetail {
  /** The page as an admin would recognise it. */
  page: string;
  /** The cal.com event type this page booked into, or null for an outcome. */
  legacyEventType: LegacyEventType | null;
  /**
   * Where the page can be opened, one entry per address that sends this source
   * (#3033). Empty for an outcome, an API caller, and a page whose address nobody
   * has established yet; a Low page may not be empty (`scripts/test-page-volume.ts`).
   */
  links: readonly PageLink[];
}

const bySubmission = (path: string, only?: string): PageLink => ({
  url: `${LANDING_HOST}${path}`,
  id: "submission",
  ...(only === undefined ? {} : { only }),
});
const byProspect = (path: string): PageLink => ({ url: `${LANDING_HOST}${path}`, id: "prospect" });

/**
 * Each source's page and legacy cal.com event type, from the live routing forms
 * (org 19474) as recorded on #2072, and where it is opened, from the trypennie
 * route that sends it (Halo-lab-Trypennie/trypennie `SLATE_PAGE_SOURCES` in
 * `src/utils/booking.ts`, and the `src/app` route each use sits under, read
 * 2026-10-02).
 */
export const SOURCE_DETAILS: Record<BookingSource, SourceDetail> = {
  // src/app/my-offers/result/page.tsx reads `submission_id` from the query.
  "my-offers-result": {
    page: "/my-offers/result",
    legacyEventType: "review",
    links: [bySubmission(`/my-offers/result?submission_id=${SUBMISSION_ID}`)],
  },
  // src/app/booking/[SO_ID]: SubmissionPage/InnerContent sends one of these two by
  // the lead's AI_Agent_Eligible__c, so the one address serves both.
  booking: {
    page: "/booking",
    legacyEventType: "review",
    links: [bySubmission(`/booking/${SUBMISSION_ID}`, "a lead not marked eligible for the AI agent")],
  },
  "booking-agent-eligible": {
    page: "/booking, eligible for the AI agent",
    legacyEventType: "connect",
    links: [bySubmission(`/booking/${SUBMISSION_ID}`, "a lead marked eligible for the AI agent")],
  },
  "booking-portal": {
    page: "/booking/portal",
    legacyEventType: "call",
    links: [bySubmission(`/booking/portal/${SUBMISSION_ID}`)],
  },
  // #2873: the Income Verification pop ups on /offerportal and /offerportal-2 set
  // this, not the /offerhub page, which has no booker of its own and hands off to
  // /booking/portal. The pop ups rewrite the page's source to it, so it is also
  // what every /offerportal booking records. Both routes render the same
  // PortalModals, under src/app/offerportal and src/app/offerportal-2.
  offerhub: {
    page: "/offerportal",
    legacyEventType: "call",
    links: [byProspect(`/offerportal/${PROSPECT_ID}`), byProspect(`/offerportal-2/${PROSPECT_ID}`)],
  },
  "rml-portal": { page: "/rml/portal", legacyEventType: "income", links: [] },
  "email-booking": { page: "Email booking link", legacyEventType: "terms", links: [] },
  "guided-app": { page: "Guided application completion", legacyEventType: "apply", links: [] },
  "agent-direct": { page: "An advisor's direct link", legacyEventType: "meet", links: [] },
  pennie: { page: "/pennie", legacyEventType: "review", links: [bySubmission(`/pennie/${SUBMISSION_ID}`)] },
  "review-terms": {
    page: "/review-terms",
    legacyEventType: "terms",
    links: [bySubmission(`/review-terms/${SUBMISSION_ID}`)],
  },
  // src/app/my-offers/result-2/page.tsx reads `submission_id` from the query.
  "my-offers-result-2": {
    page: "/my-offers/result-2",
    legacyEventType: "review",
    links: [bySubmission(`/my-offers/result-2?submission_id=${SUBMISSION_ID}`)],
  },
  // src/app/portal-2 and src/app/portal-3 both render PortalAlternateContent.
  "income-landing": {
    page: "the /portal-2 or /portal-3 calendar",
    legacyEventType: "call",
    links: [byProspect(`/portal-2/${PROSPECT_ID}`), byProspect(`/portal-3/${PROSPECT_ID}`)],
  },
  "not-given": { page: "No source on the link", legacyEventType: null, links: [] },
  unrecognised: { page: "A source Slate does not know", legacyEventType: null, links: [] },
  // #2876: not pages, so no cal.com event type. `Record<BookingSource, ...>` makes
  // tsc refuse a caller added to BOOKING_API_CALLERS without a line here.
  "api-regal": { page: "The booking API, called by Regal", legacyEventType: null, links: [] },
  "api-trypennie": { page: "The booking API, called by trypennie", legacyEventType: null, links: [] },
  "api-canary": { page: "The booking API, called by the smoke canary", legacyEventType: null, links: [] },
  // #3543: Marcia's booking MCP endpoint, not a page either.
  "mcp-marcia": { page: "Marcia, through her booking MCP endpoint", legacyEventType: null, links: [] },
  // #4200: a person's door, not a page a lead opens.
  coordinator: { page: "The coordinator booking page", legacyEventType: null, links: [] },
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
 * `not-given`, or, when the booking came through the key authed booking API,
 * that caller's `api-<caller>` (#2876), or, when it came through an MCP channel's
 * gateway, that channel's `mcp-<channel>` (#3543, which wins over an API caller,
 * since only one of the two is ever set): the caller is known, so recording nothing
 * would throw away a fact. Anything else outside the page list, including a link
 * that names one of the outcomes or a machine source, is `unrecognised`: only the
 * authenticated caller decides which machine source a booking records, never a link.
 */
export function readBookingSource(
  prefill: Record<string, unknown> | null | undefined,
  apiCaller?: FullApiCaller,
  mcpChannel?: AuditChannel,
): SourceReading {
  const absent: SourceReading = {
    source:
      mcpChannel !== undefined
        ? mcpSourceFor(mcpChannel)
        : apiCaller === undefined
          ? SOURCE_NOT_GIVEN
          : apiSourceFor(apiCaller),
    unrecognisedRaw: null,
  };
  const value = prefill?.[BOOKING_SOURCE_PARAM];
  if (value === undefined || value === null) return absent;
  if (typeof value !== "string") {
    return { source: SOURCE_UNRECOGNISED, unrecognisedRaw: String(value).slice(0, RAW_LOG_LIMIT) };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return absent;
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
