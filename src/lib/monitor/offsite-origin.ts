/**
 * A real booking that arrived from a host page which is not the production site
 * (#2715).
 *
 * On 2026-09-25 a partner testing from a localhost page booked a REAL Low advisor
 * twice. Regal sent reminder texts and an advisor call task for a fake lead, and the
 * second booking sat confirmed for six hours until a person happened to query the
 * bookings table. Slate knew the whole time: every embed booking stores the framing
 * page's origin in `prefill.parentOrigin` (the booker page copies every URL
 * parameter into `prefill`, and widget.js passes its own origin as that parameter).
 *
 * So this reads the bookings created in the last `OFFSITE_ORIGIN_LOOKBACK_MS` on the
 * REAL buckets and pages once per booking whose recorded origin is not one of
 * `PRODUCTION_ORIGINS`. It is a page and never a refusal: the origin is what the
 * host DECLARES (#2641), so it is evidence for a person to look at, not a gate.
 *
 * What does not page, each counted under its own name so a quiet run says what it
 * looked at (L98, L11):
 *   - a booking on an `is_test` bucket, from anywhere: the partner test path
 *     (#2660) is exactly where off site hosts belong;
 *   - a booking with no origin recorded: the standalone /book page, the booking API
 *     and an admin booking carry none, and absence is not evidence of anything;
 *   - a booking from a production origin.
 *
 * The REFERRER is not consulted, because nothing stores it on a booking: the booker
 * reads `document.referrer` only to compare it with the declared origin (#2641) and
 * posts neither to the confirm. `parentOrigin` is the one recorded fact.
 *
 * INCIDENT, not condition: the booking has already been made and the texts already
 * sent. Cancelling it is the remedy, and an all clear saying "the booking that came
 * from localhost is no longer from localhost" would say nothing.
 *
 * ONCE PER BOOKING. The key is per booking (`booking_offsite_origin:<id>`), a
 * booking stays in the read for the whole lookback (24 five minute ticks), and two
 * independent things stop it paging on each of them:
 *   - one batched `alert_state` read before sending skips any booking already
 *     stamped, which is also what keeps the per key cooldown read off the lane's
 *     shared subrequest budget on every repeat tick;
 *   - the cooldown handed to `sendThrottledAlert` is a coded constant far longer
 *     than the lookback (pinned by the test), so even when that batched read fails
 *     the dispatcher's own per key stamp refuses the repeat. A FAILED Slack post
 *     stamps only a short retry window, so a page that never arrived is retried
 *     inside the lookback rather than lost.
 *
 * Pure apart from its injected reads, so scripts/test-offsite-origin.ts drives it.
 */
import { formatSlotDay, formatSlotTime } from "@/lib/booking/slot-label";
import type { ThrottledNotify } from "./alert-deps";

/**
 * The host pages a real lead books from, as bare origins. The ONE place this list
 * lives. Both spellings of the production site, because a host page served on
 * either frames the booker with its own origin and the apex redirect is not
 * something Slate controls (#2641's own preview is exactly that pair).
 */
export const PRODUCTION_ORIGINS: readonly string[] = [
  "https://trypennie.com",
  "https://www.trypennie.com",
];

/** The alert family: one incident per booking. */
export const OFFSITE_ORIGIN_KEY = "booking_offsite_origin";

export function offsiteOriginKey(bookingId: string): string {
  return `${OFFSITE_ORIGIN_KEY}:${bookingId}`;
}

/**
 * How far back the check reads, by `created_at`. Two hours is 24 monitor ticks, so
 * a lane that misses a few still sees every booking, and it stays short enough that
 * the page arrives while the call can still be cancelled.
 */
export const OFFSITE_ORIGIN_LOOKBACK_MS = 2 * 60 * 60_000;

/**
 * The per key cooldown. Not a tunable setting: its only job is to be LONGER than
 * the lookback, so a booking cannot be paged twice even when the batched
 * already-paged read fails. A week is far past any lookback this could be given.
 */
export const OFFSITE_ORIGIN_COOLDOWN_MS = 7 * 24 * 60 * 60_000;

/** The zone the page renders a call's time in, named in the text as ET. */
const ALERT_ZONE = "America/New_York";

/** The columns this check needs off a `bookings` row. */
export interface RecentBooking {
  id: string;
  bucket_id: string;
  starts_at: string;
  agent_name: string | null;
  agent_email: string | null;
  prefill: Record<string, string> | null;
}

/** The columns this check needs off a `buckets` row. */
export interface OriginBucket {
  id: string;
  code: string;
  name: string;
  is_test: boolean;
}

/** What a booking's recorded origin says about where it came from. */
export type BookingOrigin =
  | { kind: "none" }
  | { kind: "production"; origin: string }
  | { kind: "offsite"; origin: string }
  /** Something was recorded and it is not a web origin. Never echoed into Slack:
   *  the value is whatever somebody put in a URL. */
  | { kind: "unreadable" };

/**
 * Classify the recorded `parentOrigin`. Judged on the ORIGIN (scheme, host and
 * port), so `http://trypennie.com` and `https://trypennie.com:8443` are not the
 * production site, and a path or query on the value cannot make one match.
 */
export function classifyBookingOrigin(prefill: Record<string, string> | null | undefined): BookingOrigin {
  const raw = prefill?.parentOrigin;
  if (typeof raw !== "string" || raw.trim() === "") return { kind: "none" };
  let origin: string;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return { kind: "unreadable" };
    origin = url.origin;
  } catch {
    return { kind: "unreadable" };
  }
  return PRODUCTION_ORIGINS.includes(origin) ? { kind: "production", origin } : { kind: "offsite", origin };
}

/** The origins this module pages about: anything recorded that is not production. */
export function isOffsiteOrigin(
  origin: BookingOrigin,
): origin is Extract<BookingOrigin, { kind: "offsite" | "unreadable" }> {
  return origin.kind === "offsite" || origin.kind === "unreadable";
}

/**
 * Was this booking made from a KNOWN TEST SOURCE? (#2737) The one answer, shared by
 * the off site page above and by every check that must not count a test booking
 * made in a real bucket as a lead (L261).
 *
 * Keyed on the recorded host page, because that is the one fact every embed booking
 * already carries (`prefill.parentOrigin`, set by widget.js from its own page). The
 * test bookings made on 2026-09-25 on XBC 100 and 112 came from a partner's
 * localhost page and from dev.trypennie.com, and a real lead books from the
 * production site. So the test is "a host was recorded and it is not one of
 * `PRODUCTION_ORIGINS`", derived from the same list rather than a second list of
 * test hosts: a list of test hosts would miss the next staging or preview host,
 * where this catches it by construction, and a real production host missing from
 * `PRODUCTION_ORIGINS` is paged about by the check above on its first booking.
 *
 * What it deliberately does NOT recognise, so a reader knows what still counts:
 * a booking with NO host recorded (the standalone /book page, the booking API, an
 * admin booking) and a test made FROM the production site. Neither carries anything
 * that separates it from a lead. Test buckets are the other half of "is this a
 * test", decided by `buckets.is_test`, and callers ask that separately.
 */
export function isTestSourceBooking(prefill: Record<string, string> | null | undefined): boolean {
  return isOffsiteOrigin(classifyBookingOrigin(prefill));
}

/** One booking worth a page. */
export interface OffsiteFinding {
  booking: RecentBooking;
  bucket: OriginBucket;
  origin: Extract<BookingOrigin, { kind: "offsite" | "unreadable" }>;
}

/**
 * The page. Leads with what happened and to whom, then the one decision the reader
 * has to make, then the link to the booking in Admin, where it can be cancelled.
 * The lead's own manage link is deliberately NOT used: it carries the lead's token,
 * and a Slack channel is not somewhere a credential belongs.
 */
export function formatOffsiteOriginAlert(f: OffsiteFinding, bookingUrl: string): string {
  const when = `${formatSlotDay(f.booking.starts_at, ALERT_ZONE)} at ${formatSlotTime(f.booking.starts_at, ALERT_ZONE)} ET`;
  const agent = f.booking.agent_name?.trim() || f.booking.agent_email || "an unassigned advisor";
  const from =
    f.origin.kind === "offsite"
      ? `from ${f.origin.origin}`
      : "from a host page whose address Slate cannot read";
  return (
    `A booking on a real bucket came ${from}, which is not the production site. ` +
    `It is with ${agent} in bucket ${f.bucket.code} (${f.bucket.name}) on ${when}. ` +
    `If it was a test, cancel it so the advisor and the reminder texts stop; if it was a ` +
    `real lead, the page they booked from needs checking.\n${bookingUrl}`
  );
}

export interface OffsiteOriginDeps {
  /** Bookings created inside the lookback, on the buckets below. THROWS on a failed
   *  read: an empty list here would read as "nothing came from off site". */
  loadBookings: () => Promise<RecentBooking[]>;
  /** The bucket list, test buckets included, so a test booking is skipped by name. */
  buckets: OriginBucket[];
  /** Which of these alert keys already carry a send stamp. May throw; the
   *  dispatcher's cooldown is the second line then. */
  alreadyPaged: (keys: string[]) => Promise<Set<string>>;
  notify: ThrottledNotify<unknown>;
  bookingUrl: (bookingId: string) => string;
}

export type OffsiteOriginResult =
  | { status: "unreadable"; error: string }
  | {
      status: "checked";
      /** Real bucket bookings read. */
      checked: number;
      production: number;
      /** No origin recorded: counted, never paged. */
      noOrigin: number;
      /** On a test bucket: skipped whatever the origin. */
      testBucket: number;
      /** On a bucket the list does not hold, so it cannot be called real. */
      unknownBucket: number;
      /** Off site or unreadable, whether or not paged this tick. */
      offsite: number;
      paged: number;
      alreadyPaged: number;
      /** A send that threw; it is retried next tick while inside the lookback. */
      sendFailed: number;
      /** The batched already-paged read failed and the cooldown decided instead. */
      dedupeUnread: boolean;
    };

/**
 * One monitor tick. A failed bookings read measures nothing and pages nothing, and
 * says so in its own status rather than as zero off site bookings (#1134, #1152).
 */
export async function runOffsiteOriginCheck(deps: OffsiteOriginDeps): Promise<OffsiteOriginResult> {
  let bookings: RecentBooking[];
  try {
    bookings = await deps.loadBookings();
  } catch (err) {
    return { status: "unreadable", error: err instanceof Error ? err.message : String(err) };
  }

  const bucketById = new Map(deps.buckets.map((b) => [b.id, b]));
  let checked = 0;
  let production = 0;
  let noOrigin = 0;
  let testBucket = 0;
  let unknownBucket = 0;
  const findings: OffsiteFinding[] = [];

  for (const booking of bookings) {
    const bucket = bucketById.get(booking.bucket_id);
    if (!bucket) {
      unknownBucket++;
      continue;
    }
    if (bucket.is_test) {
      testBucket++;
      continue;
    }
    checked++;
    const origin = classifyBookingOrigin(booking.prefill);
    if (origin.kind === "none") noOrigin++;
    else if (origin.kind === "production") production++;
    else if (isOffsiteOrigin(origin)) findings.push({ booking, bucket, origin });
  }

  let stamped = new Set<string>();
  let dedupeUnread = false;
  if (findings.length > 0) {
    try {
      stamped = await deps.alreadyPaged(findings.map((f) => offsiteOriginKey(f.booking.id)));
    } catch {
      dedupeUnread = true;
    }
  }

  let paged = 0;
  let alreadyPaged = 0;
  let sendFailed = 0;
  for (const f of findings) {
    const key = offsiteOriginKey(f.booking.id);
    if (stamped.has(key)) {
      alreadyPaged++;
      continue;
    }
    try {
      await deps.notify(key, OFFSITE_ORIGIN_COOLDOWN_MS, formatOffsiteOriginAlert(f, deps.bookingUrl(f.booking.id)));
      paged++;
    } catch {
      sendFailed++;
    }
  }

  return {
    status: "checked",
    checked,
    production,
    noOrigin,
    testBucket,
    unknownBucket,
    offsite: findings.length,
    paged,
    alreadyPaged,
    sendFailed,
    dedupeUnread,
  };
}
