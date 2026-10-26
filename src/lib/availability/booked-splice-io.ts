import { unwrap } from "@/lib/db/result";
import { selectAllPages } from "@/lib/supabase/paginate";
import { loadBusinessHoursCached, type BusinessHours } from "@/lib/booking/business-hours-load";
import type { Attributes, Bucket, EventType } from "@/lib/db/types";
import { log } from "@/lib/log";
import type { BookedSpliceDeps, PoolPlan } from "./booked-splice";

import { bucketsMatchingAgent } from "./bucket-match";
import { eligibleFromRoster } from "./pool";
import { groupByPool } from "./pool-key";
import { computeSlotsFromInputs, parseDayCounts } from "./service";
import { readSlotRows, spliceFromRead, spliceSlotRow, type SlotRowDb } from "./slot-row-write";

/**
 * The database half of the booked window splice (#3324), batched across pools.
 *
 * Every read here is ONE statement per booking however many pools the advisor
 * serves (#3324 review: the per pool shape cost about 77 calls for a four pool
 * advisor and 209 for a twelve pool one, onto the database whose saturation failed
 * the load run's burst). The roster is three reads, then one each for schedules,
 * the cap count, busy time and the affected rows. Business hours come from the per
 * isolate cache the read path already uses, so they cost nothing on a warm isolate
 * and two reads on a cold one. What still scales is one compare and swap per code
 * whose offer changed; collapsing those needs an RPC (see the PR for #3324).
 *
 * `db` is injected so a test can count the statements the REAL wiring makes:
 * `src/lib/availability/slot-cache-splice.test.ts`.
 */

/** What a pool's compute needs that the roster read already holds. */
export interface SplicePoolCtx {
  bucket: Bucket;
  eventType: EventType;
  lowIds: string[];
  businessHours: BusinessHours;
}

type BucketWithEvent = Bucket & { event_types: EventType | null };

export function bookedSpliceIo(
  db: SlotRowDb,
  context: string,
  hours: () => Promise<BusinessHours> = loadBusinessHoursCached,
): BookedSpliceDeps<SplicePoolCtx> {
  return {
    now: Date.now,

    // Three reads for every pool together: the buckets with their event types, the
    // active manual members, and the bookable advisors with their attributes. The
    // advisors' pools, and who each routes to, are then worked out in memory by the
    // same judges the live reads use (`bucketsMatchingAgent`, `eligibleFromRoster`).
    // Still three for a move's two advisors (#3334): both are judged from one roster.
    loadPlan: async (userIds) => {
      const [bucketsRes, membersRes, usersRes, businessHours] = await Promise.all([
        db.from("buckets").select("*, event_types(*)"),
        db.from("bucket_members").select("bucket_id, user_id").eq("active", true),
        db
          .from("users")
          .select("id, org_id, attributes")
          .eq("bookable", true)
          .is("deactivated_at", null),
        hours(),
      ]);
      const buckets = (unwrap(bucketsRes, "splice buckets") ?? []) as BucketWithEvent[];
      const members = (unwrap(membersRes, "splice bucket members") ?? []) as { bucket_id: string; user_id: string }[];
      const users = (unwrap(usersRes, "splice advisors") ?? []) as {
        id: string;
        org_id: string;
        attributes: Attributes | null;
      }[];

      const manualByBucket = new Map<string, string[]>();
      for (const m of members) manualByBucket.set(m.bucket_id, [...(manualByBucket.get(m.bucket_id) ?? []), m.user_id]);

      // Keyed by the pool's representative code, so a pool both advisors serve is
      // planned once and names both of them.
      const plans = new Map<string, PoolPlan<SplicePoolCtx>>();
      for (const userId of new Set(userIds)) {
        const advisor = users.find((u) => u.id === userId);
        // Not bookable any more, so no pool routes to them and no row offers their time.
        if (!advisor) continue;
        const orgBuckets = buckets.filter((b) => b.org_id === advisor.org_id);
        const mine = new Set(
          bucketsMatchingAgent(
            advisor.id,
            advisor.attributes ?? {},
            orgBuckets.map((b) => ({
              code: b.code,
              criteria: b.criteria ?? {},
              manualMemberIds: manualByBucket.get(b.id) ?? [],
              fallbackUserId: b.fallback_user_id,
            })),
          ),
        );
        const orgAgents = users
          .filter((u) => u.org_id === advisor.org_id)
          .map((u) => ({ id: u.id, attributes: u.attributes ?? {} }));

        const pooled = orgBuckets.map((b) => ({
          code: b.code,
          bucket: b,
          orgId: b.org_id,
          eventTypeId: b.event_type_id,
          criteria: b.criteria ?? null,
          fallbackUserId: b.fallback_user_id,
          memberIds: manualByBucket.get(b.id) ?? [],
        }));
        for (const group of groupByPool(pooled).values()) {
          if (!group.some((m) => mine.has(m.code))) continue;
          const rep = group[0]!;
          const planned = plans.get(rep.code);
          if (planned) {
            planned.servedBy.push(advisor.id);
            continue;
          }
          const { event_types: eventType, ...bucket } = rep.bucket;
          if (!eventType) {
            log.warn("slot-cache", { msg: "splice skipped a pool with no event type", bucket: rep.code, context });
            continue;
          }
          const eligible = eligibleFromRoster(bucket, orgAgents, new Set(rep.memberIds));
          plans.set(rep.code, {
            codes: group.map((m) => m.code),
            servedBy: [advisor.id],
            eventType,
            memberIds: eligible.ids,
            ctx: { bucket, eventType, lowIds: eligible.lowIds, businessHours },
          });
        }
      }
      return [...plans.values()];
    },

    loadSchedules: async (userIds) => {
      if (userIds.length === 0) return { schedules: [], rules: [] };
      const rows =
        unwrap(
          await db
            .from("availability_schedules")
            .select("id, user_id, timezone, availability_rules(schedule_id, weekday, start_minute, end_minute)")
            .in("user_id", userIds),
          "splice availability_schedules",
        ) ?? [];
      return {
        schedules: rows.map((s) => ({ id: s.id, user_id: s.user_id, timezone: s.timezone })),
        rules: rows.flatMap((s) => s.availability_rules ?? []),
      };
    },

    loadDayCounts: async (userIds, tzByUser, from, to) => {
      const { data, error } = await db.rpc("count_bookings_per_local_day", {
        p_user_ids: userIds,
        p_tz_by_user: tzByUser,
        p_from: from,
        p_to: to,
      });
      // Fail loud: a swallowed count would under-count the cap and keep offering a
      // capped advisor's day (the #35 / #166 direction).
      if (error) throw new Error(`splice daily cap count failed: ${error.message}`);
      return parseDayCounts(data);
    },

    // busy_blocks is a growth table, so it is paged past PostgREST's 1,000 row cap
    // (#828), ordered by id (#3273), and throws on a read error. A move's two
    // windows are one statement too (#3334): an `or` of one overlap test per span,
    // so two times days apart read their own blocks and not every block between.
    loadBusy: async (userIds, spans) => {
      if (spans.length === 0) return [];
      return selectAllPages<{ user_id: string; starts_at: string; ends_at: string }>("splice busy_blocks", "id", () => {
        const q = db.from("busy_blocks").select("id, user_id, starts_at, ends_at").in("user_id", userIds);
        if (spans.length === 1) return q.lt("starts_at", spans[0]!.to).gt("ends_at", spans[0]!.from);
        return q.or(spans.map((s) => `and(starts_at.lt.${s.to},ends_at.gt.${s.from})`).join(","));
      });
    },

    compute: (pool, members, range, nowMs) =>
      computeSlotsFromInputs(
        pool.ctx.bucket.code,
        {
          resolved: { bucket: pool.ctx.bucket, eventType: pool.ctx.eventType },
          // The splice never touches the row's org name, only its slot lists.
          orgRes: { data: null, error: null },
          membersResult: { members, lowIds: pool.ctx.lowIds },
          businessHours: pool.ctx.businessHours,
        },
        range.computeFrom,
        range.computeTo,
        nowMs,
      ),

    readRows: (codes) => readSlotRows(db, codes),
    writeFromRead: (code, row, parts, fenceAtMs, startedMs) => spliceFromRead(db, code, row, parts, fenceAtMs, startedMs),
    writeSplice: (code, parts, fenceAtMs, startedMs) => spliceSlotRow(db, code, parts, fenceAtMs, startedMs),
    // Set by the caller, which owns the edge cache.
    invalidate: async () => {},
    warn: (msg, err) => log.warn("slot-cache", { msg, bucket: context }, err),
  };
}
