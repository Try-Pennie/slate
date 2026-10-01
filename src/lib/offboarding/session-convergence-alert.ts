/**
 * The page and the all clear for the session access convergence (#2459), kept
 * apart from `session-convergence.ts` so the alert preview can import the copy
 * without reaching a module that reads the clock or the database.
 */
import { log } from "@/lib/log";
import type { AlertResolve, ThrottledNotify } from "@/lib/monitor/alert-deps";

/** What one convergence run did (see `session-convergence.ts`). Declared here so
 *  the copy below needs nothing from the module that does the work. */
export interface SessionConvergenceResult {
  departed: number;
  alreadyRevoked: number;
  /** Banned this run and still departed. */
  revoked: number;
  /** Bans GoTrue refused. Retried by the next run. */
  revokeFailed: number;
  /** Active people given their access back, a mid run reactivation included. */
  restored: number;
  /** Restores GoTrue refused: somebody active is locked out until the next run. */
  restoreFailed: number;
  foreignBans: number;
  deferred: number;
  unlisted: number;
  listingComplete: boolean;
}

/** alert_state key for the page and its all clear. */
export const SESSION_CONVERGENCE_ALERT_KEY = "departed_sessions_unconverged";

/** What one roster run's convergence came to: a result, or why it could not read. */
export type SessionConvergenceOutcome =
  | { ok: true; result: SessionConvergenceResult }
  | { ok: false; reason: string };

/**
 * Why this run is unhealthy, or null when it is not. A backlog the cap left for
 * the next run is EXPECTED (the first run after deploy has one) and is never a
 * reason; nor is a foreign ban or a departed row whose auth user is gone.
 */
export function sessionConvergenceUnhealthy(outcome: SessionConvergenceOutcome): string | null {
  if (!outcome.ok) return "unreadable";
  const r = outcome.result;
  if (r.restoreFailed > 0) return "restore-failed";
  if (r.revokeFailed > 0) return "revoke-failed";
  if (!r.listingComplete) return "listing-partial";
  return null;
}

function people(n: number): string {
  return `${n} ${n === 1 ? "person" : "people"}`;
}

/**
 * The page. Worst first: an active person locked out costs somebody their work
 * today, while a departed person whose ban did not land is still refused on every
 * request by the access gate.
 */
export function formatSessionConvergenceAlert(outcome: SessionConvergenceOutcome): string {
  const lead = "Sign in access is not following the roster on two roster runs in a row. ";
  if (!outcome.ok) {
    return (
      lead +
      `The check could not run: ${outcome.reason}. Until it can, nobody who leaves is banned from ` +
      `renewing a session, and nobody wrongly banned is let back in. Departed people are still refused ` +
      `on every request.`
    );
  }
  const r = outcome.result;
  const parts: string[] = [];
  if (r.restoreFailed > 0) {
    parts.push(
      `${people(r.restoreFailed)} active in Slate ${r.restoreFailed === 1 ? "is" : "are"} still locked out ` +
        `by a departure ban that could not be lifted, so they cannot sign in.`,
    );
  }
  if (r.revokeFailed > 0) {
    parts.push(
      `${people(r.revokeFailed)} who left could not be banned, so they keep a session ` +
        `token they can renew; they are still refused on every request.`,
    );
  }
  if (!r.listingComplete) {
    parts.push("The list of sign in accounts came back partial, so some accounts could not be checked at all.");
  }
  return (
    lead +
    parts.join(" ") +
    ` The Worker logs under tag=offboarding name each person and the error. Each run retries on its own.`
  );
}

/** The all clear, hung off a measured healthy run. */
export function formatSessionConvergenceRecovery(): string {
  return (
    "Sign in access is following the roster again: every departed person the last roster run could " +
    "reach is banned, and nobody active is locked out. No action is needed."
  );
}

/**
 * The two consecutive unhealthy runs the page waits for, like the Twilio read
 * streak beside it: one miss is a blip the next hour usually fixes, the second is
 * the retry failing too. A three hour window spans two hourly runs.
 */
export const SESSION_CONVERGENCE_STREAK_WINDOW_S = 3 * 60 * 60;
export const SESSION_CONVERGENCE_STREAK_ALERT_AT = 2;

export interface SessionConvergenceReportDeps {
  /** Count one unhealthy run; true once the streak reaches the threshold. */
  recordStreak: () => Promise<boolean>;
  clearStreak: () => Promise<void>;
  notify: ThrottledNotify;
  resolve: AlertResolve;
  /** Read only when a page is about to go, so a quiet run costs nothing. */
  cooldownMs: () => Promise<number>;
}

/**
 * Page on the second unhealthy run in a row; clear only off a MEASURED healthy run
 * (#1134, #1152). Never throws: the roster has synced, and an alerting problem
 * must not turn a good run into a failed one.
 */
export async function reportSessionConvergence(
  outcome: SessionConvergenceOutcome,
  deps: SessionConvergenceReportDeps,
): Promise<void> {
  try {
    const unhealthy = sessionConvergenceUnhealthy(outcome);
    if (unhealthy !== null) {
      if (await deps.recordStreak()) {
        await deps.notify(SESSION_CONVERGENCE_ALERT_KEY, await deps.cooldownMs(), formatSessionConvergenceAlert(outcome));
      }
      return;
    }
    await deps.clearStreak();
    await deps.resolve(SESSION_CONVERGENCE_ALERT_KEY, formatSessionConvergenceRecovery());
  } catch (err) {
    log.error("agents", { msg: "session convergence alert could not be sent or cleared" }, err);
  }
}
