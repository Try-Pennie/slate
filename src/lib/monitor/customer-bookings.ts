import type { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/log";
import { parseStampMs } from "@/lib/date/stamp";
import type { BookingSource } from "@/lib/booking/booking-source";
import {
  isHostlessUnsourced,
  isUnsourced,
  LOW_PAGES_ON_SLATE,
  PAGE_SEEN_LOOKBACK_DAYS,
  pageTrafficFilter,
  UNSOURCED_VALUES,
  type PageSourceMeasure,
} from "@/lib/monitor/page-volume";
import { isHostlessBooking, isTestSourceBooking } from "@/lib/monitor/offsite-origin";
import { selectAllPages } from "@/lib/supabase/paginate";
import { LOW_TIER, VOLUME_TIERS, recordOfTiers, tierCodePattern, type VolumeTier } from "@/lib/monitor/volume-tiers";

/**
 * The embed every read here joins on: the bucket's test flag, which is the only
 * place test-ness lives, and its code, whose first digit is the booking's tier
 * (#2874). One string, so the reads cannot select different columns of it.
 */
const BUCKET_EMBED = "buckets!inner(is_test, code)";

/**
 * The two recorded host page facts (#2728), selected without the rest of `prefill`,
 * which carries the lead's contact: only `parentOrigin` is read out of it (#2960).
 */
const ORIGIN_COLUMNS = "referrer_origin, parent_origin:prefill->>parentOrigin";

/** The origin columns as a row carries them. */
interface OriginRow {
  referrer_origin: string | null;
  parent_origin: string | null;
}

/** A row's two recorded origins in the shape the off site predicates read. */
function originFacts(r: OriginRow) {
  return {
    prefill: r.parent_origin == null ? null : { parentOrigin: r.parent_origin },
    referrer_origin: r.referrer_origin,
  };
}

/** Whether a row recorded no host page, through the one predicate (#2960). */
function rowIsHostless(r: OriginRow): boolean {
  return isHostlessBooking(originFacts(r));
}

/**
 * Whether a row is TEST traffic made from a development host on a real bucket
 * (#2974): a localhost page, dev.trypennie.com, any host recorded that is not the
 * production site. Judged by `isTestSourceBooking`, the one predicate the off site
 * page, the below tier check, the cross system reconciliation and the failure rate
 * tally already read (L261), so every volume read here leaves out exactly the
 * bookings those leave out.
 *
 * Excluded HERE, where the bookings are read, never stamped where they are written
 * (L559): the predicate is derived from `PRODUCTION_ORIGINS`, so a production host
 * added to that list later reclassifies every past booking at once, where a stamp
 * would have frozen the mistake into the row. And a misclassified real page is not
 * hidden: every booking this leaves out was paged about, once and by name, by the
 * off site check (`booking_offsite_origin`), whose text asks whether it was a test.
 */
function rowIsTestSource(r: OriginRow): boolean {
  return isTestSourceBooking(originFacts(r));
}

/**
 * How many rows an existence read looks through for one that is not test traffic
 * (#2974). Development host bookings are rare (13 on real buckets ever, the last on
 * 2026-09-29), so a full page of them is not an answer: it refuses instead.
 */
const FIRST_REAL_SCAN = 50;

/** The first row that is not test traffic, refusing when a full scan held none. */
function firstRealRow<T extends OriginRow>(rows: T[], what: string): T | null {
  const real = rows.find((r) => !rowIsTestSource(r));
  if (real) return real;
  if (rows.length >= FIRST_REAL_SCAN) {
    throw new Error(`${what}: the first ${FIRST_REAL_SCAN} bookings were all test traffic from development hosts`);
  }
  return null;
}

/**
 * Customer bookings created since `sinceIso`, for the low-volume alarm (#370).
 *
 * The alarm exists to notice that CUSTOMERS have stopped booking, so the one thing
 * it must never count is Slate booking against itself. The smoke canary makes
 * roughly 8 bookings every 6 hours and will do so forever (#396), and a floor
 * measured against those cannot tell a quiet afternoon from a dead funnel: today
 * the last 6 hours hold 8 bookings and 0 of them are real.
 *
 * `bookings` has no is_test column, so test-ness is a property of the BUCKET, which
 * is why this is an inner join with an embedded filter rather than a plain column
 * predicate. Verified against the live API before it was written: the same window
 * returns 8 unfiltered and 0 filtered.
 *
 * #2974: the bookings are read as rows (an id and the two recorded origins each)
 * rather than as a head count, so test traffic from a development host on a real
 * bucket is left out by the shared predicate (`rowIsTestSource`). The alarm's
 * windows (30 and 120 minutes) are one page; subrequests are not a constraint
 * since Cloudflare lifted the cap (docs/cloudflare-platform-notes.md).
 *
 * Returns null when the read FAILED, never 0 (#1158, and the wider rule in
 * AGENTS.md): zero is the value that pages, so an errored query must present as
 * unverified and let the caller skip the tick rather than invent a drought.
 *
 * #2874: ONE tier's bookings, the tier whose floors the count is judged against, so
 * widening the pilot to another tier can never hold this tier's count up. Required
 * rather than defaulted to Low, so every caller names the tier it means (L168).
 */
export async function countCustomerBookingsSince(
  db: ReturnType<typeof supabaseAdmin>,
  sinceIso: string,
  tier: VolumeTier,
): Promise<number | null> {
  // #2974: read as ROWS, not a head count, so each booking's host page is judged by
  // the shared predicate in code; a SQL copy of it would be a second rule that can
  // drift from the first. Paged, so a long lookback (the measurement's seven days, about
  // 1,300 Low bookings) is read whole rather than truncated at one page.
  //
  // #2073: routed bookings only. A booking through an agent's own link is a later call
  // with a lead the funnel already sent, so counting it would hold the alarm quiet while
  // customers stopped arriving.
  //
  // #2876: page traffic only (`isPageTraffic`). A booking API call names its caller and
  // came from no landing page, and the floors were fitted to page traffic, so a steady
  // API stream would hold the count above its floor while every page was dark. Null (a
  // booking from before #2072) is kept explicitly, because `not in` alone drops a null.
  //
  // The chain is kept short on purpose: the test data guard reads the 14 lines from
  // `.from(` for the count, and must see `rows.length` there (scripts/test-test-data-counts.ts).
  const rows = await selectAllPages<OriginRow>("booking volume count", "id", () =>
    db
      .from("bookings")
      .select(`id, ${ORIGIN_COLUMNS}, ${BUCKET_EMBED}`)
      .eq("buckets.is_test", false)
      .eq("kind", "routed")
      .or(pageTrafficFilter())
      .like("buckets.code", tierCodePattern(tier))
      .gte("created_at", sinceIso),
  ).catch((err: unknown) => {
    log.error("monitor", { msg: "booking volume count read failed", since: sinceIso, tier }, err instanceof Error ? err : undefined);
    return null;
  });
  if (rows === null) return null;
  const testSource = rows.filter(rowIsTestSource).length;
  if (testSource > 0) {
    log.info("monitor", { msg: "booking volume count left out test traffic from development hosts", since: sinceIso, tier, test_source: testSource });
  }
  return rows.length - testSource;
}

/**
 * The most bookings the per page read accepts (#2738). Two hours of Low traffic is
 * about 50; a full page means the list was cut short, and a short list undercounts
 * every page at once, so it refuses rather than answers.
 */
export const SOURCE_READ_LIMIT = 1000;

/**
 * Customer bookings created since `sinceIso`, each with the page it came from
 * (`bookings.source`, #2072), for the per page low volume alarm (#2738).
 *
 * ONE read for every page, counted in code, so three pages cost one subrequest on
 * a budget four cron lanes share rather than six. The same test-bucket rule as the
 * count above. THROWS on a failed read, a full page or an unreadable timestamp:
 * each of those answered as a list would read as pages that stopped booking, which
 * is the answer that pages. The lane's step boundary reports the throw.
 *
 * #2874: one tier's bookings, the tier the pages' floors were fitted to, so another
 * tier booking through the same pages cannot hold a page's count up.
 */
export async function listCustomerBookingSourcesSince(
  db: ReturnType<typeof supabaseAdmin>,
  sinceIso: string,
  tier: VolumeTier,
): Promise<{ createdMs: number; source: string | null; hostless: boolean }[]> {
  const { data, error } = await db
    .from("bookings")
    .select(`created_at, source, ${ORIGIN_COLUMNS}, ${BUCKET_EMBED}`)
    .eq("buckets.is_test", false)
    // #2073: routed bookings only, as the count above.
    .eq("kind", "routed")
    .like("buckets.code", tierCodePattern(tier))
    .gte("created_at", sinceIso)
    .limit(SOURCE_READ_LIMIT);
  if (error) {
    log.error("monitor", { msg: "page volume read failed", since: sinceIso }, error);
    throw new Error("page volume: could not read the bookings list");
  }
  const rows = (data ?? []) as ({ created_at: string; source: string | null } & OriginRow)[];
  if (rows.length >= SOURCE_READ_LIMIT) {
    throw new Error(`page volume: the bookings list came back truncated at ${SOURCE_READ_LIMIT} rows`);
  }
  // #2974: test traffic from a development host is no page's booking.
  return rows
    .filter((r) => !rowIsTestSource(r))
    .map((r) => {
      const createdMs = parseStampMs(r.created_at);
      if (createdMs === null) throw new Error("page volume: a booking's created_at is unreadable");
      return { createdMs, source: r.source, hostless: rowIsHostless(r) };
    });
}

/**
 * Whether ANY customer booking since `sinceIso` carried one of `sources` (#2738):
 * the difference between a page that stopped booking and one whose link never
 * carried a source. Throws on a failed read, because "never recorded" is the
 * answer that changes what the page says. Scoped to one tier, as the list above.
 */
export async function customerBookingFromSourcesSince(
  db: ReturnType<typeof supabaseAdmin>,
  sources: readonly BookingSource[],
  sinceIso: string,
  tier: VolumeTier,
): Promise<boolean> {
  // cap-safe: at most FIRST_REAL_SCAN rows, it is an existence check that looks past
  // test traffic from a development host (#2974).
  const { data, error } = await db
    .from("bookings")
    .select(`id, ${ORIGIN_COLUMNS}, ${BUCKET_EMBED}`)
    .eq("buckets.is_test", false)
    // #2073: routed bookings only, as the count above.
    .eq("kind", "routed")
    .like("buckets.code", tierCodePattern(tier))
    .in("source", [...sources])
    .gte("created_at", sinceIso)
    .limit(FIRST_REAL_SCAN);
  if (error) {
    log.error("monitor", { msg: "page source lookup failed", since: sinceIso }, error);
    throw new Error("page volume: could not read whether the page has recorded a booking");
  }
  return firstRealRow((data ?? []) as OriginRow[], "page volume") !== null;
}

/**
 * Each tier's first real page booking at or after `sinceIso`, or null for a tier
 * nobody has booked (#2874). This is what decides which tiers Slate carries and
 * when each one's floors may start being learned: derived from the bookings it
 * actually takes, never a constant somebody has to edit when the pilot widens.
 *
 * The same population the alarm counts (a real bucket, routed, page traffic), so a
 * test booking, an agent's own link or a booking API call can never start a tier.
 * One existence read per tier, run by the once a day refit rather than every tick.
 * THROWS on any failed read: an empty answer is "no tier is carried", which would
 * stop every tier learning on a read that never ran.
 */
export async function firstTierBookingsSince(
  db: ReturnType<typeof supabaseAdmin>,
  sinceIso: string,
): Promise<Record<VolumeTier, number | null>> {
  const out: [VolumeTier, number | null][] = [];
  for (const tier of VOLUME_TIERS) {
    // cap-safe: at most FIRST_REAL_SCAN rows, the earliest, looking past test traffic
    // from a development host (#2974).
    const { data, error } = await db
      .from("bookings")
      .select(`created_at, ${ORIGIN_COLUMNS}, ${BUCKET_EMBED}`)
      .eq("buckets.is_test", false)
      .eq("kind", "routed")
      .or(pageTrafficFilter())
      .like("buckets.code", tierCodePattern(tier))
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: true })
      .limit(FIRST_REAL_SCAN);
    if (error) {
      log.error("monitor", { msg: "first tier booking read failed", tier, since: sinceIso }, error);
      throw new Error(`volume tiers: could not read tier ${tier}'s first booking`);
    }
    const row = firstRealRow((data ?? []) as ({ created_at: string } & OriginRow)[], `volume tiers: tier ${tier}`);
    if (!row) {
      out.push([tier, null]);
      continue;
    }
    const ms = parseStampMs(row.created_at);
    if (ms === null) throw new Error(`volume tiers: tier ${tier}'s first booking has an unreadable created_at`);
    out.push([tier, ms]);
  }
  return recordOfTiers(out);
}

/**
 * Whether the Low pages' bookings are carrying their source (#2765, #2767): real
 * bookings over the per page alarm's own lookback, how many recorded no page, and
 * whether each page recorded one of its own. ONE measurement, read by the readiness
 * gate and by /admin/alerts, so the two can never count differently. Of the Low
 * tier only (#2874), because the pages' floors, and the per page alarm that reads
 * the same rows, are Low's.
 *
 * Throws on any failed read. Every caller maps that to "could not be read", never
 * to zero unsourced, which is the answer that would show floors as coverage.
 */
export async function measurePageSources(
  db: ReturnType<typeof supabaseAdmin>,
  nowMs: number,
): Promise<PageSourceMeasure> {
  const sinceIso = new Date(nowMs - PAGE_SEEN_LOOKBACK_DAYS * 86_400_000).toISOString();
  // #2876: page traffic only, the same count the tier alarm reads, so a lookback
  // holding only booking API calls reads as no page traffic rather than as every
  // booking having carried a source.
  const pageTraffic = await countCustomerBookingsSince(db, sinceIso, LOW_TIER);
  if (pageTraffic === null) throw new Error("page sources: the real booking count could not be read");
  // The bookings that recorded no page, as ROWS rather than a count (#2960): whether
  // each one had a host page decides whether it counts, and that is judged in code by
  // the same predicates the per page step uses, never by a second filter here (L16).
  // A null source is a booking from before #2072.
  const { data, error } = await db
    .from("bookings")
    .select(`source, ${ORIGIN_COLUMNS}, ${BUCKET_EMBED}`)
    .eq("buckets.is_test", false)
    // #2073: routed bookings only. An agent's own link carries no page source, so
    // counting its bookings would read as landing pages dropping theirs.
    .eq("kind", "routed")
    .like("buckets.code", tierCodePattern(LOW_TIER))
    .or(["source.is.null", ...UNSOURCED_VALUES.map((v) => `source.eq.${v}`)].join(","))
    .gte("created_at", sinceIso)
    .limit(SOURCE_READ_LIMIT);
  if (error) {
    log.error("monitor", { msg: "unsourced booking read failed", since: sinceIso }, error);
    throw new Error("page sources: the unsourced bookings could not be read");
  }
  const read = (data ?? []) as ({ source: string | null } & OriginRow)[];
  // A short list would undercount the unsourced, which is the answer that shows the
  // floors as coverage, so a full page refuses rather than answers.
  if (read.length >= SOURCE_READ_LIMIT) {
    throw new Error(`page sources: the unsourced bookings came back truncated at ${SOURCE_READ_LIMIT} rows`);
  }
  // #2974: test traffic from a development host is left out here as the count above
  // leaves it out, so the share is quoted over one population.
  const noPage = read
    .filter((r) => !rowIsTestSource(r))
    .map((r) => ({ source: r.source, hostless: rowIsHostless(r) }));
  const unsourced = noPage.filter(isUnsourced).length;
  const hostless = noPage.filter(isHostlessUnsourced).length;
  // The count the share is quoted against leaves the set aside bookings out, as the
  // per page step's total does: they could not have been any page's.
  const realBookings = pageTraffic - hostless;
  const pages: PageSourceMeasure["pages"] = [];
  for (const page of LOW_PAGES_ON_SLATE) {
    pages.push({
      id: page.id,
      name: page.name,
      recorded: await customerBookingFromSourcesSince(db, page.sources, sinceIso, LOW_TIER),
    });
  }
  return { lookbackDays: PAGE_SEEN_LOOKBACK_DAYS, realBookings, unsourced, hostless, pages };
}
