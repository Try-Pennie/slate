import type { User } from "@/lib/db/types";

/**
 * May this users row act on this request? (#2378)
 *
 * The one judge behind every place Slate turns an identity into an ACTOR: the
 * signed in session (`realCurrentUser`), the Slack interactivity actor
 * (`resolveActor`) and the sign in itself (`provision.ts`). Before this, only the
 * impersonation TARGET was filtered on `deactivated_at`, so the rule was known,
 * written down in the runbook, applied to the person being acted as, and applied
 * to nobody who was doing the acting. Offboarding a manager took nothing away
 * from them: their laptop kept a Supabase session cookie that middleware refreshed
 * on every request, and the roster, every lead's contact details, cancel,
 * reassign, reschedule and time off approval all kept working until the refresh
 * token died, which by default has no absolute expiry (L137).
 *
 * THREE OUTCOMES, NOT TWO, and the separation is the point (L11). "There is no
 * such row", "they have left" and "I could not read the row" send three different
 * people to do three different things, and a single `null` answers for all three
 * at the call site that has to log it.
 *
 * IT JUDGES IN CODE RATHER THAN FILTERING IN SQL, deliberately. A
 * `.is("deactivated_at", null)` on each read would be one character shorter and
 * would collapse `deactivated` into `no-row`, so the one event worth a log line,
 * somebody's live session being refused the moment they were offboarded, would be
 * indistinguishable from a request carrying a stale cookie for a row that never
 * existed. Judging here also keeps the rule in ONE place rather than in a filter
 * each new read has to remember (L41).
 *
 * FAIL CLOSED (L42). An unreadable row is "I cannot tell whether they still work
 * here", and for an authorization gate the safe answer to that is to refuse. The
 * cost is that a database blip signs everybody out for the length of the blip, and
 * that is the correct side to be wrong on: the other side leaves a departed
 * manager holding admin for as long as the read is failing, which is exactly when
 * nobody is watching.
 */
export type SessionGate =
  | { admit: true; user: User }
  | { admit: false; reason: "no-row" | "deactivated" | "unreadable" };

/** A row shape this judge can read: anything carrying the departure stamp. */
export interface DeactivatableRow {
  deactivated_at?: string | null;
}

/**
 * Has this person left? True only for a row carrying a stamp. A row with the
 * column absent (a partial select, a fixture) reads as still here, which matches
 * every other reader of this column in the codebase.
 */
export function isDeactivated(row: DeactivatableRow | null | undefined): boolean {
  return row != null && row.deactivated_at != null;
}

/**
 * The gate itself. `error` is consulted FIRST and on its own: a driver that hands
 * back an error alongside a stale row must not have the row answer for it.
 */
export function gateSessionRow(
  row: User | null,
  error: { message: string } | null | undefined,
): SessionGate {
  if (error) return { admit: false, reason: "unreadable" };
  if (!row) return { admit: false, reason: "no-row" };
  if (isDeactivated(row)) return { admit: false, reason: "deactivated" };
  return { admit: true, user: row };
}

/**
 * A sign in refused because the account has been deactivated.
 *
 * Its own type rather than a bare `Error` because the sign in callback has to
 * tell it apart from the #1648 refusals beside it: those are retryable ("we could
 * not finish setting up your account"), and this one is not, so advising a retry
 * would be advice that can never work (L111). Thrown by provisioning and caught
 * in `src/app/api/auth/callback/route.ts`.
 */
export class DeactivatedAccountError extends Error {
  constructor(message = "this Slate account has been deactivated") {
    super(message);
    this.name = "DeactivatedAccountError";
  }
}
