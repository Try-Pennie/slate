// Unit tests for the shared Google-calendar error handling (#617).
// Verifies gfetch's ok() no longer swallows HTTP 410 as success, and that
// updateEventTime raises a typed EventGone on a 404/410 (deleted event) so the
// reschedule path can recreate the event instead of committing a phantom move.
// No network: globalThis.fetch is stubbed for BOTH the DWD token endpoint and
// the Calendar API, and a throwaway RSA key satisfies the JWT signer.
// Run: node --experimental-strip-types scripts/test-google-calendar.ts
import { generateKeyPairSync } from "node:crypto";

// A real (throwaway) service-account key so the domain-wide-delegation JWT
// signer produces a valid signature without any live credentials.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
process.env.GOOGLE_SA_CLIENT_EMAIL = "sa@slate-test.iam.gserviceaccount.com";
process.env.GOOGLE_SA_PRIVATE_KEY = privateKey as string;

const TOKEN_URL = "https://oauth2.googleapis.com/token";

let assertions = 0;
function assert(cond: boolean, msg: string) {
  assertions++;
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

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

const { updateEventTime, listCalendars } = await import("../src/lib/google/calendar.ts");
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

  console.log(`ok - ${assertions} assertions`);
}

await main();
