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
 * unchanged. Work deferred past the response must leave the budget
 * (`outsideCallBudget`), or it would inherit an expiry meant for the lead.
 *
 * `Date.now()` in a Worker advances at I/O, not during computation, so this
 * measures time spent WAITING on dependencies, which is what it exists to bound.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  DeadlineExceededError,
  NO_DEADLINE,
  fetchWithinDeadline,
  type Deadline,
  type FetchLike,
} from "./fetch-within-deadline.ts";
import { realTimer, type ScheduleTimer } from "./read-within-deadline.ts";

interface Budget {
  readonly expiresAt: number;
  /** What the budget is for and how long it was, for the error that names it. */
  readonly label: string;
  readonly totalMs: number;
}

const current = new AsyncLocalStorage<Budget | undefined>();

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
  const outer = current.getStore();
  const own: Budget = { expiresAt: now() + ms, label, totalMs: ms };
  return current.run(outer && outer.expiresAt <= own.expiresAt ? outer : own, work);
}

/**
 * Run `work` under a budget of its own that IGNORES the enclosing one: the small
 * fixed allowance for cleanup that has to happen after the main budget is spent
 * (handing a lead's rate limit hit back once their confirm timed out). Bounded,
 * so the path's worst case is still the sum of the two, never open ended.
 */
export function withinFreshCallBudget<T>(
  ms: number,
  label: string,
  work: () => Promise<T>,
  now: () => number = () => Date.now(),
): Promise<T> {
  return current.run({ expiresAt: now() + ms, label, totalMs: ms }, work);
}

/** Run `work` with no budget at all: the work deferred past a response. */
export function outsideCallBudget<T>(work: () => T): T {
  return current.run(undefined, work);
}

/**
 * How long one request may wait: the smaller of its own limit and what the
 * budget has left, with the label and length the error should carry if it is
 * missed. A missed budget names the BUDGET ("google events.insert did not answer
 * within 8000ms"), not the slice that happened to be left when the request began.
 * Throws when the budget is already spent, so nothing starts that cannot finish.
 */
export function deadlineWithinBudget(
  ownMs: number,
  label: string,
  now: () => number = () => Date.now(),
): { waitMs: number; reportAs: { label: string; timeoutMs: number } } {
  const budget = current.getStore();
  if (!budget) return { waitMs: ownMs, reportAs: { label, timeoutMs: ownMs } };
  const left = budget.expiresAt - now();
  if (left <= 0) throw new DeadlineExceededError(budget.label, budget.totalMs);
  if (left >= ownMs) return { waitMs: ownMs, reportAs: { label, timeoutMs: ownMs } };
  return { waitMs: left, reportAs: { label: budget.label, timeoutMs: budget.totalMs } };
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
  if (deadline === NO_DEADLINE) return fetchImpl(input, init);
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
