// #3104: the fault switch covers every outside system, not only calendar reads.
//
// Three things are pinned here, and each is pinned from both sides (L1, L159):
//
//   1. the GATE. Nothing faults unless SLATE_LOADTEST is "true", a percentage is set
//      AND the system is named. Each fact is turned off on its own, and the wired
//      injectors are driven in real processes with the flag off and the percentage
//      at 100, so "structurally off in production" is a measurement rather than a
//      sentence (the wrangler half is scripts/test-wrangler-loadtest-env.ts);
//   2. the TARGETS. A system faults only when it is named, an unknown name faults
//      nothing and is reported, and the unset default is exactly the old read only
//      switch, so an existing fault leg is unchanged;
//   3. the SHAPES. A faulted database call is either slow or a PostgREST shaped 500
//      that supabase-js itself reads as an error, a faulted Salesforce call waits
//      past the booking path's deadline before failing, and a faulted webhook fails
//      per attempt so a retry can land.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-loadtest-fault-targets.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  DEFAULT_FAULT_TARGETS,
  FAULT_MARKER,
  FAULT_TARGETS,
  FAULT_TARGET_CONTRACT,
  SALESFORCE_FAULT_LATENCY_MS,
  SUPABASE_FAULT_LATENCY_MS,
  SUPABASE_FAULT_EXEMPT_TABLES,
  everyTargetDegrades,
  faultActive,
  loadtestSupabaseFetch,
  parseFaultPct,
  parseFaultTargets,
  salesforceLoadtestFault,
  shouldInject,
  supabaseFaultKey,
  supabaseFaultShape,
  webhookLoadtestFault,
  type FaultSwitch,
} from "../src/lib/loadtest-fault.ts";
import { CALLING_NUMBER_DEADLINE_MS } from "../src/lib/salesforce/lead-calling-number.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const execFileAsync = promisify(execFile);

const ON: FaultSwitch = { loadtest: true, pct: 100, targets: [...FAULT_TARGETS] };

// --- the gate ------------------------------------------------------------------
{
  for (const target of FAULT_TARGETS) {
    eq(faultActive(target, ON), true, `${target} faults with the flag, a percentage and its name`);
    eq(faultActive(target, { ...ON, loadtest: false }), false, `${target} never faults without SLATE_LOADTEST`);
    eq(faultActive(target, { ...ON, pct: 0 }), false, `${target} never faults at zero percent`);
    eq(
      faultActive(target, { ...ON, targets: FAULT_TARGETS.filter((t) => t !== target) }),
      false,
      `${target} never faults when it is not named`,
    );
  }
  eq(shouldInject("supabase", "k", { ...ON, pct: 0 }), false, "and no call fails with the gate shut");
}

// --- the targets -----------------------------------------------------------------
{
  eq(parseFaultTargets(undefined).targets, [...DEFAULT_FAULT_TARGETS], "unset is the default");
  eq(parseFaultTargets(" ").targets, [...DEFAULT_FAULT_TARGETS], "blank is the default");
  eq(DEFAULT_FAULT_TARGETS, ["google-read"], "and the default is the original read only switch");
  eq(
    parseFaultTargets("webhook, supabase").targets,
    ["supabase", "webhook"],
    "a list is read in the canonical order, so two spellings of one set compare equal",
  );
  const typo = parseFaultTargets("google-read,supabse");
  eq(typo.targets, [], "an unknown name faults NOTHING rather than faulting less than was asked");
  eq(typo.unknown, ["supabse"], "and it is reported by name");
  eq(parseFaultPct("ten"), 0, "an unreadable percentage is zero, never NaN");
  eq(parseFaultPct("150"), 100, "and an over large one is clamped");
}

// --- which targets keep the 5xx bar ----------------------------------------------
{
  eq(everyTargetDegrades(["google-read"]), true, "the original pass keeps its no 5xx bar");
  eq(everyTargetDegrades(["google-read", "webhook", "salesforce"]), true, "and so do the other degrading systems");
  eq(everyTargetDegrades(["google-read", "supabase"]), false, "a database fault is a 5xx by design");
  eq(everyTargetDegrades(["google-write"]), false, "and so is a calendar write that did not land");
  eq(FAULT_TARGET_CONTRACT["google-write"], "fails-loud", "#2241's reason, recorded where the judge reads it");
}

// --- Supabase: two shapes, and supabase-js reads the 500 as an error, once ---------------
{
  eq(loadtestSupabaseFetch(fetch, { sw: { ...ON, targets: ["google-read"] } }), null, "unnamed means no wrapper at all");
  eq(loadtestSupabaseFetch(fetch, { sw: { ...ON, loadtest: false } }), null, "and so does production");

  // Both shapes occur across ordinary keys, so a pass meets slowness AND failure.
  const shapes = new Set(
    Array.from({ length: 200 }, (_, i) => supabaseFaultShape(supabaseFaultKey("GET", `u${i}`, "", 0))),
  );
  eq([...shapes].sort(), ["latency", "unavailable"], "a pass produces both database fault shapes");

  // The minute is in the key: one read is not failed on every tick for the whole run.
  const verdicts = new Set(
    Array.from({ length: 60 }, (_, m) =>
      shouldInject("supabase", supabaseFaultKey("GET", "/rest/v1/buckets?select=*", "", m * 60_000), {
        ...ON,
        pct: 50,
      }),
    ),
  );
  eq(verdicts.size, 2, "a fixed read fails on some minutes and not on others");
  eq(
    supabaseFaultKey("GET", "u", "", 1_000),
    supabaseFaultKey("GET", "u", "", 59_000),
    "and inside one minute the verdict is stable",
  );

  // Drive both shapes through the real wrapper with a fake base and clock.
  const latencyKeyUrl = Array.from({ length: 200 }, (_, i) => `https://x.supabase.co/rest/v1/t${i}`).find(
    (u) => supabaseFaultShape(supabaseFaultKey("GET", u, "", 0)) === "latency",
  )!;
  const downKeyUrl = Array.from({ length: 200 }, (_, i) => `https://x.supabase.co/rest/v1/t${i}`).find(
    (u) => supabaseFaultShape(supabaseFaultKey("GET", u, "", 0)) === "unavailable",
  )!;
  const slept: number[] = [];
  let reached = 0;
  const base = (async () => {
    reached++;
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const wrapped = loadtestSupabaseFetch(base, {
    sw: ON,
    sleep: async (ms) => {
      slept.push(ms);
    },
    now: () => 0,
  })!;
  const slow = await wrapped(latencyKeyUrl);
  eq(slow.status, 200, "a latency fault still answers");
  eq(slept, [SUPABASE_FAULT_LATENCY_MS], "after holding the call");
  eq(reached, 1, "and the real database was reached");
  const down = await wrapped(downKeyUrl);
  eq(down.status, 500, "an unavailable fault answers 500");
  eq(reached, 1, "without reaching the database");

  // The point of shaping it like PostgREST: the real client must turn it into an
  // `error`, not data, or every read would "succeed" with an error body (L52).
  const always = loadtestSupabaseFetch(base, { sw: ON, sleep: async () => {}, now: () => 0 })!;
  let calls = 0;
  const forced = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return supabaseFaultShape(supabaseFaultKey(init?.method ?? "GET", url, "", 0)) === "unavailable"
      ? always(input, init)
      : always(downKeyUrl, init);
  }) as typeof fetch;
  const client = createClient("https://x.supabase.co", "sb_secret_test", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: forced },
  });
  const { data, error } = await client.from("bookings").select("id");
  eq(data, null, "supabase-js returns no data for the injected 500");
  assert(error !== null && String(error.message).includes(FAULT_MARKER), "and reports it as an error, marked injected");
  // Not retried. postgrest-js retries a 503 on a read with a 1, 2, 4 second ladder,
  // and the retry meets the same verdict, so a 503 would hold every faulted read for
  // seven seconds before failing it anyway.
  eq(calls, 1, "and the client sends it once, so the fault fails the read without a retry ladder");
}

// --- the judge's evidence tables are never faulted ---------------------------------
//
// The lane judge reads `lane_heartbeats` and `alert_state` as its evidence. A fault
// injected into a heartbeat write, or into the page's cooldown read or record, would
// produce exactly the stale lane or missing (or doubled) page the judge then reports,
// caused by the injector rather than by the code under test. So both tables are exempt,
// reads and writes, at 100 percent, in every minute.
{
  let reached = 0;
  const base = (async () => {
    reached++;
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const slept: number[] = [];
  let minute = 0;
  const wrapped = loadtestSupabaseFetch(base, {
    sw: ON,
    sleep: async (ms) => {
      slept.push(ms);
    },
    now: () => minute * 60_000,
  })!;
  const root = "https://x.supabase.co/rest/v1";
  const evidence = [
    { url: `${root}/lane_heartbeats?on_conflict=lane`, method: "POST", body: '{"lane":"sync"}' },
    { url: `${root}/lane_heartbeats?select=lane,last_ran_at`, method: "GET", body: "" },
    { url: `${root}/alert_state?on_conflict=key`, method: "POST", body: '{"key":"sync_failures"}' },
    { url: `${root}/alert_state?select=last_sent_at&key=eq.sync_failures`, method: "GET", body: "" },
  ];
  let calls = 0;
  for (minute = 0; minute < 30; minute++) {
    for (const c of evidence) {
      calls++;
      const res = await wrapped(c.url, { method: c.method, body: c.body });
      if (res.status !== 200) break;
    }
  }
  eq(reached, calls, "every evidence table call reached the database, in every minute, at 100 percent");
  eq(slept, [], "and none was held");
  eq(SUPABASE_FAULT_EXEMPT_TABLES, ["alert_state", "lane_heartbeats"], "the exempt tables are exactly the judge's two");

  // Control (L159): the exemption is by TABLE, not by a substring of the address, so a
  // neighbouring name and a query MENTIONING an evidence table are still faulted.
  for (const url of [
    `${root}/lane_heartbeats_archive?select=*`,
    `${root}/alert_states?select=*`,
    `${root}/bookings?select=*&note=eq.alert_state`,
  ]) {
    slept.length = 0;
    let answered500 = 0;
    for (minute = 0; minute < 30; minute++) if ((await wrapped(url)).status === 500) answered500++;
    // At 100 percent every call is faulted: held (a latency fault) or answered 500.
    eq(answered500 + slept.length, 30, `${url.slice(root.length)} is still faulted on every call`);
  }
}

// --- Salesforce: slow, then failed ---------------------------------------------------
{
  assert(
    SALESFORCE_FAULT_LATENCY_MS > CALLING_NUMBER_DEADLINE_MS,
    "a Salesforce fault outlasts the booking path's deadline, so the deadline branch is what runs",
  );
  const slept: number[] = [];
  let threw = "";
  try {
    await salesforceLoadtestFault("https://sf/q", async (ms) => {
      slept.push(ms);
    }, ON);
  } catch (e) {
    threw = (e as Error).message;
  }
  eq(slept, [SALESFORCE_FAULT_LATENCY_MS], "a faulted call waits first");
  assert(threw.includes("timed out") && threw.includes(FAULT_MARKER), "then fails as a marked timeout");
  const none: number[] = [];
  await salesforceLoadtestFault("https://sf/q", async (ms) => {
    none.push(ms);
  }, { ...ON, targets: ["google-read"] });
  eq(none, [], "unnamed, it neither waits nor throws");
}

// --- webhooks: per attempt ----------------------------------------------------------
{
  const half = { ...ON, pct: 50 };
  const ids = Array.from({ length: 400 }, (_, i) => `delivery-${i}`);
  const recovers = ids.some(
    (id) => webhookLoadtestFault(id, 1, half) !== null && webhookLoadtestFault(id, 2, half) === null,
  );
  const deadLetters = ids.some((id) => [1, 2, 3, 4, 5].every((a) => webhookLoadtestFault(id, a, half) !== null));
  assert(recovers, "some delivery fails its first attempt and lands on a retry");
  assert(deadLetters, "and some fails every attempt, so the dead letter path runs too");
  const failed = webhookLoadtestFault("d", 1, ON);
  eq(failed?.ok, false, "a faulted attempt is recorded as failed");
  assert(String(failed?.lastResponse).includes(FAULT_MARKER), "and marked injected in the delivery log");
}

// --- wired, in real processes --------------------------------------------------------
//
// The constants are read at import time, so each configuration is its own process.
// Every injector the app calls is driven through its REAL call site: the Google stubs,
// the Salesforce client, the webhook delivery result and the Supabase admin client's
// fetch. Built is not wired (L3).
const probe = `
  const root = ${JSON.stringify(new URL("..", import.meta.url).href)};
  const stub = await import(root + "src/lib/google/loadtest-stub.ts");
  const sf = await import(root + "src/lib/salesforce/retry.ts");
  const emit = await import(root + "src/lib/webhooks/emit.ts");
  const admin = await import(root + "src/lib/supabase/admin.ts");
  const run = async (f) => { try { await f(); return "ok"; } catch (e) { return String(e.message); } };
  const slept = [];
  // The REAL admin client, against a database that is never reached: every request
  // it lets through lands on this recorder. Twenty reads of different tables, so a
  // faulted client meets the 500 shape on at least one of them (a latency fault lets
  // its read through to the recorder after a wait).
  let reachedDb = 0;
  globalThis.fetch = async () => {
    reachedDb++;
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  };
  const reads = await Promise.all(
    Array.from({ length: 20 }, (_, i) => admin.supabaseAdmin().from("probe_table_" + i).select("id")),
  );
  const readsReached = reachedDb;
  // The judge's evidence, written and read the way the heartbeat and the page do.
  const db = admin.supabaseAdmin();
  const evidence = await Promise.all([
    db.from("lane_heartbeats").upsert({ lane: "sync", last_ran_at: new Date().toISOString() }, { onConflict: "lane" }),
    db.from("lane_heartbeats").select("lane,last_ran_at"),
    db.from("alert_state").upsert({ key: "sync_failures", last_sent_at: new Date().toISOString() }, { onConflict: "key" }),
    db.from("alert_state").select("last_sent_at").eq("key", "sync_failures").maybeSingle(),
  ]);
  const out = {
    read: await run(() => stub.stubFreeBusy("agent@trypennie.com")),
    create: await run(() => stub.stubCreateEvent({ summary: "s", start: "a", end: "b" }, "client-1")),
    patch: await run(() => stub.stubEventWrite("patch", "evt-1")),
    salesforce: await run(() => sf.fetchSfWithRetry("https://sf.example/q", {}, {
      sleep: async (ms) => { slept.push(ms); },
      fetchImpl: async () => new Response("{}"),
    })),
    salesforceSlept: slept,
    webhook: emit.loadtestDeliveryResult("delivery-1", 1),
    dbInjected: reads.filter((r) => String(r.error?.message ?? "").includes("loadtest fault")).length,
    dbReached: readsReached,
    evidenceErrors: evidence.filter((r) => r.error).length,
    evidenceReached: reachedDb - readsReached,
  };
  console.log(JSON.stringify(out));
`;

async function runProbe(env: Record<string, string>): Promise<Record<string, unknown>> {
  const childEnv = {} as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("SLATE_LOADTEST")) childEnv[k] = v;
  }
  // A database address that is not production and is never reached (the probe
  // replaces fetch), so the load test guard in `publicSupabaseUrl` lets the client be
  // built.
  childEnv.NEXT_PUBLIC_SUPABASE_URL = "https://loadtest-probe.supabase.co";
  childEnv.SUPABASE_SECRET_KEY = "sb_secret_probe";
  Object.assign(childEnv, env);
  let stdout = "";
  let stderr = "";
  try {
    ({ stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", "--import", "./scripts/register-paths.mjs", "--input-type=module", "-e", probe],
      { encoding: "utf8", cwd: fileURLToPath(new URL("..", import.meta.url)), env: childEnv },
    ));
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? String(err);
  }
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { unreadable: `stdout: ${stdout.slice(0, 300)} stderr: ${stderr.slice(0, 600)}` };
  }
}

const injected = (v: unknown) => String(v).includes(FAULT_MARKER);

// The four configurations run concurrently: each is its own process anyway.
const [prodShape, defaults, everything, typo] = await Promise.all([
  runProbe({ SLATE_LOADTEST_FAULT_PCT: "100", SLATE_LOADTEST_FAULT_TARGETS: FAULT_TARGETS.join(",") }),
  runProbe({ SLATE_LOADTEST: "true", SLATE_LOADTEST_FAULT_PCT: "100" }),
  runProbe({
    SLATE_LOADTEST: "true",
    SLATE_LOADTEST_FAULT_PCT: "100",
    SLATE_LOADTEST_FAULT_TARGETS: FAULT_TARGETS.join(","),
  }),
  runProbe({
    SLATE_LOADTEST: "true",
    SLATE_LOADTEST_FAULT_PCT: "100",
    SLATE_LOADTEST_FAULT_TARGETS: "google-read,supabse",
  }),
]);

{
  // PRODUCTION SHAPE: every percentage and every target, and no SLATE_LOADTEST. This is
  // the structural claim: nothing in the app can be made to fault without the flag.
  const p = prodShape!;
  assert(p.unreadable === undefined, `the production shaped probe ran (${String(p.unreadable)})`);
  eq(p.read, "ok", "without SLATE_LOADTEST a calendar read never faults, at 100 percent");
  eq(p.create, "ok", "nor a calendar create");
  eq(p.patch, "ok", "nor a calendar patch");
  assert(!injected(p.salesforce), "nor a Salesforce call (it goes on to the real client)");
  eq(p.salesforceSlept, [], "which is never held");
  eq(p.webhook, null, "the webhook delivery takes the real send");
  eq(p.dbInjected, 0, "and no database read is faulted");
  eq(p.dbReached, 20, "every one reaching the database");
}
{
  // The default targets: exactly the old switch. Reads fail; nothing else does.
  const p = defaults!;
  assert(injected(p.read), `the default faults calendar reads (got ${String(p.read)})`);
  eq(p.create, "ok", "and leaves calendar writes alone, as #2241 decided for the ordinary pass");
  eq(p.patch, "ok", "patches included");
  assert(!injected(p.salesforce), "Salesforce is refused instantly as before, not slowed");
  eq(p.salesforceSlept, [], "so it is never held");
  eq((p.webhook as { ok?: boolean } | null)?.ok, true, "webhooks still record the synthetic success");
  eq(p.dbInjected, 0, "and the database is not faulted");
  eq(p.dbReached, 20, "every read reaching it");
}
{
  // Every target named: every injector fires through its real call site.
  const p = everything!;
  assert(injected(p.read), `a named read faults (got ${String(p.read)})`);
  assert(injected(p.create), `a named calendar create faults (got ${String(p.create)})`);
  assert(injected(p.patch), `a named calendar patch faults (got ${String(p.patch)})`);
  assert(injected(p.salesforce), `a named Salesforce call faults (got ${String(p.salesforce)})`);
  eq(p.salesforceSlept, [SALESFORCE_FAULT_LATENCY_MS], "after waiting past the deadline");
  eq((p.webhook as { ok?: boolean } | null)?.ok, false, "a named webhook delivery fails");
  assert(Number(p.dbInjected) > 0, `the real admin client answers injected 500s (got ${String(p.dbInjected)})`);
  eq(
    Number(p.dbInjected) + Number(p.dbReached),
    20,
    "and every other read was a latency fault that went on to the database",
  );
  // With the database faulted at 100 percent, the judge's evidence still lands.
  eq(p.evidenceErrors, 0, "no heartbeat or alert_state call through the real admin client is faulted");
  eq(p.evidenceReached, 4, "every one of them reaching the database");
}
{
  // A typo faults nothing at all, which the fault leg's driver refuses on.
  const p = typo!;
  eq(p.read, "ok", "an unknown target name turns every target off, reads included");
  eq(p.dbInjected, 0, "and the database too");
}

finish();
