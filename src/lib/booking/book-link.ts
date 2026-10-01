/**
 * The `/book` URL contract in one place: what the page READS off its query, and
 * the one link Slate BUILDS into it for a lead booking again (#2982).
 *
 * The rebook link carries NO contact data. A name, email, phone or Lead id on a
 * query string lands in request logs, browser history and the Referer sent to
 * every third party script on the page. It carries the booking's own manage
 * token instead (a bearer credential already shown in the manage URL), and `/book`
 * resolves it SERVER SIDE into the same identity a host page's link would carry.
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

/** The query key carrying the cancelled booking's manage token. */
export const REBOOK_PARAM = "rebook";

/**
 * A manage token's shape: `nanoid(24)` mints them, so the URL safe alphabet. A
 * value outside it is refused before any read, so a malformed one costs nothing.
 */
const MANAGE_TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;

export interface BookEntryQuery {
  /** The bucket code the link asked for (`xbc`), possibly blank. */
  requestedCode: string;
  /** The Salesforce Lead id (`external_id`), or null when the link named nobody. */
  externalId: string | null;
  /** The lead's details as the link carried them, "" for anything it did not. */
  link: { name: string; email: string; phone: string };
  /** Every query value but the rebook token, first value per key: the booking
   *  records it as `prefill`, which reaches webhooks, so a credential stays out. */
  prefill: Record<string, string>;
  /** A well formed rebook token, or null (absent or malformed). */
  rebookToken: string | null;
}

/** Read `/book`'s query the way the page does. */
export function readBookEntryQuery(sp: SP): BookEntryQuery {
  const prefill: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    if (k === REBOOK_PARAM) continue;
    prefill[k] = Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
  }
  const rebook = first(sp, REBOOK_PARAM);
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
    rebookToken: MANAGE_TOKEN_SHAPE.test(rebook) ? rebook : null,
  };
}

/**
 * "Book a new time" for a call that is over (#2982): back into the same bucket,
 * naming the booking by its manage token and nothing else.
 */
export function rebookHref(b: { bucketCode: string; manageToken: string }): string {
  const q = new URLSearchParams();
  q.set("xbc", b.bucketCode);
  q.set(REBOOK_PARAM, b.manageToken);
  return `/book?${q.toString()}`;
}

/** The booking columns a rebook reads, and nothing more. */
export const REBOOK_COLUMNS = "status, salesforce_id, attendee_name, attendee_email, attendee_phone, source";

export interface RebookRow {
  status: string;
  salesforce_id: string | null;
  attendee_name: string | null;
  attendee_email: string | null;
  attendee_phone: string | null;
  source: string | null;
}

/** The statuses whose manage page offers "Book a new time" (`ManageBooking`). */
const REBOOKABLE_STATUSES: ReadonlySet<string> = new Set(["cancelled", "completed"]);

export interface RebookDeps {
  /** ONE row by manage token (`.maybeSingle()`), as supabase answers it. */
  readByToken: (token: string) => Promise<{ data: RebookRow | null; error: unknown }>;
  /** Told only that the read failed: never the token, never anything about the lead. */
  warn: (msg: string, err: unknown) => void;
}

/**
 * The identity a rebook token stands for, or null when it stands for nothing
 * usable: no token, no such booking, a booking whose page offers no rebook, or a
 * read that failed. Every null renders the page exactly as the bare bucket link
 * would, so a bad token is never an error page and never another booking's data.
 */
export async function loadRebookRow(token: string | null, deps: RebookDeps): Promise<RebookRow | null> {
  if (!token) return null;
  let res: { data: RebookRow | null; error: unknown };
  try {
    res = await deps.readByToken(token);
  } catch (err) {
    deps.warn("rebook lookup threw, booking without prefill", err);
    return null;
  }
  if (res.error) {
    deps.warn("rebook lookup failed, booking without prefill", res.error);
    return null;
  }
  const row = res.data;
  if (!row || !REBOOKABLE_STATUSES.has(row.status)) return null;
  return row;
}

const PAGE_SET: ReadonlySet<string> = new Set(PAGE_SOURCES);

/**
 * The query with a rebooked booking's identity filled in: its Lead id, the lead's
 * details and the page it was booked from, each only where the link itself said
 * nothing, so a host page's own values always win.
 *
 * The source is carried so the rebooked call counts toward the page it came from
 * rather than as unsourced in the per page volume alarm. Only a page is carried:
 * an outcome (`not-given`, `unrecognised`) or an API caller is not a page, and
 * `readBookingSource` would record it as `unrecognised`.
 */
export function withRebookIdentity(entry: BookEntryQuery, row: RebookRow | null): BookEntryQuery {
  if (!row) return entry;
  const fill = (linkValue: string, stored: string | null) => linkValue || stored?.trim() || "";
  const prefill = { ...entry.prefill };
  if (!prefill[BOOKING_SOURCE_PARAM] && row.source && PAGE_SET.has(row.source)) {
    prefill[BOOKING_SOURCE_PARAM] = row.source;
  }
  return {
    ...entry,
    externalId: entry.externalId ?? (row.salesforce_id?.trim() || null),
    link: {
      name: fill(entry.link.name, row.attendee_name),
      email: fill(entry.link.email, row.attendee_email),
      phone: fill(entry.link.phone, row.attendee_phone),
    },
    prefill,
  };
}
