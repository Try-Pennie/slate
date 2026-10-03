/**
 * Deterministic fault injection for the load run, across every outside system the
 * deployment talks to (#1050, #3104).
 *
 * It began as Google Calendar READS only, which proved the lanes degrade when Google
 * misbehaves and said nothing about the database, Salesforce, the outbound webhooks or
 * a failing calendar WRITE. This is the one switch for all of them, so the percentage,
 * the hash and the "is this a load test" gate are decided once rather than once per
 * client (L41).
 *
 * **It is structurally off in production, by two independent facts, and both must
 * hold for anything here to fire:**
 *
 *   1. `SLATE_LOADTEST` must be "true". Every injector below asks `isLoadtest()` at
 *      call time, so a percentage that somehow reached production does nothing. The
 *      flag is set on `env.loadtest` in wrangler.jsonc and nowhere else, and
 *      `scripts/test-wrangler-loadtest-env.ts` fails the build the moment the top
 *      level (production) carries it.
 *   2. `SLATE_LOADTEST_FAULT_PCT` must be above zero. It is committed NOWHERE: the
 *      fault leg adds it with `wrangler deploy --var` and the restore step deploys
 *      again without it. The same test fails the build if production, or the
 *      committed `env.loadtest` block, carries it.
 *
 * `SLATE_LOADTEST_FAULT_TARGETS` picks WHICH systems fail, a comma separated list of
 * `FAULT_TARGETS`. Unset is `google-read` alone, which is exactly the behaviour the
 * switch had before the other targets existed, so an existing fault leg is
 * unchanged. A name that matches no target faults NOTHING and is reported
 * (`LOADTEST_FAULT_TARGETS_UNKNOWN`), rather than being ignored: a typo would
 * otherwise drop a target silently while the run read as faulting it (L100), and the
 * fault leg's driver refuses before sending a request when the deployment reports
 * one.
 *
 * DETERMINISTIC, not random. A random failure rate makes a soak irreproducible: a run
 * that passed and a run that failed differ by the dice. The verdict is a hash of the
 * call's own key, so the same key fails on every run. Which key each system uses is
 * written beside its injector, because it decides what "the same call" means.
 */
import { isLoadtest } from "@/lib/loadtest-guard";

/** Every system the fault switch can fail, in the order the runbook explains them. */
export const FAULT_TARGETS = [
  "google-read",
  "google-write",
  "supabase",
  "salesforce",
  "webhook",
] as const;
export type FaultTarget = (typeof FAULT_TARGETS)[number];

/** What an unset `SLATE_LOADTEST_FAULT_TARGETS` means: the original read only switch. */
export const DEFAULT_FAULT_TARGETS: readonly FaultTarget[] = ["google-read"];

/**
 * What each target is DESIGNED to do to a booking request when it fails, which is
 * what decides the fault pass's bar (#3104).
 *
 * `degrades`: the request path survives the failure by design. A failed calendar
 * READ re-routes or answers from the cache, a failed webhook is retried by the
 * outbox after the response, and every Salesforce read on the booking path sits
 * behind a deadline with an answer for "unread". A 5xx with only these failing is a
 * defect, so the "no 5xx under fault" bar applies.
 *
 * `fails-loud`: a failure is a 5xx by design. A calendar WRITE that did not land
 * means the event does not exist, and the confirm path's database writes are the
 * booking itself; answering 200 over either would be the lie. With one of these
 * faulted the 5xx count measures the percentage rather than the code (#2241), so it
 * is reported and not barred, and what is judged instead is the cron lanes.
 */
export const FAULT_TARGET_CONTRACT: Record<FaultTarget, "degrades" | "fails-loud"> = {
  "google-read": "degrades",
  "google-write": "fails-loud",
  supabase: "fails-loud",
  salesforce: "degrades",
  webhook: "degrades",
};

/** Whether every target in a set degrades, so the request path must not 5xx. */
export function everyTargetDegrades(targets: readonly FaultTarget[]): boolean {
  return targets.every((t) => FAULT_TARGET_CONTRACT[t] === "degrades");
}

/** A raw percentage as a number in 0..100. Unreadable is 0, never NaN: NaN compares
 *  false against every threshold, so it would silently mean "no faults" while reading
 *  as configured (L50). Zero means the same thing, and says it. */
export function parseFaultPct(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
}

/**
 * The targets a raw setting names. Unset or blank is the default; any name that is
 * not a target empties the set and is returned in `unknown`, so a typo faults nothing
 * and says so rather than faulting less than was asked for.
 */
export function parseFaultTargets(raw: string | undefined): {
  targets: FaultTarget[];
  unknown: string[];
} {
  const names = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (names.length === 0) return { targets: [...DEFAULT_FAULT_TARGETS], unknown: [] };
  const known = new Set<string>(FAULT_TARGETS);
  const unknown = [...new Set(names.filter((n) => !known.has(n)))].sort();
  if (unknown.length > 0) return { targets: [], unknown };
  // Ordered by FAULT_TARGETS rather than as typed, so two spellings of one set report
  // identically and the driver's comparison is about membership, not order (L228).
  const wanted = new Set(names);
  return { targets: FAULT_TARGETS.filter((t) => wanted.has(t)), unknown: [] };
}

/**
 * The percentage of calls that fail, read once per isolate.
 *
 * Module scope, matching how it has always been read: `/api/smoke/version` reports
 * this SAME constant (#2262, L70), and the fault leg's driver refuses a deployment
 * whose report is not what it asked for. A read that ran before the Worker's vars
 * were assigned would therefore report zero and be refused, which is the safe
 * direction.
 */
export const LOADTEST_FAULT_PCT = parseFaultPct(process.env.SLATE_LOADTEST_FAULT_PCT);

const PARSED_TARGETS = parseFaultTargets(process.env.SLATE_LOADTEST_FAULT_TARGETS);
/** The systems this deployment fails, reported by `/api/smoke/version` from here. */
export const LOADTEST_FAULT_TARGETS: readonly FaultTarget[] = PARSED_TARGETS.targets;
/** Names in the setting that matched no target. Non-empty means nothing is faulted. */
export const LOADTEST_FAULT_TARGETS_UNKNOWN: readonly string[] = PARSED_TARGETS.unknown;

/** A stable small hash, so a key's verdict is the same in every run and on every machine. */
export function keyHash(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** Whether this call should fail. Pure over the key and the configured percentage. */
export function shouldFault(key: string, pct: number = LOADTEST_FAULT_PCT): boolean {
  if (pct <= 0) return false;
  if (pct >= 100) return true;
  return keyHash(key) % 100 < pct;
}

/** The facts the gate reads, injectable so a test can drive each one off on its own. */
export interface FaultSwitch {
  loadtest: boolean;
  pct: number;
  targets: readonly FaultTarget[];
}

function liveSwitch(): FaultSwitch {
  return { loadtest: isLoadtest(), pct: LOADTEST_FAULT_PCT, targets: LOADTEST_FAULT_TARGETS };
}

/** Whether `target` is being faulted at all. Every injector asks this first. */
export function faultActive(target: FaultTarget, sw: FaultSwitch = liveSwitch()): boolean {
  return sw.loadtest && sw.pct > 0 && sw.targets.includes(target);
}

/** Whether THIS call to `target` fails: the gate, then the key's own verdict. */
export function shouldInject(
  target: FaultTarget,
  key: string,
  sw: FaultSwitch = liveSwitch(),
): boolean {
  return faultActive(target, sw) && shouldFault(key, sw.pct);
}

/** The marker on every injected failure, so one is never mistaken for the real thing. */
export const FAULT_MARKER = "(loadtest fault)";

// --- Supabase ---------------------------------------------------------------

/**
 * How long a latency fault holds a database call before letting it through.
 *
 * Long enough to be felt on the confirm path, which makes a dozen database round
 * trips, and short of anything a single call would be cut off at, so this measures
 * slowness rather than becoming a second timeout fault.
 */
export const SUPABASE_FAULT_LATENCY_MS = 1_500;

/**
 * The key a database call is judged by: the method, the address and the body, inside
 * the minute the call is made.
 *
 * The MINUTE is deliberate and it is the one place this switch trades away exact
 * reproducibility. Many of Slate's reads are the same request every tick (the bucket
 * list, a heartbeat upsert is the same URL), so a key of the content alone would fail
 * one of them on EVERY tick for the whole run, which measures a permanently broken
 * table rather than an unreliable database. Inside the minute the verdict is still
 * stable, so a retry within the same tick meets the same answer.
 */
export function supabaseFaultKey(method: string, url: string, body: string, nowMs: number): string {
  return `supabase:${method}:${url}:${body}:${Math.floor(nowMs / 60_000)}`;
}

/** Which of the two failures a faulted database call meets, chosen by its key. */
export function supabaseFaultShape(key: string): "latency" | "unavailable" {
  return keyHash(`shape:${key}`) % 2 === 0 ? "latency" : "unavailable";
}

/**
 * The 500 a faulted database call answers with, shaped as PostgREST shapes an error so
 * supabase-js reads it into `error` exactly as it would a real one.
 *
 * A 500 and NOT a 503, measured rather than chosen for the look of it: postgrest-js
 * retries a 503 (and a 520) on every read, three times on a 1, 2 and 4 second ladder,
 * and the retry is the same request inside the same minute, so it meets the same
 * verdict. A 503 here would therefore hold every faulted read for seven seconds and
 * then fail it anyway, which measures the client's backoff rather than Slate. A 500
 * is not retried and reaches the caller's own handling at once.
 */
export function supabaseFaultResponse(): Response {
  return new Response(
    JSON.stringify({
      code: "PGRST500",
      message: `Internal Server Error ${FAULT_MARKER}`,
      details: null,
      hint: null,
    }),
    { status: 500, headers: { "content-type": "application/json" } },
  );
}

function bodyText(body: unknown): string {
  return typeof body === "string" ? body : "";
}

/**
 * The fetch the Supabase client should use, or null when the database is not being
 * faulted, which is every production request: the caller then passes no fetch at all
 * and the client is exactly what it was.
 */
export function loadtestSupabaseFetch(
  base: typeof fetch,
  opts: {
    sw?: FaultSwitch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): typeof fetch | null {
  const sw = opts.sw ?? liveSwitch();
  if (!faultActive("supabase", sw)) return null;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const faulting = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const key = supabaseFaultKey(method, url, bodyText(init?.body), now());
    if (!shouldFault(key, sw.pct)) return base(input, init);
    if (supabaseFaultShape(key) === "latency") {
      await sleep(SUPABASE_FAULT_LATENCY_MS);
      return base(input, init);
    }
    return supabaseFaultResponse();
  };
  return faulting as typeof fetch;
}

// --- Salesforce --------------------------------------------------------------

/**
 * How long a faulted Salesforce call hangs before it fails.
 *
 * Under load test every Salesforce call is ALREADY refused (#2335), instantly, so the
 * failure every path met was the fast one. What a refusal can never exercise is the
 * SLOW one: the booking path's Salesforce reads race a deadline
 * (`CALLING_NUMBER_DEADLINE_MS`, 2.5 seconds) and the branch that answers when the
 * deadline wins had never run at scale. So a faulted call waits past that deadline and
 * then fails as a timeout. `scripts/test-loadtest-fault-injection.ts` holds this above
 * the deadline, so a deadline raised later cannot quietly turn this back into a fast
 * failure.
 */
export const SALESFORCE_FAULT_LATENCY_MS = 3_000;

/**
 * Hang, then throw, for a faulted Salesforce call. Keyed on the request address, which
 * carries the query and the lead ids, so the same lead is slow on every run.
 */
export async function salesforceLoadtestFault(
  url: string,
  sleep: (ms: number) => Promise<void>,
  sw: FaultSwitch = liveSwitch(),
): Promise<void> {
  if (!shouldInject("salesforce", `salesforce:${url}`, sw)) return;
  await sleep(SALESFORCE_FAULT_LATENCY_MS);
  throw new Error(`Salesforce request timed out ${FAULT_MARKER}`);
}

// --- outbound webhooks ---------------------------------------------------------

/**
 * The recorded outcome of a faulted webhook delivery, or null when this attempt is not
 * faulted.
 *
 * Keyed on the delivery AND the attempt, so one delivery can fail its first attempt and
 * land on a retry, which is the path the outbox exists for, while another fails every
 * attempt and reaches the dead letter alert. A key of the delivery alone would only
 * ever produce the second.
 */
export function webhookLoadtestFault(
  deliveryId: string,
  attempt: number,
  sw: FaultSwitch = liveSwitch(),
): { ok: false; lastResponse: string } | null {
  if (!shouldInject("webhook", `webhook:${deliveryId}:${attempt}`, sw)) return null;
  return { ok: false, lastResponse: `503 Service Unavailable ${FAULT_MARKER}` };
}
