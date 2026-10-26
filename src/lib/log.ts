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
 * Errors are passed THROUGH as a second argument rather than flattened into the
 * string, because Cloudflare serializes a real Error object (verified in #708) and
 * that is how the stack survives to the logs. All three levels take it (#1188), so
 * a call site never has to choose between the right SEVERITY and keeping the
 * stack: warn is correct for a failure with a documented backstop, which is most
 * best-effort work, and promoting those to error to carry an error would overstate
 * severity on paths that self-heal and pollute error-level queries.
 */

/** The subsystem a line belongs to. Kept as a plain string: a union would need
 *  updating in two places every time a new lane or route starts logging. */
export type LogTag = string;

/** Field values a line can carry. null/undefined fields are dropped. */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

const SERVICE = "slate";

/**
 * What has to be escaped inside a quoted value: the backslash itself, the quote,
 * and every character that a log viewer may draw as a line break or not at all
 * (C0 and C1 controls, DEL, and the two Unicode line and paragraph separators).
 */
const NEEDS_ESCAPE = /[\\"\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

const SHORT_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\\\",
  '"': '\\"',
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

function escapeChar(ch: string): string {
  return SHORT_ESCAPES[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

/**
 * `key=value`, quoting strings so a value with spaces stays one field. Numbers
 * and booleans go unquoted so they read as the scalars they are.
 *
 * A string can be a stranger's (the public beacons log a CSP report's URLs and the
 * browser's user agent), so it is escaped in ONE pass where the backslash is its
 * own case (#4237, L809). Escaping only the quote let `x\" paged=true` render as
 * `x\\" paged=true`, which a reader takes as an escaped backslash, then a closing
 * quote, then a forged `paged=true` field; and a raw line feed forged a whole line.
 * A value with none of these characters renders exactly as it always did, so no
 * existing query changes. `src/lib/log-shipping/parse-line.ts` reads it back.
 */
export function renderValue(value: string | number | boolean): string {
  if (typeof value === "string") return `"${value.replace(NEEDS_ESCAPE, escapeChar)}"`;
  return String(value);
}

/** What a field key must look like for `parseSlateLine` to read it back. */
export const LOG_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A key as written. Every key comes from code today; one built from data later is
 *  made an identifier rather than allowed to split or forge a field (#4237). */
function safeKey(key: string): string {
  if (LOG_KEY.test(key)) return key;
  const cleaned = key.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

/** The tag is written bare, so it may hold nothing that ends or escapes a field. */
function safeTag(tag: string): string {
  return tag.replace(/[\s="]/g, "_").replace(NEEDS_ESCAPE, "_");
}

/** The line itself, so it can be asserted on without spying on the console. */
export function formatLine(tag: LogTag, fields: LogFields): string {
  const parts = [`${SERVICE} tag=${safeTag(tag)}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    parts.push(`${safeKey(key)}=${renderValue(value)}`);
  }
  return parts.join(" ");
}

// `undefined` is never passed as a second argument: Cloudflare would record the
// line with a trailing `undefined`. Each level spells that out rather than sharing
// a writer, because a shared one has to take the console method as a closure and
// these are hot paths (an every-minute lane logs on every tick).
export const log = {
  /** Routine operational line: a cron cycle summary, an API call's outcome. */
  info(tag: LogTag, fields: LogFields, err?: unknown): void {
    const line = formatLine(tag, fields);
    if (err === undefined) console.info(line);
    else console.info(line, err);
  },

  /** Something is wrong but handled: a degraded path, a fallback, a stale lane.
   *  Pass the `Error` so the stack survives while the severity stays honest. */
  warn(tag: LogTag, fields: LogFields, err?: unknown): void {
    const line = formatLine(tag, fields);
    if (err === undefined) console.warn(line);
    else console.warn(line, err);
  },

  /**
   * A failure. Pass the `Error` itself as `err` so Cloudflare serializes its
   * stack, rather than interpolating `err.message` into a field.
   */
  error(tag: LogTag, fields: LogFields, err?: unknown): void {
    const line = formatLine(tag, fields);
    if (err === undefined) console.error(line);
    else console.error(line, err);
  },
};
