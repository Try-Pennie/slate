/**
 * The one way to write a server log line (#808).
 *
 * Lines used to be hand-rolled at each call site, each picking its own console
 * method, prefix and format. That is how #801 happened: six operational lines had
 * drifted onto `console.log`, the ONE method Cloudflare stores with no `level`,
 * which made them invisible to every level-filtered query and looked exactly like
 * the logs being dropped. Nothing structural stopped it.
 *
 * So two decisions now live here instead of at 60-odd call sites:
 *
 *   1. The LEVEL. `console.log` is unreachable from this module (and banned in
 *      `src/` by ESLint), so a line can only ever land at info/warn/error, all of
 *      which carry a queryable level.
 *   2. A searchable TAG. Every line is `slate tag=<subsystem> ...`, so a log query
 *      can filter on `tag=booking-api` instead of guessing at message substrings.
 *
 * Format (see scripts/logs.ts, which reads these back):
 *
 *   slate tag=recompute msg="refreshed 3/5 due" util=42 drained=true
 *
 * Errors are passed THROUGH to `console.error` as a second argument rather than
 * flattened into the string, because Cloudflare serializes a real Error object
 * (verified in #708) and that is how the stack survives to the logs.
 */

/** The subsystem a line belongs to. Kept as a plain string: a union would need
 *  updating in two places every time a new lane or route starts logging. */
export type LogTag = string;

/** Field values a line can carry. null/undefined fields are dropped. */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

const SERVICE = "slate";

/** `key=value`, quoting strings so a value with spaces stays one field. Numbers
 *  and booleans go unquoted so they read as the scalars they are. */
function renderValue(value: string | number | boolean): string {
  if (typeof value === "string") return `"${value.replace(/"/g, '\\"')}"`;
  return String(value);
}

/** The line itself, so it can be asserted on without spying on the console. */
export function formatLine(tag: LogTag, fields: LogFields): string {
  const parts = [`${SERVICE} tag=${tag}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    parts.push(`${key}=${renderValue(value)}`);
  }
  return parts.join(" ");
}

export const log = {
  /** Routine operational line: a cron cycle summary, an API call's outcome. */
  info(tag: LogTag, fields: LogFields): void {
    console.info(formatLine(tag, fields));
  },

  /** Something is wrong but handled: a degraded path, a fallback, a stale lane. */
  warn(tag: LogTag, fields: LogFields): void {
    console.warn(formatLine(tag, fields));
  },

  /**
   * A failure. Pass the `Error` itself as `err` so Cloudflare serializes its
   * stack, rather than interpolating `err.message` into a field.
   */
  error(tag: LogTag, fields: LogFields, err?: unknown): void {
    const line = formatLine(tag, fields);
    if (err === undefined) {
      console.error(line);
      return;
    }
    console.error(line, err);
  },
};
