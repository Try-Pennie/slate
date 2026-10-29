// An in-memory `alert_state` for vitest suites that drive the REAL alert dispatcher
// (#3801). Imported only by tests; the name keeps it out of vitest's suite glob.
//
// It behaves the way PostgREST and Postgres do on the calls the dispatcher makes,
// because the repeat rule lives in what the dispatcher reads back: a row carries
// `last_sent_at` plus the 0184 columns (`subjects`, `band`, `opened_at`), an upsert
// MERGES the columns it names into an existing row (PostgREST's merge-duplicates),
// an insert the primary key refuses answers 23505, and an update or delete filtered
// on `last_sent_at` matches only while the row still holds that stamp. A fake that
// dropped the extra columns would read every post as the first under the rule.

export interface AlertStateRow {
  last_sent_at: string;
  subjects?: string[] | null;
  band?: number | null;
  opened_at?: string | null;
}

/** The store, one per test file (vitest isolates each file's module registry). */
export const alertStateRows = new Map<string, AlertStateRow>();

/** Keys whose single row read is refused, so a test can make a read fail. */
export const refusedAlertStateReads = new Set<string>();

/**
 * Keys an upsert may not write: "refuse" answers an error, as a refused statement does;
 * "throw" rejects, as a dropped connection does. An upsert naming one writes nothing.
 */
export const refusedAlertStateWrites = new Map<string, "refuse" | "throw">();

/**
 * Stand in for a database 0184 has not reached: a read naming its columns answers
 * Postgres's undefined column (42703), and a write carrying them is refused.
 */
export const alertStateSchema = { withoutRepeatColumns: false };
const REPEAT_COLUMNS = ["subjects", "band", "opened_at"];
const namesRepeatColumn = (row: object) => REPEAT_COLUMNS.some((c) => c in row);
const NO_COLUMN = { code: "42703", message: 'column alert_state.subjects does not exist' };

type Filters = Map<string, string>;
type Result = { data?: unknown; error: unknown };

function chain(apply: (f: Filters) => Result) {
  const filters: Filters = new Map();
  const b = {
    eq: (col: string, val: string) => {
      filters.set(col, val);
      return b;
    },
    select: async () => apply(filters),
    maybeSingle: async () => apply(filters),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(apply(filters)).then(res, rej),
  };
  return b;
}

function matching(f: Filters): string | null {
  const key = f.get("key");
  if (key === undefined || !alertStateRows.has(key)) return null;
  const stamp = f.get("last_sent_at");
  return stamp === undefined || alertStateRows.get(key)?.last_sent_at === stamp ? key : null;
}

function selected(row: AlertStateRow, key: string): Record<string, unknown> {
  return {
    key,
    last_sent_at: row.last_sent_at,
    subjects: row.subjects ?? null,
    band: row.band ?? null,
    opened_at: row.opened_at ?? null,
  };
}

/** What `vi.mock("@/lib/supabase/admin", ...)` should return. */
export function fakeSupabaseAdminModule() {
  return {
    supabaseAdmin: () => ({
      from: () => ({
        select: (columns = "*") => ({
          ...chain((f) => {
            const key = f.get("key") ?? "";
            if (refusedAlertStateReads.has(key)) return { data: null, error: { message: "statement timeout" } };
            if (alertStateSchema.withoutRepeatColumns && REPEAT_COLUMNS.some((c) => columns.includes(c))) {
              return { data: null, error: NO_COLUMN };
            }
            const row = alertStateRows.get(key);
            return { data: row ? selected(row, key) : null, error: null };
          }),
          // A membership read answers every row it finds with its stamp (#3802 reads
          // the stamps of several keys at once), and is refused whole when any key it
          // names is one a test has made unreadable, as one failed statement would be.
          in: async (_col: string, keys: string[]) => {
            if (keys.some((k) => refusedAlertStateReads.has(k))) {
              return { data: null, error: { message: "statement timeout" } };
            }
            return {
              data: keys
                .filter((k) => alertStateRows.has(k))
                .map((key) => ({ key, last_sent_at: (alertStateRows.get(key) as AlertStateRow).last_sent_at })),
              error: null,
            };
          },
        }),
        insert: async (row: AlertStateRow & { key: string }) => {
          if (alertStateSchema.withoutRepeatColumns && namesRepeatColumn(row)) return { error: NO_COLUMN };
          if (alertStateRows.has(row.key)) return { error: { code: "23505", message: "duplicate key" } };
          const { key, ...rest } = row;
          alertStateRows.set(key, rest);
          return { error: null };
        },
        update: (values: Partial<AlertStateRow>) =>
          chain((f) => {
            if (alertStateSchema.withoutRepeatColumns && namesRepeatColumn(values)) return { data: null, error: NO_COLUMN };
            const key = matching(f);
            if (key === null) return { data: [], error: null };
            alertStateRows.set(key, { ...(alertStateRows.get(key) as AlertStateRow), ...values });
            return { data: [{ key }], error: null };
          }),
        // One row or several, as PostgREST takes either; all or nothing, as one statement.
        upsert: async (rows: (AlertStateRow & { key: string }) | (AlertStateRow & { key: string })[]) => {
          const list = Array.isArray(rows) ? rows : [rows];
          if (alertStateSchema.withoutRepeatColumns && list.some(namesRepeatColumn)) return { error: NO_COLUMN };
          const refusals = list.map((r) => refusedAlertStateWrites.get(r.key)).filter((v) => v !== undefined);
          if (refusals.includes("throw")) throw new Error("fetch failed: connection reset");
          if (refusals.length > 0) return { error: { message: "permission denied for table alert_state" } };
          for (const { key, ...rest } of list) {
            alertStateRows.set(key, { ...(alertStateRows.get(key) ?? { last_sent_at: rest.last_sent_at }), ...rest });
          }
          return { error: null };
        },
        delete: () => ({
          ...chain((f) => {
            const key = matching(f);
            if (key === null) return { data: [], error: null };
            alertStateRows.delete(key);
            return { data: [{ key }], error: null };
          }),
          in: async (_col: string, keys: string[]) => {
            for (const k of keys) alertStateRows.delete(k);
            return { error: null };
          },
        }),
      }),
    }),
  };
}
