/**
 * A hire stranded outside the pool with no pending mark and no recorded hold
 * (#2481).
 *
 * WHAT HAPPENED. Until #2381 was fixed, the hourly roster write NULL filled
 * `bookable_pending_since` for every row that did not carry it in the same batch,
 * so a hire whose activation had been refused or deferred lost the mark that
 * retries it. The fix stopped new damage and repaired nothing: measured on
 * 2026-09-16, two Sales hires had signed in, had a calendar that synced, carried a
 * debt tier, and sat not bookable with no mark and no audit row. Nothing would ever
 * try them again, and they read exactly like somebody an admin held back on
 * purpose (L60).
 *
 * WHY THE WAITING ALERT CANNOT SEE THEM. `agents_awaiting_activation` (#2318)
 * reads the mark, which is null for precisely these people. So this check asks
 * for the SHAPE instead, and it is built from the predicates that already answer
 * each half rather than a third spelling of either (#2546, L41):
 *
 *  - WAITING is `agentsAwaitingActivation`, the same judge the waiting alert uses.
 *    Anybody it names is that alert's, not this one's.
 *  - ON SALES WITH NO RECORDED HOLD is `onSalesWithNoRecordedHold`, the roster
 *    sync's own count (#2621), which already excludes the bookable, the departed,
 *    the pending and the Redistribute marked. The Twilio Redistribute TAG counts as
 *    a recorded hold here too, because it is the documented way to say somebody
 *    should not take booked calls, and the sync's mark is only written for people
 *    Slate itself turned off.
 *
 * What it adds is what separates a damaged row from a quiet one: they have signed
 * in (`auth_user_id`), at least one of their calendars has synced cleanly, and no
 * PERSON has made a bookable decision about them (no `agent.bookable` audit row
 * with an actor). Measured on 2026-10-01 that shape held nobody: the two cases had
 * been repaired by hand, and the one Sales row held back carries an admin's audit
 * row. So it ships armed, because a standing page would have been wrong and an
 * empty one is not.
 *
 * COST. One read of a few non bookable Sales rows per monitor tick, and two more
 * only when there is a candidate, which on an ordinary tick there is not.
 */
import { agentsAwaitingActivation } from "@/lib/monitor/awaiting-activation";
import { onSalesWithNoRecordedHold } from "@/lib/salesforce/onboarding";
import { carriesRedistributeTag, isMarkedRedistribute } from "@/lib/twilio/roster-plan";
import type { Attributes } from "@/lib/db/types";
import type { AlertResolve, ThrottledNotify } from "./alert-deps";

/** alert_state row key for the page and its all clear. */
export const STRANDED_HIRES_KEY = "agents_stranded_outside_pool";

/** The columns this check needs off a `users` row. */
export interface StrandedHireRow {
  id: string;
  name: string | null;
  email: string | null;
  attributes: Attributes | null;
  bookable: boolean;
  deactivated_at: string | null;
  bookable_pending_since: string | null;
  auth_user_id: string | null;
}

export interface StrandedHire {
  id: string;
  name: string | null;
  email: string | null;
}

/**
 * Rows in the stranded shape before the two narrowing reads: signed in, on Sales,
 * not bookable, not departed, not waiting, and no hold on record.
 */
export function strandedHireCandidates(rows: StrandedHireRow[]): StrandedHireRow[] {
  const waiting = new Set(agentsAwaitingActivation(rows).map((f) => f.id));
  return rows.filter(
    (r) =>
      r.auth_user_id !== null &&
      onSalesWithNoRecordedHold({
        attributes: r.attributes,
        bookable: r.bookable,
        deactivated: r.deactivated_at !== null,
        pending: waiting.has(r.id),
        markedRedistribute: isMarkedRedistribute(r.attributes) || carriesRedistributeTag(r.attributes),
      }),
  );
}

/**
 * The candidates whose calendar has synced cleanly and about whom no person has
 * made a bookable decision. Those are the ones an activation would admit today,
 * and that nothing will ever attempt.
 */
export function strandedHires(
  candidates: StrandedHireRow[],
  syncedCalendarUserIds: Set<string>,
  decidedUserIds: Set<string>,
): StrandedHire[] {
  return candidates
    .filter((r) => syncedCalendarUserIds.has(r.id) && !decidedUserIds.has(r.id))
    .map((r) => ({ id: r.id, name: r.name, email: r.email }));
}

// --------------------------------------------------------------- the copy

const NAME_CAP = 8;

function who(a: StrandedHire): string {
  const name = a.name?.trim() || a.email || a.id;
  return a.email && a.email !== name ? `${name} (${a.email})` : name;
}

/**
 * The page. It names both repairs, because only a person can tell a stranded hire
 * from somebody meant to be held, and each repair is a control that changes the
 * state this check reads (L111): Make bookable runs the activation, and the Twilio
 * Redistribute tag records the hold.
 */
export function formatStrandedHiresAlert(agents: StrandedHire[]): string {
  const n = agents.length;
  const lines = agents.slice(0, NAME_CAP).map(who);
  const more = n > NAME_CAP ? `\n(and ${n - NAME_CAP} more)` : "";
  return (
    `${n} ${n === 1 ? "agent is" : "agents are"} on the Sales profile and signed in, with a calendar that ` +
    `syncs, and not bookable, with no activation pending and nobody on record holding them back. ` +
    `Nothing will ever try to add them to the booking pool, so no lead is offered their diary. ` +
    `Open each under admin > agents and press Make bookable, which runs the calendar check; if ` +
    `somebody is meant to be held out, tag them Redistribute in Twilio, which records the hold.\n` +
    lines.join("\n") +
    more
  );
}

/** The all clear, hung off a measured roster with nobody in the shape. */
export function formatStrandedHiresRecovery(): string {
  return (
    "Nobody on the Sales profile is sitting outside the booking pool without a pending " +
    "activation or a recorded hold. No action is needed."
  );
}

// ------------------------------------------------------------- the runner

export type StrandedHiresResult =
  /** Not measured, so nothing may be claimed in either direction. */
  | { status: "unreadable"; error: string }
  | { status: "stranded"; agents: StrandedHire[] }
  /** Measured: nobody in the shape. `measured` is how many rows were read. */
  | { status: "clear"; measured: number };

export interface StrandedHiresDeps {
  /** Non bookable, active, signed in, non test rows. THROWS on a read error. */
  loadCandidates: () => Promise<StrandedHireRow[]>;
  /** Of these users, those with a calendar that has synced cleanly. THROWS. */
  loadSyncedCalendarUserIds: (userIds: string[]) => Promise<Set<string>>;
  /** Of these users, those with an `agent.bookable` audit row a person wrote. THROWS. */
  loadDecidedUserIds: (userIds: string[]) => Promise<Set<string>>;
  notify: ThrottledNotify;
  /** REQUIRED, so a condition cannot be wired with no way to end it (#1151). */
  resolve: AlertResolve;
  cooldownMs: number;
}

/**
 * Read, judge, page or clear. A read that threw measured nothing, so it pages
 * nothing and clears nothing (#1134, #1152); a notify or resolve failure is
 * swallowed, because a flaky Slack must never fail the tick.
 */
export async function runStrandedHiresCheck(deps: StrandedHiresDeps): Promise<StrandedHiresResult> {
  let agents: StrandedHire[];
  let measured: number;
  try {
    const rows = await deps.loadCandidates();
    measured = rows.length;
    const candidates = strandedHireCandidates(rows);
    if (candidates.length === 0) {
      agents = [];
    } else {
      const ids = candidates.map((r) => r.id);
      const synced = await deps.loadSyncedCalendarUserIds(ids);
      const decided = await deps.loadDecidedUserIds(ids);
      agents = strandedHires(candidates, synced, decided);
    }
  } catch (err) {
    return { status: "unreadable", error: err instanceof Error ? err.message : String(err) };
  }

  if (agents.length) {
    await deps.notify(STRANDED_HIRES_KEY, deps.cooldownMs, formatStrandedHiresAlert(agents)).catch(() => {});
    return { status: "stranded", agents };
  }
  await deps.resolve(STRANDED_HIRES_KEY, formatStrandedHiresRecovery()).catch(() => {});
  return { status: "clear", measured };
}
