/**
 * Prod migration-version lag detection (#516, #814).
 *
 * Deploys do not apply migrations (#482), so the deployed code can run ahead of
 * the schema it needs. That has bitten three times: 0032 unrecorded (#214), 0037
 * unapplied (availability silently went empty, #276), 0055 unapplied (the #420
 * dead-man's switch sat dormant for a whole session). CI's migration-drift job
 * guards MERGE time; nothing watched PROD. This is that watch: the build carries
 * the highest migration it ships (the shipped set is contiguous 0001..N, enforced
 * by scripts/test-migrations.ts), the DB reports the FULL set it has applied, and
 * ANY missing version in 0001..N pages.
 *
 * #814: the original check compared only the highest applied version against the
 * highest shipped. A migration missing from the MIDDLE (0032 unrecorded while
 * later ones applied) leaves the max unchanged and read as "in-sync", which is the
 * exact #214 incident. Comparing the SET closes that hole and lets the alert name
 * the missing migration.
 *
 * PURE: classifyMigrationDrift / missingMigrationVersions / formatMigrationDriftAlert
 *       (node-testable). IO: runMigrationDriftCheck, dependency-injected.
 */

import { supabaseAdmin } from "@/lib/supabase/admin";

// alert_state row key for the throttle; one constant shared by the cron and the
// settings screen.
export const MIGRATION_VERSION_LAG_KEY = "migration_version_lag";

/**
 * The live database's full set of applied migration versions (the repo's NNNN
 * prefixes), read through the SECURITY DEFINER function added in migration 0072
 * (PostgREST cannot see the supabase_migrations schema directly).
 *
 * THROWS on any failure, including a missing/empty/wrong-shape result, rather than
 * returning null. The caller turns a throw into "unverified" and alerts. Returning
 * null quietly would let a broken read masquerade as a healthy schema, which is the
 * failure mode this whole check exists to remove. A missing function is itself the
 * most likely cause: it means migration 0072 was never applied, so the database IS
 * behind. A non-array result is the pre-0072 scalar function still in place (the
 * deploy landed but the migration has not), which is likewise the drift.
 */
export async function readAppliedMigrationVersions(): Promise<string[]> {
  const { data, error } = await supabaseAdmin().rpc("applied_migration_versions");
  if (error) throw new Error(`applied_migration_versions failed: ${error.message}`);
  if (!Array.isArray(data)) {
    throw new Error(
      "applied_migration_versions did not return an array (migration 0072 may be unapplied)",
    );
  }
  if (data.length === 0) {
    throw new Error("applied_migration_versions returned no applied migration versions");
  }
  return data as string[];
}

export type MigrationDriftStatus = "in-sync" | "db-behind" | "db-ahead" | "unverified";

/** A migration version is its zero-padded file prefix ("0070"), which is exactly
 *  what supabase_migrations.schema_migrations stores. Parsed, never compared as
 *  text, so an unpadded or four-to-five digit rollover can't misorder. Returns
 *  null for anything that isn't a bare integer (out-of-band timestamp versions,
 *  which the RPC already filters, are ignored rather than fatal). */
function parseVersion(v: string): number | null {
  const t = v.trim();
  if (!/^\d+$/.test(t)) return null;
  return Number(t);
}

/**
 * The migrations the shipped set (contiguous 0001..shipped) expects but the live
 * database has not applied, zero-padded to four digits and in order. Empty when the
 * DB has every version up to the shipped max. This is what lets the alert name the
 * hole instead of only reporting that one exists.
 */
export function missingMigrationVersions(
  shippedVersion: string,
  appliedVersions: string[],
): string[] {
  const shipped = parseVersion(shippedVersion);
  if (shipped === null) return [];
  const applied = new Set(
    appliedVersions.map(parseVersion).filter((n): n is number => n !== null),
  );
  const missing: string[] = [];
  for (let v = 1; v <= shipped; v++) {
    if (!applied.has(v)) missing.push(String(v).padStart(4, "0"));
  }
  return missing;
}

/**
 * Compare the migration set the deployed build ships (contiguous 0001..shipped)
 * against the full set the live DB reports applied.
 *
 * `db-behind` is the incident: any migration in 0001..shipped is missing (a hole in
 * the middle counts, #814), so code is live that expects schema the DB lacks.
 * `db-ahead` is the healthy deploy window (migrations are applied BEFORE the code
 * that needs them, so the DB leads for a few minutes) and stays quiet.
 * A set that cannot be read or is empty is `unverified`, NOT `in-sync`: a check that
 * reports healthy because it failed to look is the false-confidence bug this whole
 * guard exists to catch.
 */
export function classifyMigrationDrift(
  shippedVersion: string,
  appliedVersions: string[] | null,
): MigrationDriftStatus {
  const shipped = parseVersion(shippedVersion);
  if (shipped === null || appliedVersions === null) return "unverified";
  const applied = appliedVersions
    .map(parseVersion)
    .filter((n): n is number => n !== null);
  if (applied.length === 0) return "unverified";
  if (missingMigrationVersions(shippedVersion, appliedVersions).length > 0) return "db-behind";
  return Math.max(...applied) > shipped ? "db-ahead" : "in-sync";
}

/** Name the missing versions, capping the list so a badly-behind DB does not emit a
 *  wall of text. */
function nameMissing(missing: string[], cap = 10): string {
  if (missing.length <= cap) return missing.join(", ");
  return `${missing.slice(0, cap).join(", ")} (and ${missing.length - cap} more)`;
}

/** Slack copy for the two statuses worth waking someone for. No em/en dashes
 *  (copy lint). Returns "" for the quiet statuses so the caller sends nothing. */
export function formatMigrationDriftAlert(
  status: MigrationDriftStatus,
  shippedVersion: string,
  appliedVersions: string[] | null,
): string {
  if (status === "db-behind") {
    const missing = appliedVersions
      ? missingMigrationVersions(shippedVersion, appliedVersions)
      : [];
    const detail = missing.length
      ? `is missing migration${missing.length > 1 ? "s" : ""} ${nameMissing(missing)}`
      : `is behind the shipped set`;
    return (
      `The deployed code ships up to migration ${shippedVersion} but the live ` +
      `database ${detail}. Code is running against schema it expects to exist and that ` +
      `is missing, so features touching the new schema can fail silently. Apply the ` +
      `pending migrations (supabase db push) now.`
    );
  }
  if (status === "unverified") {
    return (
      `Could not read the live database's applied migration versions, so it is ` +
      `unknown whether prod's schema matches the deployed code (which ships up to ` +
      `${shippedVersion}). The applied_migration_versions function may itself be ` +
      `unapplied, which would mean the database is behind. Check with ` +
      `supabase migration list.`
    );
  }
  return "";
}

/**
 * The all-clear for the lag page (#1134). Covers both quiet statuses, since from
 * the reader's point of view they are the same news: the schema question is
 * settled and there is nothing to apply.
 *
 * Carries no remediation. The page it clears said "run supabase db push now", and
 * repeating that in the resolve is how an all-clear ends up sending someone to
 * apply migrations that are already applied.
 */
export function formatMigrationDriftRecovery(shippedVersion: string): string {
  return (
    `The live database's schema is back in step with the deployed code, which ` +
    `ships up to migration ${shippedVersion}. Every migration the running code expects ` +
    `is applied, so the earlier schema lag page is cleared. No action is needed.`
  );
}

/**
 * The monitor-cron step. Reads the live applied set, classifies, and (only for
 * db-behind or unverified) posts a throttled Slack alert. Returns the status for
 * the cron's response and log line.
 *
 * The read throwing is treated as `unverified` and ALERTS: the most likely cause is
 * that this feature's own migration was never applied, which is itself the drift
 * being watched for. The notify throwing is swallowed (a flaky Slack must not fail
 * the monitor tick); the persistent alert_state cooldown inside `notify` is what
 * stops repeats.
 *
 * #1134: the two quiet statuses now CLEAR an outstanding page. This check needed no
 * restructuring to make that safe, because it already refuses to call an unreadable
 * set healthy: every way the read can fail lands in `unverified`, which alerts. So
 * `in-sync` and `db-ahead` are reachable only from a read that actually succeeded,
 * which is exactly the property a recovery notice has to rest on.
 */
export async function runMigrationDriftCheck(deps: {
  shippedVersion: string;
  readAppliedVersions: () => Promise<string[] | null>;
  notify: (key: string, cooldownMs: number, text: string) => Promise<void>;
  /** Announce that an outstanding lag page has cleared. A no-op unless one was
   *  actually delivered, so it is safe to call on every healthy tick. */
  resolve: (key: string, text: string) => Promise<boolean>;
  cooldownMs: number;
  log?: (msg: string, status: MigrationDriftStatus, applied: string[] | null) => void;
}): Promise<MigrationDriftStatus> {
  let applied: string[] | null = null;
  try {
    applied = await deps.readAppliedVersions();
  } catch {
    applied = null;
  }

  const status = classifyMigrationDrift(deps.shippedVersion, applied);
  const text = formatMigrationDriftAlert(status, deps.shippedVersion, applied);
  if (text) {
    await deps.notify(MIGRATION_VERSION_LAG_KEY, deps.cooldownMs, text).catch(() => {});
  } else {
    // No alert text means `in-sync` or `db-ahead`, the two statuses that can only
    // come from a successful read. Same swallow rule as notify: a flaky Slack must
    // not fail the monitor tick, and the firing marker survives for a later retry.
    await deps
      .resolve(MIGRATION_VERSION_LAG_KEY, formatMigrationDriftRecovery(deps.shippedVersion))
      .catch(() => {});
  }
  deps.log?.("migration version check", status, applied);
  return status;
}
