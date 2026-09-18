/**
 * What the Snowflake mirror may never carry, and the one list that enforces it
 * three ways (#2564).
 *
 * The warehouse has a wider and different audience than Slate's database, and it
 * held `bookings.manage_token`: not a description of the person but a CREDENTIAL,
 * since whoever holds it can reschedule or cancel that booking with no other
 * authentication. Mirroring it made warehouse read access equal to booking control
 * access.
 *
 * The review named that column. Measured against production on 2026-09-18 it was
 * the SMALLER of two routes: 2,392 bookings carried a token, while 6,522 of 6,550
 * webhook delivery payloads carried `manage_url`, which is that same token in a
 * link, inside a VARIANT column mirrored whole. Fixing the column alone would have
 * left the credential in the warehouse and read as complete.
 *
 * So the credential is declared ONCE here and three things are derived from it:
 *
 *   - the export redaction, applied in `buildMergeSql`, which is the single point
 *     every merge path goes through (the incremental lane, the backfill lane and
 *     `reexportByIds` all build their SQL there). A new export path cannot opt out
 *     of a redaction it cannot reach around (L621).
 *   - the warehouse cleanup, for the rows already mirrored, which no future export
 *     will revisit.
 *   - `scripts/test-mirror-credentials.ts`, which fails the build when a column
 *     whose name reads like a credential joins the mirror without being declared
 *     here or explicitly reasoned about.
 *
 * Everything in this module is pure. The IO lives in `credential-sweep.ts`.
 */

export interface MirrorCredential {
  /** Mirrored table the value lives in. */
  table: string;
  /** Exported column. For a JSON credential this is the VARIANT column itself. */
  column: string;
  /** Set when the credential is a KEY INSIDE a JSON column rather than the column. */
  jsonKey?: string;
  /** What holding this value lets somebody DO. Not what it is: the reason has to
   *  answer whether a new entry belongs here, and "a token" does not. */
  why: string;
}

export const MIRROR_CREDENTIALS: MirrorCredential[] = [
  {
    table: "bookings",
    column: "manage_token",
    why:
      "whoever holds it can reschedule or cancel that booking with no other authentication, " +
      "so a warehouse reader holds booking control",
  },
  {
    table: "webhook_deliveries",
    column: "payload",
    jsonKey: "manage_url",
    why:
      "the manage URL embeds the same manage_token, so mirroring the delivery payload " +
      "mirrors the credential by a second route with more rows than the first",
  },
];

export type Row = Record<string, unknown>;

/**
 * Strip every declared credential from a batch on its way to the warehouse.
 *
 * Returns new row objects rather than editing the caller's: the export reads the
 * last row's `id` and watermark AFTER the merge to advance its cursor, and a
 * redaction that reached those would leave the lane re-exporting one page for
 * ever. Both are left untouched here, and a test pins that.
 *
 * A payload that is not an object is returned as it came. A null payload is
 * legitimate, and throwing would abort a whole export batch over a row this has
 * nothing to do to.
 */
export function redactMirrorCredentials(table: string, rows: Row[]): Row[] {
  const applicable = MIRROR_CREDENTIALS.filter((c) => c.table === table);
  if (applicable.length === 0) return rows;
  return rows.map((row) => {
    let next: Row | null = null;
    for (const c of applicable) {
      if (c.jsonKey) {
        const value = row[c.column];
        if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
        const payload = value as Record<string, unknown>;
        if (!(c.jsonKey in payload)) continue;
        next = next ?? { ...row };
        const copy = { ...payload };
        delete copy[c.jsonKey];
        next[c.column] = copy;
      } else {
        if (row[c.column] === null || row[c.column] === undefined) continue;
        next = next ?? { ...row };
        next[c.column] = null;
      }
    }
    return next ?? row;
  });
}

/** Fully qualified mirror table name, matching the erasure purge's own form. */
function qualified(table: string): string {
  return `SLATE.PUBLIC.${table}`;
}

export interface CredentialStatement {
  /** What this statement clears, for the log and for the failure message. */
  label: string;
  sql: string;
}

/**
 * Blank the credentials already mirrored.
 *
 * Every statement is bounded by `is not null`, so once the warehouse is settled
 * each one matches no rows and costs a predicate rather than a rewrite.
 *
 * The JSON case uses `object_insert(payload, <key>, null, true)`, which REMOVES
 * the key: Snowflake omits a key-value pair whose value is SQL NULL, and the TRUE
 * flag is required because the key is already present. It deliberately does not
 * empty the payload, because `payload:booking_id` is the only key the erasure
 * verify and the audit lane can find these rows by (#1201).
 */
export function buildCredentialBlankStatements(): CredentialStatement[] {
  return MIRROR_CREDENTIALS.map((c) =>
    c.jsonKey
      ? {
          label: `${c.table}.${c.column}:${c.jsonKey}`,
          sql:
            `update ${qualified(c.table)}\n` +
            `   set ${c.column} = object_insert(${c.column}, '${c.jsonKey}', null, true)\n` +
            ` where ${c.column}:${c.jsonKey} is not null`,
        }
      : {
          label: `${c.table}.${c.column}`,
          sql:
            `update ${qualified(c.table)}\n` +
            `   set ${c.column} = null\n` +
            ` where ${c.column} is not null`,
        },
  );
}

/** One residual count per credential, in the order the statements are built. */
export const CREDENTIAL_RESIDUAL_COLUMNS: string[] = MIRROR_CREDENTIALS.map(
  (c) => `${c.table}_${c.jsonKey ?? c.column}_residual`,
);

/**
 * Count what is LEFT after the blanking, one subselect per credential, each
 * reading its OWN field. A residual query that counted one field for two
 * credentials would certify the warehouse clean while the other still held the
 * value, which is exactly what #1205 was.
 */
export function buildCredentialResidualStatement(): string {
  const parts = MIRROR_CREDENTIALS.map((c, i) => {
    const predicate = c.jsonKey ? `${c.column}:${c.jsonKey} is not null` : `${c.column} is not null`;
    return `  (select count(*) from ${qualified(c.table)} where ${predicate}) as ${CREDENTIAL_RESIDUAL_COLUMNS[i]}`;
  });
  return `select\n${parts.join(",\n")}`;
}
