/**
 * The two reads the debt tier alarm judges (#2505), kept apart from the judging
 * so the decision stays node-testable and the IO has one home.
 *
 * WHY THE COUNT IS CRITERIA ONLY, and why that is the most important line in this
 * file. The obvious way to count a tier is `eligibleAgentIds` for its whole pool
 * code, which is what the empty bucket sweep uses. That function resolves a
 * BUCKET, not a criteria set: `agentIdsFromPool` matches
 * `manualMemberIds.has(a.id) || matchesCriteria(...)`, and `applyFallback` runs on
 * top. So ONE person hand named on bucket `511`, or a `fallback_user_id` pointing
 * at one agent, would make the whole Ultra High tier read as staffed and mute the
 * page, while a lead on `512` is NOT served by that member, because an
 * unconstrained code gains no same tier rung (#2486). That is word for word the
 * silence #2253 was opened about, and `bucket-coverage.ts` already records the
 * shape in its own docstring.
 *
 * It is latent rather than live today (measured 2026-09-17: 0 buckets carry a
 * `fallback_user_id`, and all 3 active `bucket_members` rows are on test buckets),
 * and the admin page offers to name a person on any row, so it is one click from
 * real.
 *
 * THE CRITERIA COME FROM THE SPEC, NOT FROM A ROW. `bucketSpecForXbc` derives them
 * from the code, so a `buckets` row that is missing, deleted or flagged
 * `is_test` cannot decide whether a debt tier is staffed. A read of the row would
 * make an absent bucket look like an empty tier, which is a page about our own
 * configuration worded as a customer outage.
 *
 * TEST AGENTS ARE EXCLUDED for the same reason the empty bucket sweep excludes
 * them: the two SMOKE fixtures are deliberately bookable so the canary keeps
 * proving the funnel, and a fixture answering "is this tier staffed" with a yes
 * is a number nobody can reconcile against the roster.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { selectAllPages } from "@/lib/supabase/paginate";
import { agentIdsFromPool } from "@/lib/availability/pool";
import { bucketSpecForXbc, DEBT_TIER } from "@/lib/xbc";
import { wholeTierPoolCode } from "@/lib/routing/tiers";
import type { Attributes, Bucket, EventType } from "@/lib/db/types";
import type { CauseCalendar } from "@/lib/monitor/tier-cause";
import type { SlotHealth } from "@/lib/monitor/slot-health";
import {
  tierHoldKey,
  tierStaffingKey,
  type TierAlertState,
  type TierReading,
  type WindowReading,
} from "@/lib/monitor/tier-staffing";
import { firingKey, mayWriteAlerts } from "@/lib/notify/dispatch";
import { parseStampMs } from "@/lib/date/stamp";
import { log } from "@/lib/log";
import { offeredWindowFor } from "@/lib/availability/offered-window";
import type { BusinessHoursRules } from "@/lib/availability/compute";

/** Every debt tier digit, from the shared vocabulary rather than typed out, so a
 *  sixth tier is covered by construction rather than silently unwatched (L96). */
export const DEBT_TIERS: string[] = Object.keys(DEBT_TIER).sort();

/**
 * Which bookable agents each debt tier has, by criteria alone.
 *
 * THROWS on an unreadable roster rather than returning an empty map, because an
 * empty map read as zeros would page every tier at once off a query that never
 * ran (#277, #1629). The lane contains the throw and the alarm reports every tier
 * unmeasured, which is the honest outcome.
 *
 * The ids, not just the count, since #3037: a tier about to page is diagnosed
 * agent by agent, and these are the agents the count was made of.
 */
export async function loadTierAgentIds(): Promise<Map<string, string[]>> {
  const db = supabaseAdmin();
  // cap-safe: the roster is bounded by the design target of 100 to 200 agents, and
  // `users` is on the guard's roster-bounded allowlist for exactly that reason.
  const rows = (unwrap(
    await db
      .from("users")
      .select("id, attributes")
      .eq("bookable", true)
      .eq("is_test", false)
      .is("deactivated_at", null),
    "tier staffing roster",
  ) ?? []) as { id: string; attributes: Attributes }[];
  const agents = rows.map((r) => ({ id: r.id, attributes: r.attributes }));
  const ids = new Map<string, string[]>();
  for (const tier of DEBT_TIERS) {
    const spec = bucketSpecForXbc(wholeTierPoolCode(tier));
    if (!spec) continue;
    // No manual members and no fallback: see the header. An empty Set is the
    // statement, not an omission.
    ids.set(tier, agentIdsFromPool(agents, new Set(), spec.criteria));
  }
  return ids;
}

/** How many bookable agents each debt tier has: the size of each tier's list. */
export function tierAgentCounts(ids: Map<string, string[]>): Map<string, number> {
  return new Map([...ids].map(([tier, list]) => [tier, list.length]));
}

/** How many bookable agents each debt tier has, by criteria alone. */
export async function loadTierAgentCounts(): Promise<Map<string, number>> {
  return tierAgentCounts(await loadTierAgentIds());
}

/** Agent ids per in() filter, under the URL length PostgREST accepts. */
const CAUSE_ID_CHUNK = 150;

/**
 * The three reads a tier about to page is diagnosed from (#3037): the event type
 * its whole pool books, its agents' calendar sync health, and their busy blocks
 * over the window.
 *
 * Run ONLY on a tick about to page, never on the healthy one, because the monitor
 * lane shares one subrequest budget with three other cron lanes.
 *
 * THROWS on any read that fails, including a pool with no bucket row or event
 * type, rather than returning empty: no calendars would read as every sync
 * stopped, and no busy blocks as every agent free, which are both wrong causes
 * worded as findings (L215). The lane catches the throw and keeps the old wording
 * with a clause saying the cause could not be read.
 */
export async function loadTierCauseReads(input: {
  tier: string;
  agentIds: string[];
  buckets: Bucket[];
  nowMs: number;
  windowEndMs: number;
}): Promise<{
  eventType: EventType;
  calendars: (CauseCalendar & { user_id: string })[];
  busy: { user_id: string; starts_at: string; ends_at: string; booking_id: string | null }[];
}> {
  const code = wholeTierPoolCode(input.tier);
  const bucket = input.buckets.find((b) => b.code === code);
  if (!bucket) throw new Error(`no bucket row for the ${code} pool`);
  const db = supabaseAdmin();
  const eventType = unwrap(
    await db.from("event_types").select("*").eq("id", bucket.event_type_id).maybeSingle(),
    "tier cause event type",
  ) as EventType | null;
  if (!eventType) throw new Error(`no event type for the ${code} pool`);
  if (input.agentIds.length === 0) return { eventType, calendars: [], busy: [] };
  // A busy block conflicts with a call when it overlaps the call's buffered span,
  // so the read reaches one buffered call either side of the window.
  const padMs = (eventType.buffer_before_min + eventType.duration_min + eventType.buffer_after_min) * 60_000;
  // In chunks, because an in() filter past about 200 ids makes a URL PostgREST
  // refuses. One tier is well under that today; a tier that grows past it gets
  // two reads rather than a refusal.
  const chunks: string[][] = [];
  for (let i = 0; i < input.agentIds.length; i += CAUSE_ID_CHUNK) {
    chunks.push(input.agentIds.slice(i, i + CAUSE_ID_CHUNK));
  }
  const calendars: (CauseCalendar & { user_id: string })[] = [];
  const busy: { user_id: string; starts_at: string; ends_at: string; booking_id: string | null }[] = [];
  for (const ids of chunks) {
    const [cals, blocks] = await Promise.all([
      // cap-safe: agent_calendars is roster bounded, and this is one tier's agents.
      db
        .from("agent_calendars")
        .select("user_id, consecutive_failures, last_success_at, last_failure_kind")
        .in("user_id", ids)
        .then((r) => unwrap(r, "tier cause calendars") as (CauseCalendar & { user_id: string })[] | null),
      // Every page: one tier's agents over a window of at most a couple of days is
      // a few hundred rows, but a truncated page would read a booked agent as free.
      selectAllPages<{ user_id: string; starts_at: string; ends_at: string; booking_id: string | null }>(
        "tier cause busy blocks",
        "id",
        () =>
          db
            .from("busy_blocks")
            .select("id, user_id, starts_at, ends_at, booking_id")
            .in("user_id", ids)
            .lt("starts_at", new Date(input.windowEndMs + padMs).toISOString())
            .gt("ends_at", new Date(input.nowMs - padMs).toISOString()),
      ),
    ]);
    calendars.push(...(cals ?? []));
    busy.push(...blocks);
  }
  return { eventType, calendars, busy };
}

/**
 * Assemble what the judge needs, from the two reads the lane already holds.
 *
 * PURE, so every combination of a failed read is driven directly. A `null` for
 * either input means that read failed, and it arrives at the judge as
 * `measured: false` rather than as a zero, which is the whole distinction the
 * alarm rests on (L215).
 */
export function tierReadings(input: {
  agentCounts: Map<string, number> | null;
  slotByCode: Map<string, SlotHealth> | null;
  /** Each tier's booker window, from `tierWindows`. A tier missing here is
   *  unmeasured, never judged against a neighbour's window or a guess. */
  windows: Map<string, WindowReading>;
}): TierReading[] {
  return DEBT_TIERS.map((tier) => {
    const label = DEBT_TIER[tier]?.label ?? tier;
    // A tier absent from a map that WAS read is a genuine zero for the roster (no
    // agent carries it) but is UNMEASURED for the slots (no cached row for the
    // tier's pool code, so nothing says what it is offering). The two differ
    // because one map is built from every tier and the other from whatever rows
    // exist.
    const count = input.agentCounts?.get(tier);
    const health = input.slotByCode?.get(wholeTierPoolCode(tier));
    return {
      tier,
      label,
      agents: input.agentCounts === null ? { measured: false } : { measured: true, count: count ?? 0 },
      slots:
        input.slotByCode === null || health === undefined || health.slotCount === null
          ? { measured: false }
          : { measured: true, firstSlotMs: health.firstSlotMs, offeredMs: health.offeredMs ?? [] },
      window: input.windows.get(tier) ?? { measured: false },
    };
  });
}

/**
 * The days the booker shows a lead in each debt tier (#3559), from that tier's
 * whole pool row in the slot cache.
 *
 * The booker cuts its strip with `offeredWindowFor` over the REQUESTED pool's
 * event type notice, and the cached row carries that event type, so the window
 * costs no read: the lane already holds the rows. A row that is missing, or whose
 * notice is not a number, is `measured: false` rather than a window built from a
 * guessed notice, and so is an org with no open day ahead (L215). Pure.
 *
 * `offeredOpenDays` is the stored setting (#3922) as the lane read it this tick,
 * or null when that read failed, and then EVERY tier is unmeasured: a window built
 * from a guessed count would page or clear a tier over days the booker is not
 * showing.
 */
export function tierWindows(input: {
  rows: { bucket_code: string; payload: { eventType?: { min_notice_min?: unknown } | null } | null }[];
  hours: BusinessHoursRules;
  nowMs: number;
  offeredOpenDays: number | null;
}): Map<string, WindowReading> {
  const out = new Map<string, WindowReading>();
  const offered = input.offeredOpenDays;
  for (const tier of DEBT_TIERS) {
    const row = input.rows.find((r) => r.bucket_code === wholeTierPoolCode(tier));
    const notice = row?.payload?.eventType?.min_notice_min;
    const w =
      offered !== null && typeof notice === "number" && Number.isFinite(notice) && notice >= 0
        ? offeredWindowFor(input.hours, input.nowMs, notice, offered)
        : null;
    out.set(tier, w === null ? { measured: false } : { measured: true, endMs: w.endMs, days: w.days });
  }
  return out;
}

/**
 * Which tiers have an open page, and since when each has held at the recovered
 * count (#3227), in ONE read of `alert_state`. It stands in for the read
 * `resolveRecovered` used to make on every tick that had a healthy tier, so the
 * hold costs no extra subrequest on the budget four cron lanes share.
 *
 * THROWS on a refused read, never an empty answer: no firing markers would read
 * as no page open, and no holds as every hold reset (L215). The lane maps the
 * throw to an unreadable state, which concludes nothing for any tier.
 *
 * A hold whose stamp cannot be read is treated as not holding, so the next good
 * tick starts it again: the all clear comes later, never sooner (L50).
 */
export async function loadTierAlertState(tiers: string[]): Promise<TierAlertState> {
  const markers = new Map(tiers.map((t) => [firingKey(tierStaffingKey(t)), t]));
  const holds = new Map(tiers.map((t) => [tierHoldKey(t), t]));
  // cap-safe: a primary key lookup, at most two rows per debt tier (five tiers).
  const { data, error } = await supabaseAdmin()
    .from("alert_state")
    .select("key, last_sent_at")
    .in("key", [...markers.keys(), ...holds.keys()]);
  if (error) throw new Error(`tier alert state read failed: ${error.message}`);
  const firing = new Set<string>();
  const holdSinceMs = new Map<string, number>();
  for (const row of (data ?? []) as { key: string; last_sent_at: string }[]) {
    const marked = markers.get(row.key);
    if (marked !== undefined) firing.add(marked);
    const held = holds.get(row.key);
    const ms = held === undefined ? null : parseStampMs(row.last_sent_at);
    if (held !== undefined && ms !== null) holdSinceMs.set(held, ms);
  }
  return { readable: true, firing, holdSinceMs };
}

/**
 * Begin each tier's hold at `nowMs`. A write that fails is logged and costs only
 * time: the next tick finds no hold and starts it again, so the all clear comes
 * later, never sooner.
 */
export async function startTierHolds(tiers: string[], nowMs: number): Promise<void> {
  if (tiers.length === 0 || !mayWriteAlerts(tierHoldKey(tiers[0]), "tier recovery hold")) return;
  const at = new Date(nowMs).toISOString();
  const { error } = await supabaseAdmin()
    .from("alert_state")
    .upsert(tiers.map((t) => ({ key: tierHoldKey(t), last_sent_at: at })), { onConflict: "key" });
  if (error) log.warn("monitor", { msg: "tier recovery hold write failed", tiers: tiers.join(","), error: error.message });
}

/**
 * Drop each tier's hold. A delete that fails is logged by name, because a hold
 * left behind is older than it should be and could let the next all clear out
 * before the tier has really held the count for the whole hold.
 */
export async function clearTierHolds(tiers: string[]): Promise<void> {
  if (tiers.length === 0 || !mayWriteAlerts(tierHoldKey(tiers[0]), "tier recovery hold clear")) return;
  const { error } = await supabaseAdmin()
    .from("alert_state")
    .delete()
    .in("key", tiers.map(tierHoldKey));
  if (error) log.error("monitor", { msg: "tier recovery hold clear failed", tiers: tiers.join(","), error: error.message });
}
