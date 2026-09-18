/**
 * Clearing the credentials the mirror already carried, and proving they stay
 * cleared (#2564).
 *
 * `mirror-credentials.ts` stops NEW rows carrying a manage token into the
 * warehouse, at the one point every merge path goes through. It can do nothing
 * about the rows already there: the export walks strictly forward over a
 * watermark, so a booking that never changes again is never revisited, and its
 * token would sit in the warehouse for as long as the row does.
 *
 * So this runs on the 6-hourly erasure-audit lane, which already talks to the
 * warehouse about things it should not be holding. Each statement is bounded by
 * `is not null`, so the first run clears the backlog and every run after it
 * matches no rows and costs a predicate.
 *
 * What it pages on is the RESIDUAL, not the count cleared. A non-zero residual
 * means the blanking ran and the credential is still there, so the cleanup cannot
 * do its job. A non-zero cleared count is legitimate on the first run (measured
 * 2026-09-18: 2,392 bookings and 6,522 delivery payloads) and is logged rather
 * than alerted, because nothing durable tells this lane which run is its first,
 * and an alarm that fires once by design is one nobody reads the second time.
 * What prevents a credential rejoining the mirror is the static guard
 * (`scripts/test-mirror-credentials.ts`), not this sweep.
 *
 * Fails loud on anything it cannot measure. An unreadable count THROWS or refuses
 * rather than being recorded as zero: a blanking reported as having changed no
 * rows and one whose count could not be read are opposite facts, and only one of
 * them means the warehouse is clean.
 */

import type { SnowflakeConfig, SnowflakeStatementResponse } from "./client";
import { executeStatement } from "./client";
import { readSnowflakeConfig } from "./config";
import {
  MIRROR_CREDENTIALS,
  buildCredentialBlankStatements,
  buildCredentialResidualStatement,
} from "./mirror-credentials";

/** The statement runner, injected so the decision logic is testable with no
 *  warehouse and no network. */
export type ExecuteStatement = (
  config: SnowflakeConfig,
  sql: string,
) => Promise<SnowflakeStatementResponse>;

export interface CredentialSweepResult {
  /** Rows blanked per credential, keyed by its label. */
  cleared: Record<string, number>;
  /** What is LEFT per credential after the blanking, null when unreadable. */
  residual: Record<string, number | null>;
  reasons: string[];
  ok: boolean;
}

/**
 * Read a numeric cell, or null when it cannot be read.
 *
 * Deliberately not collapsed to 0 by any caller here: `Number()` on a missing
 * cell yields NaN, every comparison with NaN is false, and the check would land
 * on the healthy side having measured nothing (L50).
 */
function readNumber(res: SnowflakeStatementResponse, index = 0): number | null {
  const cell = res.data?.[0]?.[index];
  if (cell === undefined || cell === null) return null;
  const n = Number(cell);
  return Number.isFinite(n) ? n : null;
}

export async function sweepMirrorCredentials(
  config: SnowflakeConfig,
  execute: ExecuteStatement = executeStatement,
): Promise<CredentialSweepResult> {
  const cleared: Record<string, number> = {};
  const reasons: string[] = [];

  for (const statement of buildCredentialBlankStatements()) {
    const res = await execute(config, statement.sql);
    const changed = readNumber(res);
    if (changed === null) {
      reasons.push(
        `${statement.label}: the blanking ran and Snowflake's row count could not be read, so it is unverified`,
      );
      continue;
    }
    cleared[statement.label] = changed;
  }

  const verify = await execute(config, buildCredentialResidualStatement());
  const residual: Record<string, number | null> = {};
  MIRROR_CREDENTIALS.forEach((credential, i) => {
    const label = `${credential.table}.${credential.column}${credential.jsonKey ? `:${credential.jsonKey}` : ""}`;
    const count = readNumber(verify, i);
    residual[label] = count;
    if (count === null) {
      reasons.push(`${label}: could not read the residual count, so the sweep is unverified`);
    } else if (count > 0) {
      reasons.push(
        `${label}: ${count} ${count === 1 ? "row" : "rows"} still ${count === 1 ? "holds" : "hold"} the credential after the sweep`,
      );
    }
  });

  return { cleared, residual, reasons, ok: reasons.length === 0 };
}

export const CREDENTIAL_SWEEP_ALERT_KEY = "snowflake_credential_residual";

/**
 * The lane entry point: read the config and sweep, or say the mirror is not
 * configured. A skipped run has measured nothing and must never clear an alert.
 */
export async function runMirrorCredentialSweep(): Promise<
  CredentialSweepResult & { skipped?: true }
> {
  const config = readSnowflakeConfig();
  if (!config) return { skipped: true, ok: true, cleared: {}, residual: {}, reasons: [] };
  return sweepMirrorCredentials(config);
}
