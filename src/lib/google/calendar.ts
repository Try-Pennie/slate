import { getDelegatedToken } from "@/lib/google/dwd";
import { googlePushUrl, googleChannelToken } from "@/lib/env";

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

/** Authenticated fetch against an agent's calendar via domain-wide delegation. */
async function gfetch(
  email: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getDelegatedToken(email);
  return fetch(url, {
    ...init,
    headers: {
      ...init.headers,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  });
}

async function ok(res: Response, label: string): Promise<Response> {
  if (!res.ok && res.status !== 410) {
    throw new Error(`${label} failed: ${res.status} ${await res.text()}`);
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

/** Lists the calendars the impersonated agent can see (for busy aggregation). */
export async function listCalendars(email: string): Promise<CalendarListEntry[]> {
  const entries: CalendarListEntry[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ maxResults: "250", showHidden: "true" });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await ok(
      await gfetch(email, `${BASE}/users/me/calendarList?${params.toString()}`),
      "calendarList.list",
    );
    const data = (await res.json()) as {
      items?: CalendarListEntry[];
      nextPageToken?: string;
    };
    entries.push(...(data.items ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);
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
): Promise<boolean> {
  const busy = await freeBusy(email, start, end, calendarIds);
  const s = Date.parse(start);
  const e = Date.parse(end);
  return !busy.some((b) => Date.parse(b.start) < e && Date.parse(b.end) > s);
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
): Promise<string> {
  const res = await ok(
    await gfetch(email, `${BASE}/calendars/${CAL}/events?sendUpdates=all`, {
      method: "POST",
      body: JSON.stringify({
        summary: input.summary,
        description: input.description,
        start: { dateTime: input.start, timeZone: input.timezone },
        end: { dateTime: input.end, timeZone: input.timezone },
        attendees: input.attendeeEmail
          ? [{ email: input.attendeeEmail, displayName: input.attendeeName }]
          : undefined,
      }),
    }),
    "events.insert",
  );
  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new Error("Google did not return an event id");
  return data.id;
}

export async function updateEventTime(
  email: string,
  eventId: string,
  start: string,
  end: string,
  timezone: string,
): Promise<void> {
  await ok(
    await gfetch(
      email,
      `${BASE}/calendars/${CAL}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
      {
        method: "PATCH",
        body: JSON.stringify({
          start: { dateTime: start, timeZone: timezone },
          end: { dateTime: end, timeZone: timezone },
        }),
      },
    ),
    "events.patch",
  );
}

export async function deleteEvent(email: string, eventId: string): Promise<void> {
  const res = await gfetch(
    email,
    `${BASE}/calendars/${CAL}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
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
  await gfetch(email, `${BASE}/channels/stop`, {
    method: "POST",
    body: JSON.stringify({ id: channelId, resourceId }),
  });
}

export interface SyncResult {
  events: GoogleEvent[];
  nextSyncToken: string | null;
}

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
  const events: GoogleEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | null = null;

  do {
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
    pageToken = data.nextPageToken;
    nextSyncToken = data.nextSyncToken ?? nextSyncToken;
  } while (pageToken);

  return { events, nextSyncToken };
}
