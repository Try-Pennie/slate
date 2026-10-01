/**
 * A lead holding a live booking in BOTH Slate and cal.com (#2933).
 *
 * During the pilot split a lead can reach both bookers: a routing code that changes
 * between page loads, or a surface outside the pilot that still opens cal.com. On
 * 2026-10-01 lead 00QUi00000t840LMAQ booked cal.com (booking 26177051) and then Slate
 * nineteen minutes later on the same Submission (aa70212d). Both stayed live, because
 * Slate's one call per lead check reads only Slate's own bookings, and Salesforce
 * ended up showing whichever write landed last.
 *
 * WHAT IS COMPARED. Every upcoming, active Slate booking in a real bucket, against
 * every upcoming cal.com booking in the org (`src/lib/calcom/upcoming-bookings.ts`).
 *
 * ON WHAT. Measured live on 2026-10-01, read only, before this was built:
 *
 * - The Salesforce SUBMISSION id is the one key both halves carry: Slate keeps it in
 *   the booking's prefill (`partnerKeysFrom`), cal.com in
 *   `metadata.sfdc_submission_id`. The known duplicate shares `a04Ui00000NDRunIAH`.
 *   cal.com holds no lead id at all, so the lead id in the page comes from Slate.
 * - The attendee ADDRESS is the second key, because 789 of the 1,252 upcoming cal.com
 *   bookings (the `review` event type) carry an empty metadata object. On the day it
 *   was measured the address found exactly the pairs the Submission id found and no
 *   others, so it adds reach without adding noise. It is compared trimmed and lower
 *   cased, and never printed.
 *
 * Either key is enough, and the page says which matched, because "same Submission"
 * and "same address" send a reader to check different things.
 *
 * WHAT IS NOT LOOKED AT. A Slate booking made from a known test host page
 * (`isTestSourceBooking`, the predicate the below tier check uses), and test buckets,
 * which the reader excludes. A cal.com booking that is cancelled, rejected or has
 * started.
 *
 * CADENCE. Once an hour, on the monitor tick that lands in the first five minutes of
 * it. The cal.com read is about six paced requests at today's volume, and the
 * duplicate this exists for was booked a day ahead, so an hour is well inside the
 * time somebody needs to cancel one call. Every five minutes would be seventy two
 * cal.com requests an hour for no earlier answer that matters.
 *
 * Detection only. Whether the booker should refuse or warn when the lead already holds
 * a live cal.com booking is a separate decision on the issue, and it would need a live
 * cal.com read on the confirm path.
 *
 * Retires with cal.com (#65, #2875): marked retired, nothing is read and every
 * outstanding page ends saying why.
 */
import { formatSlotDay, formatSlotTime } from "@/lib/booking/slot-label";
import { partnerKeysFrom } from "@/lib/booking/partner-keys";
import type { CalcomUpcomingBooking, CalcomUpcomingRead } from "@/lib/calcom/upcoming-bookings";
import type { AlertResolve, ThrottledNotify } from "./alert-deps";
import { leadIdOf } from "./below-lead-tier";
import { isTestSourceBooking, type BookingOriginFacts } from "./offsite-origin";

/** The alert family: one condition per Slate booking, `cross_system_booking:<id>`. */
export const CROSS_SYSTEM_BOOKING_KEY = "cross_system_booking";

export function crossSystemBookingKey(slateBookingId: string): string {
  return `${CROSS_SYSTEM_BOOKING_KEY}:${slateBookingId}`;
}

/** The zone the page renders both times in, named in the text as ET. */
const ALERT_ZONE = "America/New_York";

/** The window inside each hour whose monitor tick reads cal.com. One tick, since the lane ticks every five minutes. */
const DUE_WINDOW_MINUTES = 5;

/** True on the one five minute monitor tick an hour that runs this check. */
export function crossSystemBookingsDue(nowMs: number): boolean {
  return new Date(nowMs).getUTCMinutes() < DUE_WINDOW_MINUTES;
}

/** The columns this check needs off a Slate `bookings` row. */
export interface SlateUpcomingBooking extends BookingOriginFacts {
  id: string;
  starts_at: string;
  salesforce_id: string | null;
  external_id: string | null;
  agent_name: string | null;
  agent_email: string | null;
  attendee_email: string | null;
}

export type MatchedOn = "submission" | "email" | "both";

/** One Slate booking whose lead also holds at least one live cal.com booking. */
export interface CrossSystemPair {
  slate: SlateUpcomingBooking;
  /** Every live cal.com twin, soonest first. */
  calcom: CalcomUpcomingBooking[];
  matchedOn: MatchedOn;
  leadId: string | null;
}

/** cal.com statuses that are not a booking anybody will attend. */
const NOT_LIVE = new Set(["cancelled", "rejected"]);

const normEmail = (email: string | null | undefined): string | null => {
  const e = email?.trim().toLowerCase() ?? "";
  return e === "" ? null : e;
};

/**
 * Every Slate booking whose lead also holds a live cal.com booking. Pure: the caller
 * has already excluded test bookings.
 */
export function findCrossSystemBookings(
  slate: SlateUpcomingBooking[],
  calcom: CalcomUpcomingBooking[],
  nowMs: number,
): CrossSystemPair[] {
  const live = calcom.filter((c) => !NOT_LIVE.has(c.status) && Date.parse(c.start) > nowMs); // parse-ok: the reader refused any unreadable start
  const bySub = new Map<string, CalcomUpcomingBooking[]>();
  const byEmail = new Map<string, CalcomUpcomingBooking[]>();
  const add = (m: Map<string, CalcomUpcomingBooking[]>, k: string, c: CalcomUpcomingBooking) => {
    const list = m.get(k);
    if (list) list.push(c);
    else m.set(k, [c]);
  };
  for (const c of live) {
    if (c.submissionId) add(bySub, c.submissionId, c);
    for (const e of new Set(c.attendeeEmails.map(normEmail))) if (e) add(byEmail, e, c);
  }

  const pairs: CrossSystemPair[] = [];
  for (const s of slate) {
    const sub = partnerKeysFrom(s.prefill).submissionId;
    const email = normEmail(s.attendee_email);
    const subHits = sub ? bySub.get(sub) ?? [] : [];
    const emailHits = email ? byEmail.get(email) ?? [] : [];
    if (subHits.length === 0 && emailHits.length === 0) continue;
    const twins = new Map<number, CalcomUpcomingBooking>();
    for (const c of [...subHits, ...emailHits]) twins.set(c.id, c);
    const subIds = new Set(subHits.map((c) => c.id));
    const emailIds = new Set(emailHits.map((c) => c.id));
    const both = [...twins.keys()].some((id) => subIds.has(id) && emailIds.has(id));
    pairs.push({
      slate: s,
      calcom: [...twins.values()].sort((a, b) => a.start.localeCompare(b.start) || a.id - b.id),
      matchedOn: both ? "both" : subHits.length > 0 ? "submission" : "email",
      leadId: leadIdOf(s),
    });
  }
  return pairs.sort((a, b) => a.slate.starts_at.localeCompare(b.slate.starts_at) || a.slate.id.localeCompare(b.slate.id));
}

const when = (iso: string): string => `${formatSlotDay(iso, ALERT_ZONE)} at ${formatSlotTime(iso, ALERT_ZONE)} ET`;

/** cal.com's own booking page for a uid, where the booking can be seen and cancelled. */
export function calcomBookingUrl(uid: string): string {
  return `https://app.cal.com/booking/${encodeURIComponent(uid)}`;
}

const MATCH_LINE: Record<MatchedOn, string> = {
  both: "They carry the same Salesforce Submission id and the same email address.",
  submission: "They carry the same Salesforce Submission id.",
  email: "They match on the same email address; the cal.com side carries no Submission id.",
};

/**
 * The page for one Slate booking: which lead, both calls with their ids and times,
 * why they were matched, and what to do. No lead contact data, by construction: the
 * lead is named by their Salesforce id and the bookings by id and link.
 */
export function formatCrossSystemBookingAlert(pair: CrossSystemPair, slateBookingUrl: string): string {
  const lead = pair.leadId ? `Lead ${pair.leadId} is` : "A lead with no Salesforce lead id on the Slate booking is";
  const agent = pair.slate.agent_name?.trim() || pair.slate.agent_email || "an unassigned advisor";
  const twins = pair.calcom.map(
    (c) => `cal.com: ${when(c.start)} with ${c.host ?? "an unnamed host"}, booking ${c.id} (uid ${c.uid})\n${calcomBookingUrl(c.uid)}`,
  );
  const calls = 1 + pair.calcom.length;
  const cancel = calls === 2 ? "Cancel one of the two" : `Cancel all but one of the ${calls}`;
  return (
    `${lead} booked in both Slate and cal.com, so they hold ${calls} upcoming calls. ` +
    `${MATCH_LINE[pair.matchedOn]} ${cancel}, and make sure the lead knows which call stands.\n` +
    `Slate: ${when(pair.slate.starts_at)} with ${agent}, booking ${pair.slate.id}\n${slateBookingUrl}\n` +
    twins.join("\n")
  );
}

export type RecoveryReason = "slate-gone" | "calcom-gone";

/** The all clear for one Slate booking, hung off what THIS run measured. */
export function formatCrossSystemBookingRecovery(slateBookingId: string, why: RecoveryReason, slateBookingUrl: string): string {
  if (why === "slate-gone") {
    return (
      `The lead paged about earlier no longer holds a call in both systems: Slate booking ${slateBookingId} ` +
      `was cancelled or its time has passed. No action is needed.\n${slateBookingUrl}`
    );
  }
  return (
    `The lead paged about earlier no longer holds a call in both systems: the cal.com booking was cancelled or its time ` +
    `has come, and Slate booking ${slateBookingId} is the one that stands. No action is needed.\n${slateBookingUrl}`
  );
}

/** The ending for a page outstanding when cal.com is marked retired. */
export function formatCrossSystemBookingRetired(slateBookingId: string): string {
  return (
    `cal.com is marked retired on the alerts page, so Slate booking ${slateBookingId} is no longer compared ` +
    `against cal.com and this page is closed. If the lead's cal.com call was never cancelled, it still needs a person.`
  );
}

// ------------------------------------------------------------- the runner

export type CrossSystemBookingsResult =
  /** Not this tick's turn: nothing was read. */
  | { status: "not-due" }
  /** No cal.com key in this deployment. */
  | { status: "not-configured" }
  /** cal.com is marked retired: nothing to compare, by decision. */
  | { status: "retired"; cleared: number }
  /** Not measured, so nothing may be claimed in either direction. */
  | { status: "unreadable"; stage: "slate" | "calcom"; error: string }
  | {
      status: "measured";
      /** Real Slate bookings compared. */
      slateCompared: number;
      /** Made from a known test host page, so not compared. */
      testSource: number;
      /** cal.com bookings read (zero when there was no Slate booking to ask about). */
      calcomCompared: number;
      pairs: CrossSystemPair[];
      cleared: number;
    };

export interface CrossSystemBookingsDeps {
  nowMs: number;
  /** The retirement switch: true, false, or null for a read that failed. */
  calcomRetired: () => Promise<boolean | null>;
  /** Upcoming active Slate bookings in real buckets. THROWS on a read error, never answers empty. */
  loadSlate: () => Promise<SlateUpcomingBooking[]>;
  /** Every upcoming cal.com booking, or null when cal.com is not configured here. */
  readCalcom: (afterStartIso: string) => Promise<CalcomUpcomingRead | null>;
  /** Slate booking ids with an outstanding page in this family. */
  listFiring: () => Promise<Set<string>>;
  bookingUrl: (slateBookingId: string) => string;
  notify: ThrottledNotify;
  /** REQUIRED, so `tsc` enumerates every construction site (#1151, #1400). */
  resolve: AlertResolve<unknown>;
  cooldownMs: number;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The monitor lane step. A read that fails on either side measured nothing: no page,
 * no all clear, and the verdict predicate refuses it. A failing dispatch is swallowed,
 * because a flaky Slack must never fail the tick or the checks after it.
 */
export async function runCrossSystemBookingsCheck(deps: CrossSystemBookingsDeps): Promise<CrossSystemBookingsResult> {
  if (!crossSystemBookingsDue(deps.nowMs)) return { status: "not-due" };

  // Falls OPEN: an unreadable switch compares as today, like the other read only
  // cal.com comparisons (`retirement.ts`). Only a stored true stands it down.
  const retired = await deps.calcomRetired().catch(() => null);
  if (retired === true) {
    let cleared = 0;
    const firing = await deps.listFiring().catch(() => null);
    for (const id of firing ?? []) {
      const sent = await deps.resolve(crossSystemBookingKey(id), formatCrossSystemBookingRetired(id)).catch(() => false);
      if (sent) cleared++;
    }
    return { status: "retired", cleared };
  }

  let read: SlateUpcomingBooking[];
  try {
    read = await deps.loadSlate();
  } catch (err) {
    return { status: "unreadable", stage: "slate", error: message(err) };
  }
  const slate = read.filter((b) => !isTestSourceBooking(b));
  const testSourceIds = new Set(read.filter((b) => isTestSourceBooking(b)).map((b) => b.id));

  let calcom: CalcomUpcomingBooking[] = [];
  if (slate.length > 0) {
    let res: CalcomUpcomingRead | null;
    try {
      res = await deps.readCalcom(new Date(deps.nowMs).toISOString());
    } catch (err) {
      return { status: "unreadable", stage: "calcom", error: message(err) };
    }
    if (res === null) return { status: "not-configured" };
    if (!res.ok) {
      return {
        status: "unreadable",
        stage: "calcom",
        error: `cal.com bookings ${res.reason} (status ${res.status}, page ${res.page})`,
      };
    }
    calcom = res.rows;
  }

  const pairs = findCrossSystemBookings(slate, calcom, deps.nowMs);
  for (const p of pairs) {
    await deps
      .notify(crossSystemBookingKey(p.slate.id), deps.cooldownMs, formatCrossSystemBookingAlert(p, deps.bookingUrl(p.slate.id)))
      .catch(() => {});
  }

  // Driven by what THIS run measured about each paged booking, never by "we did not
  // page it" (#1134, #1152).
  let cleared = 0;
  const firing = await deps.listFiring().catch(() => null);
  if (firing !== null) {
    const compared = new Set(slate.map((b) => b.id));
    const paired = new Set(pairs.map((p) => p.slate.id));
    for (const id of firing) {
      // Excluded as a test, so not measured this run: it keeps whatever it has.
      if (testSourceIds.has(id) || paired.has(id)) continue;
      const why: RecoveryReason = compared.has(id) ? "calcom-gone" : "slate-gone";
      const sent = await deps
        .resolve(crossSystemBookingKey(id), formatCrossSystemBookingRecovery(id, why, deps.bookingUrl(id)))
        .catch(() => false);
      if (sent) cleared++;
    }
  }

  return {
    status: "measured",
    slateCompared: slate.length,
    testSource: testSourceIds.size,
    calcomCompared: calcom.length,
    pairs,
    cleared,
  };
}
