import { supabaseAdmin } from "@/lib/supabase/admin";
import { listAuthUsers } from "@/lib/auth/auth-users";
import { unwrap } from "@/lib/db/result";
import { parseStampMs } from "@/lib/date/stamp";
import { log } from "@/lib/log";
import {
  revokeSupabaseSessions,
  restoreSupabaseSessions,
  SESSION_BAN_DURATIONS,
  type SessionRevokeOutcome,
} from "@/lib/auth/session-revoke";
import type { SessionConvergenceResult } from "@/lib/offboarding/session-convergence-alert";

export type { SessionConvergenceResult };

/**
 * Session access follows the roster, in BOTH directions, whichever path changed
 * the roster (#2459): a departed person who can sign in ends up banned in Supabase
 * Auth, and an active person still carrying Slate's departure ban gets it lifted.
 *
 * WHY THIS EXISTS. #2378 made offboarding ban the person in Supabase Auth, inside
 * `applyLifecycleByUserId`. The hourly Salesforce reap, which is the ordinary way
 * people leave, departs them with its own batch write and never came through
 * there, so nobody it departed was banned: measured on 2026-10-01, 10 of the 13
 * departed rows holding an `auth_user_id` had no ban. They were still refused on
 * their next request by `gateSessionRow`, which is the control that closes the
 * hole; what they kept was a refresh token GoTrue would honour.
 *
 * WHY A CONVERGENCE RATHER THAN A CALL BESIDE THE REAP'S WRITE. The reap selects
 * only rows that are NOT yet departed, so a revoke placed beside its write that
 * failed once would never be asked for again. This reads the END STATE instead,
 * who is departed or active in Slate against who Supabase Auth itself says is
 * banned, and repairs the difference. So a failure is retried by the next run, a
 * crash between the write and the ban converges, and the people the reap already
 * departed are repaired by the first run after this ships. It is the rule
 * `withSessionAccess` (`offboarding/service.ts`) follows for one person, "act
 * whenever the end state holds, not only on the transition", applied to everyone,
 * and it backstops that path's own failures too.
 *
 * WHY BOTH DIRECTIONS. A one way convergence turned a failed restore into a
 * permanent lock out: somebody reactivated while their ban was in flight, whose
 * restore then failed, was active in Slate and banned in Auth, and no later run
 * would ever select them. Reading active rows too makes that converge like any
 * other failure.
 *
 * WHOSE BAN IT LIFTS. Nothing else in Slate bans anybody: `session-revoke.ts` is
 * the only caller of `updateUserById` with a `ban_duration` (checked 2026-10-01).
 * A ban can still be set by hand in the Supabase dashboard, so the restore is
 * scoped to Slate's own departure ban, recognised by its length: Slate bans for a
 * century, so only a ban with more than half of that remaining is lifted
 * (`isSlateDepartureBan`). A shorter ban on an active person is counted as
 * `foreignBans` and left alone. The residual, said plainly: a person banned by
 * hand for a century or more would be read as Slate's, and lifted while active.
 *
 * IT DECIDES FROM THE AUTH SYSTEM'S RECORD, never from a stamp Slate writes about
 * having banned somebody (L58): a stamp records that a call was made, and the ban
 * itself is the fact.
 *
 * COST. Two reads on a quiet hour (one page of auth users, one roster bounded read
 * of users holding a sign in), plus one admin call per person it changes, capped
 * at `MAX_SESSION_REVOKES_PER_RUN` each way, plus one read back when it banned
 * anybody. On the hourly roster lane, which shares its invocation with three other
 * crons.
 */

/**
 * At most this many bans, and separately this many restores, per run. The steady
 * state is a handful of leavers an hour; the bound exists for the first run (which
 * repairs the backlog) and for a mass departure, and whatever it leaves is taken
 * by the next run.
 */
export const MAX_SESSION_REVOKES_PER_RUN = 25;

/**
 * Half the length of the ban Slate writes, DERIVED from the duration that ships so
 * the two cannot drift apart. A ban with more than this remaining is Slate's.
 */
const SLATE_BAN_MIN_REMAINING_MS = (Number.parseInt(SESSION_BAN_DURATIONS.revoke, 10) * 60 * 60_000) / 2;

/** Whether a ban ending at `bannedUntilMs` is Slate's departure ban (see header). */
export function isSlateDepartureBan(bannedUntilMs: number, nowMs: number): boolean {
  return bannedUntilMs - nowMs > SLATE_BAN_MIN_REMAINING_MS;
}

/** A users row that holds a sign in, and whether it is departed. */
export interface RosterAuthRow {
  id: string;
  auth_user_id: string;
  departed: boolean;
}

/** Each auth user's `banned_until`, and whether the listing reached its end. */
export interface AuthBanListing {
  complete: boolean;
  bans: Map<string, string | null>;
}

export interface SessionConvergencePlan {
  toRevoke: RosterAuthRow[];
  toRestore: RosterAuthRow[];
  alreadyRevoked: number;
  /** Active people banned by something other than Slate. Counted, left alone. */
  foreignBans: number;
  /** Departed rows whose auth user the listing does not hold. Never banned blind. */
  unlisted: number;
  /** Left for the next run by the per run cap, either way. */
  deferred: number;
}

/**
 * Who to ban and who to restore. A departed person's ban counts only while
 * `banned_until` is in the future; one that has lapsed, or that cannot be read, is
 * banned again, which is the safe side because the ban is idempotent. An active
 * person is restored only from a ban that is readable, current and Slate's own.
 */
export function planSessionConvergence(
  rows: RosterAuthRow[],
  listing: AuthBanListing,
  nowMs: number,
  cap: number,
): SessionConvergencePlan {
  const revokeDue: RosterAuthRow[] = [];
  const restoreDue: RosterAuthRow[] = [];
  let alreadyRevoked = 0;
  let foreignBans = 0;
  let unlisted = 0;
  for (const row of rows) {
    const until = parseStampMs(listing.bans.get(row.auth_user_id) ?? null);
    if (row.departed) {
      if (!listing.bans.has(row.auth_user_id)) unlisted += 1;
      else if (until !== null && until > nowMs) alreadyRevoked += 1;
      else revokeDue.push(row);
    } else if (until !== null && until > nowMs) {
      if (isSlateDepartureBan(until, nowMs)) restoreDue.push(row);
      else foreignBans += 1;
    }
  }
  return {
    toRevoke: revokeDue.slice(0, cap),
    toRestore: restoreDue.slice(0, cap),
    alreadyRevoked,
    foreignBans,
    unlisted,
    deferred: Math.max(0, revokeDue.length - cap) + Math.max(0, restoreDue.length - cap),
  };
}

export interface SessionConvergenceDeps {
  /** Every auth user's ban. THROWS when it cannot be read. */
  listAuthBans: () => Promise<AuthBanListing>;
  /** Users rows that hold an `auth_user_id`. THROWS when it cannot be read. */
  listRoster: () => Promise<RosterAuthRow[]>;
  revoke: (authUserId: string) => Promise<SessionRevokeOutcome>;
  restore: (authUserId: string) => Promise<SessionRevokeOutcome>;
  /** Of these user ids, the ones still departed now. THROWS when unreadable. */
  stillDeparted: (userIds: string[]) => Promise<Set<string>>;
  now: () => number;
}


/**
 * Run the convergence. Throws only when a READ fails, because then nothing is
 * known and an empty answer would read as "everybody is converged" (L98). A
 * refused ban or restore is counted and logged per person and never stops the
 * others (L73).
 */
export async function convergeDepartedSessions(
  deps: SessionConvergenceDeps = defaultSessionConvergenceDeps,
): Promise<SessionConvergenceResult> {
  // The auth listing FIRST, so the window between reading the roster and acting
  // on it, which is the window a lifecycle change can race, is as short as it can be.
  const listing = await deps.listAuthBans();
  const rows = await deps.listRoster();
  const plan = planSessionConvergence(rows, listing, deps.now(), MAX_SESSION_REVOKES_PER_RUN);

  let restored = 0;
  let restoreFailed = 0;
  const restore = async (row: RosterAuthRow, why: string): Promise<void> => {
    try {
      await deps.restore(row.auth_user_id);
      restored += 1;
      log.warn("offboarding", { msg: `session access restored: ${why}`, user_id: row.id });
    } catch (err) {
      restoreFailed += 1;
      log.error("offboarding", { msg: `session restore failed, retried next run: ${why}`, user_id: row.id }, err);
    }
  };

  const banned: RosterAuthRow[] = [];
  let revokeFailed = 0;
  for (const row of plan.toRevoke) {
    try {
      await deps.revoke(row.auth_user_id);
      banned.push(row);
    } catch (err) {
      revokeFailed += 1;
      log.error("offboarding", { msg: "departed session revoke failed, retried next run", user_id: row.id }, err);
    }
  }

  // Somebody reactivated between the read above and their ban is restored at once
  // rather than an hour later. If that restore fails, the next run reads them as
  // active and banned and restores them then.
  let raced = 0;
  if (banned.length > 0) {
    const still = await deps.stillDeparted(banned.map((r) => r.id));
    for (const row of banned) {
      if (still.has(row.id)) continue;
      raced += 1;
      await restore(row, "reactivated while its ban was in flight");
    }
  }

  for (const row of plan.toRestore) {
    await restore(row, "active in Slate and still carrying the departure ban");
  }

  const result: SessionConvergenceResult = {
    departed: rows.filter((r) => r.departed).length,
    alreadyRevoked: plan.alreadyRevoked,
    revoked: banned.length - raced,
    revokeFailed,
    restored,
    restoreFailed,
    foreignBans: plan.foreignBans,
    deferred: plan.deferred,
    unlisted: plan.unlisted,
    listingComplete: listing.complete,
  };
  log.info("offboarding", { msg: "session access converged", ...result });
  return result;
}

// ------------------------------------------------------------- the reads

/** The shared auth user listing (`listAuthUsers`, #4379), reduced to each user's ban. */
async function listAuthBans(): Promise<AuthBanListing> {
  const listing = await listAuthUsers();
  return { complete: listing.complete, bans: new Map(listing.users.map((u) => [u.id, u.banned_until])) };
}

async function listRoster(): Promise<RosterAuthRow[]> {
  const rows = unwrap(
    // cap-safe: users is roster bounded (SAFE_TABLES), a few hundred rows.
    // any-advisor-ok: sessions are about who can sign in, whatever kind of row it is.
    await supabaseAdmin().from("users").select("id, auth_user_id, deactivated_at").not("auth_user_id", "is", null),
    "session-convergence.roster",
  );
  return ((rows ?? []) as { id: string; auth_user_id: string | null; deactivated_at: string | null }[]).flatMap((r) =>
    r.auth_user_id ? [{ id: r.id, auth_user_id: r.auth_user_id, departed: r.deactivated_at !== null }] : [],
  );
}

async function stillDeparted(userIds: string[]): Promise<Set<string>> {
  const rows = unwrap(
    await supabaseAdmin().from("users").select("id").in("id", userIds).not("deactivated_at", "is", null),
    "session-convergence.read-back",
  );
  return new Set(((rows ?? []) as { id: string }[]).map((r) => r.id));
}

export const defaultSessionConvergenceDeps: SessionConvergenceDeps = {
  listAuthBans,
  listRoster,
  revoke: (authUserId) => revokeSupabaseSessions(authUserId),
  restore: (authUserId) => restoreSupabaseSessions(authUserId),
  stillDeparted,
  now: () => Date.now(),
};
