import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { parseStampMs } from "@/lib/date/stamp";
import { log } from "@/lib/log";
import {
  revokeSupabaseSessions,
  restoreSupabaseSessions,
  type SessionRevokeOutcome,
} from "@/lib/auth/session-revoke";

/**
 * Every departed person who can sign in ends up unable to mint a session,
 * whichever path departed them (#2459).
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
 * failed once would never be asked for again: the row would be departed, banned
 * by nobody, and invisible to every later run. This reads the END STATE instead,
 * who is departed in Slate and who Supabase Auth itself says is banned, and repairs
 * the difference. So a failure is retried by the next run, a crash between the
 * write and the ban converges, and the people the reap already departed are
 * repaired by the first run after this ships. It is the same rule
 * `withSessionAccess` (`offboarding/service.ts`) follows for one person, "act
 * whenever the end state holds, not only on the transition", applied to all of
 * them, and it backstops that path's own failures too.
 *
 * IT DECIDES FROM THE AUTH SYSTEM'S RECORD, never from a stamp Slate writes about
 * having banned somebody (L58): a stamp records that a call was made, and the ban
 * itself is the fact.
 *
 * COST. Two reads on a quiet hour (one page of auth users, one roster bounded read
 * of departed rows), plus one admin call per person it bans, capped at
 * `MAX_SESSION_REVOKES_PER_RUN`, plus one read back when it banned anybody. On the
 * hourly roster lane, which shares its invocation with three other crons.
 */

/**
 * At most this many bans per run. The steady state is a handful of leavers an
 * hour; the bound exists for the first run (which repairs the backlog) and for a
 * mass departure, and whatever it leaves is taken by the next run.
 */
export const MAX_SESSION_REVOKES_PER_RUN = 25;

/** GoTrue's own maximum page size. The roster is a few hundred people. */
const AUTH_PAGE_SIZE = 1000;
/** A listing longer than this is reported as partial rather than walked for ever. */
const AUTH_MAX_PAGES = 5;

export interface DepartedRow {
  id: string;
  auth_user_id: string;
}

/** Each auth user's `banned_until`, and whether the listing reached its end. */
export interface AuthBanListing {
  complete: boolean;
  bans: Map<string, string | null>;
}

export interface SessionConvergencePlan {
  toRevoke: DepartedRow[];
  alreadyRevoked: number;
  /** Departed rows whose auth user the listing does not hold. Never banned blind. */
  unlisted: number;
  /** Left for the next run by the per run cap. */
  deferred: number;
}

/**
 * Who to ban. A ban counts only while `banned_until` is in the future; one that
 * has lapsed, or that cannot be read, is banned again, which is the safe side
 * because the ban is idempotent.
 */
export function planSessionConvergence(
  departed: DepartedRow[],
  listing: AuthBanListing,
  nowMs: number,
  cap: number,
): SessionConvergencePlan {
  const due: DepartedRow[] = [];
  let alreadyRevoked = 0;
  let unlisted = 0;
  for (const row of departed) {
    if (!listing.bans.has(row.auth_user_id)) {
      unlisted += 1;
      continue;
    }
    const until = parseStampMs(listing.bans.get(row.auth_user_id) ?? null);
    if (until !== null && until > nowMs) alreadyRevoked += 1;
    else due.push(row);
  }
  return {
    toRevoke: due.slice(0, cap),
    alreadyRevoked,
    unlisted,
    deferred: Math.max(0, due.length - cap),
  };
}

export interface SessionConvergenceDeps {
  /** Every auth user's ban. THROWS when it cannot be read. */
  listAuthBans: () => Promise<AuthBanListing>;
  /** Departed rows that hold an `auth_user_id`. THROWS when it cannot be read. */
  listDeparted: () => Promise<DepartedRow[]>;
  revoke: (authUserId: string) => Promise<SessionRevokeOutcome>;
  restore: (authUserId: string) => Promise<SessionRevokeOutcome>;
  /** Of these user ids, the ones still departed now. THROWS when unreadable. */
  stillDeparted: (userIds: string[]) => Promise<Set<string>>;
  now: () => number;
}

export interface SessionConvergenceResult {
  departed: number;
  alreadyRevoked: number;
  revoked: number;
  /** Bans GoTrue refused. Retried by the next run. */
  failed: number;
  deferred: number;
  unlisted: number;
  /** Banned, then found reactivated in the meantime, and given access back. */
  restoredAfterRace: number;
  listingComplete: boolean;
}

/**
 * Run the convergence. Throws only when a READ fails, because then nothing is
 * known and an empty answer would read as "everybody is converged" (L98). A
 * refused ban is counted and logged per person and never stops the others (L73).
 */
export async function convergeDepartedSessions(
  deps: SessionConvergenceDeps = defaultSessionConvergenceDeps,
): Promise<SessionConvergenceResult> {
  // The auth listing FIRST, so the window between reading who is departed and
  // banning them, which is the window a reactivation can race, is as short as it
  // can be.
  const listing = await deps.listAuthBans();
  const departed = await deps.listDeparted();
  const plan = planSessionConvergence(departed, listing, deps.now(), MAX_SESSION_REVOKES_PER_RUN);

  const banned: DepartedRow[] = [];
  let failed = 0;
  for (const row of plan.toRevoke) {
    try {
      await deps.revoke(row.auth_user_id);
      banned.push(row);
    } catch (err) {
      failed += 1;
      log.error("offboarding", { msg: "departed session revoke failed, retried next run", user_id: row.id }, err);
    }
  }

  // Somebody reactivated between the read above and their ban would be locked out
  // with nothing on any screen saying why, and no later run would notice, since
  // they are no longer departed. So read back and give them their access again.
  let restoredAfterRace = 0;
  if (banned.length > 0) {
    const still = await deps.stillDeparted(banned.map((r) => r.id));
    for (const row of banned) {
      if (still.has(row.id)) continue;
      try {
        await deps.restore(row.auth_user_id);
        restoredAfterRace += 1;
        log.warn("offboarding", { msg: "reactivated while its ban was in flight; access restored", user_id: row.id });
      } catch (err) {
        log.error("offboarding", { msg: "could not restore a reactivated person's access", user_id: row.id }, err);
      }
    }
  }

  const result: SessionConvergenceResult = {
    departed: departed.length,
    alreadyRevoked: plan.alreadyRevoked,
    revoked: banned.length - restoredAfterRace,
    failed,
    deferred: plan.deferred,
    unlisted: plan.unlisted,
    restoredAfterRace,
    listingComplete: listing.complete,
  };
  log.info("offboarding", { msg: "departed sessions converged", ...result });
  return result;
}

async function listAuthBans(): Promise<AuthBanListing> {
  const bans = new Map<string, string | null>();
  for (let page = 1; page <= AUTH_MAX_PAGES; page++) {
    const { data, error } = await supabaseAdmin().auth.admin.listUsers({ page, perPage: AUTH_PAGE_SIZE });
    if (error) throw new Error(`could not list auth users: ${error.message}`);
    for (const u of data.users) bans.set(u.id, u.banned_until ?? null);
    if (data.users.length < AUTH_PAGE_SIZE) return { complete: true, bans };
  }
  return { complete: false, bans };
}

async function listDeparted(): Promise<DepartedRow[]> {
  const rows = unwrap(
    await supabaseAdmin()
      .from("users")
      .select("id, auth_user_id")
      .not("deactivated_at", "is", null)
      .not("auth_user_id", "is", null),
    "session-convergence.departed",
  );
  return ((rows ?? []) as { id: string; auth_user_id: string | null }[]).flatMap((r) =>
    r.auth_user_id ? [{ id: r.id, auth_user_id: r.auth_user_id }] : [],
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
  listDeparted,
  revoke: (authUserId) => revokeSupabaseSessions(authUserId),
  restore: (authUserId) => restoreSupabaseSessions(authUserId),
  stillDeparted,
  now: () => Date.now(),
};
