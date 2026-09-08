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
    () => fetchTwilioWorkers(creds, stubFetch([new Error("dns")]).impl),
    "unreachable",
    "a network failure refuses",
  );
  for (const status of [401, 403]) {
    const m = await failure(
      () => fetchTwilioWorkers(creds, stubFetch([new Response("no", { status })]).impl),
      "refused",
      `a ${status} is its own refusal, not a generic unreachable`,
    );
    assert(m.includes("TaskRouter"), "and it says the key has to be TaskRouter scoped, which is the actual fix");
  }
  await failure(
    () => fetchTwilioWorkers(creds, stubFetch([new Response("boom", { status: 500 })]).impl),
    "unreachable",
    "a 500 refuses as unreachable",
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

finish();
