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
import { offeredWindowFor } from "@/lib/availability/offered-window";
import { loadMembersAvailability, resolveBucketByCode } from "@/lib/availability/service";
import { approvedTimeOffIntervals } from "@/lib/ooo/approved-overlap";
import { loadFailingAgents } from "@/lib/google/sync";
import { teamCapacityReport, type CapacityEventType, type TeamCapacityAdvisor } from "./team-capacity";

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
      /** The booking window's days, as the booker counts them (`offeredWindowFor`). */
      windowDays: string[];
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

export async function loadTeamCapacity(opts: LoadTeamCapacityOptions): Promise<TeamCapacityReport> {
  const db = supabaseAdmin();
  const nowMs = (opts.now ?? new Date()).getTime();
  // A read that failed is an error; a state the data is in (nobody bookable, no open day, buckets
  // that disagree) is not, and logging it as one would page on every view of a quiet page (L36).
  const STATES: TeamCapacityUnreadable[] = ["no-open-days", "no-advisors", "event-type"];
  const refuse = (reason: TeamCapacityUnreadable, err?: unknown): TeamCapacityReport => {
    if (err === undefined && STATES.includes(reason)) log.info("team-capacity", { msg: "nothing to measure", reason });
    else log.error("team-capacity", { msg: "read failed", reason }, err);
    return { measurable: false, reason };
  };

  let hours;
  try {
    hours = await loadBusinessHours();
  } catch (err) {
    return refuse("business-hours", err);
  }

  // The event type every live bucket books with. Buckets carry one each; all of today's share
  // one, and if they ever differ there is no single answer to "how many calls fit", so the page
  // says it cannot measure rather than choosing one silently.
  let resolved;
  try {
    // is_test is filtered here rather than in the query: .eq(false) would also drop a null.
    const rows = ((unwrap(
      await db.from("buckets").select("code, event_type_id, is_test").eq("org_id", opts.orgId),
      "team capacity buckets",
    ) ?? []) as { code: string; event_type_id: string | null; is_test: boolean | null }[]).filter((b) => !b.is_test);
    const types = new Set(rows.map((r) => r.event_type_id));
    if (rows.length === 0 || types.size !== 1) return refuse("event-type");
    resolved = await resolveBucketByCode(rows[0].code);
    if (!resolved) return refuse("event-type");
  } catch (err) {
    return refuse("event-type", err);
  }
  const eventType = resolved.eventType as CapacityEventType;

  let offered: number | null;
  try {
    offered = await readOfferedOpenDays();
  } catch (err) {
    return refuse("booking-window", err);
  }
  if (offered === null) return refuse("booking-window");
  const window = offeredWindowFor(hours, nowMs, eventType.min_notice_min, offered);
  // No window is not an empty one: drawn, it would read as a team with no room (L10).
  if (!window || window.days.length === 0) return refuse("no-open-days");
  const windowDays = window.days;
  // The picked day comes from a URL, so anything that is not a real date is ignored rather than
  // allowed to turn the busy read's bounds into NaN.
  const extra = opts.extraDay && /^\d{4}-\d{2}-\d{2}$/.test(opts.extraDay) && DateTime.fromISO(opts.extraDay, { zone: hours.zone }).isValid ? opts.extraDay : null;
  if (opts.extraDay && !extra) log.warn("team-capacity", { msg: "ignored an unreadable picked day", day: opts.extraDay });
  const days = extra && !windowDays.includes(extra) ? [...windowDays, extra] : windowDays;

  let roster: { id: string; name: string | null; email: string }[];
  try {
    // The bookable pool is bookable AND not departed AND not a test advisor; is_test is filtered
    // here because .eq(false) in the query would also drop every advisor whose flag is null.
    roster = ((unwrap(
      await db
        .from("users")
        .select("id, name, email, is_test")
        .eq("org_id", opts.orgId)
        .eq("bookable", true)
        .is("deactivated_at", null),
      "team capacity roster",
    ) ?? []) as { id: string; name: string | null; email: string; is_test: boolean | null }[])
      .filter((u) => !u.is_test)
      .map(({ id, name, email }) => ({ id, name, email }));
  } catch (err) {
    return refuse("roster", err);
  }

  // Busy time and time off over every reported day, widened by a whole call and its gaps on each
  // side so a block starting at midnight is still seen by the first and last slots (#3273).
  const marginMs = (eventType.duration_min + eventType.buffer_before_min + eventType.buffer_after_min) * 60_000;
  const sorted = [...days].sort();
  const fromMs = DateTime.fromISO(sorted[0], { zone: hours.zone }).toMillis() - marginMs;
  const toMs = DateTime.fromISO(sorted.at(-1)!, { zone: hours.zone }).plus({ days: 1 }).toMillis() + marginMs;
  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(toMs).toISOString();

  if (roster.length === 0) return refuse("no-advisors");
  const ids = roster.map((u) => u.id);
  const [membersRes, timeOffRes, failing] = await Promise.all([
    loadMembersAvailability(resolved.bucket, fromIso, toIso, async () => ({ ids, fallbackApplied: false })).then(
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
  if (!membersRes.ok) return refuse("calendars", membersRes.err);
  // The availability read returns a row for every advisor asked about, so a missing one means it
  // came back incomplete, which is a failed read and never "nobody working".
  const returned = new Set(membersRes.members.map((m) => m.userId));
  const missing = ids.filter((id) => !returned.has(id));
  if (missing.length) return refuse("calendars", new Error(`no availability row for ${missing.length} advisor(s)`));
  if (!timeOffRes.ok) return refuse("time-off", timeOffRes.err);
  if (!failing.ok) return refuse("calendar-sync", failing.err);
  // Null means the sync health could not be read, never that nothing is failing (#1134).
  if (failing.list === null) return refuse("calendar-sync");

  const report = teamCapacityReport({
    days,
    roster,
    members: membersRes.members,
    timeOff: timeOffRes.m,
    failingEmails: new Set(failing.list.map((f) => f.email)),
    eventType,
    hours,
    nowMs,
  });
  return { measurable: true, nowMs, zone: hours.zone, windowDays, days, eventType, advisors: report.advisors };
}
