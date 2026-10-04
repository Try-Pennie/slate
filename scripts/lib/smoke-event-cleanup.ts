// Smoke-test calendar cleanup (#524).
//
// The booking smoke test books and cancels real bookings on the smoketest@ /
// smoketest2@ mailboxes. Per #166 a cancel can leave a lingering Google event, so
// those calendars accumulate orphaned busy blocks over time. The reschedule hot
// path reads availability LIVE from Google (not the busy_blocks cache), so that
// clutter can make the lone test agent read busy and cause flaky smoke failures.
//
// This module owns the sweep: identify the smoke-created orphans on a mailbox and
// delete them. Deleting from a REAL mailbox, so identification is deliberately
// conservative (see isStaleSmokeEvent). The pure filter is exported separately
// from the I/O so it is unit-testable without any Google access.

import { getDelegatedToken } from "@/lib/google/dwd";
import { sendWithTokenRetry } from "@/lib/google/token-retry";
import { PUBLIC_TEST_EVENT_TYPE_NAME } from "../smoke-seed.ts";

/** Minimal shape of a Google Calendar event, with the fields the filter needs. */
export interface CalEvent {
  id: string;
  status?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string }[];
}

// A smoke booking's Google summary is `<event type> with Smoke Test` (the smoke
// attendee name is always "Smoke Test"), and its attendee address is a plus-alias
// of the real test mailbox (smoketest+<tag>@ / smoketest2+<tag>@). Either marker
// is a signal a genuine calendar event would never carry.
const SMOKE_SUMMARY = /\bsmoke test\b/i;
const SMOKE_ATTENDEE = /^smoketest\d*\+[^@]*@/i;
// #2660: a partner's test booking is `<public test event type> with <tester>` on
// the same mailbox, with the tester's own address as attendee, so neither marker
// above sees it and a cancelled one would sit on the calendar for ever. The event
// type name is read from the seed rather than restated, so the two cannot drift.
const PUBLIC_TEST_SUMMARY = new RegExp(
  `\\b${PUBLIC_TEST_EVENT_TYPE_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
  "i",
);

function hasSmokeMarker(ev: CalEvent): boolean {
  if (SMOKE_SUMMARY.test(ev.summary ?? "")) return true;
  if (PUBLIC_TEST_SUMMARY.test(ev.summary ?? "")) return true;
  return (ev.attendees ?? []).some((a) => a.email != null && SMOKE_ATTENDEE.test(a.email));
}

/**
 * True when an event is a stale smoke orphan that is safe to delete. Requires ALL
 * of: a smoke marker (summary or attendee alias); a TIMED event that has already
 * ended (`end.dateTime < now`), and the booker never books past-time slots, so a
 * concurrently-running smoke test's events are always future and never match;
 * not already cancelled. All-day events (which booking never creates) are always
 * kept, so a real personal block on the mailbox is never touched.
 *
 * `now` is epoch milliseconds, passed in so the filter stays pure and testable.
 */
export function isStaleSmokeEvent(ev: CalEvent, now: number): boolean {
  if (ev.status === "cancelled") return false;
  const endIso = ev.end?.dateTime;
  if (!endIso) return false; // all-day (end.date) or malformed, never sweep
  const end = Date.parse(endIso);
  if (!Number.isFinite(end) || end >= now) return false; // future/ongoing, keep
  return hasSmokeMarker(ev);
}

/** Split a calendar's events into the stale smoke orphans and everything kept. */
export function partitionSmokeEvents(
  events: CalEvent[],
  now: number,
): { toDelete: CalEvent[]; kept: CalEvent[] } {
  const toDelete: CalEvent[] = [];
  const kept: CalEvent[] = [];
  for (const ev of events) (isStaleSmokeEvent(ev, now) ? toDelete : kept).push(ev);
  return { toDelete, kept };
}

// --- I/O ---------------------------------------------------------------------

const BASE = "https://www.googleapis.com/calendar/v3";
const CAL = "primary"; // impersonating the mailbox, "primary" is its own calendar
// Far above any real delta on a test calendar; stops a pathological list from
// issuing unbounded requests (mirrors calendar.ts MAX_SYNC_PAGES).
const MAX_PAGES = 50;

/** The calendar operations the sweep needs. Injected so the orchestration and its
 *  error handling are unit-testable with a hand-written fake (no real Google). */
export interface CalendarClient {
  list(email: string, timeMinIso: string, timeMaxIso: string): Promise<CalEvent[]>;
  del(email: string, eventId: string): Promise<void>;
}

type FetchFn = typeof fetch;
/** `refused` names a token Google just refused, so the source replaces it (#3144). */
type TokenFn = (email: string, refused?: string) => Promise<string>;

/** The real DWD-backed client. `fetch`/`getToken` are injectable so the HTTP
 *  error handling (non-ok list, tolerated 404/410 delete) can be tested too. */
export function makeGoogleCalendarClient(
  deps: { fetch?: FetchFn; getToken?: TokenFn } = {},
): CalendarClient {
  const doFetch = deps.fetch ?? fetch;
  const getToken: TokenFn =
    deps.getToken ?? ((email, refused) => getDelegatedToken(email, undefined, undefined, refused));
  // #3144: a cached token Google refuses is replaced and the call resent once.
  function gfetch(email: string, url: string, init?: RequestInit): Promise<Response> {
    return sendWithTokenRetry(
      (refused) => getToken(email, refused),
      (token) => doFetch(url, { ...init, headers: { ...init?.headers, authorization: `Bearer ${token}` } }),
    );
  }
  return {
    // Paginated events.list over a window, projecting just the filtered fields.
    async list(email, timeMinIso, timeMaxIso) {
      const events: CalEvent[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const params = new URLSearchParams({
          singleEvents: "true",
          showDeleted: "false",
          maxResults: "2500",
          timeMin: timeMinIso,
          timeMax: timeMaxIso,
          fields: "items(id,status,summary,start,end,attendees(email)),nextPageToken",
        });
        if (pageToken) params.set("pageToken", pageToken);
        const res = await gfetch(email, `${BASE}/calendars/${CAL}/events?${params.toString()}`);
        if (!res.ok) {
          throw new Error(`events.list failed for ${email}: ${res.status} ${await res.text()}`);
        }
        const data = (await res.json()) as { items?: CalEvent[]; nextPageToken?: string };
        events.push(...(data.items ?? []));
        pageToken = data.nextPageToken;
        if (!pageToken) break;
      }
      return events;
    },
    // Tolerant delete (404/410 mean already gone); no sendUpdates, so no cancel spam.
    async del(email, eventId) {
      const res = await gfetch(
        email,
        `${BASE}/calendars/${CAL}/events/${encodeURIComponent(eventId)}`,
        { method: "DELETE" },
      );
      if (!res.ok && res.status !== 404 && res.status !== 410) {
        throw new Error(`events.delete failed for ${email}: ${res.status} ${await res.text()}`);
      }
    },
  };
}

const defaultClient = makeGoogleCalendarClient();

export interface SweepResult {
  email: string;
  matched: number;
  deleted: number;
  dryRun: boolean;
  deletedIds: string[];
}

export interface SweepOptions {
  /** Reference clock, epoch ms. Defaults to now. */
  now?: number;
  /** How far back to look for orphans. Defaults to 90 days. */
  lookbackDays?: number;
  /** Actually delete (true) or report only (false, the default). */
  apply?: boolean;
}

/** Sweep one mailbox. Fails loud: a real Google error throws rather than passing silently. */
export async function sweepMailbox(
  email: string,
  opts: SweepOptions = {},
  client: CalendarClient = defaultClient,
): Promise<SweepResult> {
  const now = opts.now ?? Date.now();
  const lookbackDays = opts.lookbackDays ?? 90;
  const apply = opts.apply ?? false;
  const timeMin = new Date(now - lookbackDays * 86_400_000).toISOString();
  const timeMax = new Date(now).toISOString();

  const events = await client.list(email, timeMin, timeMax);
  const { toDelete } = partitionSmokeEvents(events, now);

  const deletedIds: string[] = [];
  if (apply) {
    for (const ev of toDelete) {
      await client.del(email, ev.id);
      deletedIds.push(ev.id);
    }
  }
  return { email, matched: toDelete.length, deleted: deletedIds.length, dryRun: !apply, deletedIds };
}

/** Sweep several mailboxes in turn, returning one result per mailbox. */
export async function sweepMailboxes(
  emails: string[],
  opts: SweepOptions = {},
  client: CalendarClient = defaultClient,
): Promise<SweepResult[]> {
  const results: SweepResult[] = [];
  for (const email of emails) results.push(await sweepMailbox(email, opts, client));
  return results;
}

/**
 * Best-effort sweep for the smoke script's teardown: applies the sweep but never
 * throws, so a cleanup failure (e.g. missing SA creds in a CI context, or a
 * transient Google error) cannot fail the smoke run. The failure is surfaced in
 * the return value (ok=false, error) rather than swallowed silently, and the
 * caller logs it. Use sweepMailboxes directly where a failure SHOULD be loud (the CLI).
 */
export async function sweepQuietly(
  emails: string[],
  opts: SweepOptions = {},
  client: CalendarClient = defaultClient,
): Promise<{ ok: boolean; deleted: number; error?: string }> {
  try {
    const results = await sweepMailboxes(emails, { ...opts, apply: true }, client);
    return { ok: true, deleted: results.reduce((n, r) => n + r.deleted, 0) };
  } catch (err) {
    return { ok: false, deleted: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
