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

/**
 * The mirror disagrees with the live database.
 *
 * Says nothing about the cause: each reason carries the cause the check actually
 * measured (`driftCause`, reconcile.ts). The old wording asserted "the export lane
 * may be lagging or failing" for every drift, and on 2026-08-03 that was the one
 * cause that was not happening (#1230), while the real one, rows inserted behind
 * the lane's strictly forward watermark, went unnamed.
 *
 * It also promised "deletion (when built) must not run until this clears". That is
 * now doubly wrong: deletion IS built, and it is gated on the Supabase-only export
 * lag reading rather than on this comparison (#1139), so pointing a reader here
 * during a retention question sends them to the wrong lane.
 */
export function snowflakeDriftAlert(reasons: string[]): string {
  return (
    `The Snowflake analytics mirror is out of sync with the live database. ${reasons.join("; ")}. ` +
    // The remedy stays in the reason, which is the only part that knows the cause:
    // a failed positive control reaches this same wrapper, and there re-exporting
    // stranded rows is advice for a problem the reader does not have.
    `Retention deletion is gated on the export lag reading, not on this comparison, so it keeps ` +
    `running either way.`
  );
}

/**
 * The mirror agrees again.
 *
 * Deliberately does not say the export lane caught up (#1230). The drift it clears
 * may have been rows stranded behind the watermark and repaired by a re-export,
 * with the lane current throughout, and the all-clear may claim only what the
 * lane measured: that the counts agree.
 */
export function snowflakeDriftRecovery(): string {
  return "The Snowflake analytics mirror matches the live database again. Every mirrored table is " +
          "back within tolerance and the positive control found its known row, so anything that was " +
          "waiting on the mirror being complete can proceed. No action is needed.";
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
