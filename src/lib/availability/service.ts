import { supabaseAdmin } from "@/lib/supabase/admin";
import { selectAllPages } from "@/lib/supabase/paginate";
import { unwrap, unwrapCount } from "@/lib/db/result";
import {
  computeBucketSlots,
  freeMembersForSlot,
  assembleMemberAvailability,
  capCountWindow,
  type MemberAvailability,
} from "@/lib/availability/compute";
import { loadBusinessHours } from "@/lib/booking/business-hours-load";
import { agentIdsFromPool } from "@/lib/availability/pool";
import {
  applyFallback,
  payPeriod,
  bucketShareFromResult,
  orderByBucketShare,
  shadowRankingDivergence,
} from "@/lib/availability/roundrobin";
import { sendThrottledAlert, resolveAlert, settleAlertsSilently } from "@/lib/notify/dispatch";
import { unfairOrderingAlert } from "@/lib/booking/alert-copy";
import {
  emptyBucketMessage,
  recoveredBucketMessage,
  emptyBuckets,
  planEmptyBucketAlerts,
  emptyBucketsAggregateMessage,
  emptyBucketsAggregateRecoveredMessage,
  AGGREGATE_BUCKET_CODE,
  type BucketCoverage,
} from "@/lib/availability/bucket-coverage";
import { loadMonitorSettings } from "@/lib/monitor/settings";
import { mapWithConcurrency } from "@/lib/concurrency";
import type { Attributes, Bucket, Criteria, EventType } from "@/lib/db/types";
// Lazy circular-safe import: eligible-cache.ts imports eligibleAgentIds from
// this module, but since both modules only export functions (no module-level
// execution), ESM live bindings ensure the reference is valid by call time.
import { eligibleAgentIdsCached } from "./eligible-cache.ts";
import { log } from "@/lib/log";

export { agentIdsFromPool } from "@/lib/availability/pool";

const EMPTY_BUCKETS_ALERT_KEY = "empty_buckets";
// Bounded fan-out for the per-bucket eligibility resolves (each hits the DB).
const COVERAGE_CONCURRENCY = 6;

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
  const { orgAgents, manualMemberIds, criteria } = await resolveBucketPool(bucket);
  return agentIdsFromPool(orgAgents, manualMemberIds, criteria);
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
export type EligibleResolver = (
  bucket: Bucket,
) => Promise<{ ids: string[]; fallbackApplied: boolean }>;

export async function eligibleAgentIds(
  bucket: Bucket,
): Promise<{ ids: string[]; fallbackApplied: boolean }> {
  const matched = await resolveBucketAgentIds(bucket);
  // The fallback is only consulted when the matched pool is empty, so skip the
  // eligibility round-trip otherwise. A stored fallback_user_id can point at an
  // agent who is no longer bookable (or, with offboarding, deactivated); never
  // route to them just because the pool came up empty.
  if (matched.length > 0 || !bucket.fallback_user_id) {
    return applyFallback(matched, bucket.fallback_user_id, false);
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
  return applyFallback(matched, bucket.fallback_user_id, !!fallback);
}

/** IO the empty-bucket sweep needs; defaulted to real impls, injectable in tests. */
export interface EmptyBucketDeps {
  loadBuckets(): Promise<Bucket[]>;
  countEligible(bucket: Bucket): Promise<number>;
  /** One throttled alert per dead bucket, keyed by code so each surfaces independently. */
  sendAlert(code: string, message: string): Promise<void>;
  /** The all-clear for a bucket that has agents again (#1151), same key. */
  clearAlert(code: string, message: string): Promise<void>;
  /** Drop superseded per-bucket pages without posting an all-clear for each. */
  settleSilently(codes: string[]): Promise<void>;
  /**
   * Bookable agents in the roster, for naming the shared cause on the aggregate
   * page. `null` means the count could NOT be read, which the copy states rather
   * than presenting as zero.
   */
  countBookableAgents(): Promise<number | null>;
}

/**
 * The real IO, built per sweep so the cooldown comes from the store (#571) rather
 * than a constant nobody can reach. It is a factory, not a const, because the
 * cooldown has to be resolved once per run instead of once per process.
 */
async function realEmptyBucketDeps(): Promise<EmptyBucketDeps> {
  // Never throws: a config read failure falls through to the coded default rather
  // than taking the monitor down with it.
  const { cooldownMs } = await loadMonitorSettings();
  const cooldown = cooldownMs.empty_buckets;
  return {
    // Real lead routes only. The SMOKE fixtures (#396) are deliberately staffed by
    // the two test agents so the canary keeps proving the funnel, and the canary is
    // what watches them: counting them here would put a fixture in a number someone
    // reconciles against the roster ("60 of 62" when they have 60), and paging about
    // one would be noise to whoever is deciding whether real leads can be routed.
    loadBuckets: async () =>
      ((await supabaseAdmin().from("buckets").select("*").eq("is_test", false)).data ??
        []) as Bucket[],
    // Use the 60s cross-invocation cache (#421) so all cron lanes in a tick share
    // one eligibility read per bucket rather than each re-querying the DB.
    countEligible: async (bucket) => (await eligibleAgentIdsCached(bucket)).ids.length,
    sendAlert: (code, message) =>
      // alert-key: empty_buckets:*
      sendThrottledAlert(`${EMPTY_BUCKETS_ALERT_KEY}:${code}`, cooldown, message).then(() => {}),
    // all-clear-proof: src/lib/availability/empty-buckets.test.ts - drives this module
    // against the real dispatch boundary with a failing bucket read, and pins that a
    // sweep that measured no pool announces no recovery.
    clearAlert: (code, message) =>
      // alert-key: empty_buckets:*
      resolveAlert(`${EMPTY_BUCKETS_ALERT_KEY}:${code}`, message).then(() => {}),
    settleSilently: (codes) =>
      settleAlertsSilently(codes.map((c) => `${EMPTY_BUCKETS_ALERT_KEY}:${c}`)),
    // Test agents are excluded on purpose: the two SMOKE fixtures are bookable so
    // the canary keeps proving the funnel, and counting them would answer "is the
    // roster switched on" with a yes while no real lead can be routed.
    countBookableAgents: async () =>
      unwrapCount(
        await supabaseAdmin()
          .from("users")
          .select("id", { count: "exact", head: true })
          .eq("bookable", true)
          .eq("is_test", false)
          .is("deactivated_at", null),
        "empty-buckets bookable count",
      ),
  };
}

/**
 * Proactive routing dead-zone monitor (#327): resolve every bucket's eligible
 * pool and throttled-alert if any route to ZERO agents (matched pool empty AND
 * no usable fallback), so a misconfigured bucket is caught before a lead hits
 * it. Best-effort — called from the hourly roster cron after the reconcile.
 * Returns the empty codes for the cron's response/log. Deps are injectable so
 * the decision-and-fan-out is unit-tested without DB/Slack.
 */
export async function alertOnEmptyBuckets(
  deps?: EmptyBucketDeps,
): Promise<{ empty: string[]; aggregated: boolean }> {
  const d = deps ?? (await realEmptyBucketDeps());
  const buckets = await d.loadBuckets();
  if (buckets.length === 0) return { empty: [], aggregated: false };

  const coverage: BucketCoverage[] = await mapWithConcurrency(
    buckets,
    COVERAGE_CONCURRENCY,
    async (bucket) => ({
      code: bucket.code,
      eligibleCount: await d.countEligible(bucket),
    }),
  );

  const plan = planEmptyBucketAlerts(coverage);
  const empty = emptyBuckets(coverage);
  const emptySet = new Set(empty);

  if (plan.aggregated) {
    // One page for the set, naming the count and the cause. The cause lookup is
    // best-effort: a failed read becomes an explicit "could not be read" in the
    // copy, and must never swallow the page itself.
    const agents = await d.countBookableAgents().catch(() => null);
    await d
      .sendAlert(
        AGGREGATE_BUCKET_CODE,
        emptyBucketsAggregateMessage(empty.length, coverage.length, agents),
      )
      .catch(() => {});
  } else {
    for (const code of plan.pageCodes) {
      await d.sendAlert(code, emptyBucketMessage(code)).catch(() => {});
    }
  }

  // #1151: "this bucket routes to nobody" is a CONDITION that ends when someone
  // is staffed onto it, and this monitor is the only thing that re-measures it.
  // Driven by the MEASURED coverage, not by "we did not alert this run": a bucket
  // is cleared only because its pool was counted and is non-empty. A run that
  // could not load any bucket returned earlier and clears nothing.
  for (const c of coverage) {
    if (emptySet.has(c.code)) continue;
    await d.clearAlert(c.code, recoveredBucketMessage(c.code, c.eligibleCount)).catch(() => {});
  }

  // The aggregate is a condition of its own and owes the same two answers. While
  // it holds, the per-bucket pages it replaced are settled WITHOUT a notice each
  // (the aggregate page is the notice). When it ends, ONE all-clear that says
  // whether anything is still dead, since some buckets may still be paging.
  if (plan.aggregated) {
    if (plan.settleCodes.length > 0) {
      // Not swallowed: a marker left behind is this flood again on the next wave,
      // as sixty all-clears, so the failure has to be visible somewhere.
      await d
        .settleSilently(plan.settleCodes)
        .catch((err) =>
          log.error(
            "empty-buckets",
            { msg: "settling superseded per-bucket pages failed", codes: plan.settleCodes.length },
            err,
          ),
        );
    }
  } else {
    await d
      .clearAlert(
        AGGREGATE_BUCKET_CODE,
        emptyBucketsAggregateRecoveredMessage(empty.length, coverage.length),
      )
      .catch(() => {});
  }
  return { empty, aggregated: plan.aggregated };
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
): Promise<MemberAvailability[]> {
  const db = supabaseAdmin();

  const { ids: userIds } = await resolveEligible(bucket);
  if (userIds.length === 0) return [];

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
  // throws on a read error (fail-loud).
  const busyP = selectAllPages<{ user_id: string; starts_at: string; ends_at: string }>(
    "busy_blocks",
    (pageFrom, pageTo) =>
      db
        .from("busy_blocks")
        .select("user_id, starts_at, ends_at")
        .in("user_id", userIds)
        .lt("starts_at", to)
        .gt("ends_at", from)
        .range(pageFrom, pageTo),
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

  const [busy, countRes] = await Promise.all([
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

  const rules = schedules.flatMap((s) => s.availability_rules ?? []);
  return assembleMemberAvailability(userIds, schedules, rules, busy, dayCountsByUser);
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
}

/** Cached slot list for a bucket code — the read path for the embed modal. */
export async function getBucketSlots(
  code: string,
  from: string,
  to: string,
  resolveEligible: EligibleResolver = eligibleAgentIds,
): Promise<BucketSlots | null> {
  const resolved = await resolveBucketByCode(code);
  if (!resolved) return null;
  const { bucket, eventType } = resolved;

  // Neither the org name nor the business hours depend on member availability, so
  // overlap all three instead of running them as sequential hops. `loadBusinessHours`
  // THROWS on an unreadable week (#1294), which propagates out of here on purpose:
  // `recomputeBucketSlots` catches it and leaves the previous good row standing
  // rather than writing an empty one, and the stale-bucket alarm surfaces it. The
  // alternative, serving an unfiltered list, would silently re-open hours an admin
  // had narrowed and nobody would see it.
  const [orgRes, members, businessHours] = await Promise.all([
    supabaseAdmin()
      .from("organizations")
      .select("name")
      .eq("id", bucket.org_id)
      .maybeSingle(),
    loadMembersAvailability(bucket, from, to, resolveEligible),
    loadBusinessHours(),
  ]);
  const org = orgRes.data;
  const slots = computeBucketSlots({
    members,
    durationMin: eventType.duration_min,
    bufferBeforeMin: eventType.buffer_before_min,
    bufferAfterMin: eventType.buffer_after_min,
    minNoticeMin: eventType.min_notice_min,
    dailyCap: eventType.daily_cap,
    slotIntervalMin: eventType.slot_interval_min,
    businessHours,
    from,
    to,
    nowMs: Date.now(),
  });

  return {
    bucket,
    eventType,
    orgName: (org as { name: string } | null)?.name ?? "",
    slots,
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
): Promise<{ candidates: string[]; memberCount: number }> {
  const endIso = new Date(
    startMs + eventType.duration_min * 60_000,
  ).toISOString();
  // The candidate list runs the SAME predicate the booker's display does, so it must
  // see the same org window (#1295): otherwise a direct-API book at a closed hour
  // would find candidates the booker would never have offered.
  const [members, businessHours] = await Promise.all([
    loadMembersAvailability(bucket, new Date(startMs).toISOString(), endIso),
    loadBusinessHours(),
  ]);

  const free = freeMembersForSlot(
    members,
    {
      durationMin: eventType.duration_min,
      bufferBeforeMin: eventType.buffer_before_min,
      bufferAfterMin: eventType.buffer_after_min,
      minNoticeMin: eventType.min_notice_min,
      dailyCap: eventType.daily_cap,
      slotIntervalMin: eventType.slot_interval_min,
      businessHours,
      nowMs: Date.now(),
    },
    startMs,
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
  ).catch(() => {});
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
