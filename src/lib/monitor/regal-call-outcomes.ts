/**
 * Are call outcomes being stored for the calls Regal posts? (#2944)
 *
 * The show rate in the Slate vs cal.com split is computed from
 * `regal_call_outcomes`, one row per completed call. That table fills in silence:
 * a field Regal stopped sending (every body refused by name at the edge), an
 * insert that fails (a migration that never reached production), or a deploy that
 * broke the write all leave the detector's own counter, `regal_call_events`,
 * ticking over normally while the outcome rows stop. A split read from a table
 * that quietly stopped filling would report a show rate about whichever calls
 * happened to land, which is worse than reporting nothing.
 *
 * So this compares OUTCOME ROWS WRITTEN against COMPLETED CALLS RECEIVED over the
 * last two hours. The received count comes from the detector's per reason counts
 * (the same RPC the feed checks read), which is a DIFFERENT writer from the one
 * being judged, so a broken outcome write cannot also silence its own measurement
 * (L345). Both are keyed on Regal's event id, so a redelivery counts once on each
 * side.
 *
 * A CONDITION on its own key. It pages when the ratio sits under 80% on two
 * consecutive checks (one short check is an ordinary blip, L36), and its all clear
 * hangs off a MEASURED healthy ratio, never off "we did not page this run"
 * (#1134, #1152). A window with no completed call at all is "no calls": nothing was
 * measured, so it is neither healthy nor a page, and the quiet feed alarm
 * (`regal_calls_quiet`) is the one that asks whether calls should be arriving. A
 * window with only a handful of calls is too few to judge a rate on (L139, L716):
 * one refused body among three would read as 67%.
 *
 * Pure apart from the injected reads, streak and dispatcher
 * (scripts/test-regal-call-outcomes-monitor.ts).
 */
import type { RegalCallReason } from "@/lib/regal/inbound-call";
import type { RegalReasonCounts } from "./regal-call-feed";
import type { AlertResolve, ThrottledNotify } from "./alert-deps";

export const REGAL_CALL_OUTCOMES_KEY = "regal_call_outcomes_short";

/**
 * The consecutive check counter, a SEPARATE key from the alert, for the reason
 * `EMPTY_REASON_STREAK_KEY` gives: one throttles the counting and the other the
 * sending, and sharing them would make clearing one clear the other.
 */
export const REGAL_CALL_OUTCOMES_STREAK_KEY = "streak:regal_call_outcomes_short";

/** Comfortably longer than the monitor lane's five minute interval, so two
 *  genuinely consecutive checks land in the same window. */
export const REGAL_CALL_OUTCOMES_STREAK_WINDOW_S = 900;

/** The window both counts are read over. */
export const REGAL_OUTCOME_WINDOW_MS = 2 * 60 * 60_000;

/**
 * The window when the table has never stored a row. An empty table while calls arrive
 * is the total failure this check exists for, so it is still judged, but only over the
 * last 15 minutes: long enough to see a busy feed, short enough that calls received
 * before the deploy that created the table age out within three checks.
 */
export const REGAL_OUTCOME_EMPTY_WINDOW_MS = 15 * 60_000;

/** At or above this share of completed calls with an outcome row is healthy. */
export const REGAL_OUTCOME_MIN_RATIO = 0.8;

/**
 * Fewer completed calls than this in the window is too few to judge a rate on.
 * A working day brings several hundred an hour (about 6,000 a weekday), so this
 * only ever bites at the edges of the day, where one refused call among a few
 * would otherwise page about nothing.
 */
export const REGAL_OUTCOME_MIN_CALLS = 20;

/**
 * The detector reasons that are a completed call with a HUMAN advisor on it (#2950).
 * Only those can decide a show (a human call of at least 300 s), so only those may
 * count as an outcome that should have been stored. Left out on purpose:
 * - `agent_email_null`, an unanswered dialer attempt. It arrives with no talk time
 *   and is refused rather than stored as zero (measured 2026-10-01: every one of 9
 *   in the first five minutes was refused `talk_time_unreadable`). Counting it read a
 *   working feed as 76% stored, under the floor, on the day it shipped.
 * - `ai_agent`, which is not the advisor's call.
 * - every unreadable and non completed reason, which the outcome side refuses too.
 * Listed rather than derived: a new detector reason is left out until somebody
 * decides it carries a human advisor, which errs toward a quieter check, never a
 * false page.
 */
export const HUMAN_CALL_REASONS: readonly RegalCallReason[] = ["candidate", "foreign_domain", "no_slate_user"];

export function humanCallsFrom(counts: RegalReasonCounts): number {
  return HUMAN_CALL_REASONS.reduce((sum, r) => sum + (counts[r] ?? 0), 0);
}

const n = (x: number): string => x.toLocaleString("en-US");

/** Floored, so 79.9% never reads as the 80% floor, and capped at 100. */
function percent(written: number, received: number): string {
  return `${Math.min(100, Math.floor((written / received) * 100))}%`;
}

/** The window a check read, said the way a person would: "two hours", "40 minutes". */
function windowPhrase(minutes: number): string {
  if (minutes === 120) return "two hours";
  if (minutes % 60 === 0) return `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`;
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

export function formatRegalCallOutcomesAlert(m: { received: number; written: number; windowMinutes: number }): string {
  const calls = `${n(m.received)} completed advisor ${m.received === 1 ? "call" : "calls"}`;
  const stored = m.written === 0 ? `None of the ${calls}` : `Only ${n(m.written)} of the ${calls}`;
  return (
    `${stored} Regal posted in the last ${windowPhrase(m.windowMinutes)} ${m.received === 1 && m.written === 0 ? "was" : "were"} ` +
    `stored with their lead and talk time (${percent(m.written, m.received)}), under the 80% floor on two ` +
    `checks running. The show rate in the ` +
    `Slate vs cal.com split is computed from these rows, so every missing one is a call the comparison ` +
    `cannot see. The Worker logs under tag=regal-call-outcomes say why: a "refused" line names the field ` +
    `Regal stopped sending, and an error line means the write to regal_call_outcomes failed.`
  );
}

export function formatRegalCallOutcomesRecovery(m: { received: number; written: number; windowMinutes: number }): string {
  return (
    `Call outcomes are being stored again: ${n(m.written)} of the ${n(m.received)} completed advisor calls Regal ` +
    `posted in the last ${windowPhrase(m.windowMinutes)} (${percent(m.written, m.received)}).`
  );
}

export type RegalCallOutcomesResult =
  | { status: "unmeasured"; why: string }
  | { status: "no-calls" }
  | { status: "too-few"; received: number; written: number }
  | { status: "short"; received: number; written: number; paged: boolean }
  | { status: "healthy"; received: number; written: number };

export interface RegalCallOutcomesDeps {
  /** The detector's per reason counts received at or after `sinceIso`. THROWS on a read error. */
  loadReasonCounts: (sinceIso: string) => Promise<RegalReasonCounts>;
  /** HUMAN outcome rows (not an AI call, an advisor on it) received at or after
   *  `sinceIso`, the same population `humanCallsFrom` counts. THROWS on a read error. */
  countOutcomes: (sinceIso: string) => Promise<number>;
  /** When the table stored its first row, or null for an empty table. THROWS on a read error. */
  firstOutcomeAtMs: () => Promise<number | null>;
  /** Records one short check; true once the short state has persisted for two. */
  streak: () => Promise<boolean>;
  clearStreak: () => Promise<void>;
  armed: boolean;
  notify: ThrottledNotify;
  /** REQUIRED, so `tsc` enumerates every construction site rather than letting a
   *  caller wire a condition with no way to end it (#1151, #1400). */
  resolve: AlertResolve<unknown>;
  cooldownMs: number;
  nowMs: number;
}

export async function runRegalCallOutcomesCheck(deps: RegalCallOutcomesDeps): Promise<RegalCallOutcomesResult> {
  // Both counts start no earlier than the table's first stored row. Without that, the
  // checks right after the deploy that created the table compare a few minutes of
  // stored rows against two hours of received calls and page on a healthy feed.
  let firstMs: number | null;
  try {
    firstMs = await deps.firstOutcomeAtMs();
  } catch (err) {
    return { status: "unmeasured", why: err instanceof Error ? err.message : String(err) };
  }
  const startMs =
    firstMs === null
      ? deps.nowMs - REGAL_OUTCOME_EMPTY_WINDOW_MS
      : Math.max(deps.nowMs - REGAL_OUTCOME_WINDOW_MS, firstMs);
  const sinceIso = new Date(startMs).toISOString();
  const windowMinutes = Math.max(1, Math.round((deps.nowMs - startMs) / 60_000));
  let counts: RegalReasonCounts;
  let written: number;
  try {
    [counts, written] = await Promise.all([deps.loadReasonCounts(sinceIso), deps.countOutcomes(sinceIso)]);
  } catch (err) {
    return { status: "unmeasured", why: err instanceof Error ? err.message : String(err) };
  }
  const received = humanCallsFrom(counts);
  // Nothing measured: neither healthy nor a page, and the streak and the alert are
  // left exactly as they were.
  if (received === 0) return { status: "no-calls" };
  if (received < REGAL_OUTCOME_MIN_CALLS) return { status: "too-few", received, written };

  if (written / received < REGAL_OUTCOME_MIN_RATIO) {
    // Disarmed measures and logs, and records nothing that could page later.
    if (!deps.armed) return { status: "short", received, written, paged: false };
    const persistent = await deps.streak();
    if (persistent) {
      const text = formatRegalCallOutcomesAlert({ received, written, windowMinutes });
      await deps.notify(REGAL_CALL_OUTCOMES_KEY, deps.cooldownMs, text).catch(() => {});
    }
    return { status: "short", received, written, paged: persistent };
  }

  // A MEASURED healthy ratio: the only thing that ends the condition.
  if (deps.armed) {
    await deps.clearStreak();
    const text = formatRegalCallOutcomesRecovery({ received, written, windowMinutes });
    await deps.resolve(REGAL_CALL_OUTCOMES_KEY, text).catch(() => {});
  }
  return { status: "healthy", received, written };
}
