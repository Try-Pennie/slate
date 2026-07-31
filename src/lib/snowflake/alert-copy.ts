/**
 * The words the Snowflake mirror lanes say (#1153).
 *
 * Lifted out of the route handlers so the alert preview renders the REAL copy by
 * calling these, instead of holding a second copy that drifts (L41).
 *
 * All three are CONDITIONS (src/lib/notify/alert-catalog.ts): the warehouse is
 * untrustworthy, or out of step, or still holding data someone asked us to erase,
 * and each stays true until it is fixed. So each has a matching all-clear, and
 * each says what is blocked while it lasts.
 */

/** The warehouse self-check is failing, so nothing may trust the mirror. */
export function snowflakeHealthcheckAlert(reason: string): string {
  return (
    `The Snowflake warehouse self-check is failing, so we cannot trust the archive mirror. ` +
          // #1135: Snowflake answers with a multi-line SQL compilation error and a
          // driver stack. One readable line here; the full text is in the log.
          `${reason}. Until this clears, retention will refuse to delete anything ` +
          `(the safe direction) and a deletion request's warehouse purge cannot be verified.`
  );
}

/** The self-check passes again. */
export function snowflakeHealthcheckRecovery(): string {
  return "The Snowflake warehouse self-check is working again. The mirror can be trusted, " +
        "retention is no longer blocked on it, and the earlier warning is cleared. No action is needed.";
}

/** The mirror disagrees with the live database. */
export function snowflakeDriftAlert(reasons: string[]): string {
  return `The Snowflake analytics mirror is out of sync with the live database. ${reasons.join("; ")}. The export lane may be lagging or failing; deletion (when built) must not run until this clears.`;
}

/** The mirror agrees again. */
export function snowflakeDriftRecovery(): string {
  return "The Snowflake analytics mirror matches the live database again. The export lane has " +
          "caught up, so anything that was waiting on the mirror being complete can proceed. No action is needed.";
}

/** An erasure is not finished in the warehouse. */
export function erasureResidualAlert(reasons: string[]): string {
  return `A data-subject erasure is incomplete in the Snowflake warehouse. ${reasons.join("; ")}. Run the Snowflake purge step in docs/pii-erasure-runbook.md for the affected bookings.`;
}

/**
 * The purge SQL itself no longer runs (#1128).
 *
 * A separate condition from a residual, and deliberately its own alert key: this
 * one says the TOOL is broken, that one says a particular request is unfinished.
 * Sharing a key would let a clean residual audit clear a broken-SQL page, which
 * is how a check quietly stops being able to report (L53).
 */
export function purgeSqlBrokenAlert(reasons: string[]): string {
  return (
    `The Snowflake purge SQL for a deletion request no longer runs against the warehouse. ` +
    // alert-text-ok: each reason is already one short human line (the statement's
    // table plus a shortened Snowflake reason); the full text is in the log.
    `${reasons.join("; ")}. Nothing is broken for customers, but until this is fixed an erasure ` +
    `would be honored in the live database and NOT in the archive. The statements are in ` +
    `src/lib/snowflake/purge-sql.ts, quoted by docs/pii-erasure-runbook.md.`
  );
}

/** The purge SQL runs again. */
export function purgeSqlBrokenRecovery(): string {
  return (
    "The Snowflake purge SQL for a deletion request runs against the warehouse again. Every " +
    "statement compiled against the live schema, so a deletion request can be completed there. " +
    "No action is needed."
  );
}

/** The erasure is complete. */
export function erasureResidualRecovery(): string {
  return "The data-subject erasure that was incomplete in the Snowflake warehouse is now " +
          "complete. The audit finds no remaining data for the erased bookings, so the compliance " +
          "request is fully honored and the earlier page is cleared. No action is needed.";
}
