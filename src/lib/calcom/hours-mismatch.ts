// Whether cal.com holds a different week than the one an advisor set in Slate,
// and the sentence that tells them so (#3549). Pure: no network, no database, and
// the clock is passed in, so `scripts/test-calcom-hours-mismatch.ts` drives every
// outcome offline.
//
// WHY IT EXISTS. An advisor who sets their own hours in Slate stops receiving the
// daily cal.com copy, by design (`hoursOverwriteRefusal`): the copy never
// overwrites hours somebody chose. While cal.com still takes bookings that leaves
// one person with two weeks and nobody told. Measured 2026-10-08: fourteen
// advisors in that state, five of them on which DAYS they work, and one asked in
// Slack whether she had to update both systems.
//
// A READ THAT COULD NOT BE MADE IS SAID (Dan, 2026-10-08). The note appears only
// on a difference, so a silent failure would draw exactly what agreement draws.
import { weekdayPhrase } from "@/lib/schedule-core";
import { zoneLabel, zonesKeepSameClock } from "@/lib/booking/timezones";
import { planImportedWeek, type HoursSource, type SlateRule } from "@/lib/calcom/schedule-import";
import type { ScheduleForImportRead } from "@/lib/calcom/client";

/**
 * Whether the page should ask cal.com at all.
 *
 * Only an advisor's OWN week: every other source is replaced by the daily copy,
 * so a difference there closes itself within a day and naming it would send
 * somebody to fix what is already being fixed. An unreadable retirement switch
 * (null) still asks, because the read changes nothing and skipping would be a
 * guess that cal.com is gone.
 */
export function shouldCompareWithCalcom(
  hoursSource: HoursSource | null,
  ruleCount: number,
  calcomRetired: boolean | null,
): boolean {
  return hoursSource === "agent" && ruleCount > 0 && calcomRetired !== true;
}

export type CalcomHoursJudgement =
  /** The two weeks agree. */
  | { kind: "same" }
  /** Nothing in cal.com to keep in step: no account, no key, or the load test. */
  | { kind: "not-in-calcom" }
  | { kind: "differs"; text: string }
  /** The comparison was not made. Never drawn as agreement. */
  | { kind: "unchecked"; text: string };

export const CALCOM_HOURS_UNCHECKED =
  "Couldn't compare these with your cal.com hours just now. Reload to try again.";

const REMEDY = "Leads can still book you through cal.com, so update your hours there as well.";

function windowsByDay(rules: SlateRule[]): Map<number, string> {
  const byDay = new Map<number, string[]>();
  for (const r of rules) {
    const list = byDay.get(r.weekday) ?? [];
    list.push(`${r.start_minute}-${r.end_minute}`);
    byDay.set(r.weekday, list);
  }
  return new Map([...byDay].map(([d, w]) => [d, w.sort().join(",")]));
}

/** The advisor's Slate week against what cal.com answered. */
export function judgeCalcomHours(
  slate: { timezone: string; rules: SlateRule[] },
  read: ScheduleForImportRead,
  nowMs: number,
): CalcomHoursJudgement {
  switch (read.kind) {
    case "no-account":
    case "not-configured":
    case "loadtest":
      return { kind: "not-in-calcom" };
    case "no-schedule":
      return { kind: "differs", text: `cal.com has no working hours set for you. ${REMEDY}` };
    case "rate-limited":
    case "refused":
    case "unreachable":
    case "unreadable":
      return { kind: "unchecked", text: CALCOM_HOURS_UNCHECKED };
    case "schedule":
      break;
  }

  const cal = planImportedWeek(read.schedule);
  if (!cal.ok) return { kind: "unchecked", text: CALCOM_HOURS_UNCHECKED };

  const mine = windowsByDay(slate.rules);
  const theirs = windowsByDay(cal.rules);
  const onlyCal = [...theirs.keys()].filter((d) => !mine.has(d));
  const onlySlate = [...mine.keys()].filter((d) => !theirs.has(d));
  const sentences: string[] = [];

  if (onlyCal.length > 0 && onlySlate.length > 0) {
    sentences.push(`cal.com still has you working ${weekdayPhrase(onlyCal)} and not ${weekdayPhrase(onlySlate)}.`);
  } else if (onlyCal.length > 0) {
    sentences.push(`cal.com also has you working ${weekdayPhrase(onlyCal)}.`);
  } else if (onlySlate.length > 0) {
    sentences.push(`cal.com doesn't have you working ${weekdayPhrase(onlySlate)}.`);
  }

  if (!zonesKeepSameClock(slate.timezone, cal.timezone, nowMs)) {
    // Every day's hours are different instants in another zone, so naming each day
    // would bury the one fact that explains all of them.
    sentences.push(`cal.com has your timezone as ${zoneLabel(cal.timezone)}.`);
  } else {
    const changed = [...mine.keys()].filter((d) => theirs.has(d) && theirs.get(d) !== mine.get(d));
    if (changed.length > 0) {
      const too = sentences.length > 0 ? " too" : "";
      sentences.push(`Your hours on ${weekdayPhrase(changed)} are different there${too}.`);
    }
  }

  if (sentences.length === 0) return { kind: "same" };
  return { kind: "differs", text: `${sentences.join(" ")} ${REMEDY}` };
}
