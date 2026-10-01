/**
 * The `/book` URL contract in one place: what the page READS off its query, and
 * the one link Slate BUILDS into it from a booking it already holds (#2982).
 *
 * Both halves live here so a parameter name cannot drift between the writer and
 * the reader: `scripts/test-rebook-link.ts` builds a rebook link and parses it
 * back through `readBookEntryQuery`, which is what `/book` itself calls.
 *
 * Pure, no `@/` imports, so the node test suite can load it directly.
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

/** What a rebook link is built from: the booking's own stored values. */
export interface RebookSource {
  bucketCode: string;
  /** `bookings.salesforce_id`, the 00Q Lead id `/book` routes and recognises on. */
  salesforceId: string | null;
  attendeeName: string | null;
  attendeeEmail: string | null;
  attendeePhone: string | null;
  /** `bookings.source`; only a PAGE source is carried (see below). */
  source: string | null;
}

const PAGE_SET: ReadonlySet<string> = new Set(PAGE_SOURCES);

/**
 * "Book a new time" for a call that is over (#2982): back into the same bucket,
 * carrying the Lead id and the details the lead already gave, so the new booking
 * is tied to their Lead and they retype nothing.
 *
 * The source is the page the cancelled call was booked from, so the rebooked call
 * counts toward that page rather than as unsourced in the per page volume alarm.
 * Only a page is carried: an outcome (`not-given`, `unrecognised`) or an API
 * caller is not a page, and `readBookingSource` would record it as `unrecognised`.
 *
 * Blank values are left off, so a booking holding nothing about the lead links to
 * the bare bucket exactly as before.
 */
export function rebookHref(b: RebookSource): string {
  const q = new URLSearchParams();
  q.set("xbc", b.bucketCode);
  const put = (key: string, value: string | null) => {
    const v = value?.trim();
    if (v) q.set(key, v);
  };
  put("external_id", b.salesforceId);
  put("name", b.attendeeName);
  put("email", b.attendeeEmail);
  put("phone", b.attendeePhone);
  if (b.source && PAGE_SET.has(b.source)) q.set(BOOKING_SOURCE_PARAM, b.source);
  return `/book?${q.toString()}`;
}
