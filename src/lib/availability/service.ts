import { supabaseAdmin } from "@/lib/supabase/admin";
import { selectAllPages } from "@/lib/supabase/paginate";
import { unwrap } from "@/lib/db/result";
import {
  computeBucketSlots,
  freeMembersAtExactWindow,
  freeMembersForSlot,
  assembleMemberAvailability,
  capCountWindow,
  type MemberAvailability,
} from "@/lib/availability/compute";
import { loadBusinessHours } from "@/lib/booking/business-hours-load";
import { agentIdsFromPool } from "@/lib/availability/pool";
import { lowCarrierIds, withoutLowCarriers } from "@/lib/availability/low-exclusion";
import { poolServesLowExcludedRungs } from "@/lib/routing/tiers";
import {
  applyFallback,
  payPeriod,
  bucketShareFromResult,
  orderByBucketShare,
  shadowRankingDivergence,
} from "@/lib/availability/roundrobin";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { logAlertSendFailure } from "@/lib/notify/send-failure";
import { unfairOrderingAlert } from "@/lib/booking/alert-copy";
import type { Attributes, Booking, Bucket, Criteria, EventType } from "@/lib/db/types";
import { bufferedReadWindow, dropHeldAgents, parseLiveHolds, type LiveHold } from "@/lib/booking/reroute-hold";
import { bufferedWindow } from "@/lib/booking/buffered-window";
import { userIdsOnApprovedTimeOff } from "@/lib/ooo/approved-overlap";
import type { CurrentAgentPicture, RoundRobinOpts } from "@/lib/booking/orchestration";
import { log } from "@/lib/log";

export { agentIdsFromPool } from "@/lib/availability/pool";

/**
 * Resolves a bucket's raw pool data: active manual members, bookable org agents,
 * and the bucket's criteria. Used by the decision log (Task 7) to classify
 * exclusions; `resolveBucketAgentIds` delegates here so there is one source of truth.
 */
export async function resolveBucketPool(bucket: Bucket): Promise<{
  orgAgents: { id: string; attributes: Attributes }[];
  manualMemberIds: Set<string>;
  criteria: Criteria;
}> {
  const db = supabaseAdmin();
  // The manual-members and org-agents reads are independent, so fire them
  // together: one round-trip instead of two on the availability hot path.
  const [membersRes, agentsRes] = await Promise.all([
    db.from("bucket_members").select("user_id").eq("bucket_id", bucket.id).eq("active", true),
    // One pass over org agents: include a bookable agent if they're a manual
    // member OR match the criteria. Non-bookable and deactivated (offboarded)
    // agents never enter the pool.
    db
      .from("users")
      .select("id, attributes, bookable")
      .eq("org_id", bucket.org_id)
      .eq("bookable", true)
      .is("deactivated_at", null),
  ]);
  // Fail loud on a query error (#277): a broken read here used to swallow into
  // an empty pool and silently show no availability. Throw instead.
  const manualMemberIds = new Set(
    (unwrap(membersRes, "bucket_members") ?? []).map(
      (m) => (m as { user_id: string }).user_id,
    ),
  );
  const orgAgents = (unwrap(agentsRes, "bucket pool agents") ?? []).map((a) => {
    const row = a as { id: string; attributes: Attributes };
    return { id: row.id, attributes: row.attributes };
  });
  return { orgAgents, manualMemberIds, criteria: bucket.criteria ?? {} };
}

/**
 * Resolves a bucket's round-robin pool: active manual members UNION agents in
 * the org whose attributes match the bucket criteria. Either source may be
 * empty; manual selection and attribute routing compose.
 */
export async function resolveBucketAgentIds(bucket: Bucket): Promise<string[]> {
  return (await resolveBucketAgentPool(bucket)).ids;
}

/**
 * The agents a bucket's criteria match, with the manual members unioned in.
 *
 * It used to also report whether a legal restriction had been dropped to find
 * anybody (#2158). Ten codes carried that criterion and matched nobody, so
 * every lead on them was served by widening the criteria at request time and
 * telling somebody about it in Slack. #2218 removed the criterion from those
 * buckets instead, so there is nothing left to widen and the pool is simply the
 * pool.
 */
export async function resolveBucketAgentPool(
  bucket: Bucket,
): Promise<{ ids: string[]; lowIds: string[] }> {
  const { orgAgents, manualMemberIds, criteria } = await resolveBucketPool(bucket);
  // #2842: which of the org's bookable agents carry Low, read from the SAME rows
  // the pool was matched from, so the exclusion costs no second read. It is over
  // the whole org rather than the pool, because the fallback agent is looked up
  // separately and has to be judged too; callers narrow it to the ids they return.
  return {
    ids: agentIdsFromPool(orgAgents, manualMemberIds, criteria),
    lowIds: lowCarrierIds(orgAgents),
  };
}

/**
 * The agents eligible for a bucket, with the fallback applied: the matched pool
 * (manual ∪ attribute), or — when that's empty and the bucket has a
 * `fallback_user_id` — just the fallback agent. `fallbackApplied` flags which.
 */
/**
 * Resolves a bucket's eligible agent ids. The live `eligibleAgentIds` is the
 * default everywhere; the recompute lane injects the 60s cached resolver
 * (`eligibleAgentIdsCached`) so all cron lanes in a tick share one eligibility
 * read per bucket, while the booker read + booking verify stay live (#421/#508).
 */
export type EligibleResolver = (bucket: Bucket) => Promise<EligibleAgents>;

/**
 * A bucket's eligible agents. `lowIds` is which of `ids` carry Low (#2842), for a
 * top tier lead's cascade, which must skip them. OPTIONAL and absent means
 * UNKNOWN, never "nobody": a resolver that does not supply it (the named link
 * resolver, an eligibility cache entry written before the field existed) makes
 * `withoutLowCarriers` offer nobody rather than everybody.
 */
export type EligibleAgents = { ids: string[]; fallbackApplied: boolean; lowIds?: string[] };

export async function eligibleAgentIds(bucket: Bucket): Promise<EligibleAgents> {
  const pool = await resolveBucketAgentPool(bucket);
  const matched = pool.ids;
  const withLow = (r: { ids: string[]; fallbackApplied: boolean }): EligibleAgents => {
    const low = new Set(pool.lowIds);
    return { ...r, lowIds: r.ids.filter((id) => low.has(id)) };
  };
  // The fallback is only consulted when the matched pool is empty, so skip the
  // eligibility round-trip otherwise. A stored fallback_user_id can point at an
  // agent who is no longer bookable (or, with offboarding, deactivated); never
  // route to them just because the pool came up empty.
  if (matched.length > 0 || !bucket.fallback_user_id) {
    return withLow(applyFallback(matched, bucket.fallback_user_id, false));
  }
  const db = supabaseAdmin();
  const fallback = unwrap(
    await db
      .from("users")
      .select("id")
      .eq("id", bucket.fallback_user_id)
      .eq("org_id", bucket.org_id)
      .eq("bookable", true)
      .is("deactivated_at", null)
      .maybeSingle(),
    "fallback agent",
  );
  return withLow(applyFallback(matched, bucket.fallback_user_id, !!fallback));
}

/**
 * The eligibility resolver for ONE named agent (#2073): the "pool" is them. The
 * link's own judge already decided they are bookable and not departed, so this
 * reads nothing.
 */
export function namedAgentResolver(userId: string): EligibleResolver {
  return async () => ({ ids: [userId], fallbackApplied: false });
}

/**
 * `inner` with every Low carrier removed (#2842). Fails closed with the helper it
 * uses: a result that did not say who carries Low yields nobody.
 */
export function lowExcludedResolver(inner: EligibleResolver): EligibleResolver {
  return async (bucket) => {
    const r = await inner(bucket);
    return { ...r, ids: withoutLowCarriers(r.ids, r.lowIds), lowIds: [] };
  };
}

export interface ResolvedBucket {
  bucket: Bucket;
  eventType: EventType;
}

/**
 * Look up a bucket by its public code (the `xbc` query param) + its event type.
 *
 * Deliberately org-less: Slate is single-org and a global unique index on
 * `buckets(code)` (#624, migration 0082) enforces that codes never collide
 * across orgs, so `.maybeSingle()` can match at most one row. A future second
 * org must thread org context into the embed contract rather than reusing codes.
 */
export async function resolveBucketByCode(
  code: string,
): Promise<ResolvedBucket | null> {
  const db = supabaseAdmin();
  // Fetch the bucket WITH its event type nested (one query instead of two
  // sequential cross-region hops) (#249). event_type_id is a FK to event_types.
  // event_types is embedded via the buckets.event_type_id FK; the DB
  // Relationships (#354) type the nested row, so no `unknown` cast is needed.
  const row = unwrap(
    await db
      .from("buckets")
      .select("*, event_types(*)")
      .eq("code", code)
      .maybeSingle(),
    "bucket by code",
  );
  if (!row) return null;

  const { event_types: eventType, ...bucket } = row;
  if (!eventType) return null;

  return { bucket: bucket as Bucket, eventType };
}

/** Loads cached availability for the bucket's resolved pool over [from, to]. */
export async function loadMembersAvailability(
  bucket: Bucket,
  from: string,
  to: string,
  resolveEligible: EligibleResolver = eligibleAgentIds,
  /**
   * #3248: leave out the busy blocks a reroute hold wrote. The candidate read and
   * the reroute search judge holds from `reroute_holds` itself, which ignores an
   * expired hold the instant it expires, rather than from its cached block, which
   * the self heal lane only clears within a minute. The slot cache keeps them, so it
   * stops offering a time only the held advisor could serve.
   */
  opts?: { excludeHoldBlocks?: boolean },
): Promise<{ members: MemberAvailability[]; lowIds: string[] | undefined }> {
  const db = supabaseAdmin();

  const { ids: userIds, lowIds } = await resolveEligible(bucket);
  if (userIds.length === 0) return { members: [], lowIds };

  // The daily-cap count is per agent per LOCAL day, so the bookings read must cover
  // the FULL local day of every day in [from, to] — not just the requested window.
  // The reroute/verify path calls this with a window only as long as the slot, which
  // left the cap count almost empty and the cap unenforced (#540). Widen the bookings
  // read by a day on each side (covers any timezone); the busy/calendar read keeps
  // the exact window so conflict logic is unchanged.
  const capWindow = capCountWindow(from, to);

  // The daily-cap count (#832) buckets each agent's bookings by their LOCAL day, so it
  // needs the agent's timezone, and it MUST be the SAME tz the compute uses for the
  // slot-day and working-hours checks, or the cap miscounts and overbooks. So resolve
  // schedules FIRST (one row per agent, single-shot, pool-bounded), then hand each
  // agent's tz to the server-side count RPC. busy_blocks reads in parallel throughout;
  // the count RPC then runs parallel with it once the tz map is known.
  const schedulesP = db
    .from("availability_schedules")
    .select(
      "id, user_id, timezone, availability_rules(schedule_id, weekday, start_minute, end_minute)",
    )
    .in("user_id", userIds);
  // busy_blocks over the whole pool + window is an aggregate; a large pool crosses
  // PostgREST's 1,000-row cap, so page past it (#828) or a silent truncation drops busy
  // blocks and an agent looks free and gets overbooked (#35 / #166). selectAllPages
  // orders the pages by id, without which OFFSET paging skipped rows and offered a
  // sold out Monday (#3273), and throws on a read error (fail-loud).
  const busyP = selectAllPages<{ user_id: string; starts_at: string; ends_at: string; source: string }>(
    "busy_blocks",
    "id",
    () =>
      db
        .from("busy_blocks")
        .select("user_id, starts_at, ends_at, source")
        .in("user_id", userIds)
        .lt("starts_at", to)
        .gt("ends_at", from),
  );

  // Fail loud on the schedules read (#277). availability_rules is embedded via the
  // rules.schedule_id FK; the DB Relationships (#354) type the nested rows, so no
  // `unknown` cast is needed.
  const schedules = unwrap(await schedulesP, "availability_schedules") ?? [];

  // Per-agent tz: the SAME last-wins pick assembleMemberAvailability makes (both fall
  // back to America/New_York for an agent with no schedule, matching the RPC's coalesce),
  // so the count's local-day bucketing matches the member's tz exactly.
  const tzByUser: Record<string, string> = {};
  for (const s of schedules) tzByUser[s.user_id] = s.timezone;

  const [busyRows, countRes] = await Promise.all([
    busyP,
    db.rpc("count_bookings_per_local_day", {
      p_user_ids: userIds,
      p_tz_by_user: tzByUser,
      p_from: capWindow.from,
      p_to: capWindow.to,
    }),
  ]);
  // Fail loud: a swallowed count error would under-count the cap and over-offer slots
  // (the #35 / #166 direction), so throw rather than default to an empty count.
  if (countRes.error) {
    throw new Error(`loadMembersAvailability: daily-cap count failed: ${countRes.error.message}`);
  }
  const dayCountsByUser = parseDayCounts(countRes.data);
  const busy = opts?.excludeHoldBlocks ? busyRows.filter((b) => b.source !== "hold") : busyRows;

  const rules = schedules.flatMap((s) => s.availability_rules ?? []);
  return {
    members: assembleMemberAvailability(userIds, schedules, rules, busy, dayCountsByUser),
    lowIds,
  };
}

/**
 * Parse the `count_bookings_per_local_day` RPC's jsonb (`"<user_id>|<local_date>" ->
 * count`) into a per-user local-date -> count map. Returning one jsonb scalar keeps the
 * whole count under a single PostgREST row, so it never hits the 1,000-row SETOF cap the
 * old paged row-read had to walk (#832).
 */
function parseDayCounts(data: unknown): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  if (!data || typeof data !== "object") return out;
  for (const [key, n] of Object.entries(data as Record<string, number>)) {
    const sep = key.indexOf("|");
    if (sep === -1) continue;
    const userId = key.slice(0, sep);
    const localDate = key.slice(sep + 1);
    const perDay = out.get(userId) ?? new Map<string, number>();
    perDay.set(localDate, n);
    out.set(userId, perDay);
  }
  return out;
}

export interface BucketSlots {
  bucket: Bucket;
  eventType: EventType;
  orgName: string;
  slots: string[];
  /**
   * #2842: the times at least one advisor who does NOT carry Low is free, for a
   * top tier lead cascaded onto this pool, who must never be offered a Low
   * carrier. Computed only for the pools such a lead can land on
   * (`poolServesLowExcludedRungs`), from the same members and the same rules as
   * `slots` in the same pass, so it costs no read.
   *
   * ABSENT means UNKNOWN and is read as "nobody": a row written before this field
   * existed, a pool no top tier lead can reach, or an eligibility result that did
   * not say who carries Low. Reading absence as "everybody" would hand a top tier
   * lead to exactly the advisors the rule keeps away.
   */
  slotsWithoutLow?: string[];
}

/** What `loadBucketSlotInputs` reads for one bucket code (#3258). */
export interface BucketSlotInputs {
  resolved: ResolvedBucket;
  /** The org name read. Its error is tolerated by the one reader (see getBucketSlots). */
  orgRes: { data: { name: string } | null; error: unknown };
  membersResult: Awaited<ReturnType<typeof loadMembersAvailability>>;
  businessHours: Awaited<ReturnType<typeof loadBusinessHours>>;
}

/**
 * Every read a bucket's slot compute needs, with no compute (#3258).
 *
 * Split out of `getBucketSlots` so the load run's `reads-only` arm of the post
 * confirm recompute makes EXACTLY the reads a recompute makes, through the same
 * code, rather than a copy that could drift from it (L41). Null when the code
 * names no bucket.
 */
export async function loadBucketSlotInputs(
  code: string,
  from: string,
  to: string,
  resolveEligible: EligibleResolver = eligibleAgentIds,
  /** #3324: a caller that already resolved the bucket (to size its window from the
   *  event type) passes it, rather than paying the same read twice. */
  preResolved?: ResolvedBucket,
): Promise<BucketSlotInputs | null> {
  const resolved = preResolved ?? (await resolveBucketByCode(code));
  if (!resolved) return null;
  const { bucket } = resolved;

  // Neither the org name nor the business hours depend on member availability, so
  // overlap all three instead of running them as sequential hops. `loadBusinessHours`
  // THROWS on an unreadable week (#1294), which propagates out of here on purpose:
  // `recomputeBucketSlots` catches it and leaves the previous good row standing
  // rather than writing an empty one, and the stale-bucket alarm surfaces it. The
  // alternative, serving an unfiltered list, would silently re-open hours an admin
  // had narrowed and nobody would see it.
  const [orgRes, membersResult, businessHours] = await Promise.all([
    supabaseAdmin()
      .from("organizations")
      .select("name")
      .eq("id", bucket.org_id)
      .maybeSingle(),
    loadMembersAvailability(bucket, from, to, resolveEligible),
    loadBusinessHours(),
  ]);
  return { resolved, orgRes, membersResult, businessHours };
}

/** Cached slot list for a bucket code: the read path for the embed modal. */
export async function getBucketSlots(
  code: string,
  from: string,
  to: string,
  resolveEligible: EligibleResolver = eligibleAgentIds,
): Promise<BucketSlots | null> {
  const inputs = await loadBucketSlotInputs(code, from, to, resolveEligible);
  if (!inputs) return null;
  return computeSlotsFromInputs(code, inputs, from, to, Date.now());
}

/**
 * The compute half of `getBucketSlots`, over inputs already read (#3324). Split out
 * so a booking's splice runs the SAME predicate over a narrow window whose busy time
 * it read slightly wider (by the buffers), rather than a copy of it (L41).
 */
export function computeSlotsFromInputs(
  code: string,
  inputs: BucketSlotInputs,
  from: string,
  to: string,
  nowMs: number,
): BucketSlots {
  const { resolved, orgRes, membersResult, businessHours } = inputs;
  const { bucket, eventType } = resolved;
  const members = membersResult.members;
  // error-ok: the org NAME's only consumer is the accessible name of the Booker's
  // logo mark (#2629), so an unreadable read degrades to a mark drawn as
  // decoration and nothing reads that emptiness as an answer. Failing the
  // whole availability compute over a decorative string would take the booker down
  // for a cosmetic value; the next recompute cycle refills it. The two reads BESIDE
  // it are the ones that matter and neither is null-tolerant: `loadBusinessHours`
  // throws (#1294) and `loadMembersAvailability` throws on its daily-cap count.
  const org = orgRes.data;
  const slotsFor = (pool: MemberAvailability[]) =>
    computeBucketSlots({
      members: pool,
      durationMin: eventType.duration_min,
      bufferBeforeMin: eventType.buffer_before_min,
      bufferAfterMin: eventType.buffer_after_min,
      minNoticeMin: eventType.min_notice_min,
      dailyCap: eventType.daily_cap,
      slotIntervalMin: eventType.slot_interval_min,
      businessHours,
      from,
      to,
      nowMs,
    });
  const slots = slotsFor(members);

  // #2842: the second pass, only where a top tier lead's cascade can read it, and
  // only when the resolver said who carries Low. One clock for both passes, so the
  // two lists judge minimum notice at the same instant.
  let slotsWithoutLow: string[] | undefined;
  if (poolServesLowExcludedRungs(code) && membersResult.lowIds !== undefined) {
    const keep = new Set(
      withoutLowCarriers(members.map((m) => m.userId), membersResult.lowIds),
    );
    // The pass is paid on the every minute recompute lane, whose headroom already
    // pages (#2021), so the two cases with a known answer skip it: nobody carries
    // Low (the lists are the same) and everybody does (nobody is free).
    slotsWithoutLow =
      keep.size === members.length
        ? slots
        : keep.size === 0
          ? []
          : slotsFor(members.filter((m) => keep.has(m.userId)));
  }

  return {
    bucket,
    eventType,
    orgName: (org as { name: string } | null)?.name ?? "",
    slots,
    ...(slotsWithoutLow !== undefined ? { slotsWithoutLow } : {}),
  };
}

/**
 * Round-robin candidate order for a specific slot: the cached-free members,
 * ordered least-recently-booked first (the agent booked longest ago, or never,
 * is tried first). Verify-on-book then confirms with a single live Google check
 * before committing. No mutable pointer — fair under concurrency and immune to
 * the reschedule double-count the old `rr_last_assigned_user_id` rotation had.
 */
export async function roundRobinCandidates(
  bucket: Bucket,
  eventType: EventType,
  startMs: number,
  preview = false,
  /**
   * #2073: one named agent instead of the bucket's pool, for a booking made
   * through their own link. Everything below runs unchanged for them alone, which
   * is the point: the same predicate the booker's display uses judges the slot.
   */
  onlyUserId?: string,
  /**
   * #2842: drop every advisor who carries Low, for a rung below a top tier lead's
   * own tier (`rungExcludesLow`). The pool size is then the filtered pool's, so a
   * pool made entirely of Low carriers reads as having nobody for this lead.
   */
  excludeLow = false,
  opts: RoundRobinOpts = {},
): Promise<{ candidates: string[]; memberCount: number }> {
  const endMs = startMs + eventType.duration_min * 60_000;
  // #3273: busy time is read over the BUFFERED window, the one `bookableSlotReason`
  // judges and verify on book asks Google about. Read over the bare call, a meeting
  // ending exactly at the start sits only inside a buffer, is never read, and the
  // advisor goes to the live check only to be refused there.
  const [readFrom, readTo] = bufferedWindow(
    eventType,
    new Date(startMs).toISOString(),
    new Date(endMs).toISOString(),
  );
  // The candidate list runs the SAME predicate the booker's display does, so it must
  // see the same org window (#1295): otherwise a direct-API book at a closed hour
  // would find candidates the booker would never have offered.
  const [pool, businessHours] = await Promise.all([
    loadMembersAvailability(
      bucket,
      readFrom,
      readTo,
      excludeLow
        ? lowExcludedResolver(eligibleAgentIds)
        : onlyUserId !== undefined
          ? namedAgentResolver(onlyUserId)
          : eligibleAgentIds,
      { excludeHoldBlocks: true },
    ),
    loadBusinessHours(),
  ]);
  const members = pool.members;

  const judgeInput = {
    durationMin: eventType.duration_min,
    bufferBeforeMin: eventType.buffer_before_min,
    bufferAfterMin: eventType.buffer_after_min,
    // #3248: a reroute's time is already chosen, so minimum notice (a rule for a
    // lead choosing) does not apply, and the exact window is judged rather than
    // the advisor's offering grid (red team 9).
    minNoticeMin: opts.fixedTime ? 0 : eventType.min_notice_min,
    dailyCap: eventType.daily_cap,
    slotIntervalMin: eventType.slot_interval_min,
    businessHours,
    nowMs: Date.now(),
  };
  const judged = opts.fixedTime
    ? freeMembersAtExactWindow(members, judgeInput, startMs)
    : freeMembersForSlot(members, judgeInput, startMs);
  // #3248: an advisor held for a bucket correction is skipped BEFORE verify, so a
  // lead picking that time is routed elsewhere rather than invited and then
  // cancelled. One read for the whole pool; a failed read throws, never "no holds".
  const free = judged.length === 0
    ? judged
    : dropHeldAgents(
        judged,
        await loadLiveHolds(judged, startMs, endMs, eventType),
        {
          startMs,
          endMs,
          bufferBeforeMin: eventType.buffer_before_min,
          bufferAfterMin: eventType.buffer_after_min,
        },
        opts.forBookingId,
      );
  // #1300: the POOL SIZE travels with the free list. Zero free has two causes that
  // need opposite handling (an empty bucket pages, an out of hours moment must not),
  // and the free list alone cannot tell them apart. The members are already loaded
  // here, so this costs nothing.
  const memberCount = members.length;
  if (free.length <= 1) return { candidates: free, memberCount };
  // Per-bucket equal-share (#305): anchor the pay period on the SLOT's start so a
  // next-period slot balances against next-period meetings. On the real assignment
  // path, log the equal-share vs recency divergence (#321) for pre-cutover
  // validation; a dry-run preview (#380) suppresses both that log and the
  // unfair-ordering alert so previews never pollute real-assignment data.
  return {
    candidates: await rankBucketShare(
      bucket.id,
      free,
      startMs,
      "verify-on-book candidate order",
      !preview,
      preview,
    ),
    memberCount,
  };
}

/**
 * The unexpired, unconsumed reroute holds on `userIds` whose buffered window comes
 * near this call (#3248), parsed. A superset of the clashing ones; `dropHeldAgents`
 * applies the exact rule. THROWS on a read error or an unreadable row, because an
 * empty answer would read as "nobody is held" and route a lead onto an advisor an
 * admin is holding (audit 12).
 */
export async function loadLiveHolds(
  userIds: string[],
  startMs: number,
  endMs: number,
  eventType: Pick<EventType, "buffer_before_min" | "buffer_after_min">,
): Promise<LiveHold[]> {
  if (userIds.length === 0) return [];
  const [from, to] = bufferedWindow(
    eventType,
    new Date(startMs).toISOString(),
    new Date(endMs).toISOString(),
  );
  // Expiry is judged by the DATABASE clock inside the function, the clock the
  // trigger and the sweep use, so the three can never disagree about a hold in its
  // last seconds (L736). The function also owns the window superset.
  const rows = unwrap(
    await supabaseAdmin().rpc("live_reroute_holds", {
      p_user_ids: userIds,
      p_from: from,
      p_to: to,
    }),
    "live reroute holds",
  ) ?? [];
  return parseLiveHolds(rows);
}

/**
 * What a reroute needs to know about the booking's CURRENT advisor on one rung
 * (#3248): the rung's pool through the REAL resolver (so a fallback stand in and
 * the Low carriers are visible, red team 4), their cached availability over the
 * booking's stored window with hold blocks left out, and whether they have
 * approved time off over it. Every read throws on failure (audit 12), so the
 * caller's answer is the retriable error rather than a keep.
 */
export async function loadCurrentAgentPicture(
  bucket: Bucket,
  eventType: EventType,
  booking: Pick<Booking, "assigned_user_id" | "starts_at" | "ends_at">,
): Promise<CurrentAgentPicture> {
  const agentId = booking.assigned_user_id;
  // Busy time is read over the BUFFERED window, because the keep check judges the
  // buffers against it: a meeting inside a buffer that was never read would let the
  // advisor be kept with no gap.
  const read = bufferedReadWindow(booking, eventType);
  const [pool, availability, businessHours, away] = await Promise.all([
    eligibleAgentIds(bucket),
    agentId
      ? loadMembersAvailability(bucket, read.fromIso, read.toIso, namedAgentResolver(agentId), {
          excludeHoldBlocks: true,
        })
      : Promise.resolve({ members: [], lowIds: undefined }),
    loadBusinessHours(),
    agentId ? userIdsOnApprovedTimeOff([agentId], booking.starts_at, booking.ends_at) : Promise.resolve(new Set<string>()),
  ]);
  return {
    pool,
    member: availability.members[0] ?? null,
    onTimeOff: agentId !== null && away.has(agentId),
    businessHours,
  };
}

const UNFAIR_ORDERING_ALERT_KEY = "rr_ordering_degraded";
const UNFAIR_ORDERING_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * The fairness ordering read failed. Per the booking-never-fails rule (#277) the
 * booking still proceeds; the assignment just may not reflect each agent's fair
 * share this period. Fire a throttled alert so a potentially unfair assignment is
 * visible. Never throws (a failed alert must not fail the booking).
 */
async function alertUnfairOrdering(context: string): Promise<void> {
  await sendThrottledAlert(
    UNFAIR_ORDERING_ALERT_KEY,
    UNFAIR_ORDERING_COOLDOWN_MS,
    unfairOrderingAlert(context),
  ).catch(logAlertSendFailure(UNFAIR_ORDERING_ALERT_KEY));
}

/**
 * Shared per-bucket equal-share ranker (#305) for BOTH the booking path and the
 * routing API, so they can't diverge. Among `candidateIds`, orders by fewest
 * bookings in `bucketId` whose meeting falls in the pay period containing
 * `anchorMs`, tie-broken least-recently-booked then id (new-to-pool agents seeded
 * at the pool average). Reads one bucket's bookings from the prior period start
 * through this period's end (the prior window distinguishes a brand-new agent
 * from an established-but-quiet one). Fail-safe: a read error degrades to a valid
 * order and alerts, never throws.
 */
async function rankBucketShare(
  bucketId: string,
  candidateIds: string[],
  anchorMs: number,
  context: string,
  shadowLog = false,
  preview = false,
): Promise<string[]> {
  if (candidateIds.length <= 1) return candidateIds;
  const period = payPeriod(anchorMs);
  const priorStartMs = payPeriod(period.startMs - 1).startMs;
  const share = bucketShareFromResult(
    await supabaseAdmin()
      // cap-safe: one bucket's bookings across two pay periods, scoped to the tier's candidate agents.
      .from("bookings")
      .select("assigned_user_id, starts_at, created_at")
      .eq("bucket_id", bucketId)
      // #2073: a named link booking was never a share of this bucket's routing,
      // so counting it would push its agent down the order for leads they never
      // received through the pool.
      .eq("kind", "routed")
      .gte("starts_at", new Date(priorStartMs).toISOString())
      .lt("starts_at", new Date(period.endMs).toISOString())
      .in("assigned_user_id", candidateIds)
      .in("status", ["confirmed", "rescheduled", "completed"]),
    period.startMs,
  );
  // A dry-run preview (#380) is not a real assignment, so it must not page on a
  // degraded share (nor log the shadow line below).
  if (share.degraded && !preview) await alertUnfairOrdering(context);

  // Pre-cutover shadow run (#321): on the real assignment path, log how the live
  // equal-share order compares to the prior recency order, so the equal-share
  // distribution can be validated against real traffic before the fleet relies
  // on it. Structured line for Cloudflare observability; assignment is unaffected
  // (the live order is always equal-share). Skipped for the routing-API preview.
  if (shadowLog && !share.degraded) {
    const div = shadowRankingDivergence(candidateIds, share);
    log.info("routing-shadow", {
      bucket_id: bucketId,
      anchor_ms: anchorMs,
      candidates: candidateIds.length,
      diverged: div.diverged,
      equal_share_top: div.equalShareTop,
      recency_top: div.recencyTop,
      equal_share_order: div.equalShareOrder.join(","),
      recency_order: div.recencyOrder.join(","),
    });
    return div.equalShareOrder;
  }
  return orderByBucketShare(candidateIds, share);
}

export interface RoutingResolution {
  bucket: Bucket;
  eventType: EventType;
  eligibleIds: string[];
  fallbackApplied: boolean;
  routedAgentId: string | null;
}

/**
 * Resolve routing for a bucket code (xbc) WITHOUT a calendar check: the eligible
 * agents (fallback applied), ordered least-recently-booked, plus the top pick.
 * Powers the standalone routing API; the booking flow still verifies on book.
 */
export async function resolveRouting(
  code: string,
): Promise<RoutingResolution | null> {
  const resolved = await resolveBucketByCode(code);
  if (!resolved) return null;
  const { bucket, eventType } = resolved;
  const { ids, fallbackApplied } = await eligibleAgentIds(bucket);
  // No slot in a routing preview, so anchor the period on now. This endpoint is a
  // read-only lookup, not an assignment (#673): run it as a dry-run preview so an
  // anonymous probe against a skewed bucket can never page the unfair-ordering
  // alert or write a shadow line. The returned order is unaffected.
  const ordered = await rankBucketShare(bucket.id, ids, Date.now(), "routing API order", false, true);
  return {
    bucket,
    eventType,
    eligibleIds: ordered,
    fallbackApplied,
    routedAgentId: ordered[0] ?? null,
  };
}
