// Is the shadow run trustworthy today? (#2066)
//
// Answering that on 2026-09-07 took a database query plus reading eight issues, and
// `docs/parallel-run-plan.md` says outright that it cannot report status. This is
// the judgement behind the one command that answers it, kept pure so it is pinned
// by fixtures where no database exists, in the same family as
// `verify:availability-truth`, `verify:ooo-protection` and `verify:calcom-parity`.
//
// The preconditions, each already measured somewhere in Slate and none of them
// visible together anywhere:
//
// - no alert cooldown is stretched above its default (two sat at a week for a month
//   and nothing listed them, #2065);
// - the daily Slate against cal.com comparison ran recently and is not reporting
//   drift (#2031);
// - nobody is waiting to become bookable behind a refused activation (#2071);
// - every bookable agent has a calendar row, hydrated past the booking horizon
//   (#1736: an agent flipped bookable holds no busy time until the lanes reach them,
//   and looks free for every hour their week allows);
// - no real bucket is empty, by the empty bucket alarm's own predicate;
// - trypennie's booking key has authenticated from their production site recently
//   (#2717), because their confirmed page reads every booking with it and a key
//   missing from their production environment sends every pilot lead to a not
//   found page.
//
// And two that gate ARMING the low volume alarms (#1956, #2738) rather than the
// shadow run itself (#2767): each Low page's bookings carry their `source`, and the
// upcoming federal holidays are decided in the org's date exceptions. While the
// alarms are off these are listed under their own heading and never change the
// exit, so a READY day is not held red by an alarm nobody has switched on; once the
// switch is on (or unset, which the deployment's env may resolve to on) they are
// findings like the rest, because an armed alarm with either unmet pages falsely.
//
// Two rules carry it. Every way of learning nothing exits on its OWN code, because
// "an alarm is muted", "cal.com has not been compared for two days" and "the bucket
// read failed" send three different people three different places (L11). And a run
// that measured nobody is never a pass (L98): zero bookable agents or zero real
// buckets is the shape of a broken read, not a healthy morning.

import {
  judgePartnerKey,
  PARTNER_KEY_MAX_AGE_DAYS,
  type CallerSeenRow,
} from "../../src/lib/booking/caller-seen.ts";
import { pageSourceStatus, type PageSourceMeasure } from "../../src/lib/monitor/page-volume.ts";
import { judgeCalendarCoverage, type CalendarWindowRow } from "../../src/lib/monitor/calendar-window-coverage.ts";
import {
  classifyParitySweep,
  parseParitySweep,
  pagingLabel,
  type ParityFinding,
} from "../../src/lib/monitor/schedule-parity-alert.ts";

/**
 * Who drifted, or why nobody can be named (#2089).
 *
 * "named" carries only the PAGING findings, worst first, classified by the same
 * judge the alert uses, so this line and the page cannot disagree about what counts
 * as drift. "unavailable" keeps the finding and says why the names are missing,
 * because a drift line with nobody in it and no reason reads as a broken check.
 */
export type ParityDriftDetail =
  | { kind: "named"; runUrl: string; paging: ParityFinding[] }
  | { kind: "unavailable"; why: string };

/**
 * The summary the daily lane wrote (`parity-summary.json`, kept as the run's
 * `parity-summary` artifact), read through the endpoint's own `parseParitySweep`,
 * so a verdict the alert would refuse is refused here too rather than rendered.
 */
export function parityDriftFromSummary(raw: unknown, runUrl: string): ParityDriftDetail {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { kind: "unavailable", why: "the sweep summary is not an object" };
  }
  const sweep = parseParitySweep({ ...(raw as Record<string, unknown>), runUrl });
  if ("error" in sweep) return { kind: "unavailable", why: `the sweep summary was refused: ${sweep.error}` };
  return { kind: "named", runUrl: sweep.runUrl, paging: classifyParitySweep(sweep).paging };
}

/**
 * How long after the heartbeat stamp the run that stamped it may finish. The stamp
 * is one of the job's last steps, so its run ends within minutes; anything finishing
 * later is a different run, and anything finishing before it cannot have stamped it.
 */
export const PARITY_RUN_PAIRING_MS = 60 * 60_000;
/** Clock skew allowed between the database stamp and GitHub's run time. */
const PARITY_RUN_SKEW_MS = 5 * 60_000;

/**
 * The successful schedule parity run whose summary describes the sweep the drift
 * alert is about (L420). The heartbeat records no run id, so the pairing is by
 * time: the run must END just after the stamp it wrote, never merely be the newest.
 */
export function pickParityRun<R extends { id: number; updatedAtMs: number; url: string }>(
  runs: readonly R[],
  heartbeatMs: number | null,
): R | { why: string } {
  if (heartbeatMs === null) return { why: "the comparison has never reached a verdict, so there is no run to read" };
  const match = runs.find(
    (r) => r.updatedAtMs >= heartbeatMs - PARITY_RUN_SKEW_MS && r.updatedAtMs <= heartbeatMs + PARITY_RUN_PAIRING_MS,
  );
  return match ?? { why: "no successful schedule parity run finished just after the last verdict, so its summary cannot be paired" };
}

/** How many agents one kind of difference names before counting the rest. */
const DRIFT_NAME_CAP = 4;

function driftLine(d: ParityDriftDetail): string {
  if (d.kind === "unavailable") {
    return `the cal.com comparison is currently reporting drift; nobody is named here because ${d.why}. pnpm verify:calcom-parity names them`;
  }
  if (d.paging.length === 0) {
    return `the drift alert is still firing, but the newest sweep found no difference that pages, so the alert has not cleared: ${d.runUrl}`;
  }
  const total = d.paging.reduce((n, f) => n + f.count, 0);
  const groups = d.paging.map((f) => {
    const shown = f.agents.slice(0, DRIFT_NAME_CAP);
    const rest = f.count - shown.length;
    const who = shown.length ? ` (${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""})` : "";
    return `${f.count} ${pagingLabel(f.verdict, f.count)}${who}`;
  });
  return `the cal.com comparison is reporting drift on ${total} agent(s): ${groups.join("; ")}; ${d.runUrl}`;
}

export interface StretchedCooldown {
  key: string;
  minutes: number;
  defaultMinutes: number;
}

export interface ReadinessFacts {
  nowMs: number;
  /** Cooldown rows set above their default. null = the table could not be read. */
  stretchedCooldowns: StretchedCooldown[] | null;
  parity: {
    /** The `schedule-parity` heartbeat, stamped only by a MEASURED sweep. */
    lastRunMs: number | null;
    boundMs: number;
    /** Whether the drift alert is currently firing. null = alert_state unreadable. */
    drifting: boolean | null;
    /**
     * Who the newest measured sweep found drifting (#2089), read from the summary
     * the daily lane kept as a run artifact, or why nobody can be named. Only looked
     * up while `drifting` is true; it never changes the exit, only the sentence.
     */
    drift: ParityDriftDetail;
  };
  /** Emails with `bookable_pending_since` set. null = unreadable. */
  pendingBookable: string[] | null;
  calendars: {
    bookableAgents: number;
    /** Bookable agents with no agent_calendars row at all. */
    missingRows: string[];
    /** Calendars whose hydration does not reach the booking horizon. */
    uncovered: string[];
  } | null;
  emptyBuckets: { realBuckets: number; empty: string[] } | null;
  /**
   * Debt tiers with nobody assigned at all (#2505). null = unreadable.
   *
   * The gate was BLIND to this before, and not by a small margin: `emptyBuckets`
   * drops any code whose ladder reaches a staffed rung, and every tier 5 code
   * reaches tier 4, so a completely unstaffed Ultra High produced exit 0 READY.
   * The flip morning gate could not answer the question the pilot most needs
   * answered. Named tiers, never a count, because the reader has to know WHICH.
   */
  emptyTiers: { measuredTiers: number; empty: string[] } | null;
  /**
   * Bookable agents on hours nobody set (#1753): the seeding stamp, or a pre stamp
   * row still shaped exactly like the org default. null = unreadable. Honest since
   * the stamp exists; before it this was a proxy that named every agent whose real
   * week happened to equal the seed, which is why it was left out of the first cut.
   */
  unsetHours: string[] | null;
  /**
   * The partner whose key must be proven and every `api_caller_seen` row read for
   * it (#2717). null = unreadable. Judged by `judgePartnerKey`, the same judge the
   * admin console shows, so the gate and the page cannot disagree.
   */
  partnerKey: { caller: string; rows: CallerSeenRow[] } | null;
  /** The low volume alarms' arming preconditions (#2767). */
  lowVolumeArming: LowVolumeArmingFacts;
  /**
   * #2875: `monitor_alert_config.calcom_retired`, read through
   * `loadCalcomRetired`. true ends the judgement before anything else, because the
   * parallel run it judges is over; null is an unreadable section.
   */
  calcomRetired: boolean | null;
}

/**
 * What arming the tier and per page low volume alarms (#1956, #2738) depends on.
 * Each read is null when it failed.
 */
export interface LowVolumeArmingFacts {
  /**
   * `monitor_alert_config.low_volume_armed`. "unset" is a null column, which falls
   * through to the deployment's `BOOKING_VOLUME_ALERT_ARMED`, a value this command
   * cannot read, so it is judged as armed (fail closed). null = unreadable.
   */
  armed: "armed" | "disarmed" | "unset" | null;
  /**
   * `measurePageSources` over the per page alarm's own lookback
   * (`PAGE_SEEN_LOOKBACK_DAYS`), the same measurement the alerts settings page
   * judges: how many real bookings carried no source, and whether each Low page
   * recorded one of its own. A page that has not is one the armed alarm reports as
   * having stopped booking.
   */
  pageSources: PageSourceMeasure | null;
  /** Upcoming federal holiday dates no exception or closed weekday decides. */
  holidays: {
    windowDays: number;
    /** How many holiday dates fell in the window. */
    checked: number;
    uncovered: { date: string; name: string }[];
  } | null;
}

export type ReadinessFinding =
  | "unreadable"
  | "nothing-measured"
  | "tier-empty"
  | "bucket-empty"
  | "calendar-missing"
  | "calendar-uncovered"
  | "alarm-muted"
  | "parity-drifting"
  | "parity-stale"
  | "bookable-pending"
  | "hours-unset"
  | "partner-key-unproven"
  | "page-source-missing"
  | "holidays-uncovered"
  | "page-source-unmeasured";

/** The findings that gate ARMING the low volume alarms, and only while they are on. */
export type ArmingFinding = "page-source-missing" | "holidays-uncovered" | "page-source-unmeasured";

/**
 * Worst FIRST. The reasoning for each rung:
 *
 * A read that failed leads, because a run that cannot see cannot vouch for anything
 * beneath it, and reporting the findings it did see as the verdict would let a
 * broken read pass for a partial all clear. Nothing measured is the same class.
 * Then the findings that turn a lead away today: an empty bucket, then a bookable
 * agent with no calendar (offered as free for every hour), then one whose calendar
 * is not hydrated far enough. A muted alarm is next, because it hides every later
 * finding from the people who would act. Drift in cal.com, then a comparison that
 * has not run, then somebody waiting behind a refused flip, which costs coverage
 * rather than correctness.
 */
export const READINESS_ORDER: readonly ReadinessFinding[] = [
  "unreadable",
  "nothing-measured",
  // Ranked ABOVE an empty bucket: a bucket with nobody in it is served by the
  // rest of its debt tier (#2486), and a debt tier with nobody in it is served
  // only by dropping the lead a tier, which is the thing a pilot is measuring.
  "tier-empty",
  "bucket-empty",
  "calendar-missing",
  "calendar-uncovered",
  // Below every finding that stops a lead being BOOKED, above everything else: the
  // booking is made, and the lead lands on a not found page instead of their
  // confirmation, which is the first thing they see from us.
  "partner-key-unproven",
  "alarm-muted",
  // Only ever present while the low volume alarms are armed (#2767). Just below a
  // muted alarm, because an alarm paging falsely is the other way an alarm stops
  // being read (L36), and below everything that affects a lead, because neither
  // turns anybody away. A page with no source pages every 30 minutes on every open
  // day, a holiday gap for one day, and an unmeasured week is a question rather
  // than a known fault, so they rank in that order.
  "page-source-missing",
  "holidays-uncovered",
  "page-source-unmeasured",
  "parity-drifting",
  "parity-stale",
  "bookable-pending",
  // Last: the agent IS offered, on a plausible week, so a lead is booked with
  // somebody who exists and may simply not be there at that hour. Real, and the
  // slowest to bite.
  "hours-unset",
] as const;

/**
 * One code per outcome. 1 is deliberately absent: the entry exits 1 before any
 * judging when no credentials are configured, so nothing here may share it.
 */
export const READINESS_EXIT = {
  ready: 0,
  unreadable: 2,
  nothingMeasured: 3,
  tierEmpty: 4,
  bucketEmpty: 12,
  calendarMissing: 5,
  calendarUncovered: 6,
  alarmMuted: 7,
  parityDrifting: 8,
  parityStale: 9,
  bookablePending: 10,
  hoursUnset: 11,
  /** "trypennie key never seen from production" (#2717), in every one of its forms. */
  partnerKeyUnproven: 13,
  /** Low volume alarms armed and bookings recorded no source, or a Low page recorded none (#2767, #2796). */
  pageSourceMissing: 14,
  /** Low volume alarms armed and an upcoming federal holiday is undecided (#2767). */
  holidaysUncovered: 15,
  /** Low volume alarms armed and no real booking in the lookback to judge sources by (#2767). */
  pageSourceUnmeasured: 16,
  /**
   * #2875: cal.com is marked retired, so there is no parallel run to judge. Its
   * own code rather than 0, because READY claims a trustworthy shadow run and
   * nothing was measured; 17 and 18 stay retired with the shared key (#2865).
   */
  calcomRetired: 19,
} as const;

const EXIT_FOR: Record<ReadinessFinding, number> = {
  unreadable: READINESS_EXIT.unreadable,
  "nothing-measured": READINESS_EXIT.nothingMeasured,
  "tier-empty": READINESS_EXIT.tierEmpty,
  "bucket-empty": READINESS_EXIT.bucketEmpty,
  "calendar-missing": READINESS_EXIT.calendarMissing,
  "calendar-uncovered": READINESS_EXIT.calendarUncovered,
  "alarm-muted": READINESS_EXIT.alarmMuted,
  "parity-drifting": READINESS_EXIT.parityDrifting,
  "parity-stale": READINESS_EXIT.parityStale,
  "bookable-pending": READINESS_EXIT.bookablePending,
  "hours-unset": READINESS_EXIT.hoursUnset,
  "partner-key-unproven": READINESS_EXIT.partnerKeyUnproven,
  "page-source-missing": READINESS_EXIT.pageSourceMissing,
  "holidays-uncovered": READINESS_EXIT.holidaysUncovered,
  "page-source-unmeasured": READINESS_EXIT.pageSourceUnmeasured,
};

export interface ReadinessJudgement {
  exit: number;
  /** Every finding, worst first, each with its own sentence. */
  findings: { kind: ReadinessFinding; detail: string }[];
  /**
   * The arming preconditions left unmet while the low volume alarms are OFF: shown,
   * never gating. Empty while the alarms are on, when they are findings instead.
   */
  advisories: { kind: ArmingFinding | "unreadable"; detail: string }[];
  /** What was measured, then the findings, for a person reading the terminal. */
  summary: string;
}

const NAME_CAP = 8;
function names(list: string[]): string {
  const shown = list.slice(0, NAME_CAP).join(", ");
  return list.length > NAME_CAP ? `${shown} and ${list.length - NAME_CAP} more` : shown;
}
function hours(ms: number): string {
  return `${Math.round(ms / 3_600_000)}h`;
}

export function judgeReadiness(f: ReadinessFacts): ReadinessJudgement {
  // #2875: every precondition below is about Slate shadowing cal.com. Once cal.com
  // is retired the comparison stops by design and parity-stale would hold this red
  // for ever, which reads as a broken shadow run rather than a finished one.
  if (f.calcomRetired === true) {
    return {
      exit: READINESS_EXIT.calcomRetired,
      findings: [],
      advisories: [],
      summary:
        "RETIRED: cal.com is marked retired on the alerts page, so the parallel run this command judges is over and nothing was judged. " +
        "If cal.com is still taking bookings, turn that setting off and run this again.",
    };
  }
  const findings: { kind: ReadinessFinding; detail: string }[] = [];
  const unreadable: string[] = [];
  if (f.calcomRetired === null) unreadable.push("the cal.com retired setting");

  if (f.stretchedCooldowns === null) unreadable.push("alert cooldowns");
  else if (f.stretchedCooldowns.length) {
    findings.push({
      kind: "alarm-muted",
      detail: `${f.stretchedCooldowns.length} alarm cooldown(s) stretched above the default: ${f.stretchedCooldowns
        .map((c) => `${c.key} at ${c.minutes} min (default ${c.defaultMinutes})`)
        .join("; ")}`,
    });
  }

  if (f.parity.drifting === null) unreadable.push("drift alert state");
  else if (f.parity.drifting) {
    findings.push({ kind: "parity-drifting", detail: driftLine(f.parity.drift) });
  }
  if (f.parity.lastRunMs === null) {
    findings.push({ kind: "parity-stale", detail: "the cal.com comparison has never reached a verdict" });
  } else if (f.nowMs - f.parity.lastRunMs > f.parity.boundMs) {
    findings.push({
      kind: "parity-stale",
      detail: `the cal.com comparison last reached a verdict ${hours(f.nowMs - f.parity.lastRunMs)} ago, past its ${hours(f.parity.boundMs)} bound`,
    });
  }

  if (f.pendingBookable === null) unreadable.push("pending bookable flips");
  else if (f.pendingBookable.length) {
    findings.push({
      kind: "bookable-pending",
      detail: `${f.pendingBookable.length} agent(s) waiting to become bookable behind a refused activation: ${names(f.pendingBookable)}`,
    });
  }

  if (f.calendars === null) unreadable.push("calendars");
  else {
    if (f.calendars.missingRows.length) {
      findings.push({
        kind: "calendar-missing",
        detail: `${f.calendars.missingRows.length} bookable agent(s) with no calendar row, so they read as free all day: ${names(f.calendars.missingRows)}`,
      });
    }
    if (f.calendars.uncovered.length) {
      findings.push({
        kind: "calendar-uncovered",
        detail: `${f.calendars.uncovered.length} calendar(s) not hydrated to the booking horizon: ${names(f.calendars.uncovered)}`,
      });
    }
  }

  if (f.unsetHours === null) unreadable.push("hours sources");
  else if (f.unsetHours.length) {
    findings.push({
      kind: "hours-unset",
      detail: `${f.unsetHours.length} bookable agent(s) on working hours nobody set: ${names(f.unsetHours)}`,
    });
  }

  if (f.emptyTiers === null) unreadable.push("debt tiers");
  else if (f.emptyTiers.empty.length) {
    findings.push({
      kind: "tier-empty",
      detail: `${f.emptyTiers.empty.length} debt tier(s) with nobody assigned: ${names(f.emptyTiers.empty)}`,
    });
  }

  let partnerProof: string | null = null;
  if (f.partnerKey === null) unreadable.push("partner key sightings");
  else {
    // Passes on a recent production host OR a recent server call that named no
    // host (Dan, 2026-09-25: trypennie's lookup is a server call). One exit for
    // every way it fails, each in its own words (never seen, only localhost or a
    // private address, only another host, or not recently): the fix is the same
    // person asking the same partner, and the sentence says which question to ask.
    //
    // Exits 17 and 18 judged the retired shared key (#2819, #2822) and are retired
    // with it (#2865); the numbers stay unused so an old log never reads as a new one.
    const v = judgePartnerKey(f.partnerKey.caller, f.partnerKey.rows, f.nowMs, PARTNER_KEY_MAX_AGE_DAYS * 86_400_000);
    if (v.status !== "proven") findings.push({ kind: "partner-key-unproven", detail: v.detail });
    else partnerProof = v.detail;
  }

  if (f.emptyBuckets === null) unreadable.push("buckets");
  else if (f.emptyBuckets.empty.length) {
    findings.push({
      kind: "bucket-empty",
      detail: `${f.emptyBuckets.empty.length} real bucket(s) with nobody to route to: ${names(f.emptyBuckets.empty)}`,
    });
  }

  // #2767: the arming preconditions, judged the same way whether or not they gate.
  const arming = f.lowVolumeArming;
  const armingChecks: { kind: ArmingFinding; detail: string }[] = [];
  const armingUnreadable: string[] = [];
  // #2960: the bookings set aside as made by hand with no host page never gate, and
  // are said in every state, always as the status's own `note`: an unrecorded status
  // says it inside the text the finding quotes, an unmeasured one is appended to this
  // file's own wording, and a recorded one goes on the arming line.
  let setAside: string | null = null;
  if (arming.pageSources === null) armingUnreadable.push("Low page booking sources");
  else {
    const s = arming.pageSources;
    // #2796: whether the sources are recorded well enough is judged by the alerts
    // settings page's own status, which reads the one rule in page-volume.ts
    // (`bookingSourcesRecorded`), so the two surfaces cannot answer the same
    // bookings differently. Every page having recorded one booking of its own is
    // NOT that rule: one untagged booking can still hold a page that stopped.
    const status = pageSourceStatus(s);
    if (status.state === "recorded") setAside = status.note;
    if (status.state === "unmeasured") {
      armingChecks.push({
        kind: "page-source-unmeasured",
        detail:
          `page sources unmeasured: no real booking in the last ${s.lookbackDays} days, so whether each Low page's links carry ?source= cannot be judged yet; re-run after real bookings from each page` +
          (status.note ? `. ${status.note}` : ""),
      });
    } else if (status.state === "unrecorded") {
      // In the alerts page's own sentence, which also names any page with none.
      armingChecks.push({ kind: "page-source-missing", detail: status.text });
    } else {
      // Every booking carried a source, so nothing can be hiding a page's bookings
      // and this claims no ambiguity: the page simply recorded none (L11).
      const without = s.pages.filter((p) => !p.recorded).map((p) => p.name);
      if (without.length) {
        armingChecks.push({
          kind: "page-source-missing",
          detail: `${without.length} Low page(s) Slate carries recorded no booking at all in the last ${s.lookbackDays} days, though every one of the ${s.realBookings} real bookings carried a source, so the per page alarm would report each as a page that stopped booking: ${names(without)}`,
        });
      }
    }
  }
  if (arming.holidays === null) armingUnreadable.push("holiday exceptions");
  else if (arming.holidays.uncovered.length) {
    const h = arming.holidays;
    armingChecks.push({
      kind: "holidays-uncovered",
      detail: `${h.uncovered.length} federal holiday date(s) in the next ${h.windowDays} days carry no business hours exception, so both alarms would judge them as ordinary open days; add a closed exception, or an open one if Pennie works that day: ${names(h.uncovered.map((x) => `${x.name} ${x.date}`))}`,
    });
  }
  if (arming.armed === null) armingUnreadable.push("low volume arming switch");
  // Fail closed on an unset switch: the deployment's env decides it, unseen here.
  const armingGates = arming.armed !== "disarmed";
  const advisories: ReadinessJudgement["advisories"] = [];
  if (armingGates) {
    findings.push(...armingChecks);
    unreadable.push(...armingUnreadable);
  } else {
    advisories.push(...armingChecks.sort((a, b) => READINESS_ORDER.indexOf(a.kind) - READINESS_ORDER.indexOf(b.kind)));
    if (armingUnreadable.length) {
      advisories.push({ kind: "unreadable", detail: `could not read ${armingUnreadable.join(", ")}, so that precondition is unjudged` });
    }
  }
  const armingState =
    arming.armed === "unset"
      ? "the low volume switch is unset, so the deployment's BOOKING_VOLUME_ALERT_ARMED decides and they are judged as if armed"
      : arming.armed === "armed"
        ? "the low volume alarms are armed"
        : arming.armed === null
          ? "the low volume switch could not be read, so they are judged as if armed"
          : "the low volume alarms are disarmed, so none of this changes the exit";
  const armingLine =
    (advisories.length === 0 && !armingGates
      ? `\nBefore arming the low volume alarms (#1956, #2738): every real booking in the last ${arming.pageSources?.lookbackDays} days carried its source and every Low page Slate carries recorded one, every federal holiday in the next ${arming.holidays?.windowDays} days is decided (${arming.holidays?.checked} date(s))`
      : advisories.length
        ? `\nBefore arming the low volume alarms (#1956, #2738); ${armingState}:\n` +
          advisories.map((a) => `  ${a.kind}: ${a.detail}`).join("\n")
        : armingChecks.length || armingUnreadable.length
          ? `\nArming preconditions gate this run: ${armingState}`
          : `\nArming preconditions met while gating (${armingState}): every real booking carried its source and every Low page Slate carries recorded one, every federal holiday in the next ${arming.holidays?.windowDays} days is decided`) +
    (setAside ? `\n${setAside}` : "");

  if (unreadable.length) {
    findings.unshift({
      kind: "unreadable",
      detail: `could not read ${unreadable.join(", ")}, so nothing beneath is vouched for`,
    });
  } else if (
    (f.calendars?.bookableAgents ?? 0) === 0 ||
    (f.emptyBuckets?.realBuckets ?? 0) === 0 ||
    (f.emptyTiers?.measuredTiers ?? 0) === 0
  ) {
    findings.unshift({
      kind: "nothing-measured",
      detail: `measured ${f.calendars?.bookableAgents ?? 0} bookable agents, ${f.emptyTiers?.measuredTiers ?? 0} debt tiers and ${f.emptyBuckets?.realBuckets ?? 0} real buckets, which judges nothing`,
    });
  }

  findings.sort((a, b) => READINESS_ORDER.indexOf(a.kind) - READINESS_ORDER.indexOf(b.kind));
  const measured =
    f.calendars && f.emptyBuckets && f.emptyTiers
      ? `measured ${f.calendars.bookableAgents} bookable agents, ${f.emptyTiers.measuredTiers} debt tiers and ${f.emptyBuckets.realBuckets} real buckets`
      : "measured only part of the picture";
  if (findings.length === 0) {
    return { exit: READINESS_EXIT.ready, findings, advisories, summary: `READY: ${measured}; no alarm muted, comparison fresh, nobody waiting, every calendar hydrated, every week set by somebody, every debt tier staffed, no empty bucket; ${partnerProof}${armingLine}` };
  }
  return {
    exit: EXIT_FOR[findings[0].kind],
    findings,
    advisories,
    summary: `NOT READY (${findings[0].kind}): ${measured}\n` + findings.map((x) => `  ${x.kind}: ${x.detail}`).join("\n") + armingLine,
  };
}

/**
 * Why a gh call failed, in one short line. execFileSync's message opens with the
 * "Command failed: gh ..." line, which names the command and not the cause; gh prints
 * the cause (not signed in, no access, not found) to stderr, so that is read first.
 */
export function ghFailureReason(err: unknown): string {
  const firstLine = (text: string): string =>
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? "";
  const stderr = typeof err === "object" && err !== null ? (err as { stderr?: unknown }).stderr : undefined;
  const fromStderr = typeof stderr === "string" || Buffer.isBuffer(stderr) ? firstLine(String(stderr)) : "";
  const fromMessage = firstLine(err instanceof Error ? err.message : String(err));
  return (fromStderr || fromMessage).slice(0, 160);
}

/**
 * The calendars that keep readiness from READY, named for the reader. The monitor's
 * judge is used so both agree on what a lapsed calendar is, but its first run
 * patience is NOT granted here: this command is run at a chosen moment before real
 * leads, and a calendar that has never been hydrated is not hydrated however new it
 * is. So a calendar the monitor would still be waiting on is named, as such.
 */
export function readinessUncoveredCalendars(input: {
  rows: CalendarWindowRow[];
  horizonDays: number;
  nowIso: string;
}): string[] {
  const label = (r: CalendarWindowRow) => `${r.email ?? r.userId} (${r.calendarId})`;
  const { uncovered } = judgeCalendarCoverage(input);
  const named = new Set(uncovered);
  const waiting = input.rows.filter((r) => !named.has(r) && r.syncWindowToIso === null);
  return [
    ...uncovered.map(label),
    ...waiting.map((r) => `${label(r)}, joined the rotation moments ago and not hydrated yet`),
  ];
}
