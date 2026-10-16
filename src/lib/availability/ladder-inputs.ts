import { DateTime, IANAZone } from "luxon";
import { capCountWindow } from "@/lib/availability/compute";
import { payPeriod } from "@/lib/availability/roundrobin";
import { bufferedWindow } from "@/lib/booking/buffered-window";
import { BUSINESS_ZONE, type BusinessHoursException, type BusinessHoursRow } from "@/lib/booking/business-hours";
import type { LiveHoldRow } from "@/lib/booking/reroute-hold";
import type { Attributes, Bucket, Criteria, EventType, User } from "@/lib/db/types";
import type { ResolvedBucket } from "@/lib/availability/service";

/**
 * Everything a confirm's candidate read needs for every rung of its ladder, read in ONE
 * request (#3489, `ladder_candidate_inputs`, migration 0176).
 *
 * A walk down the ladder read each rung with seven to nine requests and each lower
 * rung's bucket with another, and request COUNT is what queues a crowd (#3492). This
 * holds the rows those reads returned, for the whole ladder, so each rung is judged by
 * the same TypeScript as before (`roundRobinCandidates`) from rows already in hand.
 *
 * The function reads every bookable advisor of the ladder's orgs and reads busy time,
 * counts and holds over windows made a SUPERSET of every rung's (`ladderWindows`). A
 * rung whose own window is not inside them is read the old way (`covers`).
 */
export interface LadderInputs {
  readonly windows: LadderWindows;
  /** The rung's bucket with its event type, or null when the code has no row (or no
   *  event type), exactly as `resolveBucketByCode` answers. */
  bucket(code: string): ResolvedBucket | null;
  /** Whether [fromIso, toIso) lies inside the window busy time and holds were read over. */
  covers(fromIso: string, toIso: string): boolean;
  /** The org's bookable advisors who have not left, as `resolveBucketPool` read them. */
  orgAgents(orgId: string): { id: string; attributes: Attributes }[];
  /** A bucket's active manual members. */
  membersOf(bucketId: string): Set<string>;
  /** The bucket's raw pool, as `resolveBucketPool` reads it, for the routing trace. */
  pool(bucket: Pick<Bucket, "id" | "org_id" | "criteria">): {
    orgAgents: { id: string; attributes: Attributes }[];
    manualMemberIds: Set<string>;
    criteria: Criteria;
  };
  /** A bookable advisor's whole row, as the advisor read (`getUser`) returns it, or
   *  null for somebody the read did not hold. */
  user(id: string): User | null;
  /** The advisors' emails, as the emails read (`loadEmails`) answers: an advisor the
   *  read does not hold, or one with no email, is left out. */
  emails(ids: readonly string[]): Map<string, string>;
  readonly schedules: { id: string; user_id: string; timezone: string }[];
  readonly rules: { schedule_id: string; weekday: number; start_minute: number; end_minute: number }[];
  readonly busy: { user_id: string; starts_at: string; ends_at: string; source: string }[];
  /** `count_bookings_per_local_day`'s answer, unparsed (`parseDayCounts`). */
  readonly dayCounts: unknown;
  readonly holds: LiveHoldRow[];
  readonly shares: { bucket_id: string; assigned_user_id: string | null; starts_at: string; created_at: string }[];
  readonly businessHours: BusinessHoursRow[];
  readonly exceptions: BusinessHoursException[];
  /**
   * #3530: the advisors left out because a row of theirs could not be read. Every row
   * of theirs is gone from every section above, so no rung can offer them. Logged by
   * the reader that fetched the answer and paged by the monitor lane
   * (`ladder_advisor_unreadable`), because an advisor nobody can book is a staffing
   * fault somebody has to repair.
   */
  readonly dropped: readonly DroppedAdvisor[];
}

/** An advisor the ladder read left out, and why (#3530). */
export interface DroppedAdvisor {
  readonly id: string;
  /** Their name from their roster row, when it had one; null when it did not. */
  readonly name: string | null;
  /** Each unreadable row, as `<section>: no readable <fields>`. Never a value. */
  readonly why: readonly string[];
}

/**
 * The windows the read covers, every one a superset of a rung's own, as ISO instants
 * (and a date for the exceptions). Every bound is sent: the function refuses a missing
 * one rather than reading an unbounded window.
 */
export interface LadderWindows {
  busyFrom: string;
  busyTo: string;
  capFrom: string;
  capTo: string;
  shareFrom: string;
  shareTo: string;
  exceptionsFrom: string;
}

/**
 * How far the busy and holds window reaches past the requested rung's own buffered
 * window on each side, so a lower rung whose event type is longer or more buffered is
 * still inside it. A rung outside it anyway is read the old way, never judged short.
 */
export const LADDER_WINDOW_SLACK_MIN = 60;

/**
 * How old the ladder read may be when a rung is judged from it (#3530). One read serves
 * the whole walk, so a lower rung is judged from busy time, day counts, holds and the
 * roster read before the live Google checks on the rungs above it. In that time another
 * confirm can book the same advisor's day (the daily cap exceeded by one), a reroute can
 * hold them, or they can stop being bookable, and the read still offers them. A rung
 * judged after this long is judged from a fresh read instead
 * (`assignAgentWithTierFallback`).
 *
 * Two seconds, derived from the two clocks a walk runs under. It is a quarter of a live
 * check's own deadline (`GOOGLE_CONFIRM_TIMEOUT_MS`, 8 seconds), so a rung that waited
 * on a slow Google check always re-reads, while a walk that only touched the database
 * (the read itself is priced at 200ms, each line call less) never pays for one. And it
 * is a sixth of the confirm budget (`BOOKING_CONFIRM_BUDGET_MS`, 12 seconds), so a walk
 * that re-reads still has the budget to judge its rung and write the booking. A re-read
 * is one request, never the seven to nine a rung read cost before #3489. Both relations
 * are pinned by `scripts/test-ladder-read-staleness.ts`; the constants live where they
 * are because importing either here would pull the Google client or the orchestration
 * into a module the booker's availability read loads.
 */
export const LADDER_READ_MAX_AGE_MS = 2_000;

/**
 * The windows to read for a confirm at `startIso` on a ladder whose requested rung has
 * `eventType`: the rung's buffered window widened by `LADDER_WINDOW_SLACK_MIN`; the cap
 * count's day either side of that (`capCountWindow`, the rule the count already had);
 * the share read's two pay periods around the slot (`rankBucketShare`'s own); and the
 * business hour exceptions from today in the business zone (`loadBusinessHours`'s).
 */
export function ladderWindows(
  startIso: string,
  eventType: Pick<EventType, "duration_min" | "buffer_before_min" | "buffer_after_min">,
  nowMs: number,
): LadderWindows {
  const startMs = Date.parse(startIso);
  const endIso = new Date(startMs + eventType.duration_min * 60_000).toISOString();
  const [from, to] = bufferedWindow(eventType, new Date(startMs).toISOString(), endIso);
  const slack = LADDER_WINDOW_SLACK_MIN * 60_000;
  const busyFrom = new Date(Date.parse(from) - slack).toISOString();
  const busyTo = new Date(Date.parse(to) + slack).toISOString();
  const cap = capCountWindow(busyFrom, busyTo);
  const period = payPeriod(startMs);
  const priorStartMs = payPeriod(period.startMs - 1).startMs;
  return {
    busyFrom,
    busyTo,
    capFrom: cap.from,
    capTo: cap.to,
    shareFrom: new Date(priorStartMs).toISOString(),
    shareTo: new Date(period.endMs).toISOString(),
    exceptionsFrom: DateTime.fromMillis(nowMs).setZone(BUSINESS_ZONE).toISODate() ?? "1970-01-01",
  };
}

/** The function's answer could not be read. Thrown, never read as an empty ladder. */
export class LadderInputsUnreadableError extends Error {
  constructor(why: string) {
    super(`ladder candidate inputs: ${why}`);
    this.name = "LadderInputsUnreadableError";
  }
}

type Row = Record<string, unknown>;
const isRow = (x: unknown): x is Row => x !== null && typeof x === "object" && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === "string" && x.length > 0;
const isInstant = (x: unknown): x is string => typeof x === "string" && Number.isFinite(Date.parse(x));
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);

/**
 * `ladder_candidate_inputs`'s answer, read and checked.
 *
 * THROWS on anything it cannot read for everybody: a missing section, a row that is not
 * a row, an org wide row (a bucket, a day of the week, an exception) without the fields
 * its reader judges by, and a row that NAMES NOBODY (busy time, a hold, a count or a
 * share with no readable advisor id). Every one of those read as empty would be the
 * permissive answer (nobody busy, nobody held, no hours narrowed), which is the outage
 * that looks like a quiet day (#277, L50), and a row naming nobody could be anybody's.
 *
 * A row that names its advisor and is otherwise unreadable DROPS THAT ADVISOR (#3530),
 * whole: off the roster, so out of every pool (by criteria, as a manual member and as a
 * bucket's fallback, which must be on the roster to be routed), and every other row of
 * theirs with them. It used to throw, so one bad row failed every confirm on every
 * ladder of the org, where the reads it replaced failed only that advisor's pools. It
 * never skips just the bad row: a busy block, hold or count left out makes the advisor
 * look free, and they are booked over a call they already have. The advisors dropped
 * are returned in `dropped` so the caller can say so; they are never silently gone.
 */
export function ladderInputsFrom(data: unknown, windows: LadderWindows): LadderInputs {
  if (!isRow(data)) throw new LadderInputsUnreadableError("the answer is not an object");
  const section = (key: string): Row[] => {
    const v = data[key];
    if (!Array.isArray(v)) throw new LadderInputsUnreadableError(`${key} is not a list`);
    return v.map((r, i) => {
      if (!isRow(r)) throw new LadderInputsUnreadableError(`${key}[${i}] is not a row`);
      return r;
    });
  };
  const need = (key: string, i: number, ok: boolean, what: string) => {
    if (!ok) throw new LadderInputsUnreadableError(`${key}[${i}] has no readable ${what}`);
  };
  // #3530: the advisors with a row that could not be read, and every reason.
  const reasons = new Map<string, string[]>();
  const drop = (id: string, key: string, what: string) => {
    const why = `${key}: no readable ${what}`;
    const list = reasons.get(id) ?? [];
    if (!list.includes(why)) list.push(why);
    reasons.set(id, list);
  };
  /** The advisor a row names, which must be readable or the whole answer is not. */
  const owner = (key: string, i: number, r: Row, field: string): string => {
    need(key, i, isStr(r[field]), "advisor");
    return r[field] as string;
  };

  const buckets = new Map<string, ResolvedBucket | null>();
  section("buckets").forEach((r, i) => {
    need("buckets", i, isStr(r.code) && isStr(r.id) && isStr(r.org_id), "code, id or org");
    const { event_types: eventType, ...bucket } = r;
    // As `resolveBucketByCode`: a bucket with no event type is no bucket to book.
    buckets.set(r.code as string, isRow(eventType) ? { bucket: bucket as unknown as Bucket, eventType: eventType as unknown as EventType } : null);
  });

  // Every section is read before anything is kept, so an advisor found unreadable in a
  // LATER section is still taken out of the earlier ones.
  const names = new Map<string, string>();
  const agentRows = section("agents").flatMap((r, i) => {
    const id = owner("agents", i, r, "id");
    if (typeof r.name === "string" && r.name.trim()) names.set(id, r.name.trim());
    if (!(isStr(r.org_id) && isRow(r.attributes) && isStr(r.email))) {
      drop(id, "agents", "org, attributes or email");
      return [];
    }
    return [{ id, row: r }];
  });

  const memberRows = section("members").flatMap((r, i) => {
    const id = owner("members", i, r, "user_id");
    if (!isStr(r.bucket_id)) {
      drop(id, "members", "bucket");
      return [];
    }
    return [{ bucket_id: r.bucket_id as string, user_id: id }];
  });

  const scheduleRows = section("schedules").flatMap((r, i) => {
    const id = owner("schedules", i, r, "user_id");
    // A zone Luxon cannot read is as unreadable as none: the hours and the day the cap
    // counts in are both judged in it (`IANAZone.isValidZone`, the schedule writer's own
    // check, so only a row written around it can fail here).
    if (!(isStr(r.id) && isStr(r.timezone) && IANAZone.isValidZone(r.timezone as string) && Array.isArray(r.availability_rules))) {
      drop(id, "schedules", "id, zone or rules");
      return [];
    }
    const rules = (r.availability_rules as unknown[]).flatMap((x) => {
      if (!(isRow(x) && isStr(x.schedule_id) && isInt(x.weekday) && isInt(x.start_minute) && isInt(x.end_minute))) return [null];
      return [{ schedule_id: x.schedule_id as string, weekday: x.weekday as number, start_minute: x.start_minute as number, end_minute: x.end_minute as number }];
    });
    if (rules.some((x) => x === null)) {
      drop(id, "schedules", "rule");
      return [];
    }
    return [{ schedule: { id: r.id as string, user_id: id, timezone: r.timezone as string }, rules: rules as LadderInputs["rules"] }];
  });

  const busyRows = section("busy").flatMap((r, i) => {
    const id = owner("busy", i, r, "user_id");
    if (!(isInstant(r.starts_at) && isInstant(r.ends_at) && isStr(r.source))) {
      drop(id, "busy", "bounds or source");
      return [];
    }
    return [{ user_id: id, starts_at: r.starts_at as string, ends_at: r.ends_at as string, source: r.source as string }];
  });

  // `"<advisor>|<YYYY-MM-DD>" -> count` (`parseDayCounts`). A count it cannot read would
  // be read as no bookings that day, which waives the advisor's daily cap.
  if (!isRow(data.day_counts)) throw new LadderInputsUnreadableError("day_counts is not an object");
  const dayCounts: Record<string, number> = {};
  for (const [key, n] of Object.entries(data.day_counts)) {
    const sep = key.indexOf("|");
    if (sep <= 0) throw new LadderInputsUnreadableError(`day_counts has a count naming no advisor`);
    const id = key.slice(0, sep);
    if (!(/^\d{4}-\d{2}-\d{2}$/.test(key.slice(sep + 1)) && isInt(n) && n >= 0)) {
      drop(id, "day_counts", "day or count");
      continue;
    }
    dayCounts[key] = n;
  }

  const holdRows = section("holds").flatMap((r, i) => {
    const id = owner("holds", i, r, "agent_user_id");
    if (!(isStr(r.booking_id) && isInstant(r.booking_starts_at) && isInstant(r.booking_ends_at) && isInstant(r.buffered_starts_at) && isInstant(r.buffered_ends_at))) {
      drop(id, "holds", "booking or window");
      return [];
    }
    return [r as unknown as LiveHoldRow];
  });

  const shareRows = section("shares").flatMap((r, i) => {
    // A share with no advisor is kept for the share's own reduction to skip, so it must
    // still read; one that does not names nobody to drop.
    if (r.assigned_user_id === null) {
      need("shares", i, isStr(r.bucket_id) && isInstant(r.starts_at) && isInstant(r.created_at), "bucket or instants");
      return [{ bucket_id: r.bucket_id as string, assigned_user_id: null, starts_at: r.starts_at as string, created_at: r.created_at as string }];
    }
    const id = owner("shares", i, r, "assigned_user_id");
    if (!(isStr(r.bucket_id) && isInstant(r.starts_at) && isInstant(r.created_at))) {
      drop(id, "shares", "bucket or instants");
      return [];
    }
    return [{ bucket_id: r.bucket_id as string, assigned_user_id: id as string | null, starts_at: r.starts_at as string, created_at: r.created_at as string }];
  });

  const businessHours = section("business_hours").map((r, i) => {
    need("business_hours", i, isInt(r.weekday) && typeof r.is_open === "boolean" && isInt(r.start_minute) && isInt(r.end_minute), "weekday, open flag or minutes");
    return r as unknown as BusinessHoursRow;
  });
  const exceptions = section("exceptions").map((r, i) => {
    need("exceptions", i, isStr(r.on_date) && typeof r.is_open === "boolean", "date or open flag");
    return r as unknown as BusinessHoursException;
  });

  // Keep what is left: nobody dropped appears in any section.
  const kept = (id: string | null) => id === null || !reasons.has(id);
  const agentsByOrg = new Map<string, { id: string; attributes: Attributes }[]>();
  const userById = new Map<string, User>();
  for (const { id, row } of agentRows) {
    if (!kept(id)) continue;
    const list = agentsByOrg.get(row.org_id as string) ?? [];
    list.push({ id, attributes: row.attributes as Attributes });
    agentsByOrg.set(row.org_id as string, list);
    userById.set(id, row as unknown as User);
  }
  const members = new Map<string, Set<string>>();
  for (const m of memberRows) {
    if (!kept(m.user_id)) continue;
    const set = members.get(m.bucket_id) ?? new Set<string>();
    set.add(m.user_id);
    members.set(m.bucket_id, set);
  }
  const keptSchedules = scheduleRows.filter((s) => kept(s.schedule.user_id));
  const schedules: LadderInputs["schedules"] = keptSchedules.map((s) => s.schedule);
  const rules: LadderInputs["rules"] = keptSchedules.flatMap((s) => s.rules);
  const busy = busyRows.filter((b) => kept(b.user_id));
  for (const key of Object.keys(dayCounts)) if (!kept(key.slice(0, key.indexOf("|")))) delete dayCounts[key];
  const holds = holdRows.filter((h) => kept(h.agent_user_id));
  const shares = shareRows.filter((s) => kept(s.assigned_user_id));
  const dropped: DroppedAdvisor[] = [...reasons].map(([id, why]) => ({ id, name: names.get(id) ?? null, why }));

  const busyFromMs = Date.parse(windows.busyFrom);
  const busyToMs = Date.parse(windows.busyTo);
  return {
    windows,
    bucket: (code) => buckets.get(code) ?? null,
    covers: (fromIso, toIso) => Date.parse(fromIso) >= busyFromMs && Date.parse(toIso) <= busyToMs,
    orgAgents: (orgId) => agentsByOrg.get(orgId) ?? [],
    membersOf: (bucketId) => members.get(bucketId) ?? new Set<string>(),
    pool: (bucket) => ({
      orgAgents: agentsByOrg.get(bucket.org_id) ?? [],
      manualMemberIds: members.get(bucket.id) ?? new Set<string>(),
      criteria: bucket.criteria ?? {},
    }),
    user: (id) => userById.get(id) ?? null,
    emails: (ids) => {
      const m = new Map<string, string>();
      for (const id of ids) {
        const email = userById.get(id)?.email;
        if (email) m.set(id, email);
      }
      return m;
    },
    schedules,
    rules,
    busy,
    dayCounts,
    holds,
    shares,
    businessHours,
    exceptions,
    dropped,
  };
}
