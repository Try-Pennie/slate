import type { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/log";
import { parseStampMs } from "@/lib/date/stamp";
import type { BookingSource } from "@/lib/booking/booking-source";
import {
  LOW_PAGES_ON_SLATE,
  PAGE_SEEN_LOOKBACK_DAYS,
  pageTrafficFilter,
  UNSOURCED_VALUES,
  type PageSourceMeasure,
} from "@/lib/monitor/page-volume";
import { LOW_TIER, VOLUME_TIERS, recordOfTiers, tierCodePattern, type VolumeTier } from "@/lib/monitor/volume-tiers";

/**
 * The embed every read here joins on: the bucket's test flag, which is the only
 * place test-ness lives, and its code, whose first digit is the booking's tier
 * (#2874). One string, so the reads cannot select different columns of it.
 */
const BUCKET_EMBED = "buckets!inner(is_test, code)";

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
  // cap-safe: a head-only exact count returns no rows.
  const { count, error } = await db
    .from("bookings")
    .select(`*, ${BUCKET_EMBED}`, { count: "exact", head: true })
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
    .like("buckets.code", tierCodePattern(tier))
    .gte("created_at", sinceIso);
  if (error) {
    log.error("monitor", { msg: "booking volume count read failed", since: sinceIso, tier }, error);
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
 *
 * #2874: one tier's bookings, the tier the pages' floors were fitted to, so another
 * tier booking through the same pages cannot hold a page's count up.
 */
export async function listCustomerBookingSourcesSince(
  db: ReturnType<typeof supabaseAdmin>,
  sinceIso: string,
  tier: VolumeTier,
): Promise<{ createdMs: number; source: string | null }[]> {
  const { data, error } = await db
    .from("bookings")
    .select(`created_at, source, ${BUCKET_EMBED}`)
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
 * answer that changes what the page says. Scoped to one tier, as the list above.
 */
export async function customerBookingFromSourcesSince(
  db: ReturnType<typeof supabaseAdmin>,
  sources: readonly BookingSource[],
  sinceIso: string,
  tier: VolumeTier,
): Promise<boolean> {
  // cap-safe: at most one row, it is an existence check.
  const { data, error } = await db
    .from("bookings")
    .select(`id, ${BUCKET_EMBED}`)
    .eq("buckets.is_test", false)
    // #2073: routed bookings only, as the count above.
    .eq("kind", "routed")
    .like("buckets.code", tierCodePattern(tier))
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
    // cap-safe: at most one row, the earliest.
    const { data, error } = await db
      .from("bookings")
      .select(`created_at, ${BUCKET_EMBED}`)
      .eq("buckets.is_test", false)
      .eq("kind", "routed")
      .or(pageTrafficFilter())
      .like("buckets.code", tierCodePattern(tier))
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: true })
      .limit(1);
    if (error) {
      log.error("monitor", { msg: "first tier booking read failed", tier, since: sinceIso }, error);
      throw new Error(`volume tiers: could not read tier ${tier}'s first booking`);
    }
    const row = ((data ?? []) as { created_at: string }[])[0];
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
  const realBookings = await countCustomerBookingsSince(db, sinceIso, LOW_TIER);
  if (realBookings === null) throw new Error("page sources: the real booking count could not be read");
  // cap-safe: head-only exact count, no rows. A null source is a booking from before #2072.
  const { count: unsourced, error } = await db
    .from("bookings")
    .select(`id, ${BUCKET_EMBED}`, { count: "exact", head: true })
    .eq("buckets.is_test", false)
    // #2073: routed bookings only. An agent's own link carries no page source, so
    // counting its bookings would read as landing pages dropping theirs.
    .eq("kind", "routed")
    .like("buckets.code", tierCodePattern(LOW_TIER))
    .or(["source.is.null", ...UNSOURCED_VALUES.map((v) => `source.eq.${v}`)].join(","))
    .gte("created_at", sinceIso);
  if (error || unsourced === null) {
    log.error("monitor", { msg: "unsourced booking count failed", since: sinceIso }, error ?? undefined);
    throw new Error("page sources: the unsourced count could not be read");
  }
  const pages: PageSourceMeasure["pages"] = [];
  for (const page of LOW_PAGES_ON_SLATE) {
    pages.push({
      id: page.id,
      name: page.name,
      recorded: await customerBookingFromSourcesSince(db, page.sources, sinceIso, LOW_TIER),
    });
  }
  return { lookbackDays: PAGE_SEEN_LOOKBACK_DAYS, realBookings, unsourced, pages };
}
