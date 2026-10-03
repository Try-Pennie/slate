/**
 * A fetch that cannot hang (#3102).
 *
 * Every outbound call on a path somebody is waiting on needs a deadline, and the
 * Supabase clients, the default Google calls and the delegated token mint had
 * none: a dependency that accepted the connection and never answered held a
 * lead's confirm until the BROWSER gave up at 20 seconds, and ate the budget a
 * cron lane shares with three others. This is the one wrapper they all go
 * through, so the race, the abort and the timer cleanup are written once.
 *
 * It throws rather than returning null, unlike `readWithinDeadline` beside it:
 * these are calls whose caller already has a failure path, and a timeout must
 * reach it as a failure (a degraded read here would be an empty pool, L215).
 *
 * The deadline covers the request up to its response HEADERS, which is what
 * `fetch` itself resolves on. A body that starts and then stalls is not covered;
 * every caller here reads small JSON bodies, and arming the abort past the
 * headers would cut a healthy large read in half.
 *
 * Pure, no `@/` imports, so node tests load it directly.
 */
import { realTimer, type ScheduleTimer } from "./read-within-deadline.ts";

/**
 * Thrown when a call did not answer inside its deadline.
 *
 * `code` is `ABORT_ERR` on purpose. PostgREST's client retries a GET that failed
 * with a network error up to three times, with a 1, 2 and 4 second backoff, but
 * it does NOT retry an abort, which it recognises by that code. Without it one
 * hung Supabase read would cost four deadlines plus seven seconds of sleeping
 * before anybody heard about it, which is the hang this exists to end.
 */
export class DeadlineExceededError extends Error {
  readonly code = "ABORT_ERR";
  readonly label: string;
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`${label} did not answer within ${timeoutMs}ms`);
    this.name = "DeadlineExceededError";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The only way to send a call with no deadline, and it has to be written out by
 * name at the call site, so an unbounded call is a decision a reviewer can see
 * rather than a parameter somebody forgot.
 */
export const NO_DEADLINE: unique symbol = Symbol("no deadline");
export type Deadline = number | typeof NO_DEADLINE;

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * The deadline an error reports exceeding, wherever it ended up, or null when it
 * is not a deadline at all.
 *
 * Three shapes reach a caller: the error itself; an error that carries it as its
 * `cause`; and a PostgREST result, which never throws but folds the fetch failure
 * into `error.message` as `<name>: <message>`, which `unwrap` then quotes inside
 * its own message. The last is matched on the error's NAME followed by the exact
 * sentence this module writes, which nothing else produces, rather than on any
 * wording a person might also write.
 */
export function findDeadlineExceeded(err: unknown): { label: string; timeoutMs: number } | null {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    if (e instanceof DeadlineExceededError) return { label: e.label, timeoutMs: e.timeoutMs };
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string") {
      const quoted = /DeadlineExceededError: (.+) did not answer within (\d+)ms/.exec(message);
      if (quoted) return { label: quoted[1], timeoutMs: Number(quoted[2]) };
    }
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

export function isDeadlineExceeded(err: unknown): boolean {
  return findDeadlineExceeded(err) !== null;
}

/**
 * Send one request under a deadline. A `NO_DEADLINE` call is passed straight
 * through. Otherwise the request is raced against the timer: on expiry the
 * request is aborted (so the platform stops waiting on the socket) AND the race
 * rejects at once, so even a fetch that ignores its signal cannot hold the caller.
 * The timer is cleared however the race ends, and a signal the caller passed in
 * still aborts the request.
 */
export async function fetchWithinDeadline(
  fetchImpl: FetchLike,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  deadline: Deadline,
  label: string,
  timer: ScheduleTimer = realTimer,
  /** What the error names when the wait was cut short by an enclosing budget
   *  (`call-budget.ts`) rather than set by this call: that budget's label and
   *  length, not the slice that was left. Defaults to this call's own. */
  reportAs: { label: string; timeoutMs: number } | null = null,
): Promise<Response> {
  if (deadline === NO_DEADLINE) return fetchImpl(input, init);
  const controller = new AbortController();
  const callerSignal = init?.signal ?? undefined;
  const forwardAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) forwardAbort();
  else callerSignal?.addEventListener("abort", forwardAbort, { once: true });

  let cancel = () => {};
  const expired = new Promise<never>((_resolve, reject) => {
    cancel = timer(deadline, () => {
      const err = new DeadlineExceededError(reportAs?.label ?? label, reportAs?.timeoutMs ?? deadline);
      // Rejected BEFORE the abort, so the race settles on this error. A fetch that
      // rejects on its signal's abort event would otherwise settle first, with a
      // bare AbortError that says nothing about which deadline it missed.
      reject(err);
      controller.abort(err);
    });
  });
  try {
    return await Promise.race([fetchImpl(input, { ...init, signal: controller.signal }), expired]);
  } finally {
    cancel();
    callerSignal?.removeEventListener("abort", forwardAbort);
  }
}

/**
 * A fetch-shaped function with the deadline built in, for a client that takes a
 * `fetch` option (the Supabase clients). Every request it sends gets its own timer.
 */
export function fetchWithDeadline(
  fetchImpl: FetchLike,
  deadline: Deadline,
  label: string,
  timer: ScheduleTimer = realTimer,
): FetchLike {
  return (input, init) => fetchWithinDeadline(fetchImpl, input, init, deadline, label, timer);
}
