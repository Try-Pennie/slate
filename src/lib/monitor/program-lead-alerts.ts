/**
 * The program leads alerts (#4392, phase 6 of #4255). Two CONDITIONS, each judged on the
 * monitor lane every 5 minutes, each clearing only on a measured healthy result.
 *
 * FALLBACKS TO REAL TIMES (`program_lead_fallbacks`). A program lead with a good token is
 * shown the placeholder's extra times beside the real ones; when a read that needs fails
 * (the token secret, the switch and limit, the hours, the horizon, the day counts) they are
 * shown real times only and the fallback is counted per Eastern day
 * (`program_lead_outcomes`, kind `times_fallback`, #4390). Each fallback is harmless on its
 * own, since the lead still sees every real time, but it is OUR fault and it takes away the
 * thing the program exists to give: a time when nobody real is free. One transient read
 * failure should never page (L36). A read that is broken fails every program lead who looks,
 * and a program lead looks a handful of times on one visit. So the line is
 * `PROGRAM_LEAD_FALLBACK_DAY_LIMIT`, five on one Eastern day: about one lead's visit failing
 * end to end, which a lone blip in a day does not reach, and which a broken read reaches
 * within its first few leads. It is a count rather than a share because nothing counts the
 * times a program lead is SHOWN (counting that would put a write on every availability
 * request, the hot path ADR 0003 keeps to the cache), and the count is on the day the
 * fallback happened, the day the bump ran. The day is the page's subject, so a new day
 * posts at once, and the count is banded (5, 25, 100) so a much worse day does too. It
 * clears on a measured count under the line, which in practice is the next Eastern day:
 * a count for a day only rises.
 *
 * ZERO REGISTRATIONS (`program_lead_registrations_zero`). Program leads are registered by
 * the system that accepts them (#4388) BEFORE the first text with the booking link goes out.
 * A whole business day with none means that registration has stopped, and every program
 * lead since then is being shown real times only, which nothing else would notice: the
 * booker still works. It counts registrations (`program_leads.last_registered_at`, which
 * every registration moves) from the open of the last whole business day
 * (`lastClosedBusinessDay`) to now, and pages on zero, naming that day. It clears when a
 * registration is counted, and ends in its own words when the program is switched off.
 *
 * SHIPPED DISARMED. `PROGRAM_LEAD_REGISTRATIONS_ALERT_ARMED` is false until the program is
 * switched on, which phase 7 (#4393) does after the live drill, and arms this in the same
 * change. Disarmed, the check reads nothing, sends nothing and clears nothing. Armed before
 * the program is live it would page every morning about a program nobody is using.
 *
 * Pure apart from the injected reads and the dispatcher, so the node suite drives every
 * branch (scripts/test-program-lead-alerts.ts).
 */
import { DateTime } from "luxon";
import { formatLongDate } from "@/lib/date/parse";
import { lastClosedBusinessDay, type BusinessHoursException, type BusinessWindow } from "@/lib/booking/business-hours";
import { placeholderCallDay } from "@/lib/booking/program-lead-times";
import { logAlertSendFailure, logResolveFailure } from "@/lib/notify/send-failure";
import type { AlertResolve, ThrottledNotify } from "./alert-deps";

export const PROGRAM_LEAD_FALLBACKS_KEY = "program_lead_fallbacks";
export const PROGRAM_LEAD_REGISTRATIONS_KEY = "program_lead_registrations_zero";

/** Fallbacks to real times on one Eastern day at which the condition pages. See the header. */
export const PROGRAM_LEAD_FALLBACK_DAY_LIMIT = 5;

/**
 * Whether the zero registrations condition is judged at all. FALSE until phase 7 (#4393)
 * switches the program on and arms it in the same change. See the header.
 */
export const PROGRAM_LEAD_REGISTRATIONS_ALERT_ARMED = false;

/** The band of a day's fallback count, higher is worse: 5, 25 and 100. Zero below the line. */
export function fallbackBand(count: number): number {
  if (count >= 100) return 3;
  if (count >= 25) return 2;
  if (count >= PROGRAM_LEAD_FALLBACK_DAY_LIMIT) return 1;
  return 0;
}

// ------------------------------------------------------------------- copy

function dayWords(isoDate: string, zone: string): string {
  return formatLongDate(DateTime.fromISO(isoDate, { zone })) ?? isoDate;
}

export function formatProgramLeadFallbacksAlert(day: string, count: number): string {
  return (
    `${count} program ${count === 1 ? "lead was" : "leads were"} shown real times only today (${dayWords(day, "America/New_York")}, ` +
    `Eastern) because a read the extra times need failed, so they could not book a time nobody real is free ` +
    `for. Each is counted in program_lead_outcomes and logged by reason under program-lead-times. Check the ` +
    `logs for which read is failing; the Program leads admin page shows the day's count.`
  );
}

export function formatProgramLeadFallbacksRecovery(count: number): string {
  return (
    `Program leads are being shown the extra times again: ${count} shown real times only so far today, ` +
    `under the ${PROGRAM_LEAD_FALLBACK_DAY_LIMIT} that pages.`
  );
}

export function formatProgramLeadRegistrationsAlert(day: { isoDate: string; openMs: number }, zone: string): string {
  return (
    `No program lead has been registered since the last business day opened (${dayWords(day.isoDate, zone)}). ` +
    `Leads are registered before their booking link is texted, so either none were accepted or registering ` +
    `has stopped, and every program lead since is being shown real times only. Check that the system ` +
    `accepting program leads is still calling the register endpoint, and whether it is being refused.`
  );
}

export function formatProgramLeadRegistrationsRecovery(count: number): string {
  return `Program leads are being registered again: ${count} since the last business day opened.`;
}

export function formatProgramLeadRegistrationsSwitchedOff(): string {
  return "The program is switched off, so registrations are no longer watched. Nothing says registering was fixed.";
}

// ----------------------------------------------------------------- fallbacks

export type ProgramLeadFallbackResult =
  | { status: "unreadable"; error: string }
  | { status: "paged"; day: string; count: number }
  | { status: "healthy"; day: string; count: number };

export interface ProgramLeadFallbackDeps {
  /** Fallbacks counted on this Eastern day; 0 when it has no row. THROWS on a failed read. */
  readDayCount: (day: string) => Promise<number>;
  notify: ThrottledNotify<unknown>;
  resolve: AlertResolve<unknown>;
  cooldownMs: number;
  nowMs: number;
}

export async function runProgramLeadFallbackCheck(deps: ProgramLeadFallbackDeps): Promise<ProgramLeadFallbackResult> {
  const day = placeholderCallDay(deps.nowMs);
  let count: number;
  try {
    count = await deps.readDayCount(day);
  } catch (err) {
    return { status: "unreadable", error: err instanceof Error ? err.message : String(err) };
  }
  const key = PROGRAM_LEAD_FALLBACKS_KEY;
  if (count >= PROGRAM_LEAD_FALLBACK_DAY_LIMIT) {
    await deps
      .notify(key, deps.cooldownMs, formatProgramLeadFallbacksAlert(day, count), { subjects: [day], band: fallbackBand(count) })
      .catch(logAlertSendFailure(key));
    return { status: "paged", day, count };
  }
  await deps.resolve(key, formatProgramLeadFallbacksRecovery(count)).catch(logResolveFailure(key));
  return { status: "healthy", day, count };
}

// ------------------------------------------------------------- registrations

export type ProgramLeadRegistrationsResult =
  | { status: "disarmed" }
  /** A read failed. The monitor step throws it, so its failing streak pages a lasting one. */
  | { status: "unreadable"; why: string }
  /** No whole business day to judge: not a fault, nothing measured. */
  | { status: "unmeasured"; why: string }
  | { status: "switched-off" }
  | { status: "paged"; day: string }
  | { status: "healthy"; day: string; count: number };

export interface ProgramLeadRegistrationsDeps {
  /** `PROGRAM_LEAD_REGISTRATIONS_ALERT_ARMED`, injected so the suite can drive it armed. */
  armed: boolean;
  hours: { zone: string; rules: BusinessWindow[]; exceptions: BusinessHoursException[] };
  /** The program's switch, or null when it could not be read. */
  readSwitch: () => Promise<boolean | null>;
  /** Registrations at or after `sinceIso`. THROWS on a failed read. */
  countRegisteredSince: (sinceIso: string) => Promise<number>;
  notify: ThrottledNotify<unknown>;
  resolve: AlertResolve<unknown>;
  cooldownMs: number;
  nowMs: number;
}

export async function runProgramLeadRegistrationsCheck(deps: ProgramLeadRegistrationsDeps): Promise<ProgramLeadRegistrationsResult> {
  if (!deps.armed) return { status: "disarmed" };
  const key = PROGRAM_LEAD_REGISTRATIONS_KEY;
  const on = await deps.readSwitch();
  if (on === null) return { status: "unreadable", why: "the program's switch could not be read" };
  if (!on) {
    await deps.resolve(key, formatProgramLeadRegistrationsSwitchedOff()).catch(logResolveFailure(key));
    return { status: "switched-off" };
  }
  const day = lastClosedBusinessDay(deps.hours, deps.nowMs);
  if (!day) return { status: "unmeasured", why: "no whole business day in the last two weeks" };
  let count: number;
  try {
    count = await deps.countRegisteredSince(new Date(day.openMs).toISOString());
  } catch (err) {
    return { status: "unreadable", why: err instanceof Error ? err.message : String(err) };
  }
  if (count === 0) {
    await deps
      .notify(key, deps.cooldownMs, formatProgramLeadRegistrationsAlert(day, deps.hours.zone), { subjects: [day.isoDate] })
      .catch(logAlertSendFailure(key));
    return { status: "paged", day: day.isoDate };
  }
  await deps.resolve(key, formatProgramLeadRegistrationsRecovery(count)).catch(logResolveFailure(key));
  return { status: "healthy", day: day.isoDate, count };
}
