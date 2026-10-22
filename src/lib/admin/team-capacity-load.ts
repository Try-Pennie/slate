/**
 * The reads behind Team capacity (#3935). Every one already exists for the booker or the sync
 * lane; this only gathers them and hands them to `teamCapacityReport`.
 *
 * The one rule that matters: a read that fails is reported as the read that failed, never as an
 * empty answer. A roster, calendar or time off read degrading to [] would draw a team with no room,
 * which is exactly the reading that pauses ad spend, so each failure names itself and the page
 * shows only that (design decision D26).
 */
import { DateTime } from "luxon";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { log } from "@/lib/log";
import { loadBusinessHours } from "@/lib/booking/business-hours-load";
import { readOfferedOpenDays } from "@/lib/booking/days-offered-load";
import { loadMembersAvailability, resolveBucketByCode, type ResolvedBucket } from "@/lib/availability/service";
import type { MemberAvailability } from "@/lib/availability/compute";
import type { BusinessHours } from "@/lib/booking/business-hours-load";
import { approvedTimeOffIntervals } from "@/lib/ooo/approved-overlap";
import { loadFailingAgents } from "@/lib/google/sync";
import { capacityDays } from "./capacity-days";
import { teamCapacityReport, type CapacityEventType, type TeamCapacityAdvisor, type TimeOffInterval } from "./team-capacity";

/** Which read failed. Each is said in its own words on the page, never as zeros (L10, L11). */
export type TeamCapacityUnreadable =
  | "business-hours"
  | "booking-window"
  /** The office's week holds no open day to count, so there is no window to report. */
  | "no-open-days"
  /** Nobody is bookable, a state rather than a failed read, said as such rather than drawn as no room. */
  | "no-advisors"
  | "event-type"
  | "roster"
  | "calendars"
  | "time-off"
  | "calendar-sync";

export type TeamCapacityReport =
  | { measurable: false; reason: TeamCapacityUnreadable }
  | {
      measurable: true;
      nowMs: number;
      zone: string;
      /** The page's days: the booker's, led by today after the 6 PM cutoff while the office is
       *  open, since its remaining times are still served (#3949). What the page draws. */
      windowDays: string[];
      /** The days the booker offers a lead (`offeredWindowFor`), never led by today after the
       *  cutoff. What the calendars filling up notice judges (#4064); every one is in `days`. */
      bookerDays: string[];
      /** Every day reported: the window's, then the one asked for if it is not among them. */
      days: string[];
      eventType: CapacityEventType;
      advisors: TeamCapacityAdvisor[];
    };

export interface LoadTeamCapacityOptions {
  orgId: string;
  now?: Date;
  /** A day outside the window to report too (yyyy-mm-dd, office zone), from the date picker. */
  extraDay?: string | null;
}

/** A read gathered for the page and for history, or the read that failed. */
export type CapacityRead<T> = { ok: true; value: T } | { ok: false; reason: TeamCapacityUnreadable; err?: unknown };

/** The rules every capacity number is laid out by: the office's hours and the call setting. */
export interface CapacityRules {
  hours: BusinessHours;
  eventType: CapacityEventType;
  bucket: ResolvedBucket["bucket"];
}

/** Who is in the bookable pool, and their calendars, time off and sync health over `days`. */
export interface CapacityPeople {
  roster: { id: string; name: string | null; email: string }[];
  members: MemberAvailability[];
  timeOff: Map<string, TimeOffInterval[]>;
  failingEmails: Set<string>;
}

/** The office's hours and the one call setting every live bucket books with. */
export async function loadCapacityRules(orgId: string): Promise<CapacityRead<CapacityRules>> {
  const db = supabaseAdmin();
  let hours;
  try {
    hours = await loadBusinessHours();
  } catch (err) {
    return { ok: false, reason: "business-hours", err };
  }

  // The event type every live bucket books with. Buckets carry one each; all of today's share
  // one, and if they ever differ there is no single answer to "how many calls fit", so the page
  // says it cannot measure rather than choosing one silently.
  let resolved;
  try {
    // is_test is filtered here rather than in the query: .eq(false) would also drop a null.
    const rows = ((unwrap(
      await db.from("buckets").select("code, event_type_id, is_test").eq("org_id", orgId),
      "team capacity buckets",
    ) ?? []) as { code: string; event_type_id: string | null; is_test: boolean | null }[]).filter((b) => !b.is_test);
    const types = new Set(rows.map((r) => r.event_type_id));
    if (rows.length === 0 || types.size !== 1) return { ok: false, reason: "event-type" };
    resolved = await resolveBucketByCode(rows[0].code);
    if (!resolved) return { ok: false, reason: "event-type" };
  } catch (err) {
    return { ok: false, reason: "event-type", err };
  }
  return { ok: true, value: { hours, eventType: resolved.eventType as CapacityEventType, bucket: resolved.bucket } };
}

/** The bookable pool over `days` (office dates), every read named when it fails. */
export async function loadCapacityPeople(orgId: string, rules: CapacityRules, days: string[]): Promise<CapacityRead<CapacityPeople>> {
  const db = supabaseAdmin();
  const { hours, eventType } = rules;
  let roster: { id: string; name: string | null; email: string }[];
  try {
    // The bookable pool is bookable AND not departed AND not a test advisor; is_test is filtered
    // here because .eq(false) in the query would also drop every advisor whose flag is null.
    roster = ((unwrap(
      await db
        .from("users")
        .select("id, name, email, is_test")
        .eq("org_id", orgId)
        .eq("bookable", true)
        .is("deactivated_at", null),
      "team capacity roster",
    ) ?? []) as { id: string; name: string | null; email: string; is_test: boolean | null }[])
      .filter((u) => !u.is_test)
      .map(({ id, name, email }) => ({ id, name, email }));
  } catch (err) {
    return { ok: false, reason: "roster", err };
  }
  if (roster.length === 0) return { ok: false, reason: "no-advisors" };

  // Busy time and time off over every reported day, widened by a whole call and its gaps on each
  // side so a block starting at midnight is still seen by the first and last slots (#3273).
  const marginMs = (eventType.duration_min + eventType.buffer_before_min + eventType.buffer_after_min) * 60_000;
  const sorted = [...days].sort();
  const fromMs = DateTime.fromISO(sorted[0], { zone: hours.zone }).toMillis() - marginMs;
  const toMs = DateTime.fromISO(sorted.at(-1)!, { zone: hours.zone }).plus({ days: 1 }).toMillis() + marginMs;
  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(toMs).toISOString();

  const ids = roster.map((u) => u.id);
  const [membersRes, timeOffRes, failing] = await Promise.all([
    loadMembersAvailability(rules.bucket, fromIso, toIso, async () => ({ ids, fallbackApplied: false })).then(
      (r) => ({ ok: true as const, members: r.members }),
      (err: unknown) => ({ ok: false as const, err }),
    ),
    approvedTimeOffIntervals(fromIso, toIso).then(
      (m) => ({ ok: true as const, m }),
      (err: unknown) => ({ ok: false as const, err }),
    ),
    loadFailingAgents("sync").then(
      (list) => ({ ok: true as const, list }),
      (err: unknown) => ({ ok: false as const, err }),
    ),
  ]);
  if (!membersRes.ok) return { ok: false, reason: "calendars", err: membersRes.err };
  // The availability read returns a row for every advisor asked about, so a missing one means it
  // came back incomplete, which is a failed read and never "nobody working".
  const returned = new Set(membersRes.members.map((m) => m.userId));
  const missing = ids.filter((id) => !returned.has(id));
  if (missing.length) return { ok: false, reason: "calendars", err: new Error(`no availability row for ${missing.length} advisor(s)`) };
  if (!timeOffRes.ok) return { ok: false, reason: "time-off", err: timeOffRes.err };
  if (!failing.ok) return { ok: false, reason: "calendar-sync", err: failing.err };
  // Null means the sync health could not be read, never that nothing is failing (#1134).
  if (failing.list === null) return { ok: false, reason: "calendar-sync" };
  return {
    ok: true,
    value: { roster, members: membersRes.members, timeOff: timeOffRes.m, failingEmails: new Set(failing.list.map((f) => f.email)) },
  };
}

export async function loadTeamCapacity(opts: LoadTeamCapacityOptions): Promise<TeamCapacityReport> {
  const nowMs = (opts.now ?? new Date()).getTime();
  // A read that failed is an error; a state the data is in (nobody bookable, no open day, buckets
  // that disagree) is not, and logging it as one would page on every view of a quiet page (L36).
  const STATES: TeamCapacityUnreadable[] = ["no-open-days", "no-advisors", "event-type"];
  const refuse = (reason: TeamCapacityUnreadable, err?: unknown): TeamCapacityReport => {
    if (err === undefined && STATES.includes(reason)) log.info("team-capacity", { msg: "nothing to measure", reason });
    else log.error("team-capacity", { msg: "read failed", reason }, err);
    return { measurable: false, reason };
  };

  const rules = await loadCapacityRules(opts.orgId);
  if (!rules.ok) return refuse(rules.reason, rules.err);
  const { hours, eventType } = rules.value;

  let offered: number | null;
  try {
    offered = await readOfferedOpenDays();
  } catch (err) {
    return refuse("booking-window", err);
  }
  if (offered === null) return refuse("booking-window");
  // The page's days lead with today after the 6 PM cutoff (#3949); the booker's do not (#4064).
  const window = capacityDays(hours, nowMs, eventType.min_notice_min, offered);
  // No window is not an empty one: drawn, it would read as a team with no room (L10).
  if (!window) return refuse("no-open-days");
  const { windowDays, bookerDays } = window;
  // The picked day comes from a URL, so anything that is not a real date is ignored rather than
  // allowed to turn the busy read's bounds into NaN.
  const extra = opts.extraDay && /^\d{4}-\d{2}-\d{2}$/.test(opts.extraDay) && DateTime.fromISO(opts.extraDay, { zone: hours.zone }).isValid ? opts.extraDay : null;
  if (opts.extraDay && !extra) log.warn("team-capacity", { msg: "ignored an unreadable picked day", day: opts.extraDay });
  const days = extra && !windowDays.includes(extra) ? [...windowDays, extra] : windowDays;

  const people = await loadCapacityPeople(opts.orgId, rules.value, days);
  if (!people.ok) return refuse(people.reason, people.err);

  const report = teamCapacityReport({ days, ...people.value, eventType, hours, nowMs });
  return { measurable: true, nowMs, zone: hours.zone, windowDays, bookerDays, days, eventType, advisors: report.advisors };
}
