/**
 * An in-memory `event_types` that EVALUATES the filters a writer sends and moves
 * `updated_at` on every write, the way the table's `set_updated_at` trigger does
 * (migration 0161), so two editors drawn from one row can be driven as a sequence
 * of saves and judged by the row they leave (#3798).
 *
 * It reads the shapes the event type code sends through supabase-js:
 *   - `select(cols).eq(..).eq(..).maybeSingle()` and the same chain awaited as a list,
 *   - `update(patch, { count: "exact" }).eq(..)...` awaited for `{ error, count }`,
 *   - `insert(row).select("id").single()`.
 * Only `eq` is evaluated; anything else throws, so a new query shape fails loudly
 * rather than matching everything.
 *
 * Faults are one shot and named for what they stand for: an unreadable read, a
 * failed write, a write whose count PostgREST did not report, and a write that
 * lands from somewhere else between a reader's read and its own write.
 *
 * Shared because the store suite and the editor suites both drive it. It lives
 * outside any `test-*.ts` because the node runner globs that pattern as a suite.
 */

export type EventTypeRow = Record<string, unknown> & { id: string; org_id: string; updated_at: string };

type Result<T> = { data: T; error: { message: string } | null };

export interface FakeEventTypesTable {
  /** The rows as they stand. Mutate freely to seed a case. */
  rows: EventTypeRow[];
  /** Every update the table was sent, in order, with the filters it carried. */
  updates: { patch: Record<string, unknown>; filters: [string, unknown][]; count: number }[];
  /** Rows inserted, in order. */
  inserted: Record<string, unknown>[];
  faults: {
    /** The next read answers with this error and no data. */
    read: { message: string } | null;
    /** The next update answers with this error and writes nothing. */
    update: { message: string } | null;
    /** The next update lands but reports a null count, as PostgREST can. */
    nullCount: boolean;
    /** Run once, just before the next update is evaluated: another writer. */
    beforeUpdate: (() => void) | null;
  };
  /** A supabase-js shaped client whose `from("event_types")` is this table. */
  client: { from(table: string): unknown };
  /** Write a row as another session would, through the trigger. */
  writeElsewhere(id: string, patch: Record<string, unknown>): void;
}

export function fakeEventTypesTable(seed: EventTypeRow[]): FakeEventTypesTable {
  let tick = 0;
  /** A fresh, strictly later stamp, in the shape Postgres returns a timestamptz. */
  const nextStamp = () => {
    tick += 1;
    return `2026-10-23T10:00:00.${String(tick).padStart(6, "0")}+00:00`;
  };

  const t: FakeEventTypesTable = {
    rows: seed.map((r) => ({ ...r })),
    updates: [],
    inserted: [],
    faults: { read: null, update: null, nullCount: false, beforeUpdate: null },
    client: { from },
    writeElsewhere(id, patch) {
      const row = t.rows.find((r) => r.id === id);
      if (!row) throw new Error(`fake event_types has no row ${id}`);
      Object.assign(row, patch, { updated_at: nextStamp() });
    },
  };

  function matches(row: EventTypeRow, filters: [string, unknown][]): boolean {
    return filters.every(([col, val]) => row[col] === val);
  }

  function project(row: EventTypeRow, cols: string): Record<string, unknown> {
    if (cols.trim() === "*") return { ...row };
    const out: Record<string, unknown> = {};
    for (const c of cols.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!(c in row)) throw new Error(`fake event_types has no column ${c}`);
      out[c] = row[c];
    }
    return out;
  }

  function takeReadFault(): { message: string } | null {
    const f = t.faults.read;
    t.faults.read = null;
    return f;
  }

  function select(cols: string) {
    const filters: [string, unknown][] = [];
    const found = () => t.rows.filter((r) => matches(r, filters)).map((r) => project(r, cols));
    const q = {
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return q;
      },
      async maybeSingle(): Promise<Result<Record<string, unknown> | null>> {
        const fault = takeReadFault();
        if (fault) return { data: null, error: fault };
        const rows = found();
        if (rows.length > 1) return { data: null, error: { message: "more than one row" } };
        return { data: rows[0] ?? null, error: null };
      },
      then<R>(res: (v: Result<Record<string, unknown>[] | null>) => R) {
        const fault = takeReadFault();
        return Promise.resolve(res(fault ? { data: null, error: fault } : { data: found(), error: null }));
      },
    };
    return q;
  }

  function update(patch: Record<string, unknown>, opts?: { count?: string }) {
    const filters: [string, unknown][] = [];
    const q = {
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return q;
      },
      then<R>(res: (v: { error: { message: string } | null; count: number | null }) => R) {
        const before = t.faults.beforeUpdate;
        t.faults.beforeUpdate = null;
        before?.();
        const fault = t.faults.update;
        t.faults.update = null;
        if (fault) return Promise.resolve(res({ error: fault, count: null }));
        const hit = t.rows.filter((r) => matches(r, filters));
        for (const row of hit) Object.assign(row, patch, { updated_at: nextStamp() });
        t.updates.push({ patch, filters: [...filters], count: hit.length });
        const nullCount = t.faults.nullCount;
        t.faults.nullCount = false;
        const count = opts?.count === "exact" && !nullCount ? hit.length : null;
        return Promise.resolve(res({ error: null, count }));
      },
    };
    return q;
  }

  function insert(row: Record<string, unknown>) {
    const id = `et-new-${t.inserted.length + 1}`;
    t.inserted.push(row);
    t.rows.push({ ...row, id, updated_at: nextStamp() } as EventTypeRow);
    return { select: () => ({ single: async () => ({ data: { id }, error: null }) }) };
  }

  function from(table: string) {
    if (table !== "event_types") throw new Error(`fake event_types was asked for ${table}`);
    return { select, update, insert };
  }

  return t;
}
