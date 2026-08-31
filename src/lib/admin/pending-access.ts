import { atLeast } from "../auth/roles.ts";
import { isActive } from "../active-user.ts";
import type { Role, User } from "../db/types.ts";

/**
 * Elevated access that has never been claimed by a login (#160).
 *
 * `provisionUser` links a Google sign in to a Slate row BY EMAIL. So a row seeded
 * against an address that is not the person's real login is never matched: they
 * sign in, get a brand new `agent` row, and the elevated row they were meant to
 * have sits untouched. Nothing failed, nothing was logged, and the only visible
 * symptom is a person saying they cannot see the admin pages.
 *
 * Slate cannot ask Google whether an address exists. Domain wide delegation is
 * granted the calendar and gmail.send scopes only, and reading the Workspace
 * directory needs `admin.directory.user.readonly`, which a Workspace admin has to
 * add to the delegation in the Google admin console. So the address itself cannot
 * be confirmed here, and the honest alternative is to make the WAIT observable:
 * every unclaimed privileged account, how long it has waited, and, where one
 * exists, the near identical address that DID sign in.
 *
 * That last part is the detection rather than the label. A seeded row waiting four
 * days next to a signed in account one letter away is the typo, stated as such,
 * with the address to grant instead.
 */

/** Past this, a wait stops reading as "they have not got round to it yet". */
export const PENDING_STALE_DAYS = 7;

export interface PendingAccessRow {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  /** Whole days between the row being created and now. */
  waitedDays: number;
  /** Waited long enough that the address is worth checking. */
  stale: boolean;
  /**
   * A signed in account whose address is nearly identical. A SUGGESTION built by
   * comparing text, never a recorded fact, so the copy that renders it has to
   * stay tentative.
   */
  lookalike: { id: string; email: string } | null;
}

/**
 * The part of an address two spellings of one person share: the local part, with
 * case, dots and a plus tag removed, which is exactly what Google itself ignores.
 */
export function emailLocalKey(email: string): string {
  const local = email.trim().toLowerCase().split("@")[0] ?? "";
  return local.split("+")[0].replace(/\./g, "");
}

/** Levenshtein distance, bounded by `max` so a long pair stops early. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      row.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

/**
 * How different two addresses may be and still be one person mistyped.
 *
 * Deliberately asymmetric about which way to be wrong. A missed typo costs one
 * more day of the wait already shown on the row, and the wait itself keeps
 * growing until somebody looks. A false one names a REAL colleague as somebody
 * else's mistyped address, which is both wrong and rude, and it teaches the reader
 * to stop trusting the panel. So short local parts get no suggestion at all: at
 * three or four characters plenty of genuinely different people are one edit apart
 * (sam and pam), and there is no budget that separates them.
 */
function lookalikeBudget(key: string): number {
  if (key.length < 5) return 0;
  return key.length >= 8 ? 2 : 1;
}

/**
 * Every unclaimed privileged account, longest wait first.
 *
 * Returns **null** when the roster could not be read. An unreadable roster and a
 * roster with nobody waiting are different answers, and rendering the first as the
 * second is the reassuring direction to be wrong in (L10, #1165): the panel would
 * report all clear on a query that never ran.
 */
export function pendingPrivilegedAccess(
  users: User[] | null,
  nowMs: number,
): PendingAccessRow[] | null {
  if (users === null) return null;

  // Only an account somebody has actually signed in to can be the address the
  // person really uses. An unclaimed neighbour is another guess, not evidence.
  const claimed = users
    .filter((u) => u.auth_user_id !== null && isActive(u) && !u.is_test)
    .map((u) => ({ id: u.id, email: u.email, key: emailLocalKey(u.email) }));

  const waiting = users.filter(
    (u) =>
      u.auth_user_id === null &&
      atLeast(u.role, "manager") &&
      isActive(u) &&
      !u.is_test,
  );

  const rows = waiting.map((u) => {
    const key = emailLocalKey(u.email);
    const budget = lookalikeBudget(key);
    let lookalike: { id: string; email: string } | null = null;
    if (budget > 0) {
      let bestDistance = budget + 1;
      for (const c of claimed) {
        if (c.email === u.email) continue;
        const d = editDistance(key, c.key, budget);
        if (d <= budget && d < bestDistance) {
          bestDistance = d;
          lookalike = { id: c.id, email: c.email };
        }
      }
    }
    const createdMs = Date.parse(u.created_at);
    // parse-ok: created_at is a NOT NULL timestamptz the database writes. An
    // unreadable one would still report a wait, so it is mapped to 0 days rather
    // than to NaN, and a 0 day wait understates rather than inventing an alarm.
    const waitedDays = Number.isFinite(createdMs)
      ? Math.max(0, Math.floor((nowMs - createdMs) / 86_400_000))
      : 0;
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      waitedDays,
      stale: waitedDays >= PENDING_STALE_DAYS,
      lookalike,
    };
  });

  return rows.sort((a, b) => b.waitedDays - a.waitedDays || a.email.localeCompare(b.email));
}

/** How long a pending account has waited, as a sentence fragment. */
export function pendingWaitText(waitedDays: number): string {
  if (waitedDays <= 0) return "added today";
  if (waitedDays === 1) return "waiting 1 day";
  return `waiting ${waitedDays} days`;
}
