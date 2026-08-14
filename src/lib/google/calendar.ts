import { getDelegatedToken } from "@/lib/google/dwd";
import { GoogleHttpError } from "@/lib/google/http-error";
import { parseGoogleErrorReason } from "@/lib/google/reachability-classify";
import {
  busyByCalendarFromResponse,
  hasBlockingBusy,
  EventGone,
  type CalendarBusy,
} from "@/lib/booking/core";
import { googlePushUrl, googleChannelToken } from "@/lib/env";
import {
  LOADTEST,
  stubCalendarList,
  stubSyncEvents,
  stubWatch,
  stubFreeBusy,
} from "@/lib/google/loadtest-stub";

const BASE = "https://www.googleapis.com/calendar/v3";
// Impersonating the agent, "primary" is their own calendar.
const CAL = "primary";

/** Minimal shape of a Google Calendar event (only the fields sync uses). */
export interface GoogleEvent {
  id?: string;
  status?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

export interface Interval {
  start: string;
  end: string;
}

/** Thrown on a 410 from an incremental sync (expired syncToken). */
export class SyncTokenExpired extends Error {
  readonly code = 410;
  constructor() {
    super("Google sync token expired");
    this.name = "SyncTokenExpired";
  }
}

// The OOO approval/undo path waits synchronously on the calendar writes before
// returning to the manager, so those calls are bounded (same posture as the
// Slack and webhook calls). A timeout surfaces as an AbortError — the caller
// records it as a failed side effect and the approval still completes.
export const CALENDAR_WRITE_TIMEOUT_MS = 8000;

/**
 * Authenticated fetch against an agent's calendar via domain-wide delegation.
 * Pass `timeoutMs` to abort a slow/unreachable Google (used by the OOO write
 * calls); the read/sync hot paths leave it unbounded as before.
 */
async function gfetch(
  email: string,
  url: string,
  init: RequestInit = {},
  timeoutMs?: number,
): Promise<Response> {
  const token = await getDelegatedToken(email);
  const controller = timeoutMs ? new AbortController() : undefined;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : undefined;
  try {
    return await fetch(url, {
      ...init,
      signal: controller?.signal,
      headers: {
        ...init.headers,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function ok(res: Response, label: string): Promise<Response> {
  // #617: no 410 exemption. syncEvents handles its own expired-token 410 BEFORE
  // calling ok(), so this stays strict for every other caller: a 410 (e.g. a
  // PATCH on a deleted event) is a failure, never a silent success.
  if (!res.ok) {
    // Carry the status (#913) and the parsed reason (#917) so callers like the
    // reachability probe can tell a definitive account/permission failure apart
    // from a transient one (a 403 rate limit vs a 403 permission failure).
    const text = await res.text();
    throw new GoogleHttpError(
      `${label} failed: ${res.status} ${text}`,
      res.status,
      parseGoogleErrorReason(text),
    );
  }
  return res;
}

/** Minimal calendarList entry (only the fields the calendar filter needs). */
export interface CalendarListEntry {
  id?: string;
  accessRole?: string;
  primary?: boolean;
  selected?: boolean;
  deleted?: boolean;
  summary?: string;
}

/**
 * Hard page cap for a single calendarList pagination pass (#171). At 250
 * calendars per page this is orders of magnitude above any real agent's set;
 * the cap only exists to stop a pathological account from issuing unbounded
 * subrequests inside one Worker invocation.
 */
export const MAX_CALENDAR_PAGES = 50;

/**
 * Thrown when calendarList pagination exceeds MAX_CALENDAR_PAGES (#171). A
 * truncated calendar list must never be treated as authoritative: ensureWatches
 * reconciles the stored calendar set against it and would delete every calendar
 * past the cap along with its push watch and cached busy blocks. Throwing keeps
 * that reconcile from ever running on a partial view; the next tick retries.
 */
export class CalendarListTruncated extends Error {
  constructor() {
    super(`calendarList exceeded ${MAX_CALENDAR_PAGES} pages`);
    this.name = "CalendarListTruncated";
  }
}

/**
 * Lists the calendars the impersonated agent can see (for busy aggregation).
 * Pass `timeoutMs` to bound each page fetch (#922, used by the bookable
 * reachability probe so a hanging Google can't stall activation); the read/sync
 * hot paths leave it unbounded as before.
 */
export async function listCalendars(
  email: string,
  timeoutMs?: number,
): Promise<CalendarListEntry[]> {
  if (LOADTEST) return stubCalendarList();
  const entries: CalendarListEntry[] = [];
  let pageToken: string | undefined;
  for (let page = 0; ; page++) {
    const params = new URLSearchParams({ maxResults: "250", showHidden: "true" });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await ok(
      await gfetch(email, `${BASE}/users/me/calendarList?${params.toString()}`, {}, timeoutMs),
      "calendarList.list",
    );
    const data = (await res.json()) as {
      items?: CalendarListEntry[];
      nextPageToken?: string;
    };
    entries.push(...(data.items ?? []));
    pageToken = data.nextPageToken;
    if (!pageToken) break;
    if (page + 1 >= MAX_CALENDAR_PAGES) throw new CalendarListTruncated();
  }
  return entries;
}

/**
 * Live free/busy across one or more of an agent's calendars — verify-on-book.
 * Busy on ANY calendar makes the agent unavailable.
 */
export async function freeBusy(
  email: string,
  timeMin: string,
  timeMax: string,
  calendarIds: string[],
): Promise<Interval[]> {
  if (LOADTEST) return stubFreeBusy();
  if (calendarIds.length === 0) return [];
  const res = await ok(
    await gfetch(email, `${BASE}/freeBusy`, {
      method: "POST",
      body: JSON.stringify({
        timeMin,
        timeMax,
        items: calendarIds.map((id) => ({ id })),
      }),
    }),
    "freeBusy",
  );
  const data = (await res.json()) as {
    calendars?: Record<string, { busy?: { start?: string; end?: string }[] }>;
  };
  const out: Interval[] = [];
  for (const cal of Object.values(data.calendars ?? {})) {
    for (const b of cal.busy ?? []) {
      if (b.start && b.end) out.push({ start: b.start, end: b.end });
    }
  }
  return out;
}

export async function isFree(
  email: string,
  start: string,
  end: string,
  calendarIds: string[],
  ignore?: Interval,
): Promise<boolean> {
  const busy = await freeBusy(email, start, end, calendarIds);
  // parse-ok: an unreadable slot boundary FAILS CLOSED here. NaN slot bounds make
  // hasBlockingBusy's overlap width NaN, its `os >= oe` early-out false, and so it
  // reports blocking: the agent reads busy, never free. Verified in core.ts.
  return !hasBlockingBusy(busy, Date.parse(start), Date.parse(end), ignore);
}

/**
 * Bulk free/busy across MANY calendars in a SINGLE query, read as one
 * domain-wide-delegation identity (`subject`) instead of impersonating each
 * agent — the scale path for verify-on-book (#167). Within a Workspace domain,
 * free/busy is visible across users, so one identity can read the whole
 * candidate pool. Google caps a freeBusy query at 20 calendar `items`, so the
 * caller must chunk; this issues exactly one call. Returns a per-calendar map;
 * any calendar Google reported an error for (e.g. access denied) — or that's
 * absent from the response — is marked `error: true` so the caller never assumes
 * it free. Response parsing is the pure, tested `busyByCalendarFromResponse`.
 */
export async function freeBusyMany(
  subject: string,
  timeMin: string,
  timeMax: string,
  calendarIds: string[],
): Promise<Map<string, CalendarBusy>> {
  if (calendarIds.length === 0) return new Map();
  if (LOADTEST) {
    return new Map(calendarIds.map((id) => [id, { busy: [], error: false }]));
  }
  const res = await ok(
    await gfetch(subject, `${BASE}/freeBusy`, {
      method: "POST",
      body: JSON.stringify({
        timeMin,
        timeMax,
        items: calendarIds.map((id) => ({ id })),
      }),
    }),
    "freeBusy.many",
  );
  const data = (await res.json()) as {
    calendars?: Record<
      string,
      { busy?: { start?: string; end?: string }[]; errors?: unknown[] }
    >;
  };
  return busyByCalendarFromResponse(calendarIds, data.calendars);
}

export interface CreateEventInput {
  summary: string;
  description?: string;
  start: string;
  end: string;
  timezone: string;
  attendeeEmail?: string;
  attendeeName?: string;
}

export async function createEvent(
  email: string,
  input: CreateEventInput,
  clientId?: string,
): Promise<string> {
  const res = await gfetch(email, `${BASE}/calendars/${CAL}/events?sendUpdates=all`, {
    method: "POST",
    body: JSON.stringify({
      // P4 (#439): a deterministic client-supplied id makes the create
      // idempotent — a retry sends the same id and Google 409s the duplicate.
      ...(clientId ? { id: clientId } : {}),
      summary: input.summary,
      description: input.description,
      start: { dateTime: input.start, timeZone: input.timezone },
      end: { dateTime: input.end, timeZone: input.timezone },
      attendees: input.attendeeEmail
        ? [{ email: input.attendeeEmail, displayName: input.attendeeName }]
        : undefined,
    }),
  });

  // 409-as-success: a duplicate client id means THIS event already exists (a
  // retry of the same intent on the same agent). GET it and return it — no
  // second insert, so no second attendee invite. Inspect the raw 409 BEFORE the
  // shared ok() (which would throw); ok() is left untouched for all other calls.
  if (clientId && res.status === 409) {
    const existing = await ok(
      await gfetch(email, `${BASE}/calendars/${CAL}/events/${encodeURIComponent(clientId)}`),
      "events.get (409 reuse)",
    );
    const reused = (await existing.json()) as { id?: string };
    if (!reused.id) throw new Error("Google did not return an event id on reuse");
    return reused.id;
  }

  await ok(res, "events.insert");
  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new Error("Google did not return an event id");
  return data.id;
}

/**
 * Event create on an arbitrary calendar (the OOO flow writes to manager OOO
 * calendars and agent primaries). No attendees and no sendUpdates — these are
 * blocking events, not invitations; the booking paths above stay untouched.
 */
export async function createEventOnCalendar(
  actorEmail: string,
  calendarId: string,
  input: Omit<CreateEventInput, "attendeeEmail" | "attendeeName">,
  clientId?: string,
): Promise<string> {
  const res = await gfetch(
    actorEmail,
    `${BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      body: JSON.stringify({
        // #1469: a deterministic client supplied id makes the create idempotent,
        // the same trick the booking path uses. These writes are bounded at 8
        // seconds because the manager waits on them, so a slow moment at Google
        // surfaces as an abort, and an aborted insert may still have been applied
        // on Google's side. The retry sends this same id and Google 409s it.
        ...(clientId ? { id: clientId } : {}),
        summary: input.summary,
        description: input.description,
        start: { dateTime: input.start, timeZone: input.timezone },
        end: { dateTime: input.end, timeZone: input.timezone },
      }),
    },
    CALENDAR_WRITE_TIMEOUT_MS,
  );

  // 409-as-success, but ONLY when we supplied the id: then the duplicate is
  // provably this same intent, and GETting it returns the event Google already
  // created. With no id of our own a 409 is a conflict we cannot resolve, and
  // swallowing it would report an event that does not exist.
  if (clientId && res.status === 409) {
    const existing = await ok(
      await gfetch(
        actorEmail,
        `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(clientId)}`,
        {},
        CALENDAR_WRITE_TIMEOUT_MS,
      ),
      "events.get (409 reuse)",
    );
    const reused = (await existing.json()) as { id?: string };
    if (!reused.id) throw new Error("Google did not return an event id on reuse");
    return reused.id;
  }

  await ok(res, "events.insert");
  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new Error("Google did not return an event id");
  return data.id;
}

/** Tolerant delete on an arbitrary calendar (404/410 mean already gone). */
export async function deleteEventOnCalendar(
  actorEmail: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  const res = await gfetch(
    actorEmail,
    `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE" },
    CALENDAR_WRITE_TIMEOUT_MS,
  );
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`events.delete failed: ${res.status} ${await res.text()}`);
  }
}

export async function updateEventTime(
  email: string,
  eventId: string,
  start: string,
  end: string,
  timezone: string,
): Promise<void> {
  const res = await gfetch(
    email,
    `${BASE}/calendars/${CAL}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
    {
      method: "PATCH",
      body: JSON.stringify({
        start: { dateTime: start, timeZone: timezone },
        end: { dateTime: end, timeZone: timezone },
      }),
    },
  );
  // #617: a PATCH on a deleted event 404/410s. Surface it as a typed EventGone
  // so the reschedule recreates the event instead of committing a phantom move
  // (ok() would otherwise throw a generic error). Checked BEFORE ok().
  if (res.status === 404 || res.status === 410) throw new EventGone("events.patch");
  await ok(res, "events.patch");
}

/**
 * Whether an event still exists on the agent's primary calendar (#830). A GET
 * returns 200 when present, 404/410 when gone (deleted by the agent, or already
 * removed by the deletion drain). Any other status throws, so a caller can tell
 * "confirmed gone" from "couldn't verify" and avoid a false alert on a blip.
 */
export async function eventExists(email: string, eventId: string): Promise<boolean> {
  const res = await gfetch(
    email,
    `${BASE}/calendars/${CAL}/events/${encodeURIComponent(eventId)}`,
    {},
    CALENDAR_WRITE_TIMEOUT_MS,
  );
  if (res.status === 404 || res.status === 410) return false;
  await ok(res, "events.get (exists)");
  return true;
}

export async function deleteEvent(
  email: string,
  eventId: string,
  opts?: { notifyAttendee?: boolean },
): Promise<void> {
  // A reassign (#969) removes the OLD agent's event SILENTLY so the customer gets
  // no cancellation email: the swap is invisible to them (their time is unchanged)
  // and the ONE notification they get is the new agent's invite. Every other
  // delete (a real cancellation) keeps sendUpdates=all so the customer is told.
  const sendUpdates = opts?.notifyAttendee === false ? "none" : "all";
  const res = await gfetch(
    email,
    `${BASE}/calendars/${CAL}/events/${encodeURIComponent(eventId)}?sendUpdates=${sendUpdates}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`events.delete failed: ${res.status} ${await res.text()}`);
  }
}

export async function watchCalendar(
  email: string,
  calendarId: string,
  channelId: string,
): Promise<{ resourceId: string | null; expiration: string | null }> {
  if (LOADTEST) return stubWatch(channelId, Date.now());
  const res = await ok(
    await gfetch(email, `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/watch`, {
      method: "POST",
      body: JSON.stringify({
        id: channelId,
        type: "web_hook",
        address: googlePushUrl(),
        token: googleChannelToken(),
      }),
    }),
    "events.watch",
  );
  const data = (await res.json()) as { resourceId?: string; expiration?: string };
  return {
    resourceId: data.resourceId ?? null,
    expiration: data.expiration
      ? new Date(Number(data.expiration)).toISOString()
      : null,
  };
}

export async function stopChannel(
  email: string,
  channelId: string,
  resourceId: string,
): Promise<void> {
  if (LOADTEST) return;
  await gfetch(email, `${BASE}/channels/stop`, {
    method: "POST",
    body: JSON.stringify({ id: channelId, resourceId }),
  });
}

export interface SyncResult {
  events: GoogleEvent[];
  nextSyncToken: string | null;
  /**
   * True when the pagination stopped at MAX_SYNC_PAGES with more pages still
   * outstanding (#171). On truncation `nextSyncToken` is null (Google only
   * returns one on the final page), so syncCalendar keeps the stored token and
   * the next tick re-reads the same delta rather than skipping the unread pages.
   */
  truncated: boolean;
}

/**
 * Hard page cap for a single events.list pagination pass (#171). Google's page
 * sizes bound this to one or two pages in practice; the cap stops a pathological
 * calendar from issuing unbounded subrequests inside one Worker invocation. It
 * is deliberately far above any real calendar's delta so normal syncs never hit
 * it. Exported for the test that drives the loop past it.
 */
export const MAX_SYNC_PAGES = 50;

/**
 * Incremental sync of an agent's events. Pass the stored syncToken for changes
 * since last sync, or null to bootstrap. Throws SyncTokenExpired on 410.
 */
export async function syncEvents(
  email: string,
  calendarId: string,
  syncToken: string | null,
  timeMinForBootstrap: string,
): Promise<SyncResult> {
  if (LOADTEST) return stubSyncEvents(syncToken, Date.now());
  const events: GoogleEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | null = null;
  let truncated = false;

  for (let page = 0; ; page++) {
    const params = new URLSearchParams({
      singleEvents: "true",
      showDeleted: "true",
    });
    if (syncToken) params.set("syncToken", syncToken);
    else {
      params.set("timeMin", timeMinForBootstrap);
      params.set("maxResults", "2500");
    }
    if (pageToken) params.set("pageToken", pageToken);

    const res = await gfetch(
      email,
      `${BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
    );
    if (res.status === 410) throw new SyncTokenExpired();
    await ok(res, "events.list");

    const data = (await res.json()) as {
      items?: GoogleEvent[];
      nextPageToken?: string;
      nextSyncToken?: string;
    };
    events.push(...(data.items ?? []));
    // Google returns nextSyncToken only on the final page; an intermediate page
    // carries nextPageToken and no token. So stopping on the cap below (which
    // only happens while a nextPageToken remains) always leaves nextSyncToken
    // null, and syncCalendar keeps the stored token to resume next tick.
    nextSyncToken = data.nextSyncToken ?? nextSyncToken;
    pageToken = data.nextPageToken;
    if (!pageToken) break;
    if (page + 1 >= MAX_SYNC_PAGES) {
      truncated = true;
      break;
    }
  }

  return { events, nextSyncToken, truncated };
}

/**
 * Rewrite an event's description on the agent's primary calendar (#1341).
 *
 * Only the body: a phone correction must never move the time, so this PATCHes
 * `description` alone and shares nothing with `updateEventTime`. `sendUpdates=all`
 * so the lead's own copy of the invite carries the number they just corrected.
 *
 * A deleted event surfaces as the same typed `EventGone` the time patch uses, so
 * a caller can tell "the event is not there" from "Google is unwell" rather than
 * reading both as one generic failure.
 */
export async function updateEventDescription(
  email: string,
  eventId: string,
  description: string,
): Promise<void> {
  const res = await gfetch(
    email,
    `${BASE}/calendars/${CAL}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
    { method: "PATCH", body: JSON.stringify({ description }) },
  );
  if (res.status === 404 || res.status === 410) throw new EventGone("events.patch.description");
  await ok(res, "events.patch.description");
}
