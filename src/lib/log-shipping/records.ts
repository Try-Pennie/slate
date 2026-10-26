/**
 * Turn the trace items Cloudflare hands a tail worker into the records Better
 * Stack stores (#3105, #3138).
 *
 * Three kinds of record, each carrying `kind` so a query can pick one:
 *
 *   - `invocation`: one per Slate invocation, its outcome (`ok`, `exception`,
 *     `exceededCpu`, ...), CPU and wall time, and what drove it: the method, the
 *     REDACTED url and the status for a request, the cron expression for a tick.
 *   - `log`: one per console line, with a `slate` line's `key=value` pairs parsed
 *     into `fields`, so the cron lane timings arrive as numbers that chart.
 *   - `exception`: one per uncaught exception, name, message and stack, which is
 *     what Better Stack groups an error on.
 *
 * Every record carries `version_id`, the deployed Worker version that produced it,
 * so an error can be attributed to the deploy that introduced it (#3138).
 *
 * Nothing leaves this module unredacted: every url through `redactUrl`, every
 * piece of free text and every string field through `redactText`. Request
 * HEADERS are never forwarded at all (cookies, authorization, the client
 * address), and neither is `cf`, which carries the caller's location.
 *
 * The input type is structural rather than the runtime's `TraceItem`, so the node
 * tests build real shaped items without the Workers type library.
 */
import { renderValue } from "../log.ts";
import { parseSlateLine, type ParsedFields } from "./parse-line.ts";
import { redactText, redactUrl } from "./redact.ts";

export interface TraceLogLike {
  timestamp: number;
  level: string;
  message: unknown;
}

export interface TraceExceptionLike {
  timestamp: number;
  name: string;
  message: string;
  stack?: string;
}

export interface TraceItemLike {
  event?: {
    request?: { method?: string; url?: string };
    response?: { status?: number };
    cron?: string;
    scheduledTime?: number;
  } | null;
  eventTimestamp: number | null;
  logs: TraceLogLike[];
  exceptions: TraceExceptionLike[];
  scriptName: string | null;
  scriptVersion?: { id?: string };
  outcome: string;
  cpuTime?: number;
  wallTime?: number;
  truncated?: boolean;
}

/** One record as Better Stack's HTTP source takes it: `dt` is the timestamp it
 *  indexes on, `message` the text it shows. */
export interface ShippedRecord {
  dt: string;
  level: string;
  message: string;
  kind: "invocation" | "log" | "exception";
  script: string | null;
  version_id: string | null;
  [key: string]: unknown;
}

/** Caps on free text, because one runaway line must not spend the whole request
 *  (or the month's ingest). Generous: a real stack fits. */
export const TEXT_LIMITS = { message: 4000, stack: 8000, field: 1000 } as const;

function cap(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)} [truncated]` : text;
}

function iso(ms: number | null | undefined): string {
  return new Date(typeof ms === "number" && Number.isFinite(ms) ? ms : Date.now()).toISOString();
}

/**
 * A console argument as scrubbed text. An object (a serialized Error, a plain
 * object) is stringified, since dropping it would lose the stack the call site
 * passed on purpose (#1188).
 *
 * Every string inside an object is scrubbed BEFORE it is stringified (#4237
 * review): JSON writes a line break as backslash n, and the contact scrub needs a
 * word boundary or a separator before a phone's digits, so `note\n555-123-4567`
 * scrubbed as JSON text kept the phone. The JSON text is scrubbed once more for
 * what a string pass cannot see: a number, or a key built from data.
 */
function scrubbedArgText(arg: unknown): string {
  if (typeof arg === "string") return redactText(arg);
  if (arg === undefined) return "undefined";
  let json: string | undefined;
  try {
    json = JSON.stringify(arg, (_key, value: unknown) => (typeof value === "string" ? redactText(value) : value));
  } catch {
    json = undefined;
  }
  return redactText(json ?? String(arg));
}

/**
 * A parsed line as text again, written from its SCRUBBED fields with the same
 * escaping `formatLine` uses (#4237 review). Scrubbing the line as written cannot
 * work: it is escaped text, where a line break inside a value is backslash n,
 * which the contact scrub does not read as a break. Rebuilt from the fields, the
 * message and the fields cannot disagree, and a line with nothing to scrub reads
 * exactly as it was written.
 */
function messageFromFields(fields: ParsedFields): string {
  const parts = ["slate"];
  for (const [key, value] of Object.entries(fields)) {
    const rendered = renderValue(value);
    // `formatLine` writes the tag bare, so a reader's `tag=cron` still matches.
    const bare = key === "tag" && typeof value === "string" && value !== "" && rendered === `"${value}"` && !/\s/.test(value);
    parts.push(`${key}=${bare ? value : rendered}`);
  }
  return parts.join(" ");
}

function redactFields(fields: ParsedFields): ParsedFields {
  const out: ParsedFields = {};
  for (const [key, value] of Object.entries(fields)) {
    // The KEY through the same scrub as the value (review of #3160): a call site
    // can build a key from data.
    out[redactText(key)] = typeof value === "string" ? cap(redactText(value), TEXT_LIMITS.field) : redactScalar(value);
  }
  return out;
}

/** A number is scrubbed as the text it was written as: a ten digit phone parses as
 *  a number and must still leave as the marker (review of #3160). One the scrub
 *  leaves alone stays a number, so Better Stack can still chart it. */
function redactScalar(value: number | boolean): string | number | boolean {
  if (typeof value !== "number") return value;
  const written = String(value);
  const scrubbed = redactText(written);
  return scrubbed === written ? value : scrubbed;
}

/** Map a console level onto the three Better Stack treats as severities. */
function level(raw: string): string {
  if (raw === "error") return "error";
  if (raw === "warn") return "warn";
  if (raw === "debug") return "debug";
  return "info";
}

function invocationRecord(item: TraceItemLike, base: Pick<ShippedRecord, "script" | "version_id">): ShippedRecord {
  const ev = item.event ?? null;
  const record: ShippedRecord = {
    ...base,
    dt: iso(item.eventTimestamp),
    level: item.outcome === "ok" ? "info" : "error",
    kind: "invocation",
    message: "",
    outcome: item.outcome,
    cpu_ms: item.cpuTime,
    wall_ms: item.wallTime,
    truncated: item.truncated === true ? true : undefined,
  };
  if (ev?.request) {
    const url = ev.request.url ? redactUrl(ev.request.url) : undefined;
    record.event = "fetch";
    record.method = ev.request.method;
    record.url = url;
    record.status = ev.response?.status;
    record.message = `${ev.request.method ?? "?"} ${url ?? "?"} ${ev.response?.status ?? "no response"} ${item.outcome}`;
  } else if (typeof ev?.cron === "string") {
    record.event = "scheduled";
    record.cron = ev.cron;
    record.message = `cron ${ev.cron} ${item.outcome}`;
  } else {
    record.event = "other";
    record.message = `invocation ${item.outcome}`;
  }
  return record;
}

/** Every record for a batch of trace items, redacted, in the order they happened
 *  within each item. */
export function recordsFromTraces(items: readonly TraceItemLike[]): ShippedRecord[] {
  const records: ShippedRecord[] = [];
  for (const item of items) {
    const base = { script: item.scriptName, version_id: item.scriptVersion?.id ?? null };
    records.push(invocationRecord(item, base));
    for (const line of item.logs) {
      const args = Array.isArray(line.message) ? line.message : [line.message];
      // Parsed AS WRITTEN, then scrubbed field by field (#4237). Scrubbing the whole
      // line first let a redaction end on the backslash of an escaped quote (a token
      // path or a query string runs up to the quote), which handed the parser a
      // closed quote and whatever a stranger wrote after it as forged fields. A
      // number is scrubbed too (`redactFields`), so a ten digit phone that parsed
      // as a number still meets the digit scrub (review of #3160).
      const parsed = typeof args[0] === "string" ? parseSlateLine(args[0]) : null;
      const fields = parsed ? redactFields(parsed) : null;
      const text = [
        fields ? messageFromFields(fields) : scrubbedArgText(args[0]),
        ...args.slice(1).map(scrubbedArgText),
      ].join(" ");
      const record: ShippedRecord = {
        ...base,
        dt: iso(line.timestamp),
        level: level(line.level),
        kind: "log",
        message: cap(text, TEXT_LIMITS.message),
      };
      if (fields) record.fields = fields;
      records.push(record);
    }
    for (const ex of item.exceptions) {
      records.push({
        ...base,
        dt: iso(ex.timestamp),
        level: "error",
        kind: "exception",
        message: cap(redactText(`${ex.name}: ${ex.message}`), TEXT_LIMITS.message),
        // A name is free text too: a subclass can be named after anything, and the
        // runtime reports whatever a thrown object's `name` said.
        error_name: cap(redactText(ex.name), TEXT_LIMITS.field),
        error_message: cap(redactText(ex.message), TEXT_LIMITS.message),
        stack: ex.stack ? cap(redactText(ex.stack), TEXT_LIMITS.stack) : undefined,
      });
    }
  }
  return records;
}
