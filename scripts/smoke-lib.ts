// Shared plumbing for the hand-run production smoke scripts (scripts/smoke-*.ts),
// extracted so the request helpers and the pass/fail checker have ONE definition
// instead of being copy-pasted (and drifting) across each script (#530).
//
// Env is read lazily, at call time, NOT at import: several smoke scripts call
// loadEnvFiles(".env.local", ...) in their own top-level code, which runs AFTER
// this module's imports are evaluated. Reading process.env inside each function
// keeps those scripts working regardless of import order.

import { envOr } from "./smoke-env.ts";
import {
  failureLogPath,
  nodeSmokeFailureIo,
  recordFailure,
  recordPass,
  type FailureLogIo,
} from "./lib/smoke-failure-log.ts";

export type Json = Record<string, unknown>;

/**
 * Base URL of the target deployment (SLATE_BASE_URL, default prod), no trailing
 * slash.
 *
 * envOr, never `??`. The canary wires SLATE_BASE_URL from a repo Actions variable,
 * and `${{ vars.X }}` for a variable that is NOT set arrives as an EMPTY STRING
 * rather than undefined, which `??` accepts. That shipped on 2026-08-14 and took
 * the canary down with `Failed to parse URL from /api/availability?bucket=SMOKE`:
 * two scripts had been converted and this shared helper, the one every request
 * actually goes through, had not.
 */
export function smokeBase(): string {
  return envOr(process.env.SLATE_BASE_URL, "https://slate.trypennie.app").replace(/\/$/, "");
}

/** The booking API key (BOOKING_API_KEY_CANARY); empty string if unset. */
export function smokeKey(): string {
  return process.env.BOOKING_API_KEY_CANARY ?? "";
}

/** Last path segment of a manage URL (the manage token); safe on null/undefined. */
export function tokenFrom(manageUrl: unknown): string {
  return String(manageUrl ?? "").split("/").pop() ?? "";
}

/**
 * The socket/DNS error codes that count as a TRANSIENT network failure worth retrying.
 * An explicit ALLOWLIST, not a denylist (L35): undici throws `TypeError: fetch failed`
 * with one of these on its `cause` for a real network blip, while deterministic bugs
 * carry other codes (`ERR_INVALID_URL`, the 2026-08-14 outage #1495; `UND_ERR_*` bad
 * arguments) or no code at all, and retrying those just wastes the backoff and hides
 * the cause. An unknown code is treated as NOT transient, the safe direction.
 */
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE",
  "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);

/** Whether a thrown fetch failure is a transient network error worth retrying (L35). */
export function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  const code = (err as { cause?: { code?: unknown } }).cause?.code;
  return typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code);
}

/**
 * A bounded retry for the canary's transient-prone network READS (#3583).
 *
 * The full pass runs every ~6 hours, so one transient blip (an `ECONNRESET`, a
 * dropped connection) on a setup read failed the whole run and burned the interval,
 * paging on a fault that was gone by the next request (run 38067762798, 2026-10-10,
 * which died "before the checks began"). This retries a thrown attempt a bounded
 * number of times; a completed response of any status is a real answer, returned
 * as-is. By default only a transient network error is retried (see
 * isTransientNetworkError), never a deterministic one. Finite, because a read that
 * retries forever hangs the run (L110).
 *
 * ONLY for IDEMPOTENT reads (e.g. `slots`). A mutating POST must NOT be retried on a
 * thrown error: a booking the server already committed, whose response was then lost
 * to an `ECONNRESET`, would be re-sent and come back `deduped`/`rescheduled` instead
 * of `created`, which fails the canary on a success (L33). So `jpost` does not use it.
 *
 * Pure: the attempt, the sleep and the retryable predicate are injected, so it is
 * node-testable with no real network and no real clock (scripts/test-smoke-retry.ts).
 */
export async function withRetry<T>(
  attempt: () => Promise<T>,
  opts: {
    attempts?: number;
    retryable?: (err: unknown) => boolean;
    sleep?: (ms: number) => Promise<void>;
    backoffMs?: number;
  } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const backoffMs = opts.backoffMs ?? 500;
  const retryable = opts.retryable ?? isTransientNetworkError;
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await attempt();
    } catch (err) {
      lastErr = err;
      if (i === attempts || !retryable(err)) throw err;
      await sleep(backoffMs * i);
    }
  }
  throw lastErr;
}

/** POST JSON to `path`, optionally bearer-authed. Never throws on a non-JSON body.
 *  Deliberately NOT retried: a POST is not idempotent for the canary's purpose (see
 *  withRetry). */
export async function jpost(
  path: string,
  body: Json,
  auth = false,
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.authorization = `Bearer ${smokeKey()}`;
  const res = await fetch(`${smokeBase()}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
}

/** Open availability slots for a bucket. Returns [] on any non-200 or missing field.
 *  #3583: this idempotent read is retried on a thrown network error so a transient
 *  blip during setup does not fail the whole run. */
export async function slots(bucket: string): Promise<string[]> {
  const res = await withRetry(() =>
    fetch(`${smokeBase()}/api/availability?bucket=${encodeURIComponent(bucket)}`, {
      headers: { authorization: `Bearer ${smokeKey()}` },
    }),
  );
  const body = (await res.json().catch(() => ({}))) as { slots?: string[] };
  return res.status === 200 ? body.slots ?? [] : [];
}

/**
 * The result of gating a bucket's open-slot count before a booking smoke run.
 * `setup_broken` means the isolated test agent is misconfigured (zero slots);
 * `insufficient` means the window is merely too thin. Both stop the run, but the
 * caller surfaces distinct guidance (#456).
 */
export type SlotAvailability =
  | { ok: true }
  | { ok: false; kind: "setup_broken" | "insufficient"; message: string };

/**
 * Decide whether a bucket has enough open slots to run the booking smoke suite,
 * and classify a shortfall so a MISCONFIGURED test agent fails loudly instead of
 * reading as a quiet pass (#456). Zero slots means the isolated test agent is
 * broken (no Google Calendar connected, no availability schedule, or recompute
 * has not published slots yet), so nothing would be exercised. A non-zero count
 * below the floor means the window is only too thin. Pure (no I/O), so it is
 * unit-testable without hitting production.
 */
export function evaluateSlotAvailability(
  bucket: string,
  slotCount: number,
  minRequired = 5,
): SlotAvailability {
  if (slotCount >= minRequired) return { ok: true };
  if (slotCount <= 0) {
    return {
      ok: false,
      kind: "setup_broken",
      message:
        `SETUP BROKEN: bucket "${bucket}" returned ZERO open slots. The isolated ` +
        `test agent is likely misconfigured (no Google Calendar connected, no ` +
        `availability schedule, or recompute has not published slots yet). Re-seed ` +
        `with scripts/seed-smoke-test.ts, confirm the availability cache is warm, ` +
        `then re-run. Nothing was exercised, so this is a configuration failure, ` +
        `not a passing run.`,
    };
  }
  return {
    ok: false,
    kind: "insufficient",
    message:
      `SETUP INCOMPLETE: bucket "${bucket}" has only ${slotCount} open slot(s), but ` +
      `the smoke run needs at least ${minRequired}. Free up the test agent's ` +
      `calendar or widen its availability schedule, then re-run.`,
  };
}

/**
 * A pass/fail checker with isolated counting. Each smoke script does:
 *   const { check, failed } = createChecker({ name: SMOKE_NAMES.reschedule });
 *   ...
 *   process.exit(failed() ? 1 : 0);
 *
 * `name` is the smoke's own (from SMOKE_NAMES), required so each pass is tagged with
 * it and a crash of this smoke counts only its own passes (#4062).
 */
export function createChecker(opts: {
  name: string;
  io?: FailureLogIo;
  env?: Record<string, string | undefined>;
}): {
  check: (cond: boolean, msg: string) => void;
  failed: () => number;
} {
  let failures = 0;
  const io = opts.io ?? nodeSmokeFailureIo;
  // #1492: record each failure as it happens, so the canary's Slack alert can name
  // WHICH checks failed rather than one sentence covering every possible cause. A
  // no-op unless the workflow set SMOKE_FAILURE_FILE, so a hand run is unchanged.
  // #4062: a pass is recorded too, so a crash after passing checks is never read as a
  // run that stopped before the checks began.
  const failureLog = failureLogPath(opts.env ?? process.env);
  return {
    check(cond: boolean, msg: string): void {
      if (cond) {
        console.log("ok:", msg);
        recordPass(io, failureLog, opts.name);
      } else {
        console.error("FAIL:", msg);
        failures += 1;
        recordFailure(io, failureLog, msg);
      }
    },
    failed: () => failures,
  };
}
