// Is the shadow run trustworthy today? (#2066)
//
// Answering that on 2026-09-07 took a database query plus reading eight issues, and
// `docs/parallel-run-plan.md` says outright that it cannot report status. This is
// the judgement behind the one command that answers it, kept pure so it is pinned
// by fixtures where no database exists, in the same family as
// `verify:availability-truth`, `verify:ooo-protection` and `verify:calcom-parity`.
//
// Five preconditions, each already measured somewhere in Slate and none of them
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
// - no real bucket is empty, by the empty bucket alarm's own predicate.
//
// Two rules carry it. Every way of learning nothing exits on its OWN code, because
// "an alarm is muted", "cal.com has not been compared for two days" and "the bucket
// read failed" send three different people three different places (L11). And a run
// that measured nobody is never a pass (L98): zero bookable agents or zero real
// buckets is the shape of a broken read, not a healthy morning.

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
}

export type ReadinessFinding =
  | "unreadable"
  | "nothing-measured"
  | "bucket-empty"
  | "calendar-missing"
  | "calendar-uncovered"
  | "alarm-muted"
  | "parity-drifting"
  | "parity-stale"
  | "bookable-pending";

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
  "bucket-empty",
  "calendar-missing",
  "calendar-uncovered",
  "alarm-muted",
  "parity-drifting",
  "parity-stale",
  "bookable-pending",
] as const;

/**
 * One code per outcome. 1 is deliberately absent: the entry exits 1 before any
 * judging when no credentials are configured, so nothing here may share it.
 */
export const READINESS_EXIT = {
  ready: 0,
  unreadable: 2,
  nothingMeasured: 3,
  bucketEmpty: 4,
  calendarMissing: 5,
  calendarUncovered: 6,
  alarmMuted: 7,
  parityDrifting: 8,
  parityStale: 9,
  bookablePending: 10,
} as const;

const EXIT_FOR: Record<ReadinessFinding, number> = {
  unreadable: READINESS_EXIT.unreadable,
  "nothing-measured": READINESS_EXIT.nothingMeasured,
  "bucket-empty": READINESS_EXIT.bucketEmpty,
  "calendar-missing": READINESS_EXIT.calendarMissing,
  "calendar-uncovered": READINESS_EXIT.calendarUncovered,
  "alarm-muted": READINESS_EXIT.alarmMuted,
  "parity-drifting": READINESS_EXIT.parityDrifting,
  "parity-stale": READINESS_EXIT.parityStale,
  "bookable-pending": READINESS_EXIT.bookablePending,
};

export interface ReadinessJudgement {
  exit: number;
  /** Every finding, worst first, each with its own sentence. */
  findings: { kind: ReadinessFinding; detail: string }[];
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
  const findings: { kind: ReadinessFinding; detail: string }[] = [];
  const unreadable: string[] = [];

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
    findings.push({ kind: "parity-drifting", detail: "the cal.com comparison is currently reporting drift" });
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

  if (f.emptyBuckets === null) unreadable.push("buckets");
  else if (f.emptyBuckets.empty.length) {
    findings.push({
      kind: "bucket-empty",
      detail: `${f.emptyBuckets.empty.length} real bucket(s) with nobody to route to: ${names(f.emptyBuckets.empty)}`,
    });
  }

  if (unreadable.length) {
    findings.unshift({
      kind: "unreadable",
      detail: `could not read ${unreadable.join(", ")}, so nothing beneath is vouched for`,
    });
  } else if ((f.calendars?.bookableAgents ?? 0) === 0 || (f.emptyBuckets?.realBuckets ?? 0) === 0) {
    findings.unshift({
      kind: "nothing-measured",
      detail: `measured ${f.calendars?.bookableAgents ?? 0} bookable agents and ${f.emptyBuckets?.realBuckets ?? 0} real buckets, which judges nothing`,
    });
  }

  findings.sort((a, b) => READINESS_ORDER.indexOf(a.kind) - READINESS_ORDER.indexOf(b.kind));
  const measured =
    f.calendars && f.emptyBuckets
      ? `measured ${f.calendars.bookableAgents} bookable agents and ${f.emptyBuckets.realBuckets} real buckets`
      : "measured only part of the picture";
  if (findings.length === 0) {
    return { exit: READINESS_EXIT.ready, findings, summary: `READY: ${measured}; no alarm muted, comparison fresh, nobody waiting, every calendar hydrated, no empty bucket` };
  }
  return {
    exit: EXIT_FOR[findings[0].kind],
    findings,
    summary: `NOT READY (${findings[0].kind}): ${measured}\n` + findings.map((x) => `  ${x.kind}: ${x.detail}`).join("\n"),
  };
}
