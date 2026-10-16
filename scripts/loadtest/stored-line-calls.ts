/**
 * The confirm line object's traced calls, read from Cloudflare's STORED logs (#3815).
 *
 * Why not only the live tail: `wrangler tail` samples at load test volume. On run
 * 38912230442 the line Worker's tail caught 411 of about 2,200 traced line calls in
 * its busiest seven minutes, losing single events (an enter without its ack), so about
 * half the traced confirms could not be split. Workers Logs keeps every one.
 *
 * Two facts about the query API, both measured on 2026-10-16, shape this module:
 *
 *   A log row carries the message and a `requestId` but NO wall time; the invocation
 *   record (`$metadata.type` `cf-worker-event`) carries `$workers.wallTimeMs`. So both
 *   are read and joined on the request id.
 *
 *   A query returns at most `STORED_PAGE_LIMIT` events and says nothing when it cut
 *   some off, so a window is read one minute at a time and HALVED whenever a page
 *   comes back full, never trusted. One minute's events agreed with its halves and its
 *   quarters (290 each way) on the run above.
 *
 * The output is the tail's own `--format json` shape, one object per invocation, so the
 * split reads it through the one parser it already has (`tailInvocations`).
 */

import { tailInvocations } from "./confirm-startup.ts";

/** The confirm line Worker's load test name, held to `wrangler.confirm-line.jsonc` by its test. */
export const LINE_WORKER_LOADTEST = "slate-confirm-line-loadtest";
/** The most events one query returns. A page this full may have been cut off. */
export const STORED_PAGE_LIMIT = 2000;
/** The window read per query, halved while a page comes back full. */
export const STORED_WINDOW_MS = 60_000;
/**
 * The longest the whole read may take. The judge's job has fifteen minutes for everything,
 * and a run's span is two queries a minute, so a slow API must stop the read, said, rather
 * than hold the judge until the job is killed with no report at all.
 */
export const STORED_READ_BUDGET_MS = 4 * 60_000;
/** The narrowest window halving goes to before the read gives up as too dense to page. */
const MIN_WINDOW_MS = 1_000;

const LINE_CALL = 'msg="line call"';

/** One query to the Workers observability API, injected so every outcome is driven offline. */
export type StoredAsk = (body: unknown) => Promise<{ status: number; json: unknown }>;

export type StoredLineCalls = { ok: true; jsonl: string; calls: number } | { ok: false; why: string };

interface StoredEvent {
  timestamp?: unknown;
  source?: { message?: unknown } | null;
  $metadata?: { requestId?: unknown; message?: unknown } | null;
  $workers?: { wallTimeMs?: unknown } | null;
}

function body(kind: "logs" | "invocations", fromMs: number, toMs: number): unknown {
  const filters: { key: string; operation: string; type: string; value: string }[] = [
    { key: "$metadata.service", operation: "eq", type: "string", value: LINE_WORKER_LOADTEST },
  ];
  if (kind === "logs") filters.push({ key: "message", operation: "includes", type: "string", value: LINE_CALL });
  else filters.push({ key: "$metadata.type", operation: "eq", type: "string", value: "cf-worker-event" });
  return {
    queryId: `loadtest-line-${kind}`,
    view: "events",
    limit: STORED_PAGE_LIMIT,
    dry: false,
    timeframe: { from: fromMs, to: toMs },
    parameters: { filters },
  };
}

/** One window's events of one kind, halving the window while a page comes back full. */
async function readWindow(
  ask: StoredAsk,
  kind: "logs" | "invocations",
  fromMs: number,
  toMs: number,
  checkBudget: () => void,
): Promise<StoredEvent[]> {
  checkBudget();
  const { status, json } = await ask(body(kind, fromMs, toMs));
  const j = json as { success?: unknown; errors?: { message?: unknown }[]; result?: { events?: { events?: unknown } } } | null;
  if (status !== 200 || j?.success !== true) {
    const msg = j?.errors?.map((e) => String(e.message ?? "")).filter(Boolean).join("; ");
    throw new Error(`the stored logs answered ${status}${msg ? ` (${msg})` : ""}`);
  }
  const events = j.result?.events?.events;
  if (!Array.isArray(events)) throw new Error("the stored logs answered with no event list");
  if (events.length < STORED_PAGE_LIMIT) return events as StoredEvent[];
  if (toMs - fromMs <= MIN_WINDOW_MS) {
    throw new Error(`a ${Math.round((toMs - fromMs) / 1000)}s window held a full page of ${kind}, so some could not be read`);
  }
  const mid = fromMs + Math.floor((toMs - fromMs) / 2);
  return [...(await readWindow(ask, kind, fromMs, mid, checkBudget)), ...(await readWindow(ask, kind, mid, toMs, checkBudget))];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/**
 * Every traced line call between `fromMs` and `toMs`, as tail shaped JSON lines with
 * each call's own wall time, or why they could not all be read. Never partial: a
 * window that could not be read fails the whole read, because a split over some of
 * the calls would read as a split over all of them (L98).
 */
export async function readStoredLineCalls(args: {
  ask: StoredAsk;
  fromMs: number;
  toMs: number;
  /** Injected so a test never waits for real (L524). */
  now?: () => number;
  budgetMs?: number;
}): Promise<StoredLineCalls> {
  const now = args.now ?? Date.now;
  const started = now();
  const budget = args.budgetMs ?? STORED_READ_BUDGET_MS;
  // Its own sentence, so an overrun reads as the budget and not as a refusal (L11).
  const checkBudget = () => {
    if (now() - started > budget) throw new Error(`the stored logs read passed its ${Math.round(budget / 1000)}s budget`);
  };
  const logs: StoredEvent[] = [];
  const invs: StoredEvent[] = [];
  try {
    for (let t = args.fromMs; t < args.toMs; t += STORED_WINDOW_MS) {
      const end = Math.min(t + STORED_WINDOW_MS, args.toMs);
      logs.push(...(await readWindow(args.ask, "logs", t, end, checkBudget)));
      invs.push(...(await readWindow(args.ask, "invocations", t, end, checkBudget)));
    }
  } catch (err) {
    return { ok: false, why: err instanceof Error ? err.message : String(err) };
  }
  // An invocation record logged near a window's edge can fall in the next window; the
  // join is over the whole read, so it still finds its call.
  const wallByRequest = new Map<string, number | null>();
  for (const e of invs) {
    const req = text(e.$metadata?.requestId);
    if (req) wallByRequest.set(req, num(e.$workers?.wallTimeMs));
  }
  const byRequest = new Map<string, { at: number | null; lines: { at: number | null; message: string }[] }>();
  let calls = 0;
  for (const e of logs) {
    const message = text(e.source?.message) ?? text(e.$metadata?.message);
    const req = text(e.$metadata?.requestId);
    if (!message || !message.includes(LINE_CALL) || !req) continue;
    calls += 1;
    const at = num(e.timestamp);
    const inv = byRequest.get(req) ?? { at, lines: [] };
    inv.lines.push({ at, message });
    byRequest.set(req, inv);
  }
  const lines = [...byRequest.entries()]
    .sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0))
    .map(([req, inv]) =>
      JSON.stringify({
        eventTimestamp: inv.at,
        // Null, never zero, when the invocation record is missing: the split counts
        // that call unreadable rather than as a call that cost nothing (L98).
        wallTime: wallByRequest.has(req) ? wallByRequest.get(req) : null,
        logs: inv.lines.map((l) => ({ timestamp: l.at, message: [l.message] })),
      }),
    );
  return { ok: true, jsonl: lines.join("\n"), calls };
}

/**
 * Which archive the line split reads, and the sentence saying so (#3815). The stored
 * logs when they hold at least the calls the live tail caught: fewer means they had not
 * finished arriving (ingestion has lagged hours, #1533), and reading them would lose
 * calls the tail has. The tail otherwise, with the reason.
 */
export function chooseLineArchive(args: {
  stored: StoredLineCalls;
  tail: string | null | undefined;
  tailCalls: number;
}): { archive: string | null | undefined; note: string } {
  const { stored, tail, tailCalls } = args;
  if (stored.ok && stored.calls >= tailCalls && stored.calls > 0) {
    return { archive: stored.jsonl, note: `line calls read from the stored logs: ${stored.calls}, where the live tail caught ${tailCalls}` };
  }
  if (stored.ok && stored.calls === 0 && tailCalls === 0) {
    return { archive: tail, note: "neither the stored logs nor the live tail held a line call" };
  }
  const why = stored.ok
    ? `the stored logs held ${stored.calls} line calls, fewer than the live tail's ${tailCalls}, so they had not finished arriving`
    : stored.why;
  return { archive: tail, note: `line calls read from the live tail (${tailCalls}), which samples at load test volume: ${why}` };
}

/** How far either side of the traced confirms the calls are read: a confirm's calls start before its answer line. */
const WINDOW_PAD_MS = 2 * 60_000;

/**
 * The span the stored logs are read over: from the first traced shared line confirm in
 * the app archive to the last, padded. Null when the archive holds none, never a guess.
 */
export function tracedConfirmWindow(archive: string): { fromMs: number; toMs: number } | null {
  let first = Infinity;
  let last = -Infinity;
  for (const item of tailInvocations(archive)) {
    if (item.kind !== "invocation" || item.invocation.eventTimestamp === null) continue;
    if (!item.invocation.logs.some((l) => / line_trace=\S/.test(l.text) && / line=("shared"|shared)/.test(l.text))) continue;
    first = Math.min(first, item.invocation.eventTimestamp);
    last = Math.max(last, item.invocation.eventTimestamp);
  }
  return Number.isFinite(first) ? { fromMs: first - WINDOW_PAD_MS, toMs: last + WINDOW_PAD_MS } : null;
}

/** The traced line calls a tail archive holds, to compare the stored read against. */
export function countLineCalls(archive: string): number {
  let n = 0;
  for (const item of tailInvocations(archive)) {
    if (item.kind === "invocation") n += item.invocation.logs.filter((l) => l.text.includes(LINE_CALL)).length;
  }
  return n;
}

/** The real query, against Cloudflare's API with the run's own token, bounded so a hung read cannot hold the judge. */
export function cloudflareAsk(token: string, accountId: string, fetchFn: typeof fetch = fetch): StoredAsk {
  return async (body) => {
    const res = await fetchFn(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/observability/telemetry/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };
}

/**
 * The judge's whole choice for one run (#3815): the window from the app archive, the
 * stored logs read when there are credentials, and which archive the split then reads,
 * with the sentence saying so. `ask` is injected for tests; the judge passes none.
 */
export async function lineArchiveForRun(args: {
  archive: string;
  tail: string | null | undefined;
  token: string;
  accountId: string;
  ask?: StoredAsk;
}): Promise<{ archive: string | null | undefined; note: string }> {
  const span = tracedConfirmWindow(args.archive);
  const stored: StoredLineCalls =
    span === null
      ? { ok: false, why: "no traced confirm is in the archive, so there was no window to read the stored logs over" }
      : args.token === "" || args.accountId === ""
        ? { ok: false, why: "no Cloudflare credentials on this runner, so the stored logs were not read" }
        : await readStoredLineCalls({ ask: args.ask ?? cloudflareAsk(args.token, args.accountId), ...span });
  return chooseLineArchive({ stored, tail: args.tail, tailCalls: typeof args.tail === "string" ? countLineCalls(args.tail) : 0 });
}
