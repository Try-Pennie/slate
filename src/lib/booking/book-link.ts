/**
 * The `/book` query contract, and the rebook link Slate builds for a lead booking
 * again after a call is over (#2982).
 *
 * The rebook booker is served UNDER the manage path the lead is already on,
 * `/booking/manage/<token>/rebook`, and resolves the booking server side by the
 * same token the manage page does. So no contact data rides on any URL, and the
 * manage token never appears on a page it was not already on: the public booker
 * at `/book`, which host pages and their scripts frame, never sees it.
 *
 * Pure, no `@/` imports, so the node test suite loads it directly; the database
 * read is injected (`service.ts` wires the real one).
 */

import { BOOKING_SOURCE_PARAM, PAGE_SOURCES } from "./booking-source.ts";

type SP = Readonly<Record<string, string | string[] | undefined>>;

function first(sp: SP, key: string): string {
  const v = sp[key];
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

export interface BookEntryQuery {
  /** The bucket code the link asked for (`xbc`), possibly blank. */
  requestedCode: string;
  /** The Salesforce Lead id (`external_id`), or null when the link named nobody. */
  externalId: string | null;
  /** The lead's details as the link carried them, "" for anything it did not. */
  link: { name: string; email: string; phone: string };
  /** Every query value, first value per key: the booking records it as `prefill`. */
  prefill: Record<string, string>;
}

/** Read `/book`'s query the way the page does. */
export function readBookEntryQuery(sp: SP): BookEntryQuery {
  const prefill: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    prefill[k] = Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
  }
  return {
    requestedCode: first(sp, "xbc"),
    externalId: first(sp, "external_id") || null,
    link: {
      name: first(sp, "name"),
      email: first(sp, "email"),
      // cal.com's two spellings are still accepted from host pages.
      phone: first(sp, "phone") || first(sp, "attendeePhoneNumber") || first(sp, "smsReminderNumber"),
    },
    prefill,
  };
}

/**
 * "Book a new time" for a call that is over (#2982): the rebook booker under this
 * booking's own manage path. The bucket rides as `xbc` only so a lookup that
 * FAILS can still draw that bucket's booker without prefill; a bucket code is not
 * contact data, and a lookup that succeeds uses the booking's own bucket instead.
 */
export function rebookHref(b: { bucketCode: string; manageToken: string }): string {
  const q = new URLSearchParams();
  q.set("xbc", b.bucketCode);
  return `/booking/manage/${encodeURIComponent(b.manageToken)}/rebook?${q.toString()}`;
}

/** The booking columns a rebook reads, and nothing more: one row by token. */
export const REBOOK_COLUMNS =
  "status, salesforce_id, attendee_name, attendee_email, attendee_phone, source, bucket:buckets(code)";

export interface RebookRow {
  status: string;
  bucketCode: string;
  salesforceId: string | null;
  attendeeName: string | null;
  attendeeEmail: string | null;
  attendeePhone: string | null;
  source: string | null;
}

function nullableString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

/**
 * The row as the read answered it, checked at RUNTIME rather than cast: a select
 * or schema change that alters the shape is a failed read, never a half filled
 * identity. Null when the shape is wrong.
 */
export function parseRebookRow(data: unknown): RebookRow | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const bucket = Array.isArray(d.bucket) ? d.bucket[0] : d.bucket;
  const code = bucket && typeof bucket === "object" ? (bucket as Record<string, unknown>).code : undefined;
  if (typeof d.status !== "string" || typeof code !== "string" || !code) return null;
  const fields = [d.salesforce_id, d.attendee_name, d.attendee_email, d.attendee_phone, d.source];
  if (!fields.every(nullableString)) return null;
  return {
    status: d.status,
    bucketCode: code,
    salesforceId: d.salesforce_id as string | null,
    attendeeName: d.attendee_name as string | null,
    attendeeEmail: d.attendee_email as string | null,
    attendeePhone: d.attendee_phone as string | null,
    source: d.source as string | null,
  };
}

/** The statuses whose manage page offers "Book a new time" (`ManageBooking`). */
const REBOOKABLE_STATUSES: ReadonlySet<string> = new Set(["cancelled", "completed"]);

/** How long the page waits on the lookup before drawing the booker without prefill. */
export const REBOOK_LOOKUP_TIMEOUT_MS = 3_000;

export type RebookLookup =
  | { kind: "found"; row: RebookRow }
  /** No such booking, or one whose page offers no rebook: the not found state. */
  | { kind: "absent" }
  /** The read failed, timed out or answered an unreadable shape: no prefill. */
  | { kind: "failed" };

export interface RebookDeps {
  /** ONE row by manage token (`.maybeSingle()`), as supabase answers it. */
  readByToken: (token: string) => Promise<{ data: unknown; error: unknown }>;
  /** Resolves after `ms`; injected so tests never wait on a real clock (L524). */
  deadline: (ms: number) => Promise<void>;
  /** Told only WHY the read failed: never the token, never anything about the lead. */
  warn: (msg: string, err: unknown) => void;
  timeoutMs?: number;
}

const TIMED_OUT: unique symbol = Symbol("timed-out");

/**
 * The booking a rebook token names. Every way the read can fail is `failed`,
 * which the page answers with the bare bucket booker rather than an error, since
 * the lead can still book; a token naming nothing usable is `absent`, which the
 * page answers with the manage page's own not found state, never another booking.
 */
export async function loadRebookRow(token: string, deps: RebookDeps): Promise<RebookLookup> {
  let res: { data: unknown; error: unknown } | typeof TIMED_OUT;
  try {
    res = await Promise.race([
      deps.readByToken(token),
      deps.deadline(deps.timeoutMs ?? REBOOK_LOOKUP_TIMEOUT_MS).then((): typeof TIMED_OUT => TIMED_OUT),
    ]);
  } catch (err) {
    deps.warn("rebook lookup threw, booking without prefill", err);
    return { kind: "failed" };
  }
  if (res === TIMED_OUT) {
    deps.warn("rebook lookup timed out, booking without prefill", null);
    return { kind: "failed" };
  }
  if (res.error) {
    deps.warn("rebook lookup failed, booking without prefill", res.error);
    return { kind: "failed" };
  }
  if (res.data === null || res.data === undefined) return { kind: "absent" };
  const row = parseRebookRow(res.data);
  if (!row) {
    deps.warn("rebook lookup answered an unreadable row, booking without prefill", null);
    return { kind: "failed" };
  }
  if (!REBOOKABLE_STATUSES.has(row.status)) return { kind: "absent" };
  return { kind: "found", row };
}

const PAGE_SET: ReadonlySet<string> = new Set(PAGE_SOURCES);

/**
 * What the rebook booker starts with: the booking's Lead id, the lead's details
 * and the page it was booked from.
 *
 * The source is carried so the rebooked call counts toward the page it came from
 * rather than as unsourced in the per page volume alarm. Only a page is carried:
 * an outcome (`not-given`, `unrecognised`) or an API caller is not a page, and
 * `readBookingSource` would record it as `unrecognised`.
 */
export function rebookEntry(row: RebookRow): BookEntryQuery {
  const prefill: Record<string, string> = {};
  if (row.source && PAGE_SET.has(row.source)) prefill[BOOKING_SOURCE_PARAM] = row.source;
  return {
    requestedCode: row.bucketCode,
    externalId: row.salesforceId?.trim() || null,
    link: {
      name: row.attendeeName?.trim() ?? "",
      email: row.attendeeEmail?.trim() ?? "",
      phone: row.attendeePhone?.trim() ?? "",
    },
    prefill,
  };
}
