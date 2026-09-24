/**
 * The decision half of `pnpm backfill:bookable-trait` (#2085), pure so it is
 * driven offline by scripts/test-bookable-trait-backfill.ts.
 *
 * The routable write sends a trait only when a write CHANGES whether Slate can
 * route to somebody, so on the day it ships Regal holds the trait for nobody and
 * would go on holding it for nobody until each agent happened to change state
 * (L389). This posts every user row's CURRENT value once, through the same
 * delivery path.
 *
 * It is also the repair for the residual #2085 accepts: SQL run by hand in the
 * Supabase editor sends nothing, and neither does a change whose delivery row
 * could not be written (`bookable_trait_unrecorded:*`, whose page names this
 * command). So it carries NO dedupe key: a second run must send again, or the
 * page's remedy would skip everybody the first run reached and say nothing. A
 * duplicate is harmless, because every send states the agent's value at that send.
 */
import { traitFor, type RoutableStateRow, type TraitEmission } from "../../src/lib/bookable/routable-trait.ts";

export interface BackfillDeps {
  /** Every user row. THROWS on an unreadable roster, which is never zero users. */
  listUsers: () => Promise<RoutableStateRow[]>;
  /** Record one trait; `dedupeKey` is always null (see the header). Throws when it could not be recorded. */
  emit: (e: TraitEmission, dedupeKey: null) => Promise<void>;
}

export interface BackfillReport {
  users: number;
  /** Recorded to be POSTed to Regal. */
  recorded: number;
  /** Recorded and withheld: smoke test agents (#396). */
  suppressed: number;
  failed: Array<{ userId: string; email: string; error: string }>;
}

/** Each outcome on its own code, so a shell caller can branch on which it met. */
export const BACKFILL_EXIT = {
  ok: 0,
  /** No credentials or no Supabase URL here; nothing was attempted. */
  notConfigured: 1,
  /** The roster or the endpoints could not be read, or nothing subscribes. */
  unreadable: 2,
  /** The roster read came back empty, which is the shape of a broken read (L98). */
  noUsers: 3,
  /** At least one trait could not be recorded; the rest were. */
  someFailed: 4,
} as const;

export async function runBookableTraitBackfill(deps: BackfillDeps): Promise<BackfillReport> {
  const users = await deps.listUsers();
  const report: BackfillReport = { users: users.length, recorded: 0, suppressed: 0, failed: [] };
  for (const u of users) {
    const e = traitFor(u);
    try {
      await deps.emit(e, null);
      if (e.suppressed) report.suppressed++;
      else report.recorded++;
    } catch (err) {
      report.failed.push({
        userId: u.id,
        email: u.email,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return report;
}

export function backfillExitCode(r: BackfillReport): number {
  if (r.users === 0) return BACKFILL_EXIT.noUsers;
  if (r.failed.length > 0) return BACKFILL_EXIT.someFailed;
  return BACKFILL_EXIT.ok;
}

export function backfillSummary(r: BackfillReport): string {
  if (r.users === 0) {
    return "Read 0 user rows, so nothing was sent. An empty roster is the shape of a broken read, not a finished backfill.";
  }
  const lines = [
    `Read ${r.users} user row${r.users === 1 ? "" : "s"}.`,
    `Recorded ${r.recorded} trait${r.recorded === 1 ? "" : "s"} for Regal, sent through the webhook delivery path (see /admin/webhooks).`,
    `Recorded ${r.suppressed} for test agents and withheld them, as every test agent's trait is.`,
  ];
  if (r.failed.length > 0) {
    lines.push(`Could not record ${r.failed.length}:`);
    for (const f of r.failed) lines.push(`  ${f.email} (${f.userId}): ${f.error}`);
  }
  return lines.join("\n");
}
