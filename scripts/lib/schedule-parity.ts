// The comparison behind `pnpm verify:calcom-parity` (#1754). Pure: no network,
// no clock, no database, so `scripts/test-schedule-parity.ts` drives every verdict
// offline.
//
// THE QUESTION IT ANSWERS is not "is Slate correct". cal.com is the incumbent, not
// the source of truth, and a schedule both systems hold can be wrong in both. That
// question belongs to the agent. This asks whether the two systems AGREE, which is
// a check on configuration drift, and during the parallel run it is the only thing
// that can notice an agent changing their hours in one system and not the other.
//
// IT REPLACED A SLOT COMPARISON THAT COULD NEVER RUN. The first probe (#1731)
// pinned cal.com's answer to one bucket's agents with `routedTeamMemberIds[]` on
// `GET /v2/slots`; that parameter does not exist on that endpoint and every
// spelling answers 400 (re-measured live 2026-09-07). Schedules are read through
// `GET /v2/organizations/{org}/users/{id}/schedules`, which the OOO dual-write
// already uses, so it is known to work. It is also better suited to the question:
// per agent rather than per pool, with no dependency on busy time being hydrated.
//
// THE COMPARISON IS EXACT. The slot probe bucketed to the hour because the two
// systems carry different slot intervals, durations and buffers, and demanding
// equal instants would have been red from the day it shipped. None of that is true
// of a schedule: both sides store a weekday plus start and end minutes, so the
// values compare directly, and bucketing would hide the commonest drift on this
// roster rather than tolerate noise (26 real windows sit on a half or quarter
// hour, and 09:00 against 09:30 opens the same hour).
import {
  mapCalcomSchedule,
  AGENT_OWNS_HOURS,
  type CalcomSchedule,
  type SlateRule,
  type SlateSchedule,
} from "@/lib/calcom/schedule-import";
import { zonesKeepSameClock } from "@/lib/booking/timezones";

/** Luxon's convention, which is Slate's: 1 = Monday .. 7 = Sunday. Named rather
 *  than numbered wherever a person reads the output: nobody acts on "day 6". */
const DAY_NAME: Record<number, string> = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday",
};

/**
 * What cal.com gave us for one agent.
 *
 * The three states are carried as distinct kinds rather than as a nullable
 * schedule, because they call for three different people to do three different
 * things: chase an account that was never created, chase a schedule nobody set,
 * or read a schedule. Collapsing any two makes one answer for the other (L11).
 */
export type CalcomSide =
  /** No cal.com account resolves to this agent's email. */
  | { kind: "user-missing" }
  /** The account exists and carries no default schedule. */
  | { kind: "schedule-missing" }
  /** The read itself failed after every retry. Kept apart from an unreadable
   *  payload because the two are different instructions: this one says run it
   *  again (or check the key), that one says the contract changed. */
  | { kind: "read-failed"; status: number; transient: boolean }
  /** A schedule payload, exactly as cal.com returned it. Mapped here, never by
   *  the caller, so a payload we cannot read is refused in one place. */
  | { kind: "schedule"; schedule: CalcomSchedule };

export type ScheduleVerdict =
  | "agree"
  | "no-calcom-user"
  | "no-calcom-schedule"
  | "no-slate-schedule"
  | "timezone-name-differs"
  | "calcom-unreachable"
  | "calcom-unreadable"
  | "hours-differ"
  | "days-differ"
  | "timezone-differs"
  /** A real hours, days or timezone difference on a week the AGENT set for
   *  themselves, which the daily lane deliberately will not overwrite (#2092). */
  | "hours-set-by-agent";

/**
 * Worst last. Every verdict the module can produce carries a rank, and the test
 * asserts that both ways: a verdict with no rank would score as agreement by
 * omission, and a rank for a verdict nothing produces is a dead exit code nobody
 * can ever meet.
 *
 * The zone outranks the rest because it moves EVERY window at once and leaves the
 * stored numbers looking correct, which is why 74 of 103 agents were wrong for
 * months with nothing reporting it (#1739). A day difference costs one day; an
 * hours difference costs the ends of one.
 */
export const VERDICT_RANK: Record<ScheduleVerdict, number> = {
  agree: 0,
  // Below every real finding, and above agreement, so a drifted NAME is always
  // reported and never names the run while something a lead can feel is on the
  // board. The first live sweep is the argument: ten agents filed under a zone
  // label, every one of them the same clock, and one of the ten hiding a genuine
  // Saturday-for-Friday swap underneath it.
  "timezone-name-differs": 1,
  // Beside the zone alias, and for the same reason: real, reported, and never the
  // thing that names a run. It differs from the alias in being a difference a lead
  // WOULD feel; what it shares is that no automatic run will ever clear it, so
  // paging on it daily would leave the check permanently red (L36). It sits BELOW
  // the alias because the alias can still be repaired by the lane and this cannot.
  "hours-set-by-agent": 1.5,
  "no-calcom-user": 2,
  "no-calcom-schedule": 3,
  "no-slate-schedule": 4,
  "calcom-unreachable": 5,
  "calcom-unreadable": 6,
  "hours-differ": 7,
  "days-differ": 8,
  "timezone-differs": 9,
};

/**
 * Whether two zone names are the same clock for every hour worth booking.
 *
 * Slate stores `America/Denver` where cal.com stores `America/Boise` for nine
 * agents, and `America/New_York` where cal.com stores
 * `America/Indiana/Indianapolis` for one. Those pairs keep identical time (0 of
 * 9,600 sampled hours differ), so reporting them the way a genuine Phoenix against
 * Denver difference is reported (5,711 of 9,600) makes the loud finding and the
 * harmless one indistinguishable, and the harmless one is nine times commoner.
 *
 * A zone no clock can read never agrees with anything: answering true there would
 * quietly downgrade a genuinely broken value to cosmetic. Two IDENTICAL names
 * agree without a reading, since they are one value whatever it holds.
 */
export function zonesAgree(a: string, b: string, nowMs: number = Date.now()): boolean {
  if (a === b) return true;
  // The window, the sampling and the memo live in ONE judge, shared with the
  // booker's zone picker (#2687), so the two cannot disagree about Boise.
  return zonesKeepSameClock(a, b, nowMs);
}

export interface AgentComparison {
  email: string;
  verdict: ScheduleVerdict;
  /** Every difference found, in words a person can act on. The verdict names only
   *  the most severe, so an agent wrong in two ways whose zone gets fixed would
   *  otherwise read as finished. */
  reasons: string[];
}

/** Minutes from local midnight as a clock, because nobody acts on "480". */
function clock(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * One day's windows as a person reads them, gap included.
 *
 * A split day renders as both shifts rather than as its span, which is the whole
 * point of the split-shift case: an agent shown as "08:00 to 17:00" against
 * "08:00 to 12:00, 13:00 to 17:00" can see the hour they are bookable through.
 */
export function describeWindows(rules: SlateRule[]): string {
  if (rules.length === 0) return "nothing";
  return [...rules]
    .sort((a, b) => a.start_minute - b.start_minute || a.end_minute - b.end_minute)
    .map((r) => `${clock(r.start_minute)} to ${clock(r.end_minute)}`)
    .join(", ");
}

function byDay(rules: SlateRule[]): Map<number, SlateRule[]> {
  const out = new Map<number, SlateRule[]>();
  for (const r of rules) {
    const list = out.get(r.weekday);
    if (list) list.push(r);
    else out.set(r.weekday, [r]);
  }
  return out;
}

function dayList(days: number[]): string {
  return days.sort((a, b) => a - b).map((d) => DAY_NAME[d] ?? `day ${d}`).join(", ");
}

/**
 * Compare one agent's week in the two systems.
 *
 * The Slate side is judged FIRST, because it is the side we own and the side that
 * decides what a lead is offered. An agent bookable in Slate with no rules at all
 * is offered nothing, which from every Slate surface is indistinguishable from a
 * quiet agent, so it is reported even when cal.com has nothing to compare against.
 */
export function compareAgentSchedule(
  email: string,
  slate: SlateSchedule | null,
  cal: CalcomSide,
  /** Injected so the zone comparison is anchored rather than reading the clock,
   *  which would make the same fixture answer differently across a DST boundary. */
  nowMs: number = Date.now(),
): AgentComparison {
  if (slate === null || slate.rules.length === 0) {
    return {
      email,
      verdict: "no-slate-schedule",
      reasons: ["Slate holds no working hours for a bookable agent, so they are offered nothing"],
    };
  }
  if (cal.kind === "user-missing") {
    return {
      email,
      verdict: "no-calcom-user",
      reasons: ["no cal.com account resolves to this address, so there is nothing to compare against"],
    };
  }
  if (cal.kind === "read-failed") {
    return {
      email,
      verdict: "calcom-unreachable",
      reasons: [
        `cal.com would not answer for this agent (${cal.status})` +
          (cal.transient ? ", which usually clears: run it again" : ", which another attempt cannot fix"),
      ],
    };
  }
  if (cal.kind === "schedule-missing") {
    return {
      email,
      verdict: "no-calcom-schedule",
      reasons: ["the cal.com account carries no default schedule"],
    };
  }

  // Emptiness is decided from the SHAPE, before mapping, rather than by reading the
  // mapper's refusal text. A classifier that reads its own prose is one reworded
  // sentence away from silently reclassifying a whole population.
  const list = cal.schedule.availability;
  if (Array.isArray(list) && list.length === 0) {
    return {
      email,
      verdict: "no-calcom-schedule",
      reasons: ["the cal.com schedule exists and has no availability windows set"],
    };
  }

  const mapped = mapCalcomSchedule(cal.schedule);
  if (!mapped.ok) {
    // Refused whole rather than salvaged. A partly read payload yields a SMALLER
    // week, which is indistinguishable from an agent genuinely working less and
    // would be reported as a real hours finding: a defect in our own parsing
    // wearing the costume of a defect in the roster (L340).
    return {
      email,
      verdict: "calcom-unreadable",
      reasons: [`cal.com's schedule could not be read: ${mapped.why}`],
    };
  }

  const reasons: string[] = [];
  let worst: ScheduleVerdict = "agree";
  const raise = (v: ScheduleVerdict) => {
    if (VERDICT_RANK[v] > VERDICT_RANK[worst]) worst = v;
  };

  if (slate.timezone !== mapped.timezone) {
    if (zonesAgree(slate.timezone, mapped.timezone, nowMs)) {
      reasons.push(
        `timezone name: Slate has ${slate.timezone}, cal.com has ${mapped.timezone}; ` +
          "these are the same clock all year, so nothing a lead sees changes",
      );
      raise("timezone-name-differs");
    } else {
      reasons.push(`timezone: Slate has ${slate.timezone}, cal.com has ${mapped.timezone}`);
      raise("timezone-differs");
    }
  }

  const slateDays = byDay(slate.rules);
  const calDays = byDay(mapped.rules);
  const onlySlate = [...slateDays.keys()].filter((d) => !calDays.has(d));
  const onlyCal = [...calDays.keys()].filter((d) => !slateDays.has(d));
  if (onlySlate.length > 0) {
    reasons.push(`days Slate has and cal.com does not: ${dayList(onlySlate)}`);
    raise("days-differ");
  }
  if (onlyCal.length > 0) {
    reasons.push(`days cal.com has and Slate does not: ${dayList(onlyCal)}`);
    raise("days-differ");
  }

  // Days differing the same way are reported once. Five identical lines for a
  // roster-wide shift is the report nobody finishes reading, and the grouping is
  // by the PAIR of renderings so two days that differ differently stay apart.
  const groups = new Map<string, { days: number[]; slate: string; cal: string }>();
  for (const [day, rules] of slateDays) {
    const calRules = calDays.get(day);
    if (!calRules) continue;
    const a = describeWindows(rules);
    const b = describeWindows(calRules);
    if (a === b) continue;
    const key = `${a}|${b}`;
    const existing = groups.get(key);
    if (existing) existing.days.push(day);
    else groups.set(key, { days: [day], slate: a, cal: b });
  }
  for (const g of groups.values()) {
    reasons.push(`${dayList(g.days)}: Slate has ${g.slate}, cal.com has ${g.cal}`);
    raise("hours-differ");
  }

  return { email, verdict: worst, reasons };
}

/**
 * The three findings the daily lane can repair by re-importing from cal.com.
 *
 * Listed rather than picked out by rank, for the reason the sweep's own
 * `CANNOT_COMPARE` list is: a rank threshold reads as a tidy rule and silently
 * reclassifies the moment a verdict is inserted between two ranks, which is
 * exactly what adding `timezone-name-differs` did.
 */
const LANE_REPAIRABLE: readonly ScheduleVerdict[] = ["hours-differ", "days-differ", "timezone-differs"];

/**
 * Report a difference the lane is not allowed to correct, instead of paging on it
 * every morning (#2092).
 *
 * The daily lane applies an hours, days or timezone correction itself now, and
 * `hoursOverwriteRefusal` stops it replacing a week an agent set for themselves.
 * That refusal creates a state nothing could previously say: a real difference
 * that no automatic run will ever clear. Left as `hours-differ` it pages daily for
 * as long as it sits, and a permanently red check is one nobody reads by the
 * second week (L36).
 *
 * It is a SEPARATE step from `compareAgentSchedule` on purpose. That function
 * answers "do the two systems agree", which is a question about two weeks; this
 * answers "is this ours to fix", which is a question about who wrote the Slate
 * side. Folding them would put an ownership rule inside a pure comparison and give
 * every one of its fixtures a field it does not care about.
 *
 * It touches ONLY the three repairable findings. An agent with no Slate hours at
 * all is not somebody who set their own, and filing that under this heading would
 * dress a real gap as a deliberate choice (L11).
 */
export function reclassifyAgentOwnedHours(
  row: AgentComparison,
  hoursSource: string | null,
): AgentComparison {
  if (hoursSource !== "agent") return row;
  if (!LANE_REPAIRABLE.includes(row.verdict)) return row;
  return {
    ...row,
    verdict: "hours-set-by-agent",
    // The ownership is APPENDED rather than replacing the reasons. The reader
    // still has to see what actually differs: without it the line says somebody
    // owns their hours and never says the two systems disagree about what they are.
    reasons: [...row.reasons, AGENT_OWNS_HOURS],
  };
}

/**
 * The run's own verdict: the worst any agent reported.
 *
 * A sweep is only as good as its worst agent, and one wrong timezone among a
 * hundred agreements is the finding. An EMPTY sweep answers null rather than
 * "agree", because judging nothing is never a pass (L98) and the caller has to
 * turn that into its own refusal rather than an exit zero.
 */
export function worstVerdict(verdicts: ScheduleVerdict[]): ScheduleVerdict | null {
  let worst: ScheduleVerdict | null = null;
  for (const v of verdicts) {
    if (worst === null || VERDICT_RANK[v] > VERDICT_RANK[worst]) worst = v;
  }
  return worst;
}
