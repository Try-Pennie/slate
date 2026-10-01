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

export type CalcomUpcomingRead =
  | { ok: true; rows: CalcomUpcomingBooking[]; pages: number }
  | {
      ok: false;
      reason: "refused" | "unreadable" | "row-unreadable" | "too-many-pages";
      /** The HTTP status of the page that failed. */
      status: number;
      /** The zero based page it failed on. */
      page: number;
    };

/** One GET against cal.com, sent with the `cal-api-version` header the reader names. */
export type CalcomGetter = (path: string, apiVersion: string) => Promise<{ status: number; json: unknown }>;

export async function readUpcomingCalcomBookings(opts: {
  get: CalcomGetter;
  org: string;
  afterStartIso: string;
  paceMs: number;
  sleep: (ms: number) => Promise<void>;
  pageSize?: number;
  maxPages?: number;
}): Promise<CalcomUpcomingRead> {
  const take = opts.pageSize ?? CALCOM_BOOKINGS_PAGE_SIZE;
  const maxPages = opts.maxPages ?? CALCOM_BOOKINGS_MAX_PAGES;
  const byId = new Map<number, CalcomUpcomingBooking>();
  for (let page = 0; ; page++) {
    if (page >= maxPages) return { ok: false, reason: "too-many-pages", status: 200, page };
    if (page > 0 && opts.paceMs > 0) await opts.sleep(opts.paceMs);
    const q = new URLSearchParams({
      status: "upcoming",
      afterStart: opts.afterStartIso,
      sortStart: "asc",
      take: String(take),
      skip: String(page * take),
    });
    const res = await opts.get(`/organizations/${opts.org}/bookings?${q}`, CALCOM_BOOKINGS_API_VERSION);
    if (res.status !== 200) return { ok: false, reason: "refused", status: res.status, page };
    const data = (res.json as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) return { ok: false, reason: "unreadable", status: res.status, page };
    for (const item of data) {
      const row = reduceRow(item);
      if (row === null) return { ok: false, reason: "row-unreadable", status: res.status, page };
      // A booking made mid walk can shift a later page by one, so the same row can
      // arrive twice. It is one booking.
      if (!byId.has(row.id)) byId.set(row.id, row);
    }
    if (data.length < take) return { ok: true, rows: [...byId.values()], pages: page + 1 };
  }
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
