import { DateTime } from "luxon";
import { capCountWindow } from "@/lib/availability/compute";
import { payPeriod } from "@/lib/availability/roundrobin";
import { bufferedWindow } from "@/lib/booking/buffered-window";
import { BUSINESS_ZONE, type BusinessHoursException, type BusinessHoursRow } from "@/lib/booking/business-hours";
import type { LiveHoldRow } from "@/lib/booking/reroute-hold";
import type { Attributes, Bucket, EventType } from "@/lib/db/types";
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
  readonly schedules: { id: string; user_id: string; timezone: string }[];
  readonly rules: { schedule_id: string; weekday: number; start_minute: number; end_minute: number }[];
  readonly busy: { user_id: string; starts_at: string; ends_at: string; source: string }[];
  /** `count_bookings_per_local_day`'s answer, unparsed (`parseDayCounts`). */
  readonly dayCounts: unknown;
  readonly holds: LiveHoldRow[];
  readonly shares: { bucket_id: string; assigned_user_id: string | null; starts_at: string; created_at: string }[];
  readonly businessHours: BusinessHoursRow[];
  readonly exceptions: BusinessHoursException[];
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
 * `ladder_candidate_inputs`'s answer, read and checked. THROWS on anything it cannot
 * read: a missing section, a row without the fields its reader judges by, an instant
 * that does not parse. Every one of those read as empty would be the permissive answer
 * (nobody busy, nobody held, no hours narrowed), which is the outage that looks like a
 * quiet day (#277, L50).
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

  const buckets = new Map<string, ResolvedBucket | null>();
  section("buckets").forEach((r, i) => {
    need("buckets", i, isStr(r.code) && isStr(r.id) && isStr(r.org_id), "code, id or org");
    const { event_types: eventType, ...bucket } = r;
    // As `resolveBucketByCode`: a bucket with no event type is no bucket to book.
    buckets.set(r.code as string, isRow(eventType) ? { bucket: bucket as unknown as Bucket, eventType: eventType as unknown as EventType } : null);
  });

  const agentsByOrg = new Map<string, { id: string; attributes: Attributes }[]>();
  section("agents").forEach((r, i) => {
    need("agents", i, isStr(r.id) && isStr(r.org_id) && isRow(r.attributes), "id, org or attributes");
    const list = agentsByOrg.get(r.org_id as string) ?? [];
    list.push({ id: r.id as string, attributes: r.attributes as Attributes });
    agentsByOrg.set(r.org_id as string, list);
  });

  const members = new Map<string, Set<string>>();
  section("members").forEach((r, i) => {
    need("members", i, isStr(r.bucket_id) && isStr(r.user_id), "bucket or advisor");
    const set = members.get(r.bucket_id as string) ?? new Set<string>();
    set.add(r.user_id as string);
    members.set(r.bucket_id as string, set);
  });

  const schedules: LadderInputs["schedules"] = [];
  const rules: LadderInputs["rules"] = [];
  section("schedules").forEach((r, i) => {
    need("schedules", i, isStr(r.id) && isStr(r.user_id) && isStr(r.timezone) && Array.isArray(r.availability_rules), "id, advisor, zone or rules");
    schedules.push({ id: r.id as string, user_id: r.user_id as string, timezone: r.timezone as string });
    (r.availability_rules as unknown[]).forEach((x) => {
      need("schedules", i, isRow(x) && isStr(x.schedule_id) && isInt(x.weekday) && isInt(x.start_minute) && isInt(x.end_minute), "rule");
      const rule = x as Row;
      rules.push({ schedule_id: rule.schedule_id as string, weekday: rule.weekday as number, start_minute: rule.start_minute as number, end_minute: rule.end_minute as number });
    });
  });

  const busy = section("busy").map((r, i) => {
    need("busy", i, isStr(r.user_id) && isInstant(r.starts_at) && isInstant(r.ends_at) && isStr(r.source), "advisor, bounds or source");
    return { user_id: r.user_id as string, starts_at: r.starts_at as string, ends_at: r.ends_at as string, source: r.source as string };
  });

  if (!isRow(data.day_counts)) throw new LadderInputsUnreadableError("day_counts is not an object");

  const holds = section("holds").map((r, i) => {
    need(
      "holds",
      i,
      isStr(r.agent_user_id) && isStr(r.booking_id) && isInstant(r.booking_starts_at) && isInstant(r.booking_ends_at) && isInstant(r.buffered_starts_at) && isInstant(r.buffered_ends_at),
      "advisor, booking or window",
    );
    return r as unknown as LiveHoldRow;
  });

  const shares = section("shares").map((r, i) => {
    need("shares", i, isStr(r.bucket_id) && (r.assigned_user_id === null || isStr(r.assigned_user_id)) && isInstant(r.starts_at) && isInstant(r.created_at), "bucket, advisor or instants");
    return { bucket_id: r.bucket_id as string, assigned_user_id: r.assigned_user_id as string | null, starts_at: r.starts_at as string, created_at: r.created_at as string };
  });

  const businessHours = section("business_hours").map((r, i) => {
    need("business_hours", i, isInt(r.weekday) && typeof r.is_open === "boolean" && isInt(r.start_minute) && isInt(r.end_minute), "weekday, open flag or minutes");
    return r as unknown as BusinessHoursRow;
  });
  const exceptions = section("exceptions").map((r, i) => {
    need("exceptions", i, isStr(r.on_date) && typeof r.is_open === "boolean", "date or open flag");
    return r as unknown as BusinessHoursException;
  });

  const busyFromMs = Date.parse(windows.busyFrom);
  const busyToMs = Date.parse(windows.busyTo);
  return {
    windows,
    bucket: (code) => buckets.get(code) ?? null,
    covers: (fromIso, toIso) => Date.parse(fromIso) >= busyFromMs && Date.parse(toIso) <= busyToMs,
    orgAgents: (orgId) => agentsByOrg.get(orgId) ?? [],
    membersOf: (bucketId) => members.get(bucketId) ?? new Set<string>(),
    schedules,
    rules,
    busy,
    dayCounts: data.day_counts,
    holds,
    shares,
    businessHours,
    exceptions,
  };
}
