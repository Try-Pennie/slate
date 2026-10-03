import { getDelegatedToken } from "@/lib/google/dwd";
import { GoogleHttpError } from "@/lib/google/http-error";
import { parseGoogleErrorReason } from "@/lib/google/reachability-classify";
import {
  busyByCalendarFromResponse,
  chunkCalendarIds,
  hasBlockingBusy,
  EventGone,
  type CalendarBusy,
} from "@/lib/booking/core";
import { log } from "@/lib/log";
import { googlePushUrl, googleChannelToken } from "@/lib/env";
import {
  LOADTEST,
  stubCalendarList,
  stubSyncEvents,
  stubWatch,
  stubFreeBusy,
  stubCreateEvent,
  stubEventOnPrimary,
  stubEventWrite,
} from "@/lib/google/loadtest-stub";

const BASE = "https://www.googleapis.com/calendar/v3";
// Impersonating the agent, "primary" is their own calendar.
const CAL = "primary";

/** Minimal shape of a Google Calendar event (only the fields sync uses). */
export interface GoogleEvent {
  id?: string;
  status?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  /**
   * The invitation's guest list (#2389). Only the impersonated agent's OWN
   * entry, the one Google marks `self: true`, records whether THEY will be
   * there, and a declined invitation is otherwise indistinguishable from an
   * accepted one: it keeps `status: "confirmed"` and the default
   * `transparency: "opaque"`. Read by `isBusyEvent`, which is the only judge of
   * whether an event becomes cached busy time.
   *
   * `email` is declared so a call site cannot quietly read one attendee's answer
   * as another's; nothing in Slate stores it, and it never leaves this module.
   */
  attendees?: { email?: string; self?: boolean; responseStatus?: string }[];
  /** The invite's body, read so the reminder lane can edit one line of it (#1334). */
  description?: string;
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
  if (LOADTEST) return stubCalendarList(email);
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
 * Live free/busy across one or more of an agent's calendars, impersonating that
 * agent. This is the accurate fallback the bulk cross identity verifier hands an
 * agent to when it could not read one of their calendars, so it is the LAST read
 * before `createEvent`, and the in place reschedule guard's read as well.
 *
 * **Returns `null` for "could not tell", never an empty list** (#2412). Google
 * reports a per calendar failure INSIDE a 200 response, as
 * `calendars.<id>.errors[]` with reasons like `internalError`, `notFound` and
 * `tooManyCalendarsRequested`. This reader used to look only at `busy`, so an
 * errored calendar arrived as no busy time at all and `isFree` answered FREE:
 * the bulk wave refused to trust the calendar, routed the agent here for an
 * accurate answer, and this asked the same calendar, met the same error, and
 * booked the lead over whatever it held. Withholding a slot is recoverable and
 * booking over a real meeting is not, so an unreadable calendar is unreadable.
 *
 * Parsing goes through `busyByCalendarFromResponse`, the same pure, tested
 * parser `freeBusyMany` uses, so the two readers of one payload cannot hold two
 * rules again. A calendar ABSENT from the response counts as unreadable too: it
 * was not measured, and that is the shape a `tooManyCalendarsRequested` reply
 * takes for the calendars Google dropped.
 *
 * Chunked at `FREEBUSY_MAX_ITEMS`, which is why that cap now lives in the pure
 * module both readers import. Chunks run in order and the first unreadable one
 * ends the read, since the answer cannot improve.
 */
export async function freeBusy(
  email: string,
  timeMin: string,
  timeMax: string,
  calendarIds: string[],
): Promise<Interval[] | null> {
  if (LOADTEST) return stubFreeBusy(email);
  if (calendarIds.length === 0) return [];
  const out: Interval[] = [];
  for (const chunk of chunkCalendarIds(calendarIds)) {
    const res = await ok(
      await gfetch(email, `${BASE}/freeBusy`, {
        method: "POST",
        body: JSON.stringify({
          timeMin,
          timeMax,
          items: chunk.map((id) => ({ id })),
        }),
      }),
      "freeBusy",
    );
    const data = (await res.json()) as {
      calendars?: Record<
        string,
        { busy?: { start?: string; end?: string }[]; errors?: unknown[] }
      >;
    };
    const byCalendar = busyByCalendarFromResponse(chunk, data.calendars);
    for (const [calendarId, entry] of byCalendar) {
      if (entry.error) {
        log.warn("google-freebusy", {
          msg: "calendar unreadable, reporting unverified rather than free",
          email,
          calendar_id: calendarId,
        });
        return null;
      }
      for (const b of entry.busy) out.push({ start: b.start, end: b.end });
    }
  }
  return out;
}

/**
 * Whether the agent is free over the window, or `null` when a calendar could not
 * be read (#2412). Null is never a yes: `checkAgentFree` maps it to `unverified`,
 * which the booker surfaces as a retriable "try again in a moment" rather than
 * assigning the slot.
 */
export async function isFree(
  email: string,
  start: string,
  end: string,
  calendarIds: string[],
  ignore?: Interval,
): Promise<boolean | null> {
  const busy = await freeBusy(email, start, end, calendarIds);
  if (busy === null) return null;
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
  // #2241: the confirm path's first Google call. Ungated, a booking path load run
  // could not complete one booking.
  if (LOADTEST) return stubCreateEvent(input, clientId);
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
 * The body `createEventOnCalendar` accepts. Attendees are absent by construction
 * (these are blocking or informational events, never invitations).
 *
 * `transparency` and `colorId` are optional and OMITTED from the request when unset
 * (#2371), so every caller that predates them sends the byte-identical body it always
 * did. `transparency: "transparent"` is what keeps an event out of Google's free/busy
 * answer and out of `isBusyEvent`, i.e. what stops a purely informational event ever
 * moving availability.
 */
export type CreateCalendarEventInput = Omit<
  CreateEventInput,
  "attendeeEmail" | "attendeeName"
> & {
  transparency?: "transparent" | "opaque";
  colorId?: string;
};

/**
 * Event create on an arbitrary calendar (the OOO flow writes to manager OOO
 * calendars and agent primaries; #2371 writes the owner alert to an advisor's own).
 * No attendees and no sendUpdates: these are blocking or informational events, not
 * invitations, so the booking paths above stay untouched.
 */
export async function createEventOnCalendar(
  actorEmail: string,
  calendarId: string,
  input: CreateCalendarEventInput,
  clientId?: string,
): Promise<string> {
  // #2371: the owner alert reaches this on the reassign path, so a booking path load
  // run would write a real event onto a real advisor's calendar. Stubbed like the
  // booking create above, which also makes the deterministic id the answer, so the
  // 409 reuse a resume depends on still behaves as it does against Google.
  if (LOADTEST) return stubCreateEvent(input, clientId);
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
        // Conditional so an unset field is absent rather than null: Google reads an
        // explicit null as a value, and every pre-#2371 caller must keep sending
        // exactly the body it sent before.
        ...(input.transparency ? { transparency: input.transparency } : {}),
        ...(input.colorId ? { colorId: input.colorId } : {}),
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

/**
 * Move an event on an arbitrary calendar (#2371: a reschedule takes the owner alert
 * with it). No `sendUpdates`, because these events have no guests to tell.
 *
 * A 404/410 throws the typed `EventGone` rather than passing silently, so the caller
 * can tell "moved" from "there was nothing there": treating a missing event as a
 * successful move is exactly the silence this codebase keeps paying for (#617).
 */
export async function updateEventTimeOnCalendar(
  actorEmail: string,
  calendarId: string,
  eventId: string,
  start: string,
  end: string,
  timezone: string,
): Promise<void> {
  // #2371: nothing was written under the flag, so there is nothing to move, and the
  // typed EventGone below is unreachable (the same note as updateEventTime).
  if (LOADTEST) return stubEventWrite("patch", eventId);
  const res = await gfetch(
    actorEmail,
    `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        start: { dateTime: start, timeZone: timezone },
        end: { dateTime: end, timeZone: timezone },
      }),
    },
    CALENDAR_WRITE_TIMEOUT_MS,
  );
  if (res.status === 404 || res.status === 410) throw new EventGone("events.patch");
  await ok(res, "events.patch");
}

/** Tolerant delete on an arbitrary calendar (404/410 mean already gone). */
export async function deleteEventOnCalendar(
  actorEmail: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  // #2371: nothing was written under the flag, so there is nothing to delete.
  if (LOADTEST) return stubEventWrite("delete", eventId);
  const res = await gfetch(
    actorEmail,
    `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE" },
    CALENDAR_WRITE_TIMEOUT_MS,
  );
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    // A typed error, not a plain one (#2371). `reachabilityFromError` reads the status
    // and the reason off a GoogleHttpError and calls everything else TRANSIENT, so a
    // plain Error here made a `403 notACalendarUser` (an advisor who was never given
    // Calendar) indistinguishable from a blip, and the owner alert's removal would
    // have retried forever against a calendar nothing can ever reach. Same message
    // shape as before, so nothing matching on the text changes.
    const text = await res.text();
    throw new GoogleHttpError(
      `events.delete failed: ${res.status} ${text}`,
      res.status,
      parseGoogleErrorReason(text),
    );
  }
}

export async function updateEventTime(
  email: string,
  eventId: string,
  start: string,
  end: string,
  timezone: string,
): Promise<void> {
  // #2241: the in-place reschedule's move. Nothing was written, so nothing is gone:
  // the typed `EventGone` below is unreachable under the flag, which is why the
  // reschedule's recreate branch is not exercised by a load run.
  if (LOADTEST) return stubEventWrite("patch", eventId);
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
 * One event from the agent's primary calendar, or null when it is gone.
 *
 * A GET returns 200 when present and 404/410 when gone (deleted by the agent, or
 * already removed by the deletion drain). Any other status throws, so a caller
 * can tell "confirmed gone" from "couldn't verify" and avoid a false alert on a
 * blip.
 *
 * The BODY is what `pnpm verify:ooo-protection` (#1478) needs: an approved time
 * off is only protected if the event's own start and end still match the window
 * it was written for, and free/busy cannot answer that (busy periods merge, so a
 * neighbouring meeting makes a mistimed event read as a perfectly occupied
 * window).
 */
export async function getEventOnPrimary(
  email: string,
  eventId: string,
): Promise<GoogleEvent | null> {
  // #2241. Gating this gates `eventExists` with it, which is the creation-orphan
  // check's only question.
  if (LOADTEST) return stubEventOnPrimary(eventId, Date.now());
  const res = await gfetch(
    email,
    `${BASE}/calendars/${CAL}/events/${encodeURIComponent(eventId)}`,
    {},
    CALENDAR_WRITE_TIMEOUT_MS,
  );
  if (res.status === 404 || res.status === 410) return null;
  await ok(res, "events.get");
  return (await res.json()) as GoogleEvent;
}

/**
 * Whether an event still exists on the agent's primary calendar (#830). Reads
 * through the same GET as `getEventOnPrimary` so the two can never disagree
 * about what "gone" means.
 */
export async function eventExists(email: string, eventId: string): Promise<boolean> {
  return (await getEventOnPrimary(email, eventId)) !== null;
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
  // #2241: the rollback `completeReservation` takes when the insert loses, and the
  // cancel. A no-op, since nothing was created to remove.
  if (LOADTEST) return stubEventWrite("delete", eventId);
  const sendUpdates = opts?.notifyAttendee === false ? "none" : "all";
  const res = await gfetch(
    email,
    `${BASE}/calendars/${CAL}/events/${encodeURIComponent(eventId)}?sendUpdates=${sendUpdates}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    // A typed error, not a plain one (#2561), for the same reason the sibling
    // `deleteEventOnCalendar` was given one in #2371. `reachabilityFromError`
    // reads the status and the reason off a GoogleHttpError and calls everything
    // else TRANSIENT, so a plain Error here made a `403 notACalendarUser` (an
    // advisor who was never given Calendar) and a revoked delegation both look
    // like a blip, to `deleteEventBestEffort` and to the retry drain behind it.
    // Same message shape as before, so nothing matching on the text changes.
    const text = await res.text();
    throw new GoogleHttpError(
      `events.delete failed: ${res.status} ${text}`,
      res.status,
      parseGoogleErrorReason(text),
    );
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
  /**
   * Upper bound for a BOOTSTRAP, so the cache stops claiming coverage it never fetched
   * (#1261). Sent only on the bootstrap branch below: `timeMin`/`timeMax` alongside a
   * `syncToken` is a documented 400 from Google, and the delta is not scoped by them
   * anyway (measured, #1252).
   *
   * Required, not optional. Every caller now windows its bootstrap, and whatever is sent
   * here is exactly what the reconcile is allowed to judge, so a caller that forgot it
   * would silently widen what may be deleted. Making it required means tsc names every
   * construction site instead.
   */
  timeMaxForBootstrap: string,
): Promise<SyncResult> {
  if (LOADTEST)
    return stubSyncEvents(syncToken, Date.now(), {
      timeMinIso: timeMinForBootstrap,
      timeMaxIso: timeMaxForBootstrap,
    });
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
      params.set("timeMax", timeMaxForBootstrap);
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
 * Only the body: a phone correction must never move the time, so this shares
 * nothing with `updateEventTime`.
 *
 * Kept as its own name over `updateEventContact` below because the phone
 * correction is a one field edit and reads as one at its call site.
 */
export async function updateEventDescription(
  email: string,
  eventId: string,
  description: string,
): Promise<void> {
  await updateEventContact(email, eventId, { description });
}

/**
 * The lead's own details on the invite: the summary, the body, and WHO is invited
 * (#2164).
 *
 * One PATCH rather than one per field, because they change together: a lead who
 * corrects their email on the way to moving a call routinely corrects the number
 * beside it, and two patches would be two ways for the invite to end up half
 * right.
 *
 * `sendUpdates` is decided by whether the ATTENDEE moved, and that is the whole
 * rule. Google syncs an event's content to its attendees either way; this
 * parameter decides only whether they are emailed. A new address has never been
 * invited to anything, so it must be told, and the old one must learn it is out.
 * A number or a name the lead just typed on our own page is not news to them, and
 * mailing "your event was updated" back at somebody for their own correction is
 * noise. The advisor's copy carries the new value in both cases, which is the
 * point.
 *
 * A deleted event surfaces as the same typed `EventGone` the time patch uses, so a
 * caller can tell "the event is not there" from "Google is unwell" rather than
 * reading both as one generic failure.
 */
export async function updateEventContact(
  email: string,
  eventId: string,
  patch: { summary?: string; description?: string; attendeeEmail?: string; attendeeName?: string },
): Promise<void> {
  // #2241: the lead's own corrections on the way to a reschedule, which `realDeps`
  // reaches and so a booking path run can drive. `updateEventDescription` delegates
  // here, so it is gated with it.
  if (LOADTEST) return stubEventWrite("patch", eventId);
  const body: Record<string, unknown> = {};
  if (patch.summary !== undefined) body.summary = patch.summary;
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.attendeeEmail !== undefined) {
    body.attendees = [{ email: patch.attendeeEmail, displayName: patch.attendeeName }];
  }
  const sendUpdates = patch.attendeeEmail === undefined ? "none" : "all";
  const res = await gfetch(
    email,
    `${BASE}/calendars/${CAL}/events/${encodeURIComponent(eventId)}?sendUpdates=${sendUpdates}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
  if (res.status === 404 || res.status === 410) throw new EventGone("events.patch.description");
  await ok(res, "events.patch.description");
}
