// Reading the confirm line object's calls from Cloudflare's stored logs (#3815).
//
// Run 38912230442's live tail of the line Worker caught 411 of about 2,200 traced line
// calls in its busiest seven minutes: `wrangler tail` samples at that volume, and about
// half the traced confirms could not be split. The stored logs hold them all, but the
// query API caps a page and lags ingestion, so every way of not having read them all
// is said rather than read as the whole run (L98).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-loadtest-stored-line-calls.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readStoredLineCalls,
  chooseLineArchive,
  lineArchiveForRun,
  cloudflareAsk,
  tracedConfirmWindow,
  countLineCalls,
  LINE_WORKER_LOADTEST,
  STORED_PAGE_LIMIT,
  STORED_READ_BUDGET_MS,
  type StoredAsk,
} from "./loadtest/stored-line-calls.ts";
import { readConfirmStartup, tailInvocations } from "./loadtest/confirm-startup.ts";
import { formatLine } from "../src/lib/log.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const T0 = Date.parse("2026-10-16T14:40:00Z");
const MIN = 60_000;

/** A stored line call log row, as the query API returns it (shape read from the live API 2026-10-16). */
function logRow(o: { at: number; req: string; op: string; trace: string; stage: string }) {
  const message = formatLine("confirm-line-object", { msg: "line call", op: o.op, trace: o.trace, stage: o.stage });
  return { source: { level: "info", message }, timestamp: o.at, $metadata: { requestId: o.req, type: "cf-worker", message } };
}
/** A stored invocation record, which alone carries the call's wall time. */
function invRow(o: { at: number; req: string; wall: number | null }) {
  return { timestamp: o.at, $workers: o.wall === null ? { outcome: "ok" } : { outcome: "ok", wallTimeMs: o.wall }, $metadata: { requestId: o.req, type: "cf-worker-event" } };
}

/** A fake query API: answers each body from the rows whose timestamp falls in its window. */
function api(rows: { logs: unknown[]; invs: unknown[] }, opts: { status?: number; calls?: { from: number; to: number; kind: string }[] } = {}): StoredAsk {
  return async (body) => {
    const b = body as { timeframe: { from: number; to: number }; parameters: { filters: { key: string; value: unknown }[] }; limit: number };
    const kind = b.parameters.filters.some((f) => f.key === "$metadata.type" && f.value === "cf-worker-event") ? "invocations" : "logs";
    opts.calls?.push({ from: b.timeframe.from, to: b.timeframe.to, kind });
    if (opts.status && opts.status !== 200) return { status: opts.status, json: { success: false, errors: [{ message: "not allowed" }] } };
    const pool = (kind === "logs" ? rows.logs : rows.invs) as { timestamp: number }[];
    const hit = pool.filter((r) => r.timestamp >= b.timeframe.from && r.timestamp < b.timeframe.to).slice(0, b.limit);
    return { status: 200, json: { success: true, result: { events: { events: hit } } } };
  };
}

// --- the join: a log row's call gets its invocation's wall time --------------------------
{
  const rows = {
    logs: [logRow({ at: T0 + 1_000, req: "r1", op: "enter", trace: "t1", stage: "wait" }), logRow({ at: T0 + 2_000, req: "r2", op: "ack", trace: "t1", stage: "wait" })],
    invs: [invRow({ at: T0 + 1_000, req: "r1", wall: 12 }), invRow({ at: T0 + 2_000, req: "r2", wall: 40 }), invRow({ at: T0 + 3_000, req: "r3", wall: 5 })],
  };
  const r = await readStoredLineCalls({ ask: api(rows), fromMs: T0, toMs: T0 + MIN });
  assert(r.ok, `a readable window is read (got ${JSON.stringify(r)})`);
  if (r.ok) {
    eq(r.calls, 2, "two traced calls");
    const invs = [...tailInvocations(r.jsonl)].flatMap((i) => (i.kind === "invocation" ? [i.invocation] : []));
    eq(invs.map((i) => `${i.wallTime}:${i.logs[0]!.text.includes('op="enter"') ? "enter" : "ack"}`).join(","), "12:enter,40:ack", "each call carries its own invocation's wall time, in the tail's own format");
    eq(invs.length, 2, "an invocation with no traced call is left out");
  }
}
{
  // A call whose invocation record is absent carries no wall time, so the split counts
  // it unreadable rather than as zero (L98).
  const rows = { logs: [logRow({ at: T0 + 1_000, req: "r1", op: "enter", trace: "t1", stage: "wait" })], invs: [] };
  const r = await readStoredLineCalls({ ask: api(rows), fromMs: T0, toMs: T0 + MIN });
  assert(r.ok, "still read");
  if (r.ok) eq([...tailInvocations(r.jsonl)].map((i) => (i.kind === "invocation" ? String(i.invocation.wallTime) : "x")).join(","), "null", "no invocation record is no wall time, never zero");
}

// --- windows: one minute at a time, and a full page is split, never trusted ------------------
{
  const calls: { from: number; to: number; kind: string }[] = [];
  await readStoredLineCalls({ ask: api({ logs: [], invs: [] }, { calls }), fromMs: T0, toMs: T0 + 3 * MIN });
  eq(calls.filter((c) => c.kind === "logs").map((c) => (c.to - c.from) / 1000).join(","), "60,60,60", "a three minute window is read as three one minute windows");
}
{
  // More rows in a minute than a page holds: the window is halved until each half fits.
  const logs = Array.from({ length: STORED_PAGE_LIMIT + 10 }, (_, i) => logRow({ at: T0 + Math.floor((i * MIN) / (STORED_PAGE_LIMIT + 10)), req: `r${i}`, op: "enter", trace: `t${i}`, stage: "wait" }));
  const invs = logs.map((l, i) => invRow({ at: (l as { timestamp: number }).timestamp, req: `r${i}`, wall: 3 }));
  const r = await readStoredLineCalls({ ask: api({ logs, invs }), fromMs: T0, toMs: T0 + MIN });
  assert(r.ok && r.calls === STORED_PAGE_LIMIT + 10, `a full page is split until nothing is cut off (got ${r.ok ? r.calls : r.why})`);
}

// --- refusals are said, never read as an empty run ---------------------------------------
{
  const r = await readStoredLineCalls({ ask: api({ logs: [], invs: [] }, { status: 403 }), fromMs: T0, toMs: T0 + MIN });
  assert(!r.ok && r.why.includes("403"), `a refused query is a reason, with its status (got ${JSON.stringify(r)})`);
  const thrown = await readStoredLineCalls({ ask: async () => { throw new Error("network down"); }, fromMs: T0, toMs: T0 + MIN });
  assert(!thrown.ok && thrown.why.includes("network down"), `a query that throws is a reason (got ${JSON.stringify(thrown)})`);
}

// --- the whole read has a budget, so a slow API cannot hold the judge past its job ------------
{
  // Each query "takes" a minute on the injected clock: a thirty minute window would take
  // sixty, and the read stops at its budget, saying so, rather than running on.
  let clock = 0;
  const slow: StoredAsk = async (b) => { clock += 60_000; return api({ logs: [], invs: [] })(b); };
  const r = await readStoredLineCalls({ ask: slow, fromMs: T0, toMs: T0 + 30 * MIN, now: () => clock, budgetMs: STORED_READ_BUDGET_MS });
  assert(!r.ok && r.why.includes("budget"), `a read past its budget stops and says so (got ${JSON.stringify(r)})`);
  assert(clock <= STORED_READ_BUDGET_MS + 60_000, `and stops within one query of it (took ${clock / 1000}s)`);
  assert(STORED_READ_BUDGET_MS <= 5 * 60_000, `the budget leaves the judge's fifteen minute job room for everything else (got ${STORED_READ_BUDGET_MS / 1000}s)`);
}

// --- which archive the split reads ------------------------------------------------------------
{
  const stored = { ok: true as const, jsonl: "S", calls: 2_000 };
  eq(chooseLineArchive({ stored, tail: "T", tailCalls: 400 }).archive, "S", "the stored logs when they hold at least what the live tail caught");
  const short = chooseLineArchive({ stored: { ok: true, jsonl: "S", calls: 300 }, tail: "T", tailCalls: 400 });
  assert(short.archive === "T" && short.note.includes("300") && short.note.includes("400"), `stored logs holding fewer than the tail had not finished arriving, so the tail is read and that is said (got ${JSON.stringify(short)})`);
  const refused = chooseLineArchive({ stored: { ok: false, why: "the stored logs answered 403" }, tail: "T", tailCalls: 400 });
  assert(refused.archive === "T" && refused.note.includes("403"), `a refused read falls back to the tail, saying why (got ${JSON.stringify(refused)})`);
  const read = chooseLineArchive({ stored, tail: "T", tailCalls: 400 });
  assert(read.note.includes("2000") && read.note.includes("400"), `the coverage is said either way: the stored count beside what the tail caught (got ${read.note})`);
  const none = chooseLineArchive({ stored: { ok: true, jsonl: "", calls: 0 }, tail: "T", tailCalls: 0 });
  assert(none.note.includes("neither") && !none.note.includes("finished arriving"), `no line call in either source is said as that, never as stored logs still arriving (got ${none.note})`);
  const noTail = chooseLineArchive({ stored: { ok: false, why: "no token" }, tail: undefined, tailCalls: 0 });
  eq(noTail.archive, undefined, "neither readable is no line archive at all");
}

// --- end to end: a confirm the tail lost is split from the stored logs -----------------------
{
  const appArchive = JSON.stringify({ eventTimestamp: T0, wallTime: 900, cpuTime: 10, logs: [
    { timestamp: T0 + 900, message: [formatLine("confirm-profile", { total_ms: 900, isolate_age_ms: 60_000 })] },
    { timestamp: T0 + 900, message: [formatLine("booking-api", { msg: "confirm answered", isolate_invocation_index: 3, line: "shared", line_trace: "lost", wait_line_ms: 50 })] },
  ] });
  const rows = { logs: [logRow({ at: T0 + 10, req: "q1", op: "enter", trace: "lost", stage: "wait" })], invs: [invRow({ at: T0 + 10, req: "q1", wall: 20 })] };
  const r = await readStoredLineCalls({ ask: api(rows), fromMs: T0 - MIN, toMs: T0 + MIN });
  assert(r.ok, "read");
  if (r.ok) {
    const w = readConfirmStartup(appArchive, { lineArchive: r.jsonl })!.lineSplit.warm;
    eq(`${w.joined} ${w.objectMs.join(",")} ${w.outsideMs.join(",")}`, "1 20 30", "the stored calls feed the split exactly as the tail's do");
  }
}

// --- the judge's whole choice, as run-judge makes it ----------------------------------------
{
  const confirmAt = (at: number) => JSON.stringify({ eventTimestamp: at, logs: [
    { timestamp: at + 500, message: [formatLine("booking-api", { msg: "confirm answered", line: "shared", line_trace: "x" })] },
  ] });
  const tail = JSON.stringify({ eventTimestamp: T0, wallTime: 3, logs: [{ timestamp: T0, message: [formatLine("confirm-line-object", { msg: "line call", op: "enter", trace: "x", stage: "wait" })] }] });
  const noCreds = await lineArchiveForRun({ archive: confirmAt(T0), tail, token: "", accountId: "acct" });
  assert(noCreds.archive === tail && noCreds.note.includes("no Cloudflare credentials"), `no token reads the tail and says why (got ${JSON.stringify(noCreds)})`);
  const noSpan = await lineArchiveForRun({ archive: "", tail, token: "t", accountId: "a" });
  assert(noSpan.archive === tail && noSpan.note.includes("no traced confirm"), `no traced confirm reads the tail and says why (got ${JSON.stringify(noSpan)})`);
  const rows = { logs: [logRow({ at: T0 + 10, req: "q1", op: "enter", trace: "x", stage: "wait" }), logRow({ at: T0 + 20, req: "q2", op: "ack", trace: "x", stage: "wait" })], invs: [invRow({ at: T0 + 10, req: "q1", wall: 9 })] };
  const read = await lineArchiveForRun({ archive: confirmAt(T0), tail, token: "t", accountId: "a", ask: api(rows) });
  assert(read.archive !== tail && read.note.includes("stored logs: 2") && read.note.includes("caught 1"), `with credentials the stored logs are read when they hold more (got ${JSON.stringify(read)})`);
}

// --- the real query's wrapper: where it asks, how, and what an unreadable answer is ------------
{
  const seen: { url: string; init: RequestInit }[] = [];
  const fake = (async (url: string, init: RequestInit) => { seen.push({ url, init }); return new Response("not json", { status: 502 }); }) as unknown as typeof fetch;
  const r = await cloudflareAsk("tok", "acct", fake)({ hello: 1 });
  eq(seen[0]?.url, "https://api.cloudflare.com/client/v4/accounts/acct/workers/observability/telemetry/query", "it asks the account's telemetry query");
  eq((seen[0]?.init.headers as Record<string, string>)?.authorization, "Bearer tok", "with the run's token");
  eq(seen[0]?.init.body, JSON.stringify({ hello: 1 }), "posting the body as JSON");
  assert(seen[0]?.init.signal instanceof AbortSignal, "bounded by a timeout signal, so one hung query cannot hold the read");
  eq(`${r.status} ${r.json}`, "502 null", "an answer that is not JSON is its status with no body, never a parse that throws");
  const answered = await cloudflareAsk("tok", "acct", (async () => new Response('{"success":true}', { status: 200 })) as unknown as typeof fetch)({});
  eq(JSON.stringify(answered), '{"status":200,"json":{"success":true}}', "a JSON answer is passed through");
}

// --- what to ask for, and what the tail caught ------------------------------------------------
{
  const confirm = (at: number, trace: string | null) => JSON.stringify({ eventTimestamp: at, logs: [
    { timestamp: at + 500, message: [formatLine("booking-api", { msg: "confirm answered", ...(trace ? { line: "shared", line_trace: trace } : {}) })] },
  ] });
  const archive = [confirm(T0 + 5 * MIN, "a"), confirm(T0, null), confirm(T0 + 2 * MIN, "b")].join("\n");
  const w = tracedConfirmWindow(archive);
  eq(w && `${(w.fromMs - T0) / MIN} ${(w.toMs - T0) / MIN}`, "0 7", "from two minutes before the first traced confirm to two after the last; an untraced one does not widen it");
  eq(tracedConfirmWindow(confirm(T0, null)), null, "no traced confirm is no window, never a guessed one");
  const tail = [
    JSON.stringify({ eventTimestamp: T0, wallTime: 3, logs: [{ timestamp: T0, message: [formatLine("confirm-line-object", { msg: "line call", op: "enter", trace: "a", stage: "wait" })] }] }),
    JSON.stringify({ eventTimestamp: T0, wallTime: 3, logs: [{ timestamp: T0, message: ["something else"] }] }),
  ].join("\n");
  eq(countLineCalls(tail), 1, "the tail's traced calls are counted, nothing else");
}

// --- the Worker asked about is the one the load test deploys ---------------------------------
{
  const cfg = readFileSync(join(import.meta.dirname, "..", "wrangler.confirm-line.jsonc"), "utf8");
  const name = /"loadtest"\s*:\s*\{[\s\S]*?"name"\s*:\s*"([^"]+)"/.exec(cfg)?.[1];
  eq(LINE_WORKER_LOADTEST, name, "the stored logs are asked for the line Worker's load test name");
}

finish();
