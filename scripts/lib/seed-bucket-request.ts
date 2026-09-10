/**
 * How the bucket seeder REFRESHES an existing bucket (#2218).
 *
 * It used to send the sixty refresh rows as one POST carrying
 * `Prefer: resolution=merge-duplicates`. PostgREST builds that as an INSERT with
 * an ON CONFLICT clause, so every column the row omits is NULL on the tentative
 * insert, and `buckets.event_type_id` is NOT NULL. The seeder therefore answered
 * 400 `23502` on its first row and wrote nothing, which is what it had been
 * doing since #1935 stopped it writing `event_type_id` and made a refresh row
 * partial. Nobody noticed because it is a hand run command.
 *
 * A refresh of a row that exists is an UPDATE, and an update owes nothing to the
 * columns it does not name. The identity is deliberately kept OUT of the body and
 * expressed as a filter, so the request cannot be turned back into an insert by
 * changing the verb alone.
 *
 * Lives in `scripts/lib` because `scripts/test-*.ts` is the runner's glob: a
 * helper exported from a test file cannot be imported without running that
 * file's whole suite.
 */

export interface BucketRefreshRow {
  org_id: string;
  code: string;
  name: string;
  criteria: unknown;
}

export interface BucketRefreshRequest {
  method: "PATCH";
  /** Relative to the PostgREST base, e.g. `buckets?org_id=eq.…&code=eq.411`. */
  path: string;
  body: Record<string, unknown>;
}

/**
 * One request per row, which is not an inefficiency to optimise away: each
 * bucket has its own name and criteria, so a single PATCH under one filter would
 * write one bucket's values over every other bucket it matched.
 */
export function refreshRequest(row: BucketRefreshRow): BucketRefreshRequest {
  const filter = `org_id=eq.${encodeURIComponent(row.org_id)}&code=eq.${encodeURIComponent(row.code)}`;
  return {
    method: "PATCH",
    path: `buckets?${filter}`,
    body: { name: row.name, criteria: row.criteria },
  };
}

export interface RefreshOptions {
  /** The PostgREST base, e.g. `https://…/rest/v1`. */
  base: string;
  headers: Record<string, string>;
  /** Injected so the loop can be driven without a database. */
  fetchImpl?: typeof fetch;
}

/**
 * Refresh each row, and answer how many rows the DATABASE said it changed.
 *
 * Not how many were sent, which is the difference that matters: PostgREST
 * answers a PATCH whose filter matched nothing with 200 and an empty array, so a
 * loop counting what it sent would report sixty successful refreshes over a
 * filter that touched no rows at all, and nothing could ever fail (L98). A row
 * that matched nothing throws, naming the code.
 *
 * It stops at the first refusal rather than sending the remaining rows at a
 * database that is already refusing.
 */
export async function refreshBuckets(
  rows: BucketRefreshRow[],
  opts: RefreshOptions,
): Promise<number> {
  const send = opts.fetchImpl ?? fetch;
  let changed = 0;
  for (const row of rows) {
    const req = refreshRequest(row);
    const res = await send(`${opts.base}/${req.path}`, {
      method: req.method,
      headers: { ...opts.headers, Prefer: "return=representation" },
      body: JSON.stringify(req.body),
    });
    const body = (await res.json()) as unknown[];
    if (!res.ok) {
      throw new Error(`bucket ${row.code} -> ${res.status} ${JSON.stringify(body)}`);
    }
    if (!Array.isArray(body) || body.length === 0) {
      throw new Error(`bucket ${row.code} matched no row, so nothing was refreshed`);
    }
    changed += body.length;
  }
  return changed;
}
