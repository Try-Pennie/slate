/**
 * Every upcoming cal.com booking in the org (#2933), for the cross system double
 * booking check.
 *
 * During the pilot split a lead can reach both bookers, and on 2026-10-01 one did:
 * cal.com booking 26177051 and Slate booking aa70212d, one Submission, both live.
 * Slate's one call per lead check only reads Slate, so the comparison needs cal.com's
 * side, and this is that read.
 *
 * WHAT WAS MEASURED, read only, on 2026-10-01, before any of this was built:
 *
 * - The listing is `GET /v2/organizations/{org}/bookings` at API version
 *   2024-08-13. `status=upcoming` is not optional: the same request without it ran
 *   for 125 seconds and came back 524. With it, a 250 row page answers in about a
 *   second, and the org's 1,252 upcoming bookings were six pages. 250 is cal.com's
 *   ceiling: `take=500` answers 400.
 * - The `pagination` block cannot be trusted to end the walk: one page reported
 *   `totalItems: 1` beside twenty rows and `hasNextPage: true`. So the walk stops on
 *   a SHORT page, which is the one fact the rows themselves carry.
 * - The tie to Slate is `metadata.sfdc_submission_id`, the Salesforce Submission.
 *   The known duplicate's cal.com half carries `a04Ui00000NDRunIAH`, which is the
 *   submission id on the Slate booking's prefill. cal.com holds NO lead id anywhere
 *   on the booking: the metadata has only that key, and the booking fields are the
 *   lead's answers. 789 of the 1,252 rows (every one on the `review` event type)
 *   carry an empty metadata object, so the attendee address is kept as the second
 *   key, lower cased and trimmed, and never leaves the process.
 *
 * A partial read is REFUSED rather than returned, the same rule as the routing
 * response reader beside it: a list missing a page reads as "this lead holds nothing
 * in cal.com", which clears a real page and reports a double booking as healthy
 * (L98, L211). A row that cannot be read refuses the read for the same reason: it
 * could be the twin.
 *
 * No `@/` imports, so a node suite drives it with a hand written getter and an
 * injected sleep (L524).
 */

/** The API version every listing was measured at. */
export const CALCOM_BOOKINGS_API_VERSION = "2024-08-13";

/** The largest page cal.com accepts (500 answered 400 on 2026-10-01). */
export const CALCOM_BOOKINGS_PAGE_SIZE = 250;

/**
 * Pages a read may take before it refuses. 40 pages is 10,000 upcoming bookings,
 * eight times the 1,252 measured on 2026-10-01, so reaching it means something is
 * wrong with the walk rather than that the business grew.
 */
export const CALCOM_BOOKINGS_MAX_PAGES = 40;

/** One upcoming cal.com booking, reduced to what the comparison needs. */
export interface CalcomUpcomingBooking {
  /** cal.com's numeric booking id, the one its UI and webhooks name. */
  id: number;
  /** The uid its booking page is addressed by. */
  uid: string;
  /** ISO start, as cal.com wrote it. */
  start: string;
  status: string;
  /** The first host's username, or null when cal.com named none. */
  host: string | null;
  /** `metadata.sfdc_submission_id`, trimmed, or null when the booking carries none. */
  submissionId: string | null;
  /** Every attendee address, trimmed and lower cased. Held in memory only. */
  attendeeEmails: string[];
}

/**
 * The most one request may wait. Measured on 2026-10-01 a 250 row page answers in
 * about a second; the same listing WITHOUT the upcoming filter hung for 125 seconds,
 * so a request that has not answered in twenty has met that failure.
 */
export const CALCOM_BOOKINGS_PAGE_TIMEOUT_MS = 20_000;

/**
 * Why a read measured nothing. `deadline` is its own reason, never folded into
 * `unreachable`: a walk that ran out of time and a cal.com that is down send a
 * reader to two different places (L11).
 */
export type CalcomReadRefusal = "refused" | "unreadable" | "unreachable" | "deadline";

export type CalcomUpcomingRead =
  | { ok: true; rows: CalcomUpcomingBooking[]; pages: number }
  | {
      ok: false;
      reason: CalcomReadRefusal | "row-unreadable" | "too-many-pages";
      /** The HTTP status of the page that failed, 0 when no response arrived. */
      status: number;
      /** The zero based page it failed on. */
      page: number;
    };

/**
 * One GET against cal.com, sent with the `cal-api-version` header the reader names,
 * and abandoned after `timeoutMs`. The reader computes the timeout, so no request
 * can wait past the walk's own deadline.
 */
export type CalcomGetter = (path: string, apiVersion: string, timeoutMs: number) => Promise<{ status: number; json: unknown }>;

/** The deadline every read is held to: an injected clock and the instant it must end by (L524). */
interface Deadline {
  clock: () => number;
  deadlineAtMs: number;
}

/** What one request may wait: the page timeout, or what is left of the deadline if less. */
function requestTimeout(d: Deadline, pageTimeoutMs = CALCOM_BOOKINGS_PAGE_TIMEOUT_MS): number {
  return Math.min(pageTimeoutMs, d.deadlineAtMs - d.clock());
}

/** A request that threw: the deadline if it is spent, otherwise cal.com was unreachable. */
function thrownReason(d: Deadline): "deadline" | "unreachable" {
  return d.clock() >= d.deadlineAtMs ? "deadline" : "unreachable";
}

type WalkRead<T> =
  | { ok: true; rows: T[]; pages: number }
  | {
      ok: false;
      reason: CalcomReadRefusal | "row-unreadable" | "too-many-pages";
      status: number;
      page: number;
    };

/**
 * The one listing walk both readers share: page by `skip` at `take`, stop on a SHORT
 * page, refuse on anything else. A request that throws inside the budget is tried
 * again up to `retries` times, because a `past` listing's first page was measured
 * answering in 6 s on one run and 117 s on the next (#2945); a refusal with a status
 * is never retried, since cal.com answered.
 */
async function walkListing<T extends { id: number }>(
  opts: {
    get: CalcomGetter;
    org: string;
    query: Record<string, string>;
    reduce: (item: unknown) => T | null;
    paceMs: number;
    sleep: (ms: number) => Promise<void>;
    pageSize?: number;
    maxPages?: number;
    pageTimeoutMs?: number;
    retries?: number;
  } & Deadline,
): Promise<WalkRead<T>> {
  const take = opts.pageSize ?? CALCOM_BOOKINGS_PAGE_SIZE;
  const maxPages = opts.maxPages ?? CALCOM_BOOKINGS_MAX_PAGES;
  const retries = opts.retries ?? 0;
  const byId = new Map<number, T>();
  for (let page = 0; ; page++) {
    if (page >= maxPages) return { ok: false, reason: "too-many-pages", status: 200, page };
    if (page > 0 && opts.paceMs > 0) await opts.sleep(opts.paceMs);
    // The whole walk is bounded, not only each page: forty pages at the page timeout
    // would otherwise hold the monitor tick for over thirteen minutes.
    if (opts.clock() >= opts.deadlineAtMs) return { ok: false, reason: "deadline", status: 0, page };
    const q = new URLSearchParams({ ...opts.query, take: String(take), skip: String(page * take) });
    let res: { status: number; json: unknown } | null = null;
    for (let attempt = 0; res === null; attempt++) {
      try {
        res = await opts.get(
          `/organizations/${opts.org}/bookings?${q}`,
          CALCOM_BOOKINGS_API_VERSION,
          requestTimeout(opts, opts.pageTimeoutMs),
        );
      } catch {
        const reason = thrownReason(opts);
        if (reason === "deadline" || attempt >= retries) return { ok: false, reason, status: 0, page };
      }
    }
    if (res.status !== 200) return { ok: false, reason: "refused", status: res.status, page };
    const data = (res.json as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) return { ok: false, reason: "unreadable", status: res.status, page };
    for (const item of data) {
      const row = opts.reduce(item);
      if (row === null) return { ok: false, reason: "row-unreadable", status: res.status, page };
      // A booking made mid walk can shift a later page by one, so the same row can
      // arrive twice. It is one booking.
      if (!byId.has(row.id)) byId.set(row.id, row);
    }
    if (data.length < take) return { ok: true, rows: [...byId.values()], pages: page + 1 };
  }
}

export async function readUpcomingCalcomBookings(
  opts: {
    get: CalcomGetter;
    org: string;
    afterStartIso: string;
    paceMs: number;
    sleep: (ms: number) => Promise<void>;
    pageSize?: number;
    maxPages?: number;
  } & Deadline,
): Promise<CalcomUpcomingRead> {
  return walkListing({
    ...opts,
    query: { status: "upcoming", afterStart: opts.afterStartIso, sortStart: "asc" },
    reduce: reduceRow,
  });
}

// --- bookings CREATED in a window, every status (#2946) ----------------------------

/**
 * The statuses a listing accepts, measured 2026-10-01 (#2945): each reads in full on
 * its own. `upcoming` is a booking that has not ended yet, `past` one that has, and
 * `cancelled` holds the OLD half of every reschedule as well as real cancellations.
 */
export const CALCOM_LISTING_STATUSES = ["past", "upcoming", "cancelled", "unconfirmed"] as const;
export type CalcomListingStatus = (typeof CALCOM_LISTING_STATUSES)[number];

/**
 * What a page of a created window read may wait. A `past` listing's FIRST page was
 * measured at 6 s, 17 s, 46 s and 117 s on 2026-10-01 while every later page took
 * under 5 s; the 20 s the upcoming read allows would refuse it. Callers read one day
 * at a time, where no page took more than 3.5 s, and this is the ceiling over that.
 */
export const CALCOM_WINDOW_PAGE_TIMEOUT_MS = 120_000;

/** One booking as the pilot comparison needs it: the upcoming row plus its history. */
export interface CalcomListedBooking extends CalcomUpcomingBooking {
  /** When the booking was MADE, which is what a cohort is judged on. On every row measured. */
  createdAt: string;
  end: string | null;
  eventTypeId: number | null;
  /**
   * The reschedule chain, measured 2026-10-01: the new booking names the old one in
   * `rescheduledFromUid`, the old one names the new in `rescheduledToUid` and reads
   * `cancelled`. So a row with `rescheduledToUid` set is a reschedule, not a cancel.
   */
  rescheduledFromUid: string | null;
  rescheduledToUid: string | null;
  /**
   * The last ten digits of the first attendee's phone, for matching a booking to an
   * application when it carries no submission id. Held in memory only, never printed.
   */
  attendeePhone10: string | null;
  /** The first host's address, lower cased: the advisor a show rate is clustered by. */
  hostEmail: string | null;
}

export type CalcomListedRead = WalkRead<CalcomListedBooking>;

/**
 * Every booking of one status CREATED in `[afterCreatedIso, beforeCreatedIso)`.
 * The created filters were checked against a broader read on 2026-10-01 for every
 * status and differed on zero ids (#2945). Refuses rather than returning a partial
 * list, like the upcoming read: a missing page reads as applications that never
 * booked.
 */
export async function readCalcomBookingsCreated(
  opts: {
    get: CalcomGetter;
    org: string;
    status: CalcomListingStatus;
    afterCreatedIso: string;
    beforeCreatedIso: string;
    paceMs: number;
    sleep: (ms: number) => Promise<void>;
    pageSize?: number;
    maxPages?: number;
    pageTimeoutMs?: number;
    retries?: number;
  } & Deadline,
): Promise<CalcomListedRead> {
  return walkListing({
    ...opts,
    pageTimeoutMs: opts.pageTimeoutMs ?? CALCOM_WINDOW_PAGE_TIMEOUT_MS,
    retries: opts.retries ?? 1,
    query: {
      status: opts.status,
      afterCreatedAt: opts.afterCreatedIso,
      beforeCreatedAt: opts.beforeCreatedIso,
      sortStart: "asc",
    },
    reduce: reduceListedRow,
  });
}

export type CalcomListedByUidRead =
  | { ok: true; row: CalcomListedBooking }
  | { ok: false; reason: CalcomReadRefusal; status: number };

/** One booking by uid in the listed shape, for a reschedule chain whose next link the window did not hold. */
export async function readCalcomListedBookingByUid(
  opts: { get: CalcomGetter; uid: string } & Deadline,
): Promise<CalcomListedByUidRead> {
  return readOneByUid(opts, reduceListedRow);
}

/**
 * The most rounds of links past the listing a reschedule chain is followed. #2945
 * found the listing held both halves of all 215 reschedule pairs in a week, so a link
 * missing at all is rare and ten in a row means the chain loops or the data is wrong.
 */
export const CALCOM_RESCHEDULE_MAX_HOPS = 10;

export type FollowedChains =
  | { ok: true; rows: CalcomListedBooking[]; notFound: string[] }
  | { ok: false; reason: CalcomReadRefusal; uid: string; status: number }
  | { ok: false; reason: "too-many-hops"; uid: string; hops: number };

/**
 * Follow every reschedule chain to its end (#2946). The created window listing can
 * lack a chain's later links (a page shifts under a live walk), and a link read by
 * uid can name a further one the listing lacked too, so this reads missing links in
 * rounds until none is left, at most `maxHops` rounds. A uid cal.com refuses (a 404)
 * is reported in `notFound` and its chain stays unresolved, which the comparison
 * counts; any other failure refuses by uid, because a shorter chain would be judged
 * at the wrong start.
 */
export async function followRescheduleChains(
  rows: readonly CalcomListedBooking[],
  fetchByUid: (uid: string) => Promise<CalcomListedByUidRead>,
  maxHops = CALCOM_RESCHEDULE_MAX_HOPS,
): Promise<FollowedChains> {
  const byUid = new Map(rows.map((r) => [r.uid, r]));
  const notFound = new Set<string>();
  for (let hop = 0; ; hop++) {
    const wanted = [...new Set([...byUid.values()].map((r) => r.rescheduledToUid))].filter(
      (u): u is string => u !== null && !byUid.has(u) && !notFound.has(u),
    );
    if (wanted.length === 0) return { ok: true, rows: [...byUid.values()], notFound: [...notFound] };
    if (hop >= maxHops) return { ok: false, reason: "too-many-hops", uid: wanted[0], hops: hop };
    for (const uid of wanted) {
      const one = await fetchByUid(uid);
      if (one.ok) byUid.set(one.row.uid, one.row);
      else if (one.reason === "refused") notFound.add(uid);
      else return { ok: false, reason: one.reason, uid, status: one.status };
    }
  }
}

const optionalText = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** The last ten digits of a phone, or null when it holds fewer: the key #2945 matched on. */
export function phoneKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function reduceListedRow(item: unknown): CalcomListedBooking | null {
  const base = reduceRow(item);
  if (base === null) return null;
  const r = item as Record<string, unknown>;
  if (typeof r.createdAt !== "string" || !Number.isFinite(Date.parse(r.createdAt))) return null;
  const end = typeof r.end === "string" && Number.isFinite(Date.parse(r.end)) ? r.end : null;
  const attendees = Array.isArray(r.attendees) ? r.attendees : [];
  const first = (attendees[0] ?? null) as { phoneNumber?: unknown } | null;
  const responses = (r.bookingFieldsResponses ?? null) as Record<string, unknown> | null;
  const phone =
    phoneKey(first?.phoneNumber) ??
    phoneKey(responses && typeof responses === "object" ? responses.attendeePhoneNumber : undefined) ??
    phoneKey(responses && typeof responses === "object" ? responses.phone : undefined);
  const hosts = Array.isArray(r.hosts) ? r.hosts : [];
  const hostEmail = optionalText((hosts[0] as { email?: unknown } | undefined)?.email);
  return {
    ...base,
    createdAt: r.createdAt,
    end,
    eventTypeId: typeof r.eventTypeId === "number" && Number.isFinite(r.eventTypeId) ? r.eventTypeId : null,
    rescheduledFromUid: optionalText(r.rescheduledFromUid),
    rescheduledToUid: optionalText(r.rescheduledToUid),
    attendeePhone10: phone,
    hostEmail: hostEmail === null ? null : hostEmail.toLowerCase(),
  };
}

export type CalcomBookingRead =
  | { ok: true; row: CalcomUpcomingBooking }
  | { ok: false; reason: CalcomReadRefusal; status: number };

/**
 * ONE booking, read directly by uid (#2933 review): `GET /bookings/{uid}`, measured
 * live on 2026-10-01 (200 with the booking under `data` at the listing's API
 * version; 404 for a uid cal.com does not hold).
 *
 * This is what the cal.com side all clear rests on, never the listing. The listing
 * pages by `skip`, so a booking cancelled or moved while it is being walked shifts
 * every later row one place earlier and one can fall between two pages. A row
 * missing from the list is therefore not evidence the booking is gone; reading it
 * by uid is. A 404 is a refusal rather than a cancellation, because nothing was
 * measured about the booking.
 */
export async function readCalcomBookingByUid(opts: { get: CalcomGetter; uid: string } & Deadline): Promise<CalcomBookingRead> {
  return readOneByUid(opts, reduceRow);
}

/**
 * The one by uid read both shapes share (L370): the deadline, the timeout, the
 * refusal mapping and the guard against a list where one booking belongs live here
 * once, and only the reducer differs.
 */
async function readOneByUid<T>(
  opts: { get: CalcomGetter; uid: string } & Deadline,
  reduce: (item: unknown) => T | null,
): Promise<{ ok: true; row: T } | { ok: false; reason: CalcomReadRefusal; status: number }> {
  if (opts.clock() >= opts.deadlineAtMs) return { ok: false, reason: "deadline", status: 0 };
  let res: { status: number; json: unknown };
  try {
    res = await opts.get(`/bookings/${encodeURIComponent(opts.uid)}`, CALCOM_BOOKINGS_API_VERSION, requestTimeout(opts));
  } catch {
    return { ok: false, reason: thrownReason(opts), status: 0 };
  }
  if (res.status !== 200) return { ok: false, reason: "refused", status: res.status };
  const data = (res.json as { data?: unknown } | null)?.data;
  const row = Array.isArray(data) ? null : reduce(data);
  if (row === null) return { ok: false, reason: "unreadable", status: res.status };
  return { ok: true, row };
}

function reduceRow(item: unknown): CalcomUpcomingBooking | null {
  if (item === null || typeof item !== "object") return null;
  const r = item as Record<string, unknown>;
  if (typeof r.id !== "number" || !Number.isFinite(r.id)) return null;
  if (typeof r.uid !== "string" || r.uid.trim() === "") return null;
  if (typeof r.start !== "string" || !Number.isFinite(Date.parse(r.start))) return null;
  const attendees = r.attendees ?? [];
  if (!Array.isArray(attendees)) return null;
  const hosts = Array.isArray(r.hosts) ? r.hosts : [];
  const firstHost = hosts[0] as { username?: unknown } | undefined;
  const meta = r.metadata as Record<string, unknown> | null | undefined;
  const sub = meta && typeof meta === "object" ? meta.sfdc_submission_id : undefined;
  return {
    id: r.id,
    uid: r.uid,
    start: r.start,
    status: typeof r.status === "string" ? r.status : "",
    host: typeof firstHost?.username === "string" && firstHost.username.trim() !== "" ? firstHost.username : null,
    submissionId: typeof sub === "string" && sub.trim() !== "" ? sub.trim() : null,
    attendeeEmails: attendees.flatMap((a) => {
      const email = (a as { email?: unknown } | null)?.email;
      return typeof email === "string" && email.trim() !== "" ? [email.trim().toLowerCase()] : [];
    }),
  };
}
