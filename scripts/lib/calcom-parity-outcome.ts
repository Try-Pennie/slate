// The one ordering across both halves of `pnpm verify:calcom-parity` (#1911).
//
// The command answers two questions, "do the two systems hold the same roster"
// (`roster-parity.ts`) and "do they hold the same hours for it"
// (`schedule-parity.ts`). Each half ranks its own verdicts against each other,
// which is all either can honestly do. A run exits once, so the two families need
// one order and one code per outcome, and the cross-family judgements are the
// interesting ones.
//
// Written as an explicit table rather than by folding two rank scales together.
// Folding would produce an order nobody chose, and the answer to "is a departed
// agent worse than a wrong timezone" would be an accident of two numbers picked
// months apart in different files.
import { PARITY_VERDICT_CLASS, type ParityVerdict } from "@/lib/monitor/schedule-parity-alert";
import type { RosterVerdict } from "./roster-parity.ts";
import type { ScheduleVerdict } from "./schedule-parity.ts";

/**
 * A verdict that deliberately cannot fail a run, named in the TYPE as well as in
 * the list below, so `tsc` enforces the exemption in both directions: it may not
 * be given an exit code, and every other verdict must have one.
 */
type QuietVerdict = "staff-not-bookable";

/** Everything either half can report that a run can actually exit on. */
export type ParityOutcome = Exclude<RosterVerdict | ScheduleVerdict, "agree" | QuietVerdict>;

/**
 * Worst FIRST, and the reasoning for each rung:
 *
 * The two roster findings that put a real lead in front of the wrong person lead,
 * because they are the only outcomes where a booking made today is already wrong.
 * The three hours findings follow, since they change what a lead is offered but
 * always to somebody who should be taking the call. Slate offering somebody
 * cal.com does not route to comes next: it is wrong, but the incumbent is still
 * the one taking every real lead, so nothing is mis-booked by it today.
 *
 * Then the states where nothing could be compared. They rank below every measured
 * finding on purpose: an agent nobody could check is a gap in coverage, and a
 * measured difference is a defect somebody can go and fix.
 *
 * Last is a zone name that keeps the same clock, which changes nothing a lead
 * sees. It is reported so drift is knowable and ranked last so it can never bury
 * something real, which it did on the very first live sweep.
 *
 * One verdict is deliberately absent, and it is named in `DELIBERATELY_QUIET`
 * below rather than simply left out, so the exemption has a reviewer (L129).
 */
export const OUTCOME_ORDER: readonly ParityOutcome[] = [
  "departed-still-hosting",
  "held-back-still-hosting",
  "timezone-differs",
  "days-differ",
  "hours-differ",
  "bookable-not-hosting",
  "absent-from-slate",
  "not-bookable-by-design",
  "calcom-unreadable",
  "calcom-unreachable",
  "no-slate-schedule",
  "no-calcom-schedule",
  "no-calcom-user",
  "timezone-name-differs",
] as const;

/**
 * Verdicts that deliberately have NO outcome and NO exit code, with the reason.
 *
 * Named rather than left out, because an omission that is correct is
 * indistinguishable from one that was forgotten, and the check that would have
 * caught the forgotten one has to be told about the correct one somewhere.
 *
 * `staff-not-bookable`: nine admins, managers and team leads host in cal.com and
 * are correctly not bookable in Slate. Nothing will ever change them, so an
 * outcome for them would fail every run forever, and a permanently red check is
 * one nobody reads by the second week (L36). They are still PRINTED in the
 * report, so the roster can be read in full; what they cannot do is fail a run.
 */
export const DELIBERATELY_QUIET: readonly QuietVerdict[] = [
  "staff-not-bookable",
] as const;

/**
 * One code per outcome, so a shell caller can branch on WHICH kind of divergence
 * a run met without parsing prose. Stable: the roster codes were added at 20 and
 * up rather than renumbering the schedule codes that already shipped.
 *
 * Zero is reserved for agreement and appears nowhere here.
 */
export const EXIT_CODE: Record<ParityOutcome, number> = {
  "timezone-name-differs": 9,
  "no-calcom-user": 10,
  "no-calcom-schedule": 11,
  "no-slate-schedule": 12,
  "calcom-unreachable": 13,
  "calcom-unreadable": 14,
  "hours-differ": 15,
  "days-differ": 16,
  "timezone-differs": 17,
  "not-bookable-by-design": 21,
  "absent-from-slate": 22,
  "bookable-not-hosting": 23,
  "held-back-still-hosting": 24,
  "departed-still-hosting": 25,
};

/**
 * The run's outcome: the worst thing either half reported, or null when there is
 * nothing to report.
 *
 * Null covers two different situations and the caller must tell them apart: a run
 * where everything agreed, and a run that judged nothing at all. Answering "agree"
 * here would merge them, and judging nothing is never a pass (L98).
 */
export function worstOutcome(verdicts: (RosterVerdict | ScheduleVerdict)[]): ParityOutcome | null {
  let best = OUTCOME_ORDER.length;
  for (const v of verdicts) {
    const at = OUTCOME_ORDER.indexOf(v as ParityOutcome);
    if (at !== -1 && at < best) best = at;
  }
  return best === OUTCOME_ORDER.length ? null : OUTCOME_ORDER[best];
}

// --- the daily alert's copy of this vocabulary, held to it by tsc (#2031) --------
//
// The scheduled sweep reports to an endpoint in the app, and that endpoint refuses
// a verdict it does not know, so the classification table in
// `src/lib/monitor/schedule-parity-alert.ts` is a second statement of the list
// above. A second statement drifts, and it drifts silently in the worst direction:
// a verdict renamed here would arrive at the endpoint unclassified, be refused, and
// the finding would page nobody while every run still looked healthy (L41, L96).
//
// So both directions are checked at COMPILE time rather than by a test that has to
// remember to be written. Neither line runs; each exists to fail `tsc`.
// The set to check against is everything the two halves PRODUCE, which is the
// outcomes PLUS the deliberately quiet ones, never `ParityOutcome` alone. Keying it
// on `ParityOutcome` is what shipped the check inert on 2026-09-07: nine agents came
// back `staff-not-bookable`, the one verdict this file exempts from having an exit
// code, so nothing anywhere required it to be classified and the endpoint refused
// every payload that carried it. An exemption from ONE table is not an exemption
// from every table, and the guard has to be told which one it is exempt from (L129).
type ProducedVerdict = ParityOutcome | QuietVerdict;
/** Every verdict this file's halves can produce is classified over there. */
const _everyOutcomeIsClassified: Record<ProducedVerdict, unknown> = PARITY_VERDICT_CLASS;
/** And nothing is classified over there that they cannot produce. */
const _everyClassifiedOutcomeExists: ProducedVerdict = null as unknown as ParityVerdict;
void _everyOutcomeIsClassified;
void _everyClassifiedOutcomeExists;
