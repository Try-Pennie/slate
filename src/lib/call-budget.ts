/**
 * One expiry shared by every call made inside a piece of work (#3102).
 *
 * A deadline per request bounds ONE request, and the paths that matter make many
 * in sequence. A lead's confirm makes a dozen Supabase calls and two or three
 * Google calls one after another, so each one stopping inside its own limit still
 * adds up past the booker's 20 second abort, and the lead gets the browser giving
 * up instead of our retryable 503. And a Google call is itself two requests, the
 * token mint and the call, so giving each its own deadline doubled the call's.
 *
 * So a budget is an expiry carried through the async context. Inside
 * `withinCallBudget`, every budgeted request waits for the smaller of its own
 * limit and the time the budget has left, and a request that starts with the
 * budget already spent fails at once rather than starting. Budgets nest, and the
 * inner one can only ever be tighter: a Google call opens its own 8 second budget
 * inside the confirm's, so its mint and its request share one expiry, and that
 * expiry is never later than the confirm's.
 *
 * Outside any budget a request just gets its own limit, so the cron lanes are
 * unchanged. Work deferred past the response must not inherit an expiry meant for
 * the lead, and two things see to it: a budget stops governing anything once the
 * scope that opened its request has settled (#3145), whoever deferred the work,
 * and `afterResponse` leaves the budget outright (`outsideCallBudget`), which also
 * covers deferred work that starts while the request is still answering.
 *
 * `Date.now()` in a Worker advances at I/O, not during computation, so this
 * measures time spent WAITING on dependencies, which is what it exists to bound.
 */
import {
  DeadlineExceededError,
  NO_DEADLINE,
  fetchWithinDeadline,
  type Deadline,
  type FetchLike,
} from "./fetch-within-deadline.ts";
import { realTimer, type ScheduleTimer } from "./read-within-deadline.ts";
import { log } from "@/lib/log";

interface Budget {
  readonly expiresAt: number;
  /** What the budget is for and how long it was, for the error that names it. */
  readonly label: string;
  readonly totalMs: number;
  /** The allowance for a failure path, which nested cleanups share. */
  readonly cleanup?: boolean;
  /**
   * Shared by every budget opened within one request, nested or not, so the
   * request's cleanup allowance is opened ONCE and every later cleanup reuses
   * it, even one opened after the first has returned.
   */
  readonly request: { cleanup?: Budget; closed?: boolean };
}

/** The two methods of Node's AsyncLocalStorage this module uses. */
interface ContextStore<T> {
  getStore(): T | undefined;
  run<R>(store: T, work: () => R): R;
}

/**
 * The async context store, found at runtime rather than imported. A static
 * `node:async_hooks` import breaks the build: Turbopack refuses it in any client
 * chunk that reaches this module through a shared import, and the edge
 * middleware cannot take it either. Next's server runtime installs the class on
 * `globalThis` (its own request storage needs it, on Cloudflare too), and plain
 * Node, where the tests run, hands it out through `process.getBuiltinModule`.
 *
 * Where neither exists, which is only a browser bundle that never sends these
 * requests, there is no store: budgets are inert and each call keeps its own
 * limit, the posture the cron lanes have anyway.
 */
type StoreClass = new <T>() => ContextStore<T>;
function findStoreClass(): StoreClass | null {
  const fromGlobal = (globalThis as { AsyncLocalStorage?: StoreClass }).AsyncLocalStorage;
  if (typeof fromGlobal === "function") return fromGlobal;
  const proc = (globalThis as {
    process?: { getBuiltinModule?: (id: string) => { AsyncLocalStorage?: StoreClass } | undefined };
  }).process;
  return proc?.getBuiltinModule?.("node:async_hooks")?.AsyncLocalStorage ?? null;
}

const inert: ContextStore<Budget | undefined> = {
  getStore: () => undefined,
  run: (_store, work) => work(),
};

let found: ContextStore<Budget | undefined> | null = null;

/**
 * The budget in force here, or none once the scope that opened its request has
 * returned (#3145, L1017). The async context is copied into every continuation, so
 * work deferred from inside a budget (a float, a raw `after()` callback, a
 * `waitUntil`, a flight another request awaits) still finds the budget in its
 * context after the request has answered. Nobody waits on it then, so it governs
 * nothing. Deciding that HERE, where the budget is read, covers every writer;
 * `outsideCallBudget` at each one covers only the writers that remembered it.
 */
function current(): Budget | undefined {
  const budget = store().getStore();
  return budget && !budget.request.closed ? budget : undefined;
}
/** Resolved on first use, so the server runtime has installed its class by then. */
function store(): ContextStore<Budget | undefined> {
  if (!found) {
    const StoreClass = findStoreClass();
    found = StoreClass ? new StoreClass<Budget | undefined>() : inert;
    // On a server this would silently switch every budget off, so it is said out
    // loud. In a browser bundle it is expected and nothing here runs there.
    if (!StoreClass && typeof window === "undefined") {
      log.warn("call-budget", { msg: "no AsyncLocalStorage in this runtime; call budgets are inert" });
    }
  }
  return found;
}

// Every clock default below is `() => Date.now()`, never `Date.now` itself. A
// fetch built once at module load (the Supabase clients' `supabaseFetch`) would
// otherwise hold the function it found then, so a test that swaps the clock is
// silently measured against the real one.

/**
 * Run `work` with every budgeted call inside it sharing one expiry, `ms` from now,
 * or the enclosing budget's expiry if that comes first.
 */
export function withinCallBudget<T>(
  ms: number,
  label: string,
  work: () => Promise<T>,
  now: () => number = () => Date.now(),
): Promise<T> {
  const outer = current();
  const own: Budget = { expiresAt: now() + ms, label, totalMs: ms, request: outer?.request ?? {} };
  const ran = store().run(outer && outer.expiresAt <= own.expiresAt ? outer : own, work);
  if (outer) return ran;
  // The ROOT of a request closes it when its work settles, success or failure. A
  // nested budget returning (a Google call inside a confirm) leaves it open.
  return ran.finally(() => {
    own.request.closed = true;
  });
}

/**
 * Run `work` under a budget of its own that IGNORES the enclosing one: the small
 * fixed allowance for a failure path that has to run after the main budget is
 * spent (handing back a lead's rate limit hit, recording the outcome, paging).
 * ONE allowance per request, opened by the first cleanup and reused by every
 * later one in that request, whether nested inside it or opened after it has
 * returned: the service sends its outage page under the allowance and returns,
 * and the route's failure path that follows must not get a second 2 seconds, or
 * the worst case would be 12 + 2 + 2 rather than the 14 it is sized for.
 * Outside any request budget there is nothing to share, and each cleanup gets
 * its own.
 */
export function withinCleanupBudget<T>(
  ms: number,
  label: string,
  work: () => Promise<T>,
  now: () => number = () => Date.now(),
): Promise<T> {
  const outer = current();
  if (outer?.cleanup) return store().run(outer, work);
  const opened = outer?.request.cleanup;
  if (opened) return store().run(opened, work);
  const request = outer?.request ?? {};
  const cleanup: Budget = { expiresAt: now() + ms, label, totalMs: ms, cleanup: true, request };
  request.cleanup = cleanup;
  return store().run(cleanup, work);
}

/**
 * Whether the caller is running inside a budget at all (#3215). A failure path
 * shared by a lead's request and a cron drain asks this so it opens the cleanup
 * allowance only where there is a spent budget to escape, and leaves the drain's
 * calls on their own limits, as they have always been.
 */
export function insideCallBudget(): boolean {
  return current() !== undefined;
}

/** Run `work` with no budget at all: the work deferred past a response. */
export function outsideCallBudget<T>(work: () => T): T {
  return store().run(undefined, work);
}

/** What a missed deadline reports: the call, how long it waited, and the budget
 *  that cut it short, when one did. */
/**
 * What the budget in force here has left, in milliseconds (never negative), or
 * null outside any budget. For a wait that must leave room behind it, such as a
 * confirm waiting in line for the one ahead (#3257, `confirmLineWaitMs`).
 */
export function budgetLeftMs(now: () => number = () => Date.now()): number | null {
  const budget = current();
  return budget ? Math.max(0, budget.expiresAt - now()) : null;
}

export interface DeadlineReport {
  label: string;
  timeoutMs: number;
  budget: { label: string; totalMs: number } | null;
}

/**
 * How long one request may wait: the smaller of its own limit and what the
 * budget has left, and what the error should say if it is missed.
 *
 * The error always names the CALL that was in flight, because that is the
 * dependency somebody has to look at. When the enclosing budget is what cut it
 * short, it also names that budget, so "supabase did not answer within 4000ms,
 * when the booking confirm ran out of its 12000ms" says both which dependency was
 * slow and that it was slow on top of others. A request inside its own call's
 * budget (a Google call's request under the call's 8 seconds) is reported as the
 * call against the call's whole limit, once, rather than as a budget miss.
 *
 * `NO_DEADLINE` opts out of the per call default only, never out of an enclosing
 * budget: inside one it waits for what the budget has left like any other call.
 * Throws when the budget is already spent, so nothing starts that cannot finish.
 */
export function deadlineWithinBudget(
  ownMs: number,
  label: string,
  now?: () => number,
): { waitMs: number; reportAs: DeadlineReport };
export function deadlineWithinBudget(
  ownMs: Deadline,
  label: string,
  now?: () => number,
): { waitMs: Deadline; reportAs: DeadlineReport };
export function deadlineWithinBudget(
  ownMs: Deadline,
  label: string,
  now: () => number = () => Date.now(),
): { waitMs: Deadline; reportAs: DeadlineReport } {
  const budget = current();
  const own = ownMs === NO_DEADLINE ? Infinity : ownMs;
  if (!budget) return { waitMs: ownMs, reportAs: { label, timeoutMs: own, budget: null } };
  const left = budget.expiresAt - now();
  const cutBy = { label: budget.label, totalMs: budget.totalMs };
  if (left <= 0) throw new DeadlineExceededError(label, 0, cutBy);
  if (left >= own) return { waitMs: own, reportAs: { label, timeoutMs: own, budget: null } };
  if (budget.label === label) return { waitMs: left, reportAs: { label, timeoutMs: budget.totalMs, budget: null } };
  return { waitMs: left, reportAs: { label, timeoutMs: left, budget: cutBy } };
}

/** `fetchWithinDeadline`, held to the enclosing budget as well as its own limit. */
export async function fetchWithinBudget(
  fetchImpl: FetchLike,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  deadline: Deadline,
  label: string,
  timer: ScheduleTimer = realTimer,
  now: () => number = () => Date.now(),
): Promise<Response> {
  const { waitMs, reportAs } = deadlineWithinBudget(deadline, label, now);
  return fetchWithinDeadline(fetchImpl, input, init, waitMs, label, timer, reportAs);
}

/** A fetch-shaped `fetchWithinBudget`, for a client that takes a `fetch` option. */
export function fetchWithBudget(
  fetchImpl: FetchLike,
  deadline: Deadline,
  label: string,
  timer: ScheduleTimer = realTimer,
  now: () => number = () => Date.now(),
): FetchLike {
  return (input, init) => fetchWithinBudget(fetchImpl, input, init, deadline, label, timer, now);
}
