// Run: node --experimental-strip-types scripts/test-twilio-client.ts
//
// Reading Twilio's worker listing from the roster sync (#2097), and the five ways
// it can fail to produce an answer. Every one of them REFUSES, loudly and with its
// own wording, and none of them resolves to an empty list.
//
// That is the whole point of the file. If an unset secret, a refused key or an
// empty listing came back as "no workers carry the tag", every symptom of success
// would still be there: the lane runs, the Salesforce half works, the heartbeat
// stamps, the banner reports what Salesforce changed, and not one agent is ever
// flipped. Nobody would notice until a redistribute agent took a real lead (Dan,
// 2026-09-08).
import { fetchTwilioWorkers, TwilioReadError, type TwilioCredentials } from "@/lib/twilio/client";
import { assert, eq, finish } from "./lib/harness.ts";

const creds: TwilioCredentials = { sid: "SK1", secret: "shh", workspace: "WS1" };

/** A fetch that answers each call from a queue, and records what it was asked. */
function stubFetch(replies: (Response | Error)[]) {
  const urls: string[] = [];
  const headers: string[] = [];
  const impl = async (url: string | URL, init?: { headers?: Record<string, string> }) => {
    urls.push(String(url));
    headers.push(init?.headers?.Authorization ?? "");
    const next = replies.shift();
    if (next === undefined) throw new Error("stub fetch ran out of replies");
    if (next instanceof Error) throw next;
    return next;
  };
  return { impl: impl as unknown as typeof fetch, urls, headers };
}
/** A sleep that returns at once and records how long it was asked to wait (L524). */
function noSleep() {
  const waits: number[] = [];
  const impl = async (ms: number) => {
    waits.push(ms);
  };
  return { impl, waits };
}
const page = (workers: unknown[], nextPageToken: string | null = null) =>
  new Response(JSON.stringify({ workers, meta: { next_page_token: nextPageToken } }), { status: 200 });

async function failure(
  fn: () => Promise<unknown>,
  expected: string,
  msg: string,
): Promise<string> {
  try {
    await fn();
    assert(false, `${msg} (it did not refuse at all)`);
    return "";
  } catch (err) {
    if (!(err instanceof TwilioReadError)) {
      assert(false, `${msg} (threw something other than a TwilioReadError: ${String(err)})`);
      return "";
    }
    eq(err.failure, expected, msg);
    return err.message;
  }
}

// --- an unconfigured deployment ----------------------------------------------

{
  // The shape that matters most. An unset wrangler secret and a workflow variable
  // that does not exist BOTH arrive as the empty string, which `??` does not catch
  // (#1495 took the production canary down for eleven minutes on exactly this).
  const messages: string[] = [];
  for (const [name, bad] of [
    ["sid", { ...creds, sid: "" }],
    ["secret", { ...creds, secret: "" }],
    ["workspace", { ...creds, workspace: "" }],
  ] as const) {
    const m = await failure(
      () => fetchTwilioWorkers(bad, stubFetch([]).impl),
      "not-configured",
      `an empty ${name} refuses rather than reading nothing`,
    );
    messages.push(m);
    assert(m.includes("TWILIO_"), `and the refusal names the environment variables to set (${name})`);
  }
  assert(messages.every((m) => m === messages[0]), "one wording for the three, because the operator's action is the same: set all three");
}

// --- the ways the call itself fails ------------------------------------------

{
  await failure(
    () => fetchTwilioWorkers(creds, stubFetch([new Error("dns"), new Error("dns")]).impl, noSleep().impl),
    "unreachable",
    "a network failure that survives the one retry refuses",
  );
  for (const status of [401, 403]) {
    const m = await failure(
      () => fetchTwilioWorkers(creds, stubFetch([new Response("no", { status })]).impl, noSleep().impl),
      "refused",
      `a ${status} is its own refusal, not a generic unreachable`,
    );
    assert(m.includes("TaskRouter"), "and it says the key has to be TaskRouter scoped, which is the actual fix");
  }
  await failure(
    () =>
      fetchTwilioWorkers(
        creds,
        stubFetch([new Response("boom", { status: 500 }), new Response("boom", { status: 500 })]).impl,
        noSleep().impl,
      ),
    "unreachable",
    "a 500 that survives the one retry refuses as unreachable",
  );
  await failure(
    () => fetchTwilioWorkers(creds, stubFetch([new Response("not json", { status: 200 })]).impl),
    "unreadable",
    "a 200 carrying no readable worker list refuses as unreadable",
  );
  await failure(
    () => fetchTwilioWorkers(creds, stubFetch([page([])]).impl),
    "no-workers",
    "an EMPTY listing refuses, because zero is the shape of a broken read and never a roster of 142",
  );
  assert(
    new Set(["not-configured", "refused", "unreachable", "unreadable", "no-workers"]).size === 5,
    "the five failures are distinct values, so a caller can tell them apart (L11)",
  );
}

// --- the happy path, and paging ----------------------------------------------

{
  const s = stubFetch([page([{ attributes: "{}" }, { attributes: "{}" }], "tok2"), page([{ attributes: "{}" }])]);
  const workers = await fetchTwilioWorkers(creds, s.impl);
  eq(workers.length, 3, "every page is returned, not just the first");
  eq(s.urls.length, 2, "and paging stops when the token does");
  assert(s.urls[0]!.includes("/Workspaces/WS1/Workers"), "the workspace is the one it was given");
  assert(s.urls[0]!.includes("PageSize=200"), "read at the page size the roster fits in one call");
  assert(!s.urls[0]!.includes("PageToken"), "the first call carries no token");
  assert(s.urls[1]!.includes("PageToken=tok2"), "the second carries the one Twilio handed back");
  assert(s.headers[0]!.startsWith("Basic "), "the key is basic auth, exactly as the Pipedream job sends it");
  eq(
    Buffer.from(s.headers[0]!.slice("Basic ".length), "base64").toString(),
    "SK1:shh",
    "sid as the user, secret as the password",
  );
}

{
  // A repeating page token is not hypothetical: the Pipedream job met it. Without
  // this, the read is an infinite loop inside a cron invocation, which is worse
  // than a failure because it is indistinguishable from slowness (L110).
  const s = stubFetch([page([{ attributes: "{}" }], "same"), page([{ attributes: "{}" }], "same")]);
  const workers = await fetchTwilioWorkers(creds, s.impl);
  eq(s.urls.length, 2, "a repeated page token stops the walk instead of looping forever");
  eq(workers.length, 2, "with what it had already read kept");
}

// --- one retry, on the failures that can heal (#2774) -------------------------
//
// On 2026-09-25 a single 520 from Twilio's edge paged a person, and the run an hour
// earlier had read Twilio fine. A 5xx or a dropped connection is retried ONCE,
// after an injected wait, so the test waits for nothing real.

{
  const s = stubFetch([new Response("edge", { status: 520 }), page([{ attributes: "{}" }])]);
  const sleep = noSleep();
  const workers = await fetchTwilioWorkers(creds, s.impl, sleep.impl);
  eq(workers.length, 1, "one 520 then a success reads the roster fine");
  eq(s.urls.length, 2, "by asking twice");
  eq(s.urls[1], s.urls[0], "for the same page");
  eq(sleep.waits.length, 1, "with one wait between the two");
  assert(sleep.waits[0]! > 0, "and the wait is a real pause, not zero");
}

{
  const s = stubFetch([new Error("socket hang up"), page([{ attributes: "{}" }])]);
  const sleep = noSleep();
  const workers = await fetchTwilioWorkers(creds, s.impl, sleep.impl);
  eq(workers.length, 1, "a dropped connection then a success reads the roster fine");
  eq(sleep.waits.length, 1, "after one wait");
}

{
  const s = stubFetch([new Response("edge", { status: 520 }), new Response("edge", { status: 503 })]);
  const sleep = noSleep();
  const m = await failure(() => fetchTwilioWorkers(creds, s.impl, sleep.impl), "unreachable", "two 5xx in a row refuse");
  eq(s.urls.length, 2, "ONE retry, not a loop: a real outage still refuses inside the invocation (L110)");
  assert(m.includes("503"), "and the refusal names the status the retry met, which is the latest fact");
}

{
  // A refused key cannot heal between two requests a second apart, so asking again
  // only doubles the load on a credential Twilio is already turning away.
  for (const status of [401, 403]) {
    const s = stubFetch([new Response("no", { status }), page([{ attributes: "{}" }])]);
    const sleep = noSleep();
    await failure(() => fetchTwilioWorkers(creds, s.impl, sleep.impl), "refused", `a ${status} refuses at once`);
    eq(s.urls.length, 1, `a ${status} is never retried`);
    eq(sleep.waits.length, 0, `and nothing waits on a ${status}`);
  }
  // A 4xx that is not a refusal is not a transient either.
  const s = stubFetch([new Response("gone", { status: 404 }), page([{ attributes: "{}" }])]);
  await failure(() => fetchTwilioWorkers(creds, s.impl, noSleep().impl), "unreachable", "a 404 refuses");
  eq(s.urls.length, 1, "and is not retried, because only a 5xx or no answer at all can heal");
}

{
  // The retry is per request, so a blip on the second page does not throw away the
  // first page or start the walk over.
  const s = stubFetch([
    page([{ attributes: "{}" }], "tok2"),
    new Response("edge", { status: 502 }),
    page([{ attributes: "{}" }]),
  ]);
  const workers = await fetchTwilioWorkers(creds, s.impl, noSleep().impl);
  eq(workers.length, 2, "a blip on a later page is retried in place");
  eq(s.urls.length, 3, "without re-reading the first page");
}

finish();
