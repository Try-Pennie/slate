// Every outbound client refuses under SLATE_LOADTEST, by the FLAG rather than by
// an absent credential (#2335).
//
// The load run's only protection against reaching a real outside system used to be
// that the deployment held no token for it. That is configuration, and on
// 2026-09-14 configuration is exactly what went wrong: a build tree holding a copy
// of production's .env.local baked twenty five names into the bundle, the runtime
// filled in every one the Worker's bindings had not set, and the run paged the real
// Slack alerts channel about a synthetic roster for six minutes. Nothing in the code
// had an opinion, because "no token" and "a production token" reach the same branch
// from opposite directions.
//
// BOTH DIRECTIONS on every client (L1, L159). A refusal only ever seen to refuse is
// satisfied by a client that cannot reach anything at all, and the quiet direction
// is production, which runs every one of these for real.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-loadtest-external-refusals.ts
import { postSlack } from "../src/lib/notify/slack.ts";
import { fetchSfWithRetry } from "../src/lib/salesforce/retry.ts";
import { fetchTwilioWorkers } from "../src/lib/twilio/client.ts";
import { addOooOverrides } from "../src/lib/calcom/client.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** A fetch that records every call rather than making one. */
function spyFetch(body: unknown = { ok: true }) {
  const calls: string[] = [];
  const impl = (async (input: unknown) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const realFetch = globalThis.fetch;

async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    globalThis.fetch = realFetch;
  }
}

// --- Slack --------------------------------------------------------------------
//
// The one that actually fired. It no-ops rather than throwing, because every caller
// is fire and forget and a notifier that threw would change what the lanes do; but
// it answers with its OWN reason, never "slack-not-configured", which would send a
// reader to set a token that must stay unset (L11).

{
  const spy = spyFetch();
  const res = await withEnv(
    { SLATE_LOADTEST: "true", SLACK_BOT_TOKEN: "xoxb-not-a-real-token" },
    async () => {
      globalThis.fetch = spy.impl;
      return await postSlack({ text: "a synthetic roster", channel: "C0000000000" });
    },
  );
  eq(spy.calls.length, 0, "Slack is never called under the load test flag");
  assert(res.ok === false, "and the caller is told it did not post");
  assert(
    (res.error ?? "").toLowerCase().includes("load test"),
    `and the reason names the load test rather than a missing token, got ${JSON.stringify(res.error)}`,
  );
}

{
  // The quiet direction: production posts. Without this, a Slack client broken in
  // any other way would satisfy the refusal above.
  const spy = spyFetch({ ok: true, channel: "C0000000000", ts: "1.2" });
  const res = await withEnv(
    { SLATE_LOADTEST: undefined, SLACK_BOT_TOKEN: "xoxb-not-a-real-token" },
    async () => {
      globalThis.fetch = spy.impl;
      return await postSlack({ text: "a real alert", channel: "C0000000000" });
    },
  );
  eq(spy.calls.length, 1, "and with the flag off it really does reach Slack");
  assert(res.ok === true, "and reports the post");
}

// --- Salesforce ---------------------------------------------------------------
//
// These three THROW rather than no-op. A roster sync that silently read nothing
// would look exactly like an empty Salesforce, and the caller would write that
// emptiness back over the roster.

{
  const spy = spyFetch();
  let threw: unknown = null;
  await withEnv({ SLATE_LOADTEST: "true" }, async () => {
    try {
      await fetchSfWithRetry("https://example.invalid/services/data", {}, { fetchImpl: spy.impl });
    } catch (e) {
      threw = e;
    }
  });
  eq(spy.calls.length, 0, "Salesforce is never called under the load test flag");
  assert(threw !== null, "and the caller is not handed an empty answer");
  assert(
    String(threw).toLowerCase().includes("load test"),
    `and the throw names the load test, got ${String(threw)}`,
  );
}

{
  const spy = spyFetch();
  await withEnv({ SLATE_LOADTEST: undefined }, async () => {
    await fetchSfWithRetry("https://example.invalid/services/data", {}, { fetchImpl: spy.impl });
  });
  eq(spy.calls.length, 1, "and with the flag off it really does reach Salesforce");
}

// --- Twilio -------------------------------------------------------------------

{
  const spy = spyFetch();
  const creds = { sid: "SK-fake", secret: "fake", workspace: "WS-fake" };
  let threw: unknown = null;
  await withEnv({ SLATE_LOADTEST: "true" }, async () => {
    try {
      await fetchTwilioWorkers(creds, spy.impl);
    } catch (e) {
      threw = e;
    }
  });
  eq(spy.calls.length, 0, "Twilio is never called under the load test flag");
  assert(threw !== null, "and the caller is not handed an empty worker list");
  assert(
    String(threw).toLowerCase().includes("load test"),
    `and the throw names the load test, got ${String(threw)}`,
  );
}

{
  // One worker, because Twilio answering with an EMPTY list is its own refusal:
  // the fixture has to be a reply the client accepts, or this direction fails for a
  // reason that has nothing to do with the flag.
  const spy = spyFetch({ workers: [{ attributes: "{}" }], meta: {} });
  await withEnv({ SLATE_LOADTEST: undefined }, async () => {
    await fetchTwilioWorkers({ sid: "SK-fake", secret: "fake", workspace: "WS-fake" }, spy.impl);
  });
  eq(spy.calls.length, 1, "and with the flag off it really does reach Twilio");
}

// --- cal.com ------------------------------------------------------------------
//
// Reached through the OOO dual write, which is ON in env.loadtest's vars, so this
// is not hypothetical: an approval during a run would patch a real agent's real
// cal.com schedule.

{
  const spy = spyFetch();
  const outcome = await withEnv(
    { SLATE_LOADTEST: "true", CALCOM_ORG_ID: "19474", CALCOM_API_KEY: "cal_fake" },
    async () => {
      globalThis.fetch = spy.impl;
      return await addOooOverrides(
        "someone@trypennie.com",
        "2026-10-01T00:00:00.000Z",
        "2026-10-02T00:00:00.000Z",
      );
    },
  );
  eq(spy.calls.length, 0, "cal.com is never called under the load test flag");
  assert(
    outcome.toLowerCase().includes("load test"),
    `and the recorded outcome names the load test, got ${outcome}`,
  );
  // And it is settled rather than retried: a refusal that reads as transient costs
  // the caller the whole retry ladder and then says the same thing (L110).
  assert(
    !outcome.includes("never attempted"),
    "and it is answered rather than left to the retry ladder to time out",
  );
}

{
  const spy = spyFetch({ data: [] });
  await withEnv(
    { SLATE_LOADTEST: undefined, CALCOM_ORG_ID: "19474", CALCOM_API_KEY: "cal_fake" },
    async () => {
      globalThis.fetch = spy.impl;
      await addOooOverrides(
        "someone@trypennie.com",
        "2026-10-01T00:00:00.000Z",
        "2026-10-02T00:00:00.000Z",
      );
    },
  );
  assert(spy.calls.length >= 1, "and with the flag off it really does reach cal.com");
}

finish();
