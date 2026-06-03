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

/** Live free/busy for one agent — used only for verify-on-book. */
export async function freeBusy(
  email: string,
  timeMin: string,
  timeMax: string,
): Promise<Interval[]> {
  const res = await ok(
    await gfetch(email, `${BASE}/freeBusy`, {
      method: "POST",
      body: JSON.stringify({ timeMin, timeMax, items: [{ id: CAL }] }),
    }),
    "freeBusy",
  );
  const data = (await res.json()) as {
    calendars?: Record<string, { busy?: { start?: string; end?: string }[] }>;
  };
  const busy = data.calendars?.[CAL]?.busy ?? [];
  return busy
    .filter((b): b is Interval => !!b.start && !!b.end)
    .map((b) => ({ start: b.start, end: b.end }));
}

export async function isFree(
  email: string,
  start: string,
  end: string,
): Promise<boolean> {
  const busy = await freeBusy(email, start, end);
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
  channelId: string,
): Promise<{ resourceId: string | null; expiration: string | null }> {
  const res = await ok(
    await gfetch(email, `${BASE}/calendars/${CAL}/events/watch`, {
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
      `${BASE}/calendars/${CAL}/events?${params.toString()}`,
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
