/**
 * Pure batching helpers for the Salesforce roster sync (#91). The sync writes
 * two sets of per-row changes (existing-agent field refreshes, and agent to
 * manager links). Done one row at a time in a sequential await loop, ~101 users
 * become a long chain of round-trips that is slow and risks the Cloudflare
 * Workers CPU/time ceiling on the admin Sync button and the hourly cron. These
 * helpers let the IO in `sync.ts` collapse those loops into chunked/grouped
 * statements. Side-effect-free so they're unit-testable
 * (`scripts/test-salesforce-sync-batch.ts`).
 */

/**
 * Group resolved agent to manager links by manager id, so every agent assigned
 * the same manager is written in ONE `update(...).in("id", [...])` statement
 * instead of one round-trip per agent. Preserves agent order within a manager.
 */
export function groupManagerLinks(
  links: { agentId: string; managerId: string }[],
): Map<string, string[]> {
  const byManager = new Map<string, string[]>();
  for (const { agentId, managerId } of links) {
    const arr = byManager.get(managerId);
    if (arr) arr.push(agentId);
    else byManager.set(managerId, [agentId]);
  }
  return byManager;
}

/**
 * Split rows into batches of at most `size` for chunked writes, keeping each
 * upsert well under statement/row limits on a large roster. Never emits an
 * empty trailing chunk; an empty input yields no chunks (so no empty write).
 */
export function chunkRows<T>(rows: T[], size: number): T[][] {
  if (size < 1) throw new Error(`chunkRows: size must be >= 1, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}
