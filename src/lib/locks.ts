import { supabaseAdmin } from "@/lib/supabase/admin";
import { claimWindow } from "@/lib/google/sync-coalesce";

/**
 * DB-backed cross-request locks (#30): Workers isolates share no memory, so
 * "is another invocation already doing this?" lives in the sync_locks table.
 * A claim expires after its TTL, so a crashed holder can't deadlock the key.
 */

/** Returns the claim token on success, null when someone else holds the key. */
export async function acquireLock(
  key: string,
  ttlMs: number,
): Promise<string | null> {
  const db = supabaseAdmin();
  const { claimIso, staleBeforeIso } = claimWindow(Date.now(), ttlMs);

  // Fresh key: the primary key makes the insert the atomic claim.
  const ins = await db.from("sync_locks").insert({ key, claimed_at: claimIso });
  if (!ins.error) return claimIso;

  // Key exists: steal it only if the current claim is stale.
  // error-ok: a refused update arrives as `data: null`, which reads as "somebody
  // else holds it" and is the SAFE side of this gate: the lane skips this tick
  // and the next one retries. A read that stayed broken would stop the lane
  // entirely, and the lane watchdog pages on exactly that (#1027 family), so the
  // silence is watched rather than absolute.
  const { data } = await db
    .from("sync_locks")
    .update({ claimed_at: claimIso })
    .eq("key", key)
    .lt("claimed_at", staleBeforeIso)
    .select("key");
  return data?.length ? claimIso : null;
}

/** Releases only our own claim - a post-TTL thief's newer claim survives. */
export async function releaseLock(key: string, claimIso: string): Promise<void> {
  // write-ok: the lock is released by its TTL regardless, so a refused delete costs one lane's wait and never a lost lock.
  await supabaseAdmin()
    .from("sync_locks")
    .delete()
    .eq("key", key)
    .eq("claimed_at", claimIso);
}
