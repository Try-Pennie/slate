/**
 * Building a SOQL `IN` list safely, and sizing it against the limit that actually
 * refuses it.
 *
 * The escaping below was written out inline at four separate sites in
 * `sync.ts`, which is four chances to get a backslash rule subtly different. It
 * lives here once instead.
 */

/** Quote and escape one literal for a SOQL string. */
export function sfQuote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** A comma separated SOQL literal list, ready to drop inside `IN (...)`. */
export function sfInList(values: string[]): string {
  return values.map(sfQuote).join(",");
}

/**
 * The budget one `IN` list may spend, measured in URL ENCODED characters.
 *
 * The limit that refuses an oversized query is Salesforce's **16,384 byte cap on
 * a REST GET URI**, and the query rides in that URI percent encoded (`@` becomes
 * `%40`, `'` becomes `%27`, `,` becomes `%2C`), so a list is roughly 1.4x longer
 * by the time it is subject to the cap than it looks in source. A count of rows is
 * therefore NOT the unit the limit is expressed in (L81): 200 short emails and 200
 * long ones are the same number and very different URIs, and only one of them
 * fails.
 *
 * 12,000 leaves room for the SELECT, the WHERE clause and the instance URL, and
 * still fits a chunk many times larger than this roster will ever produce
 * (measured 2026-08-31: 118 active users, one chunk).
 */
export const SOQL_URI_BUDGET = 12_000;

/**
 * Splits values into `IN` lists that each stay inside the encoded budget.
 *
 * A value that cannot fit on its own still gets its own chunk rather than being
 * dropped: a silently discarded value would be indistinguishable from Salesforce
 * having no record for it, which is exactly the false absence the caller reports
 * on. Sending it and letting Salesforce refuse it is loud (L98).
 */
export function chunkSoqlValues(
  values: string[],
  budget: number = SOQL_URI_BUDGET,
): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let used = 0;
  // A comma is `%2C` once encoded, three characters and not one. Charging it as
  // one is an undercount that grows with the chunk, so every chunk lands just OVER
  // the budget rather than under it, which is the one direction that matters.
  const SEPARATOR = encodeURIComponent(",").length;
  for (const value of values) {
    const cost =
      encodeURIComponent(sfQuote(value)).length + (current.length ? SEPARATOR : 0);
    if (current.length && used + cost > budget) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(value);
    used += cost;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
