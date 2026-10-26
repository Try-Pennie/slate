/** PostgREST returns at most this many rows in one response. A read consumed as
 *  an aggregate must page past it or it silently truncates (#828, #35 / #166). */
export const PAGE_SIZE = 1000;

/** One page's answer, as a PostgREST builder resolves. */
export interface PageResult {
  data: unknown[] | null;
  error?: { message: string } | null;
}

/**
 * The query `selectAllPages` pages: a built, filtered select with no `.order()`
 * and no `.range()`. The helper orders it by the key, filters it to the rows
 * after the last key seen, and cuts each page itself.
 */
export interface PageableQuery {
  order(column: string, options?: { ascending?: boolean }): PageableQuery;
  gt(column: string, value: string | number): PageableQuery;
  or(filters: string): PageableQuery;
  range(from: number, to: number): PromiseLike<PageResult>;
}

/** A key value as PostgREST returns it and takes it back in a filter. */
type KeyValue = string | number;

/**
 * Read every row of a query, page by page. PostgREST caps a single response at
 * 1,000 rows, and a silently truncated read that is consumed as an aggregate
 * over-states or under-states coverage: an agent whose 1,001st busy block was
 * dropped looks free and gets overbooked, an OOO insight silently under-counts.
 * Throws on a read error rather than returning a short list that reads as "that
 * is all the rows there are".
 *
 * KEYSET paging, not OFFSET (2026-10-25). Every page is its own request with no
 * shared snapshot, and other writers commit between them. Under OFFSET a row
 * inserted before the boundary pushed the boundary row onto the next page as
 * well, so it was read twice (the buffer breach check paged one booking as
 * overlapping itself), and a row removed before the boundary made one row be
 * skipped. So each page asks for the rows whose key is AFTER the last key the
 * previous page returned, ordered by that key. A row present for the whole read
 * is then read exactly once whatever else changes; a row inserted mid read may be
 * missed, which is the same as it arriving just after the read.
 *
 * `uniqueKey` names a column, or a set of columns, unique and NOT NULL across the
 * table, normally the primary key (scripts/test-paged-read-keys.ts proves each
 * caller's against the migrations). A single column pages with `.gt()`; a
 * composite one with a tuple comparison written as an `.or()`, its values
 * double quoted so a comma, dot or parenthesis inside one is never read as
 * filter syntax. The key is the WHOLE order, so the query must carry no order of
 * its own (a leading caller order would make "key after the last" skip rows): a
 * caller wanting another sequence sorts the result. The select must return every
 * key column, since the next page is cut from the last row's key.
 *
 * Fails loud on what would otherwise corrupt an aggregate quietly: a row missing
 * its key, and a key returned twice (which keyset paging rules out, so seeing one
 * means the source did not honour the filter).
 *
 * `build` returns the query WITHOUT `.order()` or `.range()`; it is called once per
 * page, so it must build afresh. `context` labels the read in every thrown error
 * so a failure is greppable to its call site.
 */
export async function selectAllPages<T>(
  context: string,
  uniqueKey: string | readonly string[],
  build: () => PageableQuery,
): Promise<T[]> {
  const keys = typeof uniqueKey === "string" ? [uniqueKey] : [...uniqueKey];
  if (keys.length === 0 || keys.some((k) => k.trim() === "")) {
    throw new Error(`${context}: selectAllPages needs a unique key to order pages by`);
  }
  if (new Set(keys).size !== keys.length) {
    throw new Error(`${context}: selectAllPages was given a key naming one column twice: ${keys.join(", ")}`);
  }
  const rows: T[] = [];
  const seen = new Set<string>();
  let after: KeyValue[] | null = null;
  for (;;) {
    let q = build();
    refuseCallerShape(context, keys, q);
    if (after !== null) q = keys.length === 1 ? q.gt(keys[0]!, after[0]!) : q.or(tupleAfter(keys, after));
    for (const k of keys) q = q.order(k, { ascending: true });
    const { data, error } = await q.range(0, PAGE_SIZE - 1);
    if (error) throw new Error(`${context} read failed: ${error.message}`);
    const batch = (data ?? []) as T[];
    let last: KeyValue[] | null = null;
    for (const row of batch) {
      last = keyOf(context, keys, row);
      const id = JSON.stringify(last);
      if (seen.has(id)) {
        throw new Error(
          `${context}: key ${keys.join(", ")} = ${last.join(", ")} was returned twice; ` +
            `a paged read must return each row once, so the source did not honour the page filter`,
        );
      }
      seen.add(id);
    }
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
    after = last;
  }
}

/**
 * Rows from `selectAllPages` in the sequence a caller used to ask Postgres for:
 * by a timestamp column, ties broken by the key. The read itself is ordered by
 * its key alone (keyset paging owns the order), so a caller that cares about
 * time order sorts here. Sorts in place and returns the array. A stamp that does
 * not parse THROWS: compared as NaN it would land anywhere (L50).
 */
export function sortByStamp<T extends object>(
  context: string,
  rows: T[],
  stamp: keyof T & string,
  key: keyof T & string,
  direction: "asc" | "desc" = "asc",
): T[] {
  const ms = new Map<T, number>();
  for (const r of rows) {
    const v = (r as Record<string, unknown>)[stamp];
    const parsed = typeof v === "string" ? Date.parse(v) : NaN;
    if (!Number.isFinite(parsed)) throw new Error(`${context}: a row's ${stamp} is unreadable (${JSON.stringify(v)})`);
    ms.set(r, parsed);
  }
  const sign = direction === "asc" ? 1 : -1;
  return rows.sort((a, b) => {
    const d = ms.get(a)! - ms.get(b)!;
    if (d !== 0) return sign * d;
    const x = String((a as Record<string, unknown>)[key]);
    const y = String((b as Record<string, unknown>)[key]);
    return sign * (x < y ? -1 : x > y ? 1 : 0);
  });
}

/** The key tuple of one row, refusing a row that does not carry it. */
function keyOf(context: string, keys: readonly string[], row: unknown): KeyValue[] {
  return keys.map((k) => {
    const v = row !== null && typeof row === "object" ? (row as Record<string, unknown>)[k] : undefined;
    if (typeof v === "string" || (typeof v === "number" && Number.isFinite(v))) return v;
    throw new Error(
      `${context}: a row came back without a usable value for its key column ${k} (${v === undefined ? "missing" : JSON.stringify(v)}); ` +
        `the select must return every key column, or the next page cannot be cut`,
    );
  });
}

/**
 * Quote one value for a PostgREST logic tree. Inside double quotes the only
 * characters with meaning are the quote and the backslash, each escaped with a
 * backslash; everything else (commas, dots, colons, parentheses) is literal.
 */
export function quoteFilterValue(v: KeyValue): string {
  return `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The rows whose key tuple sorts after `after`, as a PostgREST `or` body:
 * (k1 > v1) or (k1 = v1 and k2 > v2) or (k1 = v1 and k2 = v2 and k3 > v3) ...
 */
export function tupleAfter(keys: readonly string[], after: readonly KeyValue[]): string {
  return keys
    .map((k, i) => {
      const gt = `${k}.gt.${quoteFilterValue(after[i]!)}`;
      if (i === 0) return gt;
      const eqs = keys.slice(0, i).map((p, j) => `${p}.eq.${quoteFilterValue(after[j]!)}`);
      return `and(${[...eqs, gt].join(",")})`;
    })
    .join(",");
}

/**
 * A real PostgREST builder carries its parameters on `url`. Refuse a query that
 * already orders itself (the key must be the whole order), and, for a composite
 * key, one carrying its own `or` (a second `or` parameter beside the tuple
 * comparison is not a shape this helper has proved). A source without a `url`
 * (a test fake) is judged by scripts/test-paged-read-keys.ts, which reads the
 * call sites.
 */
function refuseCallerShape(context: string, keys: readonly string[], q: PageableQuery): void {
  const url = (q as { url?: unknown }).url;
  if (!(url instanceof URL)) return;
  const own = url.searchParams.get("order");
  if (own !== null) {
    throw new Error(
      `${context}: the query orders itself (${own}); selectAllPages orders by its key alone, so sort the result instead`,
    );
  }
  if (keys.length > 1 && url.searchParams.has("or")) {
    throw new Error(`${context}: a composite key cannot page a query that carries its own or filter`);
  }
}
