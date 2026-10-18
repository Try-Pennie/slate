/**
 * Reading the envelope Cloudflare's GraphQL Analytics API answers with, for the load run's judge
 * (`scripts/loadtest/platform-reading.ts`). The hourly cron CPU check used it too until it moved
 * to the Worker logs on 2026-10-18, when Cloudflare stopped filling the dataset it read.
 *
 * That fault: the API answers HTTP 200 with an `errors` array and a NULL `data` when the query
 * names a field that does not exist, so a reader that treated a 200 as success found no rows and
 * reported a window it had never queried (measured live 2026-09-13). An error is therefore
 * looked for on EVERY answer, and quoted rather than summarised, because the API's own sentence
 * is the one thing that names the fault in one reading.
 *
 * PURE and import free, so the node suites and a bare node script can read it.
 */

/** A sentence saying why the answer is not a reading, or null when the envelope is sound. */
export function graphqlEnvelopeRefusal(httpStatus: number, body: unknown, dataset: string): string | null {
  if (httpStatus !== 200) {
    return `the analytics API answered HTTP ${httpStatus}, so ${dataset} was not read`;
  }
  const b = body as { errors?: unknown } | null;
  const errors = b && typeof b === "object" ? b.errors : undefined;
  if (Array.isArray(errors) && errors.length > 0) {
    const said = errors
      .map((e) => (e && typeof e === "object" ? String((e as { message?: unknown }).message ?? e) : String(e)))
      .join("; ");
    return `the analytics API refused the ${dataset} query: ${said}`;
  }
  return null;
}

/** The rows of `field` under the first account, or null when the answer has no such list. */
export function graphqlAccountRows(body: unknown, field: string): unknown[] | null {
  const rows = (
    body as {
      data?: { viewer?: { accounts?: Record<string, unknown>[] } };
    } | null
  )?.data?.viewer?.accounts?.[0]?.[field];
  return Array.isArray(rows) ? (rows as unknown[]) : null;
}
