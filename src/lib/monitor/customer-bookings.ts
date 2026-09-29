import type { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/log";
import { parseStampMs } from "@/lib/date/stamp";
import type { BookingSource } from "@/lib/booking/booking-source";
import {
  LOW_PAGES,
  PAGE_SEEN_LOOKBACK_DAYS,
  pageTrafficFilter,
  UNSOURCED_VALUES,
  type PageSourceMeasure,
} from "@/lib/monitor/page-volume";

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
 * returns 8 unfiltered and 0 filtered, with `head: true` and an exact count, so
 * this still costs one subrequest on a budget four cron lanes share.
 *
 * Returns null when the read FAILED, never 0 (#1158, and the wider rule in
 * AGENTS.md): zero is the value that pages, so an errored query must present as
 * unverified and let the caller skip the tick rather than invent a drought.
 */
export async function countCustomerBookingsSince(
  db: ReturnType<typeof supabaseAdmin>,
  sinceIso: string,
): Promise<number | null> {
  // cap-safe: a head-only exact count returns no rows.
  const { count, error } = await db
    .from("bookings")
    .select("*, buckets!inner(is_test)", { count: "exact", head: true })
    .eq("buckets.is_test", false)
    // #2073: routed bookings only. A booking through an agent's own link is a
    // later call with a lead the funnel already sent, so counting it would hold
    // the alarm quiet while customers stopped arriving.
    .eq("kind", "routed")
    // #2876: page traffic only (`isPageTraffic`). A booking API call names its
    // caller and came from no landing page, and the floors were fitted to page
    // traffic, so a steady API stream would hold the count above its floor while
    // every page was dark. Null (a booking from before #2072) is kept explicitly,
    // because `not in` alone drops a null.
    .or(pageTrafficFilter())
    .gte("created_at", sinceIso);
  if (error) {
    log.error("monitor", { msg: "booking volume count read failed", since: sinceIso }, error);
    return null;
  }
  return count ?? 0;
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
 */
export async function listCustomerBookingSourcesSince(
  db: ReturnType<typeof supabaseAdmin>,
  sinceIso: string,
): Promise<{ createdMs: number; source: string | null }[]> {
  const { data, error } = await db
    .from("bookings")
    .select("created_at, source, buckets!inner(is_test)")
    .eq("buckets.is_test", false)
    // #2073: routed bookings only, as the count above.
    .eq("kind", "routed")
    .gte("created_at", sinceIso)
    .limit(SOURCE_READ_LIMIT);
  if (error) {
    log.error("monitor", { msg: "page volume read failed", since: sinceIso }, error);
    throw new Error("page volume: could not read the bookings list");
  }
  const rows = (data ?? []) as { created_at: string; source: string | null }[];
  if (rows.length >= SOURCE_READ_LIMIT) {
    throw new Error(`page volume: the bookings list came back truncated at ${SOURCE_READ_LIMIT} rows`);
  }
  return rows.map((r) => {
    const createdMs = parseStampMs(r.created_at);
    if (createdMs === null) throw new Error("page volume: a booking's created_at is unreadable");
    return { createdMs, source: r.source };
  });
}

/**
 * Whether ANY customer booking since `sinceIso` carried one of `sources` (#2738):
 * the difference between a page that stopped booking and one whose link never
 * carried a source. Throws on a failed read, because "never recorded" is the
 * answer that changes what the page says.
 */
export async function customerBookingFromSourcesSince(
  db: ReturnType<typeof supabaseAdmin>,
  sources: readonly BookingSource[],
  sinceIso: string,
): Promise<boolean> {
  // cap-safe: at most one row, it is an existence check.
  const { data, error } = await db
    .from("bookings")
    .select("id, buckets!inner(is_test)")
    .eq("buckets.is_test", false)
    // #2073: routed bookings only, as the count above.
    .eq("kind", "routed")
    .in("source", [...sources])
    .gte("created_at", sinceIso)
    .limit(1);
  if (error) {
    log.error("monitor", { msg: "page source lookup failed", since: sinceIso }, error);
    throw new Error("page volume: could not read whether the page has recorded a booking");
  }
  return (data ?? []).length > 0;
}

/**
 * Whether the Low pages' bookings are carrying their source (#2765, #2767): real
 * bookings over the per page alarm's own lookback, how many recorded no page, and
 * whether each page recorded one of its own. ONE measurement, read by the readiness
 * gate and by /admin/alerts, so the two can never count differently.
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
  const realBookings = await countCustomerBookingsSince(db, sinceIso);
  if (realBookings === null) throw new Error("page sources: the real booking count could not be read");
  // cap-safe: head-only exact count, no rows. A null source is a booking from before #2072.
  const { count: unsourced, error } = await db
    .from("bookings")
    .select("id, buckets!inner(is_test)", { count: "exact", head: true })
    .eq("buckets.is_test", false)
    // #2073: routed bookings only. An agent's own link carries no page source, so
    // counting its bookings would read as landing pages dropping theirs.
    .eq("kind", "routed")
    .or(["source.is.null", ...UNSOURCED_VALUES.map((v) => `source.eq.${v}`)].join(","))
    .gte("created_at", sinceIso);
  if (error || unsourced === null) {
    log.error("monitor", { msg: "unsourced booking count failed", since: sinceIso }, error ?? undefined);
    throw new Error("page sources: the unsourced count could not be read");
  }
  const pages: PageSourceMeasure["pages"] = [];
  for (const page of LOW_PAGES) {
    pages.push({
      id: page.id,
      name: page.name,
      recorded: await customerBookingFromSourcesSince(db, page.sources, sinceIso),
    });
  }
  return { lookbackDays: PAGE_SEEN_LOOKBACK_DAYS, realBookings, unsourced, pages };
}
