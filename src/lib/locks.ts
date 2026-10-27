import { supabaseAdmin } from "@/lib/supabase/admin";
import { claimWindow } from "@/lib/google/sync-coalesce";
import { log } from "@/lib/log";
import { makeSharedInFlight } from "@/lib/concurrency";

/**
 * DB-backed cross-request locks (#30): Workers isolates share no memory, so
 * "is another invocation already doing this?" lives in the sync_locks table.
 * A claim expires after its TTL, so a crashed holder can't deadlock the key.
 */

/**
 * What one claim did (#4261): took the key, found it held by a live claim, or could not
 * be made at all. A lane that only skips a tick treats the last two alike
 * (`acquireLock`); a caller that answers a person must not, since "somebody else is
 * doing this" and "the database did not answer" call for different words (L11).
 */
export type LockClaim = { kind: "claimed"; token: string } | { kind: "held" } | { kind: "refused" };

/** Postgres's unique violation: the key already has a claim. */
const KEY_EXISTS = "23505";

/**
 * Claims the key, saying which of the three things happened. A client that THROWS (the
 * fetch itself failing) propagates, exactly as `acquireLock` always let it, so no lane's
 * handling of that changes.
 */
export async function claimSyncLock(key: string, ttlMs: number): Promise<LockClaim> {
  const db = supabaseAdmin();
  const { claimIso, staleBeforeIso } = claimWindow(Date.now(), ttlMs);
  // Fresh key: the primary key makes the insert the atomic claim.
  const ins = await db.from("sync_locks").insert({ key, claimed_at: claimIso });
  if (!ins.error) return { kind: "claimed", token: claimIso };

  // Key exists: steal it only if the current claim is stale. Tried after ANY insert
  // error, as it always was, so a transient insert failure over a stale claim still
  // claims.
  const { data, error } = await db
    .from("sync_locks")
    .update({ claimed_at: claimIso })
    .eq("key", key)
    .lt("claimed_at", staleBeforeIso)
    .select("key");
  if (error) {
    log.warn("locks", { msg: "lock steal could not run", key }, error);
    return { kind: "refused" };
  }
  if (data?.length) return { kind: "claimed", token: claimIso };
  // Nothing stale to steal. Only an insert refused because the key exists shows a live
  // claim; any other insert failure shows nothing about who holds it.
  if (ins.error.code === KEY_EXISTS) return { kind: "held" };
  log.warn("locks", { msg: "lock claim could not be made", key }, ins.error);
  return { kind: "refused" };
}

/**
 * Returns the claim token on success, null when someone else holds the key OR the claim
 * could not be made. Null is the SAFE side for a lane: it skips this tick and the next
 * one retries. A read that stayed broken would stop the lane entirely, and the lane
 * watchdog pages on exactly that (#1027 family), so the silence is watched rather than
 * absolute (#2542).
 */
export async function acquireLock(
  key: string,
  ttlMs: number,
): Promise<string | null> {
  const claim = await claimSyncLock(key, ttlMs);
  return claim.kind === "claimed" ? claim.token : null;
}

/**
 * Why a lease stopped being provably ours. Two causes, never one, because they
 * call for different readings (L11):
 *
 *   taken    the renewal ran and matched nothing: another run holds the key now
 *   refused  the renewal itself could not run (the database refused it), so
 *            nothing shows whether the claim is still held
 *
 * Both make the run stop writing, since neither can show the claim is ours. Only
 * the first may be reported as another run having taken over.
 */
export type LeaseStopReason = "taken" | "refused";

/** What one renewal did: the new token, or which of the two ways it failed. */
export type RenewLockResult = { ok: true; token: string } | { ok: false; why: LeaseStopReason };

/**
 * Renews our own claim (#3120): moves `claimed_at` forward only while the row still
 * holds `claimIso`, so a claim another run has since stolen is never taken back.
 * Returns the NEW token, or why it could not: `taken` when the claim is no longer
 * ours, `refused` when the renewal could not run at all.
 */
export async function renewLock(key: string, claimIso: string): Promise<RenewLockResult> {
  const { claimIso: next } = claimWindow(Date.now(), 0);
  const { data, error } = await supabaseAdmin()
    .from("sync_locks")
    .update({ claimed_at: next })
    .eq("key", key)
    .eq("claimed_at", claimIso)
    .select("key");
  if (error) {
    log.warn("locks", { msg: "lock renewal could not run", key }, error);
    return { ok: false, why: "refused" };
  }
  return data?.length ? { ok: true, token: next } : { ok: false, why: "taken" };
}

/**
 * A held lane lock that knows whether it is still held (#3120).
 *
 * `acquireLock` is a lease: after its TTL the next tick may take the key even
 * while this run is still working, and then two runs write at once with the older
 * one unaware. A lane that writes in a loop asks `stillHeld()` before each unit of
 * work. That renews the claim, so a run that is making progress keeps its key and
 * the next tick never takes over, and it answers false once the claim has been
 * taken (or cannot be shown to be ours), which is the run's signal to stop.
 *
 * A renewal costs a subrequest on a budget several lanes share, so it is only sent
 * once a third of the TTL has passed since the last one. Inside that window the
 * claim cannot have been stolen: a steal needs `claimed_at` older than the TTL.
 * Once lost it stays lost, so a run never resumes writing after another took over.
 */
export interface LockLease {
  readonly key: string;
  /** The current claim token, for `releaseLock`. Changes on each renewal. */
  token(): string;
  /** Renews when due; false once the claim is not provably ours. */
  stillHeld(): Promise<boolean>;
  /** Why `stillHeld()` went false, or null while it has not. */
  stopReason(): LeaseStopReason | null;
}

export function makeLockLease(
  key: string,
  claimIso: string,
  ttlMs: number,
  deps: { now?: () => number; renew?: typeof renewLock } = {},
): LockLease {
  const now = deps.now ?? Date.now;
  const renew = deps.renew ?? renewLock;
  let token = claimIso;
  let renewedAt = now();
  let stopped: LeaseStopReason | null = null;
  // A lane working concurrently asks from several tasks at once. Two renewals of
  // the same token would race, and the loser would find the token already moved
  // and report the claim lost while this very run holds it, so they share one.
  const shared = makeSharedInFlight<"renew", boolean>();
  const renewOnce = async (): Promise<boolean> => {
    // A renewal that throws is a refusal like any other: nothing shows the claim is
    // still ours. Caught here so `stillHeld()` answers stop rather than rejecting,
    // which its caller would otherwise read as its own work failing.
    let pending: Promise<RenewLockResult>;
    try {
      pending = renew(key, token);
    } catch (err) {
      pending = Promise.reject(err);
    }
    const result: RenewLockResult = await pending.catch((err: unknown) => {
      log.warn("locks", { msg: "lock renewal threw", key }, err);
      return { ok: false, why: "refused" } as const;
    });
    if (!result.ok) {
      stopped = result.why;
      log.warn("locks", {
        msg:
          result.why === "taken"
            ? "lane lock taken by another run, stopping this run"
            : "lane lock renewal refused, stopping this run",
        key,
      });
      return false;
    }
    token = result.token;
    renewedAt = now();
    return true;
  };
  return {
    key,
    token: () => token,
    stopReason: () => stopped,
    async stillHeld() {
      if (stopped !== null) return false;
      if (now() - renewedAt < ttlMs / 3) return true;
      return shared("renew", renewOnce);
    },
  };
}

/** Takes the key and returns it as a lease, or null when another run holds it. */
export async function acquireLease(key: string, ttlMs: number): Promise<LockLease | null> {
  const claim = await acquireLock(key, ttlMs);
  return claim === null ? null : makeLockLease(key, claim, ttlMs);
}

/**
 * What one release did (#4180): freed our claim, found no claim of ours to free (released
 * already, or taken over after the TTL), or could not run. Never throws, so a release in a
 * `finally` cannot replace the outcome it follows.
 */
export type ReleaseLockResult = "released" | "not-held" | "refused";

/** Releases only our own claim - a post-TTL thief's newer claim survives. Idempotent: a second
 *  release of the same claim finds nothing and answers `not-held`. */
export async function releaseLock(key: string, claimIso: string): Promise<ReleaseLockResult> {
  // The lock is released by its TTL regardless, so a refused delete costs one lane's wait and
  // never a lost lock. It is reported rather than thrown, for the callers that say what happened.
  try {
    const { data, error } = await supabaseAdmin()
      .from("sync_locks")
      .delete()
      .eq("key", key)
      .eq("claimed_at", claimIso)
      .select("key");
    if (error) {
      log.warn("locks", { msg: "lock release could not run", key }, error);
      return "refused";
    }
    return data?.length ? "released" : "not-held";
  } catch (err) {
    log.warn("locks", { msg: "lock release threw", key }, err);
    return "refused";
  }
}
