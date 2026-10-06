// #3310: the load run's teardown keeps the load test Worker and takes its secrets,
// instead of deleting it.
//
// Cloudflare has taken 27 to 105 minutes to deliver the first cron to a newly created
// Worker, and every run used to create one, so every run waited and a slow delivery
// lost the run outright. A Worker that lives on keeps receiving its crons, so the next
// run's lanes stamp within a minute of its secrets being put. Between runs it holds
// none of them, and the entry answers nothing and runs no lane (`loadtestIdle`).
//
// These drive every decision the teardown makes with no Cloudflare account: which
// Worker it may touch at all, how each read and delete is judged, and the verdict.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-loadtest-idle-worker.ts
import { readFileSync } from "node:fs";
import {
  IDLE_EXIT,
  idleVerdict,
  keepWorkerIdle,
  loadtestWorkerName,
  readDeleteSecret,
  readSchedules,
  readSecretNames,
  secretUrl,
  secretsUrl,
  schedulesUrl,
  targetRefusal,
  type IdleVerdict,
} from "./loadtest/idle-worker.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const envelope = (result: unknown) => JSON.stringify({ success: true, errors: [], messages: [], result });
const produced = new Set<number>();
const seen = (v: IdleVerdict) => {
  produced.add(v.exitCode);
  return v;
};

// --- which Worker it may touch ---------------------------------------------------
//
// This step DELETES secrets by Worker name. A name that resolved to production's would
// take production's secrets away, so the name is checked against the Worker
// `wrangler deploy --env loadtest` actually deploys, read from wrangler.jsonc, and a
// name equal to production's is refused whatever else is true.

{
  const real = readFileSync("wrangler.jsonc", "utf8");
  eq(loadtestWorkerName(real), { loadtest: "slate-loadtest", production: "slate" }, "the real config deploys the load test as slate-loadtest beside production's slate");
  eq(
    loadtestWorkerName('{ "name": "slate", "env": { "loadtest": { "name": "slate-lt" } } }'),
    { loadtest: "slate-lt", production: "slate" },
    "an explicit env name wins, as it does for wrangler",
  );
  eq(loadtestWorkerName("{ not json"), null, "a config that does not parse names nothing");
  eq(loadtestWorkerName('{ "name": "slate" }'), null, "nor does one with no load test environment");

  const names = { loadtest: "slate-loadtest", production: "slate" };
  eq(targetRefusal({ configured: "slate-loadtest", names }), null, "the configured name matching the deployed one is the only pass");
  const prod = targetRefusal({ configured: "slate", names });
  assert(prod !== null && /production/.test(prod), `production's own name is refused (got ${prod})`);
  const other = targetRefusal({ configured: "slate-loadtest-old", names });
  assert(other !== null && other.includes("slate-loadtest"), `a name that is not the deployed one is refused, naming both (got ${other})`);
  const unread = targetRefusal({ configured: "slate-loadtest", names: null });
  assert(unread !== null && /wrangler\.jsonc/.test(unread), `an unreadable config is refused, never guessed past (got ${unread})`);
  // Even a config whose load test name IS production's is refused: the guard is about
  // what the step would touch, not about agreeing with the file.
  const same = targetRefusal({ configured: "slate", names: { loadtest: "slate", production: "slate" } });
  assert(same !== null, "a config naming production's Worker for the load test is refused too");
}

// --- the addresses -----------------------------------------------------------------
{
  eq(secretsUrl("acc", "slate-loadtest"), "https://api.cloudflare.com/client/v4/accounts/acc/workers/scripts/slate-loadtest/secrets", "the secrets listing");
  eq(schedulesUrl("acc", "slate-loadtest"), "https://api.cloudflare.com/client/v4/accounts/acc/workers/scripts/slate-loadtest/schedules", "the cron schedules");
  eq(
    secretUrl("acc", "slate-loadtest", "CRON_SECRET"),
    "https://api.cloudflare.com/client/v4/accounts/acc/workers/scripts/slate-loadtest/secrets/CRON_SECRET",
    "one secret",
  );
  assert(secretUrl("acc", "w", "a/b").endsWith("/secrets/a%2Fb"), "a name is encoded, so it cannot climb out of the secrets path");
}

// --- reading the secrets listing -------------------------------------------------------
//
// Trusted only when POSITIVELY readable: a 200, a Cloudflare envelope saying success,
// a result array, every entry named. "No secrets" must never be what an error page or
// a refused token reads as (L98).

{
  eq(readSecretNames(200, envelope([{ name: "CRON_SECRET", type: "secret_text" }])), { names: ["CRON_SECRET"] }, "names are read");
  eq(readSecretNames(200, envelope([])), { names: [] }, "an empty listing is a real empty");
  const notFound = readSecretNames(404, JSON.stringify({ success: false, errors: [{ code: 10007, message: "script not found" }] }));
  assert("exitCode" in notFound && notFound.exitCode === IDLE_EXIT.notFound, "a 404 is the Worker not being there");
  const refused = readSecretNames(403, "{}");
  assert("exitCode" in refused && refused.exitCode === IDLE_EXIT.refused && /403/.test(refused.why), "another status is a refusal, with the status");
  for (const [why, body] of [
    ["an HTML page", "<html>oops</html>"],
    ["no success flag", JSON.stringify({ result: [] })],
    ["success false", JSON.stringify({ success: false, result: [] })],
    ["no result array", JSON.stringify({ success: true, result: {} })],
    ["an entry with no name", envelope([{ type: "secret_text" }])],
  ] as const) {
    const r = readSecretNames(200, body);
    assert("exitCode" in r && r.exitCode === IDLE_EXIT.unreadable, `${why} is unreadable, never no secrets`);
  }
}

// --- reading the schedules ---------------------------------------------------------------
{
  eq(readSchedules(200, envelope({ schedules: [{ cron: "* * * * *" }, { cron: "*/5 * * * *" }] })), { crons: ["* * * * *", "*/5 * * * *"] }, "schedules are read");
  eq(readSchedules(200, envelope({ schedules: [] })), { crons: [] }, "none is a real none");
  const bad = readSchedules(200, envelope({}));
  assert("exitCode" in bad && bad.exitCode === IDLE_EXIT.unreadable, "a result with no schedules list is unreadable");
  const nf = readSchedules(404, "{}");
  assert("exitCode" in nf && nf.exitCode === IDLE_EXIT.notFound, "and a 404 is the Worker not being there");
}

// --- deleting one secret ---------------------------------------------------------------
//
// It may run twice (a re-run of the job, a run whose teardown already ran), so a
// secret that is already gone is done, not a failure.
{
  eq(readDeleteSecret(200, envelope(null)), "deleted", "a 200 envelope saying success deleted it");
  eq(readDeleteSecret(404, "{}"), "absent", "a 404 is a secret already gone");
  const failed = readDeleteSecret(500, "upstream error");
  assert(typeof failed === "object" && /500/.test(failed.why), "anything else is a failure, with the status");
  const lying = readDeleteSecret(200, JSON.stringify({ success: false }));
  assert(typeof lying === "object", "a 200 whose envelope says it failed is a failure");
}

// --- the verdict --------------------------------------------------------------------
{
  const crons = ["* * * * *", "*/5 * * * *"];
  const idle = seen(idleVerdict({ workerName: "slate-loadtest", remaining: [], crons, deleted: ["CRON_SECRET"], failedDeletes: [] }));
  assert(idle.idle && idle.exitCode === IDLE_EXIT.idle, "kept, holding nothing, with its crons: the only zero");
  assert(/slate-loadtest/.test(idle.message) && /2 cron schedules/.test(idle.message), `naming the Worker and how many schedules it keeps (got ${idle.message})`);

  const holding = seen(idleVerdict({ workerName: "slate-loadtest", remaining: ["SUPABASE_SECRET_KEY"], crons, deleted: [], failedDeletes: [] }));
  assert(!holding.idle && holding.exitCode === IDLE_EXIT.stillHoldsSecrets && holding.message.includes("SUPABASE_SECRET_KEY"), "a secret still listed after the deletes is named");

  const failedDelete = seen(
    idleVerdict({ workerName: "slate-loadtest", remaining: ["CRON_SECRET"], crons, deleted: [], failedDeletes: [{ name: "CRON_SECRET", why: "answered 500" }] }),
  );
  assert(failedDelete.exitCode === IDLE_EXIT.deleteFailed && /CRON_SECRET/.test(failedDelete.message) && /500/.test(failedDelete.message), "a delete that failed is named with its reason, ahead of what it left");

  const noCrons = seen(idleVerdict({ workerName: "slate-loadtest", remaining: [], crons: [], deleted: [], failedDeletes: [] }));
  assert(!noCrons.idle && noCrons.exitCode === IDLE_EXIT.noSchedules && /cron/.test(noCrons.message), "a kept Worker with no schedules is a finding: keeping it bought nothing");

  // Holding a secret is the louder finding: an idle Worker that can still reach a
  // branch is worse than one that would make the next run wait.
  const both = seen(idleVerdict({ workerName: "slate-loadtest", remaining: ["CRON_SECRET"], crons: [], deleted: [], failedDeletes: [] }));
  eq(both.exitCode, IDLE_EXIT.stillHoldsSecrets, "a secret still held outranks missing schedules");
}

// --- the whole flow, against a fake Cloudflare -------------------------------------------
//
// The flow lives in `keepWorkerIdle` with the request injected, so the order of what it
// does is tested, not only each judgement. The case that matters most: a first listing
// that cannot be read must not stop the deletes. Returning early there would leave the
// Worker holding the run's live secrets while its crons go on arriving.

type Req = { method: "GET" | "DELETE"; url: string };
function fakeCloudflare(opts: { firstList: { status: number; bodyText: string } | { failed: string }; held: string[]; crons?: string[] }) {
  const held = new Set(opts.held);
  const calls: Req[] = [];
  let lists = 0;
  const call = async (method: "GET" | "DELETE", url: string) => {
    calls.push({ method, url });
    if (method === "DELETE") {
      const name = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
      if (!held.has(name)) return { status: 404, bodyText: "{}" };
      held.delete(name);
      return { status: 200, bodyText: envelope(null) };
    }
    if (url.endsWith("/schedules")) return { status: 200, bodyText: envelope({ schedules: (opts.crons ?? ["* * * * *"]).map((cron) => ({ cron })) }) };
    lists += 1;
    if (lists === 1) return opts.firstList;
    return { status: 200, bodyText: envelope([...held].map((name) => ({ name, type: "secret_text" }))) };
  };
  return { call, calls, held };
}
const settings = { token: "t", account: "acc", configured: "slate-loadtest" };
const realConfig = readFileSync("wrangler.jsonc", "utf8");

{
  const cf = fakeCloudflare({ firstList: { status: 200, bodyText: envelope([{ name: "CRON_SECRET" }, { name: "EXTRA" }]) }, held: ["CRON_SECRET", "EXTRA"] });
  const v = await keepWorkerIdle({ settings, wranglerJsonc: realConfig, call: cf.call });
  assert(v.idle && v.exitCode === IDLE_EXIT.idle, `a listed secret, known or not, is deleted and the Worker confirmed idle (got ${v.message})`);
  eq(cf.held.size, 0, "nothing is left held");
  assert(cf.calls.every((c) => c.url.includes("/scripts/slate-loadtest/")), "and every request was to the load test Worker");
}
for (const [why, firstList] of [
  ["never answers", { failed: "fetch failed" }],
  ["is refused", { status: 503, bodyText: "busy" }],
  ["is unreadable", { status: 200, bodyText: "<html>" }],
] as const) {
  const cf = fakeCloudflare({ firstList, held: ["SUPABASE_SECRET_KEY", "CRON_SECRET", "BOOKING_API_KEY_CANARY"] });
  const v = await keepWorkerIdle({ settings, wranglerJsonc: realConfig, call: cf.call });
  eq(cf.held.size, 0, `a first listing that ${why} still has the run's three secrets deleted`);
  assert(v.idle, `and the second listing, which reads, decides it is idle (got ${v.message})`);
}
{
  // The target guard comes before ANY request.
  const cf = fakeCloudflare({ firstList: { status: 200, bodyText: envelope([]) }, held: [] });
  const v = await keepWorkerIdle({ settings: { ...settings, configured: "slate" }, wranglerJsonc: realConfig, call: cf.call });
  assert(v.exitCode === IDLE_EXIT.wrongTarget && cf.calls.length === 0, "production's name is refused before a single request is made");
}
{
  const cf = fakeCloudflare({ firstList: { status: 200, bodyText: envelope([]) }, held: [] });
  const v = await keepWorkerIdle({ settings: { ...settings, token: "" }, wranglerJsonc: realConfig, call: cf.call });
  assert(v.exitCode === IDLE_EXIT.misconfigured && v.message.includes("CLOUDFLARE_API_TOKEN") && cf.calls.length === 0, "a missing setting is named before any request");
}

// --- every declared ending is reachable (L151) --------------------------------------------
{
  const misconfigured = seen(idleVerdict({ misconfigured: ["CLOUDFLARE_API_TOKEN"] }));
  assert(misconfigured.exitCode === IDLE_EXIT.misconfigured && misconfigured.message.includes("CLOUDFLARE_API_TOKEN"), "a missing setting is named");
  seen(idleVerdict({ wrongTarget: "the configured name is production's" }));
  seen(idleVerdict({ noAnswer: "fetch failed" }));
  seen(idleVerdict({ read: { exitCode: IDLE_EXIT.notFound, why: "x" } }));
  seen(idleVerdict({ read: { exitCode: IDLE_EXIT.refused, why: "x" } }));
  seen(idleVerdict({ read: { exitCode: IDLE_EXIT.unreadable, why: "x" } }));
  for (const [name, code] of Object.entries(IDLE_EXIT)) {
    assert(produced.has(code), `the ${name} ending (exit ${code}) is produced by some case`);
  }
  eq(new Set(Object.values(IDLE_EXIT)).size, Object.keys(IDLE_EXIT).length, "no two endings share a code");
}

// --- the idle Worker's fetch path does not log (L498) ------------------------------------
//
// An idle Worker is public on workers.dev, so a log line per request is volume any caller
// controls. The 503 body already says it is idle; only a cron tick, which Cloudflare
// sends and nobody else can, logs a line.
{
  const entry = readFileSync("worker/index.ts", "utf8");
  const fetchHalf = entry.slice(entry.indexOf("fetch:"), entry.indexOf("async scheduled"));
  const idleBranch = fetchHalf.slice(fetchHalf.indexOf("loadtestIdle("), fetchHalf.indexOf("loadtestIdleBody("));
  assert(idleBranch.length > 0, "the fetch path's idle branch was found");
  assert(!/\blog\./.test(idleBranch), "and it writes no log line for a request an unauthenticated caller can send");
}

// --- and the workflow runs it, never `wrangler delete` (L3) -----------------------------
{
  const yml = readFileSync(".github/workflows/loadtest.yml", "utf8");
  const teardown = yml.slice(yml.indexOf("\n  teardown:"));
  assert(teardown.includes("scripts/loadtest/keep-worker-idle.ts"), "the teardown job takes the secrets and confirms the Worker idle");
  assert(!/wrangler delete/.test(teardown), "and no longer deletes the Worker, which is what made every run wait for its first cron");
  assert(/LOADTEST_WORKER_NAME: \$\{\{ vars\.LOADTEST_WORKER_NAME \}\}/.test(teardown), "it is handed the configured Worker name to check against wrangler.jsonc");
}

finish();
