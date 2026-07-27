/**
 * The single skip predicate for in-place-redacted rows (#1118).
 *
 * When a row's PII is redacted in place (retention or DSR erasure), two lanes
 * must agree about it, or they fight:
 *
 *   - The export lane must STOP re-exporting it. `bookings`/`webhook_deliveries`
 *     are keyed on `updated_at`, and redacting a row bumps `updated_at` (the
 *     `set_updated_at` trigger), so without this filter the next tick re-MERGEs
 *     the blanked row over Snowflake's full-fidelity copy, the exact clobber
 *     the mirror exists to avoid. With it, Snowflake freezes at the last
 *     full-fidelity version.
 *   - The reconcile count must EXCLUDE it. Erasure is not export-gated (a DSR
 *     runs immediately), so a row erased before its first export never reaches
 *     Snowflake; if reconcile counted it on the Supabase side it would read as
 *     permanent "Snowflake is behind" drift, which trips `mirrorReadyForDeletion`
 *     and freezes the whole retention lane.
 *
 * Applying the SAME predicate in both places is what keeps them consistent, so
 * it lives here once rather than being re-derived at each call site.
 *
 * Empty for tables with no in-place redaction (append-only tables, and
 * `booking_outbox` whose retention is a hard delete, not a redaction).
 */

/** The minimal PostgREST builder surface the skip filters chain onto. */
export interface RedactionFilterable {
  is(column: string, value: null): this;
  eq(column: string, value: boolean): this;
}

/**
 * Chain the in-place-redaction skip filter for `table` onto `builder`, AND-ed
 * with whatever filters are already on it. Returns the builder unchanged for a
 * table that has no in-place redaction.
 */
export function applySkipRedacted<B extends RedactionFilterable>(table: string, builder: B): B {
  switch (table) {
    case "bookings":
      // Redacted-in-place rows carry a non-null pii_redacted_at (#1071 retention
      // and the #1072 erasure function both stamp it); keep only the un-redacted.
      return builder.is("pii_redacted_at", null);
    case "webhook_deliveries":
      // Blanked payloads carry payload_erased = true (#1073); keep only intact.
      return builder.eq("payload_erased", false);
    default:
      return builder;
  }
}
