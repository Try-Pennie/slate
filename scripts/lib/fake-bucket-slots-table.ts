/**
 * An in-memory `bucket_slots` that EVALUATES the filters the writers send (#3324),
 * rather than recording them, so a race between a full compute and a booking's splice
 * can be driven as an interleaving and judged by the row it leaves.
 *
 * It reads the same shapes PostgREST does: `eq`, `lt`, `gte`, `is`, `in`, and an
 * `or` expression that may nest `and(...)`, over plain columns and over the json
 * paths the writers filter on (`payload->splice->>fenceAt`). Timestamp COLUMNS compare
 * as instants, the way Postgres compares timestamptz; a json path is TEXT, the way
 * `->>` yields it, so a fence stamp compares as a string. That difference is real and
 * is why the writers only ever store `toISOString()` stamps in the payload.
 *
 * Shared because two suites need it: `test-slot-row-write.ts` and
 * `test-booked-splice-race.ts`. It lives outside any `test-*.ts` because the runner
 * globs that pattern as a suite.
 */

export interface SlotRow {
  bucket_code: string;
  payload: unknown;
  computed_at: string;
  invalidated_at: string | null;
  /** #3388, migration 0202. Optional so a fixture can leave it out. */
  compute_started_at?: string | null;
}

type Filter = (r: SlotRow) => boolean;

const TIMESTAMP_COLUMNS = new Set(["computed_at", "invalidated_at", "compute_started_at"]);

/** A column or json path's value, as Postgres would hand it to a comparison. */
function cell(r: SlotRow, col: string): string | null {
  if (!col.includes("->")) {
    const v = (r as unknown as Record<string, unknown>)[col];
    return v === null || v === undefined ? null : String(v);
  }
  // `a->b->>c`: walk objects with `->`, the last hop with `->>` yields text.
  const parts = col.split(/->>?/);
  let v: unknown = (r as unknown as Record<string, unknown>)[parts[0]!];
  for (const p of parts.slice(1)) {
    if (v === null || typeof v !== "object") return null;
    v = (v as Record<string, unknown>)[p];
  }
  return v === null || v === undefined ? null : String(v);
}

function compare(col: string, a: string, b: string): number {
  if (TIMESTAMP_COLUMNS.has(col)) return Date.parse(a) - Date.parse(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

function leaf(col: string, op: string, val: string): Filter {
  return (r) => {
    const v = cell(r, col);
    if (op === "is") {
      if (val !== "null") throw new Error(`fake cannot read is.${val}`);
      return v === null;
    }
    if (v === null) return false;
    if (op === "eq") return compare(col, v, val) === 0;
    if (op === "lt") return compare(col, v, val) < 0;
    if (op === "gte") return compare(col, v, val) >= 0;
    throw new Error(`fake cannot read operator ${op}`);
  };
}

/** Split on commas that are not inside parentheses. */
function topLevel(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of expr) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function parseTerm(term: string): Filter {
  if (term.startsWith("and(") && term.endsWith(")")) {
    const parts = topLevel(term.slice(4, -1)).map(parseTerm);
    return (r) => parts.every((f) => f(r));
  }
  if (term.startsWith("or(") && term.endsWith(")")) return parseOr(term.slice(3, -1));
  const [col, op, ...rest] = term.split(".");
  return leaf(col!, op!, rest.join("."));
}

function parseOr(expr: string): Filter {
  const parts = topLevel(expr).map(parseTerm);
  return (r) => parts.some((f) => f(r));
}

export interface FakeTable {
  db: never;
  rows: SlotRow[];
  /** How many statements reached the table, by kind. */
  statements: { select: number; update: number; insert: number };
  /** Run before the NEXT update statement is evaluated, once: how a test lands a
   *  competing write between a writer's read and its write. */
  beforeNextUpdate(fn: () => Promise<void> | void): void;
}

export function fakeBucketSlotsTable(
  initial: SlotRow[],
  /**
   * Columns this table does NOT have, answered as the real one answers a database
   * a migration has not reached yet: a read naming one gets Postgres's undefined
   * column (42703), a write naming one gets PostgREST's unknown column (PGRST204).
   */
  opts: { withoutColumns?: string[] } = {},
): FakeTable {
  const rows = initial;
  const absent = new Set(opts.withoutColumns ?? []);
  const readNames = (cols: string) => cols.split(",").map((c) => c.trim()).find((c) => absent.has(c));
  const writeNames = (values: object) => Object.keys(values).find((c) => absent.has(c));
  const noColumnRead = (c: string) => ({
    data: null,
    error: { code: "42703", message: `column bucket_slots.${c} does not exist` },
  });
  const noColumnWrite = (c: string) => ({
    data: null,
    error: { code: "PGRST204", message: `Could not find the '${c}' column of 'bucket_slots' in the schema cache` },
  });
  const statements = { select: 0, update: 0, insert: 0 };
  let hook: (() => Promise<void> | void) | null = null;

  const builder = (filters: Filter[], run: () => Promise<unknown>) => {
    const b: Record<string, unknown> = {
      eq(col: string, val: unknown) {
        filters.push(leaf(col, "eq", String(val)));
        return b;
      },
      lt(col: string, val: unknown) {
        filters.push(leaf(col, "lt", String(val)));
        return b;
      },
      gte(col: string, val: unknown) {
        filters.push(leaf(col, "gte", String(val)));
        return b;
      },
      is(col: string, val: null) {
        if (val !== null) throw new Error("fake reads is(col, null) only");
        filters.push(leaf(col, "is", "null"));
        return b;
      },
      in(col: string, vals: unknown[]) {
        const set = new Set(vals.map(String));
        filters.push((r) => {
          const v = cell(r, col);
          return v !== null && set.has(v);
        });
        return b;
      },
      or(expr: string) {
        filters.push(parseOr(expr));
        return b;
      },
      then(onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) {
        return run().then(onOk, onErr);
      },
    };
    return b;
  };

  const matching = (filters: Filter[]) => rows.filter((r) => filters.every((f) => f(r)));
  const copy = (r: SlotRow): SlotRow => JSON.parse(JSON.stringify(r)) as SlotRow;

  const db = {
    from(_table: string) {
      return {
        select(cols: string) {
          const filters: Filter[] = [];
          const missing = readNames(cols);
          const b = builder(filters, async () => {
            statements.select++;
            if (missing) return noColumnRead(missing);
            return { data: matching(filters).map(copy), error: null };
          });
          b.maybeSingle = async () => {
            statements.select++;
            if (missing) return noColumnRead(missing);
            const hit = matching(filters);
            return { data: hit[0] ? copy(hit[0]) : null, error: null };
          };
          return b;
        },
        update(values: Partial<SlotRow>) {
          const filters: Filter[] = [];
          const b = builder(filters, async () => ({ data: null, error: null }));
          b.select = async () => {
            if (hook) {
              const h = hook;
              hook = null;
              await h();
            }
            statements.update++;
            const missing = writeNames(values);
            if (missing) return noColumnWrite(missing);
            const hit = matching(filters);
            for (const r of hit) Object.assign(r, JSON.parse(JSON.stringify(values)));
            return { data: hit.map((r) => ({ bucket_code: r.bucket_code })), error: null };
          };
          return b;
        },
        insert: async (values: SlotRow) => {
          statements.insert++;
          const missing = writeNames(values);
          if (missing) return noColumnWrite(missing);
          if (rows.some((r) => r.bucket_code === values.bucket_code)) {
            return { data: null, error: { code: "23505", message: "duplicate key" } };
          }
          rows.push({ invalidated_at: null, ...JSON.parse(JSON.stringify(values)) });
          return { data: null, error: null };
        },
      };
    },
  };

  return {
    db: db as never,
    rows,
    statements,
    beforeNextUpdate(fn) {
      hook = fn;
    },
  };
}
