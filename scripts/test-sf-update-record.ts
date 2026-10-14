// Slate's one Salesforce write path (#3718). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-sf-update-record.ts
//
// `updateSfRecord` PATCHes one record's fields. What this file pins, on an injected
// fetch so nothing reaches Salesforce:
//  - the request: PATCH to the record's own URL, JSON body of exactly the fields given,
//    the bearer token;
//  - Salesforce's 204 is success, and anything else THROWS with the status and body, so
//    a refused write is never read as a done one;
//  - an id or object name that is not plainly a Salesforce name is refused before any
//    request, so caller text can never steer the URL.
import { updateSfRecord } from "../src/lib/salesforce/rest.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const INSTANCE = "https://example.my.salesforce.com";
type Seen = { url: string; method?: string; body?: string; auth?: string | null };

function fakeFetch(status: number, body = ""): { impl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
      auth: new Headers(init?.headers).get("authorization"),
    });
    return new Response(status === 204 ? null : body, { status });
  }) as typeof fetch;
  return { impl, seen };
}
const noSleep = async () => {};

{
  const { impl, seen } = fakeFetch(204);
  await updateSfRecord(INSTANCE, "tok", "Lead", "00QUi000010889ZMAQ", { CallMeNow__c: true, Call_Me_Now_Pending__c: true }, { fetchImpl: impl, sleep: noSleep });
  eq(seen.length, 1, "one request");
  eq(seen[0]?.url, `${INSTANCE}/services/data/v60.0/sobjects/Lead/00QUi000010889ZMAQ`, "to the record's own URL");
  eq(seen[0]?.method, "PATCH", "as a PATCH");
  eq(seen[0]?.body, JSON.stringify({ CallMeNow__c: true, Call_Me_Now_Pending__c: true }), "carrying exactly the fields given");
  eq(seen[0]?.auth, "Bearer tok", "with the bearer token");
}
{
  const { impl } = fakeFetch(400, '[{"errorCode":"INVALID_FIELD_FOR_INSERT_UPDATE"}]');
  let err: unknown = null;
  try {
    await updateSfRecord(INSTANCE, "tok", "Lead", "00QUi000010889ZMAQ", { CallMeNow__c: true }, { fetchImpl: impl, sleep: noSleep });
  } catch (e) {
    err = e;
  }
  assert(err instanceof Error && /SF update failed: 400/.test(err.message) && /INVALID_FIELD/.test(err.message), "a refused write throws with its status and Salesforce's reason");
}
{
  const { impl } = fakeFetch(200, "{}");
  let threw = false;
  try {
    await updateSfRecord(INSTANCE, "tok", "Lead", "00QUi000010889ZMAQ", { CallMeNow__c: true }, { fetchImpl: impl, sleep: noSleep });
  } catch {
    threw = true;
  }
  assert(!threw, "any 2xx is success");
}
for (const [obj, id, why] of [
  ["Lead", "00QUi000010889ZMAQ/../Account", "an id carrying a path"],
  ["Lead", "", "an empty id"],
  ["Lead/x", "00QUi000010889ZMAQ", "an object name carrying a path"],
] as const) {
  const { impl, seen } = fakeFetch(204);
  let threw = false;
  try {
    await updateSfRecord(INSTANCE, "tok", obj, id, { CallMeNow__c: true }, { fetchImpl: impl, sleep: noSleep });
  } catch {
    threw = true;
  }
  assert(threw && seen.length === 0, `${why} is refused before any request`);
}

finish();
