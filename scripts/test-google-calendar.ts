// Unit tests for the shared Google-calendar error handling (#617).
// Verifies gfetch's ok() no longer swallows HTTP 410 as success, and that
// updateEventTime raises a typed EventGone on a 404/410 (deleted event) so the
// reschedule path can recreate the event instead of committing a phantom move.
// No network: globalThis.fetch is stubbed for BOTH the DWD token endpoint and
// the Calendar API, and a throwaway RSA key satisfies the JWT signer.
// Run: node --experimental-strip-types scripts/test-google-calendar.ts
import { generateKeyPairSync } from "node:crypto";
import { assert, finish } from "./lib/harness.ts";

// A real (throwaway) service-account key so the domain-wide-delegation JWT
// signer produces a valid signature without any live credentials.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
process.env.GOOGLE_SA_CLIENT_EMAIL = "sa@slate-test.iam.gserviceaccount.com";
process.env.GOOGLE_SA_PRIVATE_KEY = privateKey as string;

const TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Install a fetch stub: the token endpoint always returns a fresh access token
 * (a distinct token each call defeats the ~55min in-memory cache across cases),
 * and every Calendar API call returns `calStatus` with `calBody`.
 */
let tokenSeq = 0;
function stubFetch(calStatus: number, calBody: unknown) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === TOKEN_URL) {
      return new Response(
        JSON.stringify({ access_token: `tok-${++tokenSeq}`, expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify(calBody), {
      status: calStatus,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

/**
 * Serves a bounded sequence of calendar pages so a paging loop can be driven
 * across (and past) its page cap without a live API (#171). Each Calendar API
 * call reads `pageToken` from the URL to pick a page: pages 0..totalPages-2
 * carry a `nextPageToken`; the final page carries a `nextSyncToken` (events
 * only) and no `nextPageToken`. `calls` counts only Calendar API hits (not the
 * token endpoint) so a test can assert the loop stopped at the cap.
 */
function stubPaginated(kind: "events" | "calendars", totalPages: number) {
  const state = { calls: 0 };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === TOKEN_URL) {
      return new Response(
        JSON.stringify({ access_token: `tok-${++tokenSeq}`, expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    state.calls++;
    const token = new URL(url).searchParams.get("pageToken");
    const page = token ? Number(token.replace("p", "")) : 0;
    const isLast = page >= totalPages - 1;
    const body: Record<string, unknown> = {};
    if (kind === "events") {
      body.items = [
        {
          id: `evt-${page}`,
          status: "confirmed",
          start: { dateTime: "2026-06-09T14:00:00Z" },
          end: { dateTime: "2026-06-09T14:30:00Z" },
        },
      ];
      if (isLast) body.nextSyncToken = "final-sync-token";
      else body.nextPageToken = `p${page + 1}`;
    } else {
      body.items = [{ id: `cal-${page}`, accessRole: "owner" }];
      if (!isLast) body.nextPageToken = `p${page + 1}`;
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return state;
}

const {
  updateEventTime,
  listCalendars,
  syncEvents,
  CalendarListTruncated,
  MAX_SYNC_PAGES,
  MAX_CALENDAR_PAGES,
} = await import("../src/lib/google/calendar.ts");
const { EventGone } = await import("../src/lib/booking/core.ts");

async function main() {
  // --- updateEventTime raises EventGone on 410 (the #617 core case) ---
  {
    stubFetch(410, { error: { code: 410, message: "Resource has been deleted" } });
    let caught: unknown;
    try {
      await updateEventTime("a@x.com", "gone-evt", "2026-06-09T14:00:00Z", "2026-06-09T14:30:00Z", "America/New_York");
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof EventGone, "updateEventTime throws EventGone on HTTP 410");
  }

  // --- updateEventTime raises EventGone on 404 too (already gone) ---
  {
    stubFetch(404, { error: { code: 404, message: "Not Found" } });
    let caught: unknown;
    try {
      await updateEventTime("a@x.com", "missing-evt", "2026-06-09T14:00:00Z", "2026-06-09T14:30:00Z", "America/New_York");
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof EventGone, "updateEventTime throws EventGone on HTTP 404");
  }

  // --- updateEventTime resolves on a normal 200 ---
  {
    stubFetch(200, { id: "evt-1" });
    let ok = true;
    try {
      await updateEventTime("a@x.com", "evt-1", "2026-06-09T14:00:00Z", "2026-06-09T14:30:00Z", "America/New_York");
    } catch {
      ok = false;
    }
    assert(ok, "updateEventTime resolves on HTTP 200");
  }

  // --- the shared ok() no longer swallows 410: a plain read now throws ---
  {
    stubFetch(410, { error: { code: 410, message: "Gone" } });
    let threw = false;
    try {
      await listCalendars("a@x.com");
    } catch {
      threw = true;
    }
    assert(threw, "listCalendars (ok()) throws on 410 instead of swallowing it");
  }

  // --- syncEvents pages to natural completion under the cap (#171 normal) ---
  {
    const s = stubPaginated("events", 3);
    const res = await syncEvents("a@x.com", "primary", "old-token", "2026-06-08T00:00:00Z");
    assert(s.calls === 3, "syncEvents pages through all 3 pages when under the cap");
    assert(res.events.length === 3, "syncEvents returns every event across pages");
    assert(
      res.nextSyncToken === "final-sync-token",
      "syncEvents returns the final sync token on natural completion",
    );
    assert(res.truncated === false, "syncEvents is not truncated when it completes");
  }

  // --- syncEvents stops at the page cap and resumes via the retained token ---
  // (#171 edge/failure path: a pathological calendar returns more pages than the
  // cap. The loop must stop at the cap AND advance no sync token, so syncCalendar
  // keeps the stored token and the next tick re-reads the same delta rather than
  // silently skipping the unread pages.)
  {
    const s = stubPaginated("events", MAX_SYNC_PAGES + 5);
    const res = await syncEvents("a@x.com", "primary", "old-token", "2026-06-08T00:00:00Z");
    assert(
      s.calls === MAX_SYNC_PAGES,
      `syncEvents stops at the ${MAX_SYNC_PAGES}-page cap instead of looping unbounded`,
    );
    assert(res.truncated === true, "syncEvents reports truncation when it hits the cap");
    assert(
      res.nextSyncToken === null,
      "a truncated syncEvents advances no token, so the next run resumes the same delta",
    );
  }

  // --- listCalendars pages to completion under the cap (#171 normal) ---
  {
    const s = stubPaginated("calendars", 2);
    const cals = await listCalendars("a@x.com");
    assert(s.calls === 2, "listCalendars pages through all pages when under the cap");
    assert(cals.length === 2, "listCalendars returns every calendar across pages");
  }

  // --- listCalendars throws rather than paging unbounded past the cap ---
  // (#171 edge/failure path: a partial calendar list is NOT authoritative, so
  // listCalendars throws instead of returning a truncated set that ensureWatches
  // would reconcile against and delete every calendar past the cap.)
  {
    const s = stubPaginated("calendars", MAX_CALENDAR_PAGES + 5);
    let caught: unknown;
    try {
      await listCalendars("a@x.com");
    } catch (e) {
      caught = e;
    }
    assert(
      caught instanceof CalendarListTruncated,
      "listCalendars throws CalendarListTruncated at the page cap",
    );
    assert(
      s.calls === MAX_CALENDAR_PAGES,
      `listCalendars stops calling Google at the ${MAX_CALENDAR_PAGES}-page cap`,
    );
  }

  finish();
}

await main();
