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
 * ONE PAGE PER PAIR, keyed `cross_system_booking:<slate booking id>:<cal.com uid>`.
 * The cal.com uid rides in the key because the all clear has to read THAT booking
 * again, and the firing marker is the only record of which booking was paged about.
 *
 * WHAT IS NOT LOOKED AT. A Slate booking made from a known test host page
 * (`isTestSourceBooking`, the predicate the below tier check uses), and test buckets,
 * which the reader excludes. A cal.com booking that is cancelled, rejected or has
 * started.
 *
 * CADENCE. Once an hour, on the monitor tick that lands in the first five minutes of
 * it. The cal.com read is about six paced requests at today's volume, and the
 * duplicate this exists for was booked a day ahead, so an hour is well inside the
 * time somebody needs to cancel one call. The whole run, listing and direct reads
 * together, is held to `CROSS_SYSTEM_BUDGET_MS`.
 *
 * Detection only, by decision on the issue: the booker neither refuses nor warns.
 *
 * Retires with cal.com (#65, #2875): marked retired, nothing is read and every
 * outstanding page ends saying why.
 */
import { logAlertSendFailure, logResolveFailure } from "../notify/send-failure.ts";
import { formatSlotDay, formatSlotTime } from "@/lib/booking/slot-label";
import { partnerKeysFrom } from "@/lib/booking/partner-keys";
import type { CalcomBookingRead, CalcomUpcomingBooking, CalcomUpcomingRead } from "@/lib/calcom/upcoming-bookings";
import type { AlertResolve, ThrottledNotify } from "./alert-deps";
import { leadIdOf } from "./below-lead-tier";
import { isTestSourceBooking, type BookingOriginFacts } from "./offsite-origin";

/** The alert family: one condition per pair, `cross_system_booking:<slate id>:<cal.com uid>`. */
export const CROSS_SYSTEM_BOOKING_KEY = "cross_system_booking";

/** The member a pair is paged under, without the family prefix. */
export function crossSystemBookingMember(slateBookingId: string, calcomUid: string): string {
  return `${slateBookingId}:${calcomUid}`;
}

export function crossSystemBookingKey(slateBookingId: string, calcomUid: string): string {
  return `${CROSS_SYSTEM_BOOKING_KEY}:${crossSystemBookingMember(slateBookingId, calcomUid)}`;
}

/** A firing member read back from `alert_state`, or null for one this version did not write. */
export function parseCrossSystemBookingMember(member: string): { slateId: string; uid: string } | null {
  const at = member.indexOf(":");
  if (at <= 0 || at === member.length - 1) return null;
  return { slateId: member.slice(0, at), uid: member.slice(at + 1) };
}

/**
 * The most one run may spend, listing and direct reads together. The `*` /5 cron
 * invocation that carries the monitor lane measured about 16 seconds a tick against a
 * 120 second ceiling (`docs/cloudflare-platform-notes.md`), and the whole listing
 * measured 7.5 seconds on 2026-10-01. 45 seconds is six times that and leaves the
 * tick well under its ceiling even when cal.com is slow, which a page timeout alone
 * could not: forty pages at twenty seconds each is over thirteen minutes.
 */
export const CROSS_SYSTEM_BUDGET_MS = 45_000;

/** The zone the page renders both times in, named in the text as ET. */
const ALERT_ZONE = "America/New_York";

/** The window inside each hour whose monitor tick reads cal.com. One tick, since the lane ticks every five minutes. */
const DUE_WINDOW_MINUTES = 5;

/**
 * How often the check actually runs: once an hour (`crossSystemBookingsDue`). The monitor
 * lane's step failure streak counts this step in runs of THIS cadence, not in the lane's
 * five minute ticks, because its eleven idle ticks an hour would otherwise break every
 * streak (#3955). `scripts/test-monitor-step-failure.ts` holds the due rule to it.
 */
export const CROSS_SYSTEM_BOOKINGS_CADENCE_MS = 60 * 60_000;

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

/** One Slate booking and one live cal.com booking held by the same lead. */
export interface CrossSystemPair {
  slate: SlateUpcomingBooking;
  calcom: CalcomUpcomingBooking;
  matchedOn: MatchedOn;
  leadId: string | null;
}

/** cal.com statuses that are not a booking anybody will attend. */
const NOT_LIVE = new Set(["cancelled", "rejected"]);

/** A cal.com booking somebody will still attend: not cancelled or rejected, and not yet started. */
export function calcomBookingIsLive(c: CalcomUpcomingBooking, nowMs: number): boolean {
  return !NOT_LIVE.has(c.status) && Date.parse(c.start) > nowMs; // parse-ok: the reader refused any unreadable start
}

const normEmail = (email: string | null | undefined): string | null => {
  const e = email?.trim().toLowerCase() ?? "";
  return e === "" ? null : e;
};

/**
 * Every (Slate booking, live cal.com booking) pair held by one lead. Pure: the caller
 * has already excluded test bookings.
 */
export function findCrossSystemBookings(
  slate: SlateUpcomingBooking[],
  calcom: CalcomUpcomingBooking[],
  nowMs: number,
): CrossSystemPair[] {
  const live = calcom.filter((c) => calcomBookingIsLive(c, nowMs));
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
    const subIds = new Set((sub ? bySub.get(sub) ?? [] : []).map((c) => c.id));
    const emailIds = new Set((email ? byEmail.get(email) ?? [] : []).map((c) => c.id));
    for (const c of live) {
      const onSub = subIds.has(c.id);
      const onEmail = emailIds.has(c.id);
      if (!onSub && !onEmail) continue;
      pairs.push({
        slate: s,
        calcom: c,
        matchedOn: onSub && onEmail ? "both" : onSub ? "submission" : "email",
        leadId: leadIdOf(s),
      });
    }
  }
  return pairs.sort(
    (a, b) =>
      a.slate.starts_at.localeCompare(b.slate.starts_at) ||
      a.slate.id.localeCompare(b.slate.id) ||
      a.calcom.start.localeCompare(b.calcom.start) ||
      a.calcom.id - b.calcom.id,
  );
}

const when = (iso: string): string => `${formatSlotDay(iso, ALERT_ZONE)} at ${formatSlotTime(iso, ALERT_ZONE)} ET`;

/** cal.com's own booking page for a uid, where the booking can be seen and cancelled. */
export function calcomBookingUrl(uid: string): string {
  return `https://app.cal.com/booking/${encodeURIComponent(uid)}`;
}

const MATCH_LINE: Record<MatchedOn, string> = {
  both: "They carry the same Salesforce Submission id and the same email address.",
  submission: "They carry the same Salesforce Submission id.",
  email: "They match on the same email address; the cal.com booking carries no Submission id.",
};

/**
 * The page for one pair: which lead, both calls with their ids and times, why they
 * were matched, and what to do. No lead contact data, by construction: the lead is
 * named by their Salesforce id and the bookings by id and link. A lead with a third
 * call gets a second page, for that pair.
 */
export function formatCrossSystemBookingAlert(pair: CrossSystemPair, slateBookingUrl: string): string {
  const lead = pair.leadId ? `Lead ${pair.leadId} is` : "A lead with no Salesforce lead id on the Slate booking is";
  const agent = pair.slate.agent_name?.trim() || pair.slate.agent_email || "an unassigned advisor";
  const c = pair.calcom;
  return (
    `${lead} booked in both Slate and cal.com, so they hold two upcoming calls. ` +
    `${MATCH_LINE[pair.matchedOn]} Cancel one of the two, and make sure the lead knows which call stands.\n` +
    `Slate: ${when(pair.slate.starts_at)} with ${agent}, booking ${pair.slate.id}\n${slateBookingUrl}\n` +
    `cal.com: ${when(c.start)} with ${c.host ?? "an unnamed host"}, booking ${c.id} (uid ${c.uid})\n${calcomBookingUrl(c.uid)}`
  );
}

export type RecoveryReason = "slate-gone" | "calcom-gone";

/** The all clear for one pair, hung off what THIS run measured about it. */
export function formatCrossSystemBookingRecovery(
  slateBookingId: string,
  calcomUid: string,
  why: RecoveryReason,
  slateBookingUrl: string,
): string {
  if (why === "slate-gone") {
    return (
      `The lead paged about earlier no longer holds a call in both systems: Slate booking ${slateBookingId} ` +
      `was cancelled or its time has passed. No action is needed.\n${slateBookingUrl}`
    );
  }
  return (
    `The lead paged about earlier no longer holds a call in both systems: the cal.com booking (uid ${calcomUid}) ` +
    `reads as cancelled or its time has come, and Slate booking ${slateBookingId} is the one that stands. ` +
    `No action is needed.\n${slateBookingUrl}`
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
      /** Paged pairs missing from the listing whose direct read says the cal.com booking is still live. */
      stillLive: number;
      /** Paged pairs missing from the listing whose direct read failed, so they keep their page. */
      unconfirmed: number;
    };

export interface CrossSystemBookingsDeps {
  /** The tick's instant: decides whether the run is due and what counts as upcoming. */
  nowMs: number;
  /** A live clock for the run's own deadline, injected so a test never waits (L524). */
  clock: () => number;
  /** The retirement switch: true, false, or null for a read that failed. */
  calcomRetired: () => Promise<boolean | null>;
  /** Upcoming active Slate bookings in real buckets. THROWS on a read error, never answers empty. */
  loadSlate: () => Promise<SlateUpcomingBooking[]>;
  /** Every upcoming cal.com booking by `deadlineAtMs`, or null when cal.com is not configured here. */
  readCalcom: (afterStartIso: string, deadlineAtMs: number) => Promise<CalcomUpcomingRead | null>;
  /** One cal.com booking by uid by `deadlineAtMs`, or null when cal.com is not configured here. */
  readCalcomByUid: (uid: string, deadlineAtMs: number) => Promise<CalcomBookingRead | null>;
  /** Members (`<slate id>:<cal.com uid>`) with an outstanding page in this family. */
  listFiring: () => Promise<Set<string>>;
  bookingUrl: (slateBookingId: string) => string;
  notify: ThrottledNotify;
  /** REQUIRED, so `tsc` enumerates every construction site (#1151, #1400). */
  resolve: AlertResolve<unknown>;
  cooldownMs: number;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The monitor lane step. A read that fails on either side, or runs out of its
 * deadline, measured nothing: no page, no all clear, and the verdict predicate
 * refuses it. A failing dispatch is swallowed, because a flaky Slack must never fail
 * the tick or the checks after it.
 */
export async function runCrossSystemBookingsCheck(deps: CrossSystemBookingsDeps): Promise<CrossSystemBookingsResult> {
  if (!crossSystemBookingsDue(deps.nowMs)) return { status: "not-due" };
  const deadlineAtMs = deps.clock() + CROSS_SYSTEM_BUDGET_MS;

  // Falls OPEN: an unreadable switch compares as today, like the other read only
  // cal.com comparisons (`retirement.ts`). Only a stored true stands it down.
  const retired = await deps.calcomRetired().catch(() => null);
  if (retired === true) {
    let cleared = 0;
    const firing = await deps.listFiring().catch(() => null);
    for (const member of firing ?? []) {
      const slateId = parseCrossSystemBookingMember(member)?.slateId ?? member;
      const sent = await deps
        .resolve(`${CROSS_SYSTEM_BOOKING_KEY}:${member}`, formatCrossSystemBookingRetired(slateId))
        .catch(logResolveFailure(`${CROSS_SYSTEM_BOOKING_KEY}:${member}`));
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

  // The listing pages by `skip`, so a booking cancelled or moved mid walk can shift a
  // later row past a page boundary and out of this read. That costs at most a MISSED
  // detection for one hour (the next run reads it), never a false page, because a
  // pair is only paged when both halves were actually read. The all clear is the
  // direction a dropped row could get wrong, which is why it never trusts the listing.
  let calcom: CalcomUpcomingBooking[] = [];
  if (slate.length > 0) {
    let res: CalcomUpcomingRead | null;
    try {
      res = await deps.readCalcom(new Date(deps.nowMs).toISOString(), deadlineAtMs);
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
      .notify(
        crossSystemBookingKey(p.slate.id, p.calcom.uid),
        deps.cooldownMs,
        formatCrossSystemBookingAlert(p, deps.bookingUrl(p.slate.id)),
      )
      .catch(logAlertSendFailure(crossSystemBookingKey(p.slate.id, p.calcom.uid)));
  }

  // Each outstanding page is cleared only off a MEASURED fact about its own pair,
  // never off "we did not page it" (#1134, #1152):
  //  - the Slate booking is absent from a complete Slate read: it was cancelled or
  //    has passed, so the lead no longer holds two calls;
  //  - otherwise the cal.com booking is read DIRECTLY by uid, and the page ends only
  //    when that read says it is cancelled, rejected or has started. Missing from the
  //    listing is not enough (see above), and a direct read that fails, is refused or
  //    runs out of time clears nothing.
  let cleared = 0;
  let stillLive = 0;
  let unconfirmed = 0;
  const firing = await deps.listFiring().catch(() => null);
  if (firing !== null) {
    const compared = new Set(slate.map((b) => b.id));
    const paired = new Set(pairs.map((p) => crossSystemBookingMember(p.slate.id, p.calcom.uid)));
    for (const member of firing) {
      const parsed = parseCrossSystemBookingMember(member);
      // Not a member this version writes, a booking excluded as a test, or a pair
      // still found: not measured as over, so it keeps whatever it has.
      if (parsed === null || testSourceIds.has(parsed.slateId) || paired.has(member)) continue;
      let why: RecoveryReason | null = null;
      if (!compared.has(parsed.slateId)) {
        why = "slate-gone";
      } else {
        const direct = await deps.readCalcomByUid(parsed.uid, deadlineAtMs).catch(() => null);
        if (direct === null || !direct.ok) {
          unconfirmed++;
        } else if (calcomBookingIsLive(direct.row, deps.nowMs)) {
          stillLive++;
        } else {
          why = "calcom-gone";
        }
      }
      if (why === null) continue;
      const sent = await deps
        .resolve(
          `${CROSS_SYSTEM_BOOKING_KEY}:${member}`,
          formatCrossSystemBookingRecovery(parsed.slateId, parsed.uid, why, deps.bookingUrl(parsed.slateId)),
        )
        .catch(logResolveFailure(`${CROSS_SYSTEM_BOOKING_KEY}:${member}`));
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
    stillLive,
    unconfirmed,
  };
}
