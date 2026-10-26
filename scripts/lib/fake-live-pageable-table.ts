// A fake table for `selectAllPages` that other writers change WHILE it is being
// read, the way production's tables are (2026-10-25: a booking inserted between
// two page reads put the boundary row on both pages, and the buffer breach check
// paged one booking as overlapping itself).
//
// Each page request is answered from the table as it stands at that moment, then
// `between(pageIndex)` runs, like a concurrent writer committing before the next
// request. The query honours what PostgREST would: `.order()` on any number of
// columns, `.gt()`, and `.or()` written in PostgREST's logic tree grammar
// (`a.gt."x",and(a.eq."x",b.gt."y")`), parsed here from the grammar rather than
// from whatever `selectAllPages` happens to emit, so a filter the helper builds
// wrongly is answered wrongly rather than agreed with. Quoted values take
// backslash escapes, as PostgREST's do.

import type { PageableQuery, PageResult } from "../../src/lib/supabase/paginate.ts";

export type FakeRow = Record<string, string | number | boolean | null>;

type Cond =
  | { kind: "cmp"; column: string; op: string; value: string }
  | { kind: "and" | "or"; items: Cond[] };

/** Parse a PostgREST logic tree body: the text inside `or=( ... )`. */
export function parseLogicTree(text: string): Cond[] {
  let i = 0;
  const fail = (why: string): never => {
    throw new Error(`fake table: cannot parse filter ${JSON.stringify(text)} at ${i}: ${why}`);
  };
  const list = (): Cond[] => {
    const items: Cond[] = [cond()];
    while (text[i] === ",") {
      i++;
      items.push(cond());
    }
    return items;
  };
  const word = (): string => {
    const start = i;
    while (i < text.length && !",.()\"".includes(text[i]!)) i++;
    if (i === start) fail("expected a name");
    return text.slice(start, i);
  };
  const value = (): string => {
    if (text[i] !== '"') {
      const start = i;
      while (i < text.length && !",()".includes(text[i]!)) i++;
      return text.slice(start, i);
    }
    i++;
    let out = "";
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") i++;
      out += text[i] ?? "";
      i++;
    }
    if (text[i] !== '"') fail("an unclosed quote");
    i++;
    return out;
  };
  const cond = (): Cond => {
    const name = word();
    if ((name === "and" || name === "or") && text[i] === "(") {
      i++;
      const items = list();
      if (text[i] !== ")") fail("expected )");
      i++;
      return { kind: name, items };
    }
    if (text[i] !== ".") fail("expected .");
    i++;
    const op = word();
    if (text[i] !== ".") fail("expected . after the operator");
    i++;
    return { kind: "cmp", column: name, op, value: value() };
  };
  const out = list();
  if (i !== text.length) fail("trailing text");
  return out;
}

/** Postgres comparison, close enough for keys: numbers numerically, text by code unit. */
function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function holds(row: FakeRow, c: Cond): boolean {
  if (c.kind === "and") return c.items.every((x) => holds(row, x));
  if (c.kind === "or") return c.items.some((x) => holds(row, x));
  const cell = row[c.column];
  if (cell === undefined) throw new Error(`fake table: filter names column ${c.column}, which the rows lack`);
  const cmp = compare(cell, typeof cell === "number" ? Number(c.value) : c.value);
  switch (c.op) {
    case "eq":
      return cmp === 0;
    case "gt":
      return cmp > 0;
    case "gte":
      return cmp >= 0;
    case "lt":
      return cmp < 0;
    default:
      throw new Error(`fake table: operator ${c.op} is not modelled`);
  }
}

/** The query a caller's chain builds: the caller's own filters, then the helper's. */
export interface LiveQuery extends PageableQuery {
  select(columns?: string): LiveQuery;
  eq(column: string, value: string | number | boolean): LiveQuery;
  in(column: string, values: readonly (string | number)[]): LiveQuery;
  gte(column: string, value: string | number): LiveQuery;
  lt(column: string, value: string | number): LiveQuery;
}

export interface LiveTable {
  /** The rows as they stand now. Mutate it in `between` to model another writer. */
  rows: FakeRow[];
  /** What `selectAllPages` hands each page: a fresh query, as `build` must return. */
  build: () => LiveQuery;
  /** Every page request, in order: its filters and order, for positive controls. */
  requests: { filters: Cond[][]; order: string[]; range: [number, number] }[];
}

/**
 * A live table. `between(pageIndex)` runs after page `pageIndex` is served and
 * before the next request is answered.
 *
 * `ignoreKeyset` models a source that drops the helper's `gt`/`or` filter, so the
 * same rows come back on every page: the shape the helper's repeat check exists to
 * refuse rather than hand on.
 */
export function liveTable(
  rows: FakeRow[],
  between: (pageIndex: number, table: LiveTable) => void = () => {},
  opts: { ignoreKeyset?: boolean } = {},
): LiveTable {
  let served = 0;
  const table: LiveTable = {
    rows,
    requests: [],
    build: () => {
      const filters: Cond[][] = [];
      const order: string[] = [];
      const cmp = (column: string, op: string, value: string | number | boolean) =>
        filters.push([{ kind: "cmp", column, op, value: String(value) }]);
      const q: LiveQuery = {
        select: () => q,
        eq: (column, value) => (cmp(column, "eq", value), q),
        in: (column, values) => {
          filters.push([{ kind: "or", items: values.map((v) => ({ kind: "cmp", column, op: "eq", value: String(v) })) }]);
          return q;
        },
        gte: (column, value) => (cmp(column, "gte", value), q),
        lt: (column, value) => (cmp(column, "lt", value), q),
        order: (column) => {
          order.push(column);
          return q;
        },
        gt: (column, value) => {
          if (!opts.ignoreKeyset) cmp(column, "gt", value);
          return q;
        },
        or: (text) => {
          // One `or` parameter is one disjunction over its items.
          if (!opts.ignoreKeyset) filters.push([{ kind: "or", items: parseLogicTree(text) }]);
          return q;
        },
        range: (from, to): PromiseLike<PageResult> => {
          table.requests.push({ filters: filters.map((f) => [...f]), order: [...order], range: [from, to] });
          const matching = table.rows.filter((r) => filters.every((group) => group.every((c) => holds(r, c))));
          const sorted = matching.slice().sort((a, b) => {
            for (const col of order) {
              const c = compare(a[col], b[col]);
              if (c !== 0) return c;
            }
            return 0;
          });
          const data = sorted.slice(from, to + 1).map((r) => ({ ...r }));
          between(served++, table);
          return Promise.resolve({ data, error: null });
        },
      };
      return q;
    },
  };
  return table;
}
