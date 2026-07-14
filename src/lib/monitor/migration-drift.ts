/**
 * Prod migration-version lag detection (#516).
 *
 * Deploys do not apply migrations (#482), so the deployed code can run ahead of
 * the schema it needs. That has bitten three times: 0032 unrecorded (#214), 0037
 * unapplied (availability silently went empty, #276), 0055 unapplied (the #420
 * dead-man's switch sat dormant for a whole session, this issue). CI's
 * migration-drift job guards MERGE time; nothing watched PROD. This is that watch:
 * the build carries the highest migration it ships, the DB reports the highest it
 * has applied, and a gap pages.
 *
 * PURE: classifyMigrationDrift / formatMigrationDriftAlert (node-testable).
 * IO:   runMigrationDriftCheck, dependency-injected like the thin-tier check.
 */

import { supabaseAdmin } from "@/lib/supabase/admin";

// alert_state row key for the throttle; one constant shared by the cron and the
// settings screen.
export const MIGRATION_VERSION_LAG_KEY = "migration_version_lag";

/**
 * The live database's highest applied migration version, read through the
 * SECURITY DEFINER function added in migration 0071 (PostgREST cannot see the
 * supabase_migrations schema directly).
 *
 * THROWS on any failure, including a null result, rather than returning null.
 * The caller turns a throw into "unverified" and alerts. Returning null quietly
 * would let a broken read masquerade as a healthy schema, which is the failure
 * mode this whole check exists to remove. A missing function is itself the most
 * likely cause: it means migration 0071 was never applied, so the database IS
 * behind.
 */
export async function readAppliedMigrationVersion(): Promise<string> {
  const { data, error } = await supabaseAdmin().rpc("applied_migration_version");
  if (error) throw new Error(`applied_migration_version failed: ${error.message}`);
  if (!data) throw new Error("applied_migration_version returned no applied migration version");
  return data;
}

export type MigrationDriftStatus = "in-sync" | "db-behind" | "db-ahead" | "unverified";

/** A migration version is its zero-padded file prefix ("0070"), which is exactly
 *  what supabase_migrations.schema_migrations stores. Parsed, never compared as
 *  text, so an unpadded or four-to-five digit rollover can't misorder. */
function parseVersion(v: string | null): number | null {
  if (v === null) return null;
  const t = v.trim();
  if (!/^\d+$/.test(t)) return null;
  return Number(t);
}

/**
 * Compare the migration version the deployed build ships against the highest one
 * the live DB has applied.
 *
 * `db-behind` is the incident: code is live that expects schema the DB lacks.
 * `db-ahead` is the healthy deploy window (migrations are applied BEFORE the code
 * that needs them, so the DB leads for a few minutes) and stays quiet.
 * A version that cannot be read or parsed is `unverified`, NOT `in-sync`: a check
 * that reports healthy because it failed to look is the false-confidence bug this
 * whole guard exists to catch.
 */
export function classifyMigrationDrift(
  shippedVersion: string,
  appliedVersion: string | null,
): MigrationDriftStatus {
  const applied = parseVersion(appliedVersion);
  const shipped = parseVersion(shippedVersion);
  if (applied === null || shipped === null) return "unverified";
  if (applied === shipped) return "in-sync";
  return applied < shipped ? "db-behind" : "db-ahead";
}

/** Slack copy for the two statuses worth waking someone for. No em/en dashes
 *  (copy lint). Returns "" for the quiet statuses so the caller sends nothing. */
export function formatMigrationDriftAlert(
  status: MigrationDriftStatus,
  shippedVersion: string,
  appliedVersion: string | null,
): string {
  if (status === "db-behind") {
    return (
      `Slate: the deployed code ships migration ${shippedVersion} but the live database ` +
      `has only applied ${appliedVersion}. Code is running against schema it expects to ` +
      `exist and that is missing, so features touching the new schema can fail silently. ` +
      `Apply the pending migrations (supabase db push) now.`
    );
  }
  if (status === "unverified") {
    return (
      `Slate: could not read the live database's applied migration version, so it is ` +
      `unknown whether prod's schema matches the deployed code (which ships ` +
      `${shippedVersion}). The applied_migration_version function may itself be ` +
      `unapplied, which would mean the database is behind. Check with ` +
      `supabase migration list.`
    );
  }
  return "";
}

/**
 * The monitor-cron step. Reads the live applied version, classifies, and (only
 * for db-behind or unverified) posts a throttled Slack alert. Returns the status
 * for the cron's response and log line.
 *
 * The read throwing is treated as `unverified` and ALERTS: the most likely cause
 * is that this feature's own migration was never applied, which is itself the
 * drift being watched for. The notify throwing is swallowed (a flaky Slack must
 * not fail the monitor tick); the persistent alert_state cooldown inside `notify`
 * is what stops repeats.
 */
export async function runMigrationDriftCheck(deps: {
  shippedVersion: string;
  readAppliedVersion: () => Promise<string | null>;
  notify: (key: string, cooldownMs: number, text: string) => Promise<void>;
  cooldownMs: number;
  log?: (msg: string, status: MigrationDriftStatus, applied: string | null) => void;
}): Promise<MigrationDriftStatus> {
  let applied: string | null = null;
  try {
    applied = await deps.readAppliedVersion();
  } catch {
    applied = null;
  }

  const status = classifyMigrationDrift(deps.shippedVersion, applied);
  const text = formatMigrationDriftAlert(status, deps.shippedVersion, applied);
  if (text) {
    await deps.notify(MIGRATION_VERSION_LAG_KEY, deps.cooldownMs, text).catch(() => {});
  }
  deps.log?.("migration version check", status, applied);
  return status;
}
