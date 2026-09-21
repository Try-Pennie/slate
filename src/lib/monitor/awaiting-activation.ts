/**
 * Somebody has been waiting to become bookable (#2318).
 *
 * `users.bookable_pending_since` records that something PLANNED to put an agent
 * in the pool and has not managed it yet. It is written by the Salesforce sync
 * when a profile upgrade makes somebody eligible (#2071) and by the admin toggle
 * before the gate runs (#2302), it survives a refusal on purpose, and only an
 * explicit bookable write settles it. So the mark is the intent, and the length
 * of time it has been carried is how long the intent has gone unmet.
 *
 * WHY NOTHING NOTICED. A refused ATTEMPT does alert, per agent, on a 30 minute
 * cooldown. An activation the hourly roster run never attempted does not: the run
 * spends a shared allowance (`MAX_ACTIVATIONS_PER_RUN`) and defers the rest, which
 * produces a `bookableDeferredToNextRun` line in a sync summary nobody reads
 * unless they pressed the button themselves. `pnpm verify:parallel-run-readiness`
 * can see it and has to be run by hand. From outside, a hire the roster counts as
 * working and Slate is not offering is indistinguishable from a hire who is fine.
 *
 * WHO COUNTS is decided by `isRoutable`, the shipped definition of "Slate will
 * route to them" (`src/lib/routing/staffing-depth.ts`), rather than a second
 * spelling of it written here (L41). A row that is already routable and still
 * carries the mark is a stale mark, not a wait; a deactivated row is somebody who
 * left, and their Google account is routinely unlicensed on the way out, so naming
 * them would send a reader to do a provisioning repair on a departed employee
 * (the same skip `verify:ooo-protection` makes for the same reason).
 *
 * Pure apart from two dependency free helpers, so the node suite drives it
 * directly (scripts/test-awaiting-activation.ts).
 */
import { parseStampMs } from "@/lib/date/stamp";
import { isRoutable } from "@/lib/routing/staffing-depth";
import type { AlertResolve, ThrottledNotify } from "./alert-deps";

/** alert_state row key for the page and its all clear. */
export const AWAITING_ACTIVATION_KEY = "agents_awaiting_activation";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How often the thing that would clear this state runs.
 *
 * The hourly roster lane (`0 * * * *`) is the only automatic retry: it re-plans
 * every flip it has a pending mark for, spends its allowance on them and defers
 * the rest to the next hour. Nothing else attempts an activation on its own.
 */
export const ROSTER_RETRY_INTERVAL_MS = HOUR_MS;

/**
 * How long somebody may sit outside the pool before the alert names them.
 *
 * DERIVED from the retry that would clear it, rather than chosen. The window has
 * to be a whole number of hourly roster runs, because a wait measured in anything
 * else is a wait nothing acts on. Four of them is the smallest number that covers
 * the two ordinary reasons a mark survives a run without anyone needing to know:
 * the run deferred the activation because a licence upgrade filled its allowance
 * (`MAX_ACTIVATIONS_PER_RUN` is 10, so a wave of 30 takes three runs to drain),
 * and a Google blip that the gate's own retry did not ride out. Past four, every
 * remaining cause needs a person: an account that has never been given Calendar
 * (#1396, the expected direction of travel on this roster), a revoked delegation,
 * a calendar Slate can reach and cannot read.
 *
 * Four hours also keeps it inside a working morning, which is the other half of
 * the requirement: a hire who arrives at nine and is still invisible at one has
 * lost half a day of leads, and a message that waits until tomorrow is a message
 * about somebody who has already been missed.
 *
 * The copy renders this number rather than spelling it out, so a change here
 * cannot leave the message claiming a window nobody enforces.
 */
export const AWAITING_ACTIVATION_GRACE_MS = 4 * ROSTER_RETRY_INTERVAL_MS;

/** The columns this check needs off a `users` row. */
export interface AwaitingActivationRow {
  id: string;
  name: string | null;
  email: string | null;
  bookable: boolean;
  deactivated_at: string | null;
  bookable_pending_since: string | null;
}

/** Somebody waiting, and when their wait started. null = the stamp is unreadable. */
export interface AwaitingActivationFinding {
  id: string;
  name: string | null;
  email: string | null;
  waitingSinceMs: number | null;
}

/**
 * Everybody carrying an unmet intent to be bookable.
 *
 * No patience here, deliberately: this answers "who is outside the pool that
 * something meant to put in it", which is what `verify:parallel-run-readiness`
 * asks before pilot leads are sent, and it wants everybody however new. The
 * waiting is applied by `agentsPastActivationGrace` for the alert only.
 */
export function agentsAwaitingActivation(rows: AwaitingActivationRow[]): AwaitingActivationFinding[] {
  const out: AwaitingActivationFinding[] = [];
  for (const r of rows) {
    if (r.bookable_pending_since === null || r.bookable_pending_since === "") continue;
    if (r.deactivated_at !== null) continue;
    if (isRoutable(r)) continue;
    out.push({
      id: r.id,
      name: r.name,
      email: r.email,
      // An unreadable stamp is a finding of its own rather than a reason to stay
      // quiet: it is the row nobody can explain, and a NaN comparison would land
      // on the silent branch and disable the alert for exactly those.
      waitingSinceMs: parseStampMs(r.bookable_pending_since),
    });
  }
  return out;
}

/**
 * Those the alert speaks about: waiting longer than the grace, or waiting for a
 * length nothing can measure. The clock is passed in, never read here, so the
 * boundary is drivable and the alert preview renders the same text every run.
 */
export function agentsPastActivationGrace(
  findings: AwaitingActivationFinding[],
  nowMs: number,
): AwaitingActivationFinding[] {
  return findings.filter(
    (f) => f.waitingSinceMs === null || nowMs - f.waitingSinceMs > AWAITING_ACTIVATION_GRACE_MS,
  );
}

// --------------------------------------------------------------- the copy

const NAME_CAP = 8;
const GRACE_HOURS = Math.round(AWAITING_ACTIVATION_GRACE_MS / HOUR_MS);

/** How long a wait has run, in the largest unit that still reads as a duration. */
function howLong(waitingSinceMs: number | null, nowMs: number): string {
  if (waitingSinceMs === null) return "for an unreadable length of time";
  const ms = Math.max(0, nowMs - waitingSinceMs);
  if (ms >= DAY_MS) {
    const days = Math.floor(ms / DAY_MS);
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  const hours = Math.floor(ms / HOUR_MS);
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

function who(a: AwaitingActivationFinding, nowMs: number): string {
  const name = a.name?.trim() || a.email || a.id;
  const label = a.email && a.email !== name ? `${name} (${a.email})` : name;
  return `${label}, ${howLong(a.waitingSinceMs, nowMs)}`;
}

/**
 * The page: what it costs, who, how long, and the two places the fix lives.
 *
 * It names both remedies because which one is right is not ours to assume. The
 * commonest cause on this roster is an account that has never been given Calendar
 * at all, which only a Workspace admin can fix; the next commonest is a calendar
 * that answers and cannot be read, which is the sync lane's business.
 */
export function formatAwaitingActivationAlert(
  agents: AwaitingActivationFinding[],
  nowMs: number,
): string {
  const n = agents.length;
  // Longest first, so the one nobody has got to in a week leads. An unreadable
  // stamp sorts to the front for the same reason: it is the least understood.
  const longestFirst = [...agents].sort((a, b) => (a.waitingSinceMs ?? 0) - (b.waitingSinceMs ?? 0));
  const lines = longestFirst.slice(0, NAME_CAP).map((a) => who(a, nowMs));
  const more = n > NAME_CAP ? `\n(and ${n - NAME_CAP} more)` : "";
  return (
    `${n} ${n === 1 ? "agent has" : "agents have"} been waiting more than ${GRACE_HOURS} hours to be ` +
    `made bookable, so the roster counts them as working and no lead is ever offered their diary. ` +
    // What was MEASURED is that nothing has settled the mark, and the two ways that
    // happens send a reader to different places, so the message names both rather
    // than asserting the likelier one. The refused case alerts per agent and the
    // deferred case is silent, which is why this exists at all (L11, L440).
    `Nothing has managed to put them in it: each hourly roster run has either refused the ` +
    `activation or not reached it. Open them under admin > agents for the last refusal, if there ` +
    `was one: an account that has never been given Calendar needs a Google Workspace admin, and ` +
    `a calendar that answers and cannot be read belongs to the calendar sync lane.\n` +
    lines.join("\n") +
    more
  );
}

/**
 * The all clear, hung off a measured sweep that found nobody past the window. It
 * names the window, because "nobody has waited four hours" and "nobody is waiting"
 * are different facts and only the first one was measured (L440).
 */
export function formatAwaitingActivationRecovery(): string {
  return (
    `Nobody has been waiting more than ${GRACE_HOURS} hours to be made bookable. ` +
    `An activation planned inside that window is not counted yet, so this does not mean ` +
    `the queue is empty.`
  );
}

// ------------------------------------------------------------- the runner

export type AwaitingActivationResult =
  /** Not measured, so nothing may be claimed in either direction. */
  | { status: "unreadable"; error: string }
  /** Measured: people are past the window. `paged` is false while disarmed, so an
   *  observed run is never mistaken for a sent one. */
  | { status: "waiting"; agents: AwaitingActivationFinding[]; paged: boolean }
  /** Measured: nobody is past the window. `measured` is how many rows were read. */
  | { status: "clear"; measured: number };

export interface AwaitingActivationDeps {
  /** Reads the roster. It THROWS on a read error; it never answers with an empty list. */
  load: () => Promise<AwaitingActivationRow[]>;
  /** False until somebody has watched a few ordinary days: measure and log, send nothing. */
  armed: boolean;
  notify: ThrottledNotify;
  /** REQUIRED, so `tsc` enumerates every construction site rather than letting a
   *  caller wire a condition with no way to end it (#1151, #1400). */
  resolve: AlertResolve;
  cooldownMs: number;
  /** Passed in so the grace boundary is drivable and the copy is deterministic. */
  nowMs: number;
}

/**
 * The monitor lane step: read, judge, page or clear.
 *
 * Three outcomes and only one of them clears. A read that threw measured nothing
 * and must say so: an all clear posted from a query that never ran is how "the
 * backlog has cleared, no action is needed" once went out over a dead read
 * (#1134, #1152), and an empty roster read is exactly the shape that produces it
 * here, since "no rows carry the mark" is what a healthy morning looks like too.
 *
 * A disarmed tick clears nothing either. Silence chosen by a switch is not a
 * measurement of health.
 *
 * A notify or resolve failure is swallowed, because a flaky Slack must never fail
 * the tick or take out the checks after it.
 */
export async function runAwaitingActivationCheck(
  deps: AwaitingActivationDeps,
): Promise<AwaitingActivationResult> {
  let rows: AwaitingActivationRow[];
  try {
    rows = await deps.load();
  } catch (err) {
    return { status: "unreadable", error: err instanceof Error ? err.message : String(err) };
  }

  const agents = agentsPastActivationGrace(agentsAwaitingActivation(rows), deps.nowMs);
  if (agents.length) {
    if (deps.armed) {
      await deps
        .notify(AWAITING_ACTIVATION_KEY, deps.cooldownMs, formatAwaitingActivationAlert(agents, deps.nowMs))
        .catch(() => {});
    }
    return { status: "waiting", agents, paged: deps.armed };
  }

  if (deps.armed) {
    await deps.resolve(AWAITING_ACTIVATION_KEY, formatAwaitingActivationRecovery()).catch(() => {});
  }
  return { status: "clear", measured: rows.length };
}
