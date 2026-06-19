/**
 * DB writes for the sync cron, kept dependency-free (the Supabase client is
 * passed in) so the batching + guards are node-testable. Exercised by
 * scripts/test-sync-writes.ts.
 */

/** The minimal slice of the Supabase client stampLastSynced needs. */
export interface SyncWritesDb {
  from(table: string): {
    update(values: Record<string, unknown>): {
      in(
        column: string,
        values: string[],
      ): PromiseLike<{ error: { message: string } | null }>;
    };
  };
}

/**
 * Stamp users.last_synced_at = `nowIso` for every agent processed this tick in
 * ONE write (#243), replacing the per-agent UPDATE the cron fired inside its
 * loop. No-op on an empty set so we never issue an `IN ()` write, and dedupes
 * so each agent is stamped once. Best-effort: logs but never throws - the mark
 * only drives rotation, so a missed stamp just re-syncs the agent next tick.
 */
export async function stampLastSynced(
  db: SyncWritesDb,
  ids: string[],
  nowIso: string,
): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  try {
    const { error } = await db
      .from("users")
      .update({ last_synced_at: nowIso })
      .in("id", unique);
    if (error) console.error(`stampLastSynced failed: ${error.message}`);
  } catch (err) {
    console.error(
      `stampLastSynced threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
