/**
 * A circuit breaker for Google Calendar calls (#3134).
 *
 * Through a Google outage every call still went out: a token mint and a request,
 * each waiting up to its deadline, on a subrequest and CPU budget four cron lanes
 * share and on a confirm a lead is waiting for. After `threshold` consecutive
 * transient failures the breaker OPENS and refuses calls at once, without sending
 * them, for `openMs`. Then it lets exactly ONE call through as a probe: Google
 * answering closes it, a failure opens it for another window.
 *
 * Refusing is a THROW (`GoogleBreakerOpenError`), never a degraded answer. Every
 * caller already has a failure path for a Google call that did not answer, and on
 * verify-on-book that path reads the agent as unverified and the booking as a
 * retryable 503, never as free. An open breaker therefore fails safe by the same
 * route a timeout does, and cannot invent free time.
 *
 * The state is held per isolate, in memory. That is deliberate: it costs no
 * subrequest and no binding, so the breaker can never itself be the thing that is
 * down, and an isolate that has just watched Google fail is exactly the one that
 * should stop calling it. The cost is that each isolate learns the outage on its
 * own (`threshold` failures each), and the open and close alerts dedupe through
 * the shared `alert_state` cooldown rather than through this state.
 *
 * Pure apart from the classifier imports, with an injected clock, so the node
 * suite drives every transition (`scripts/test-google-breaker.ts`).
 */
import { findDeadlineExceeded } from "@/lib/fetch-within-deadline";
import { isDefinitiveFailure, reachabilityFromError } from "@/lib/google/reachability-classify";

/** Consecutive transient failures that open the breaker. */
export const GOOGLE_BREAKER_THRESHOLD = 5;

/** How long an open breaker refuses calls before letting one probe through. */
export const GOOGLE_BREAKER_OPEN_MS = 30_000;

/**
 * Thrown in place of a Google call while the breaker is open. Not a
 * `GoogleHttpError`, so `reachabilityFromError` classifies it as transient, which
 * is what it is: retrying shortly can work.
 */
export class GoogleBreakerOpenError extends Error {
  /** How long until the breaker lets a probe through. */
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`Google Calendar calls are held back after repeated failures; next attempt in ${retryAfterMs}ms`);
    this.name = "GoogleBreakerOpenError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * What one call says about Google: it `answered` (any reply that is not an
 * outage, including a refusal about one agent), it is a `failure` that counts
 * toward an outage, or it is `neutral` and says nothing either way.
 */
export type BreakerVerdict = "answered" | "failure" | "neutral";

/**
 * A reply's status. Only a 5xx or a 429 is an outage. Everything else is Google
 * answering, including the non 2xx replies callers expect and handle themselves:
 * a 409 on an idempotent insert, a 404 or 410 on an event already gone, a 410 on
 * an expired sync token, and a 4xx about one agent's account.
 *
 * Deliberately NOT `classifyGoogleStatus`, which calls every status it does not
 * name transient: it was written for failures, and would count a 409 reuse or an
 * expired sync token as an outage. A 403 rate limit in a calendar reply is read
 * as an answer, since telling it apart from a permission 403 means reading the
 * body, and a quota refusal is still Google up and answering.
 */
export function googleBreakerVerdictFromStatus(status: number): BreakerVerdict {
  return status >= 500 || status === 429 ? "failure" : "answered";
}

/**
 * A thrown error (a network failure, a deadline, or the token mint refusing).
 *
 * Judged by the shared classifier and `isDefinitiveFailure`, never by comparing a
 * kind to "gone": a definitive failure (a revoked delegation, an account never
 * given Calendar) is one agent's problem and proof Google answered, so it must
 * never count toward an outage. A transient one (a 5xx or rate limited mint, a
 * network error, the call's own deadline) does.
 *
 * Neutral: a deadline set by an ENCLOSING budget (the booking confirm's) rather
 * than this call's own, because a confirm that spent its time on Supabase says
 * nothing about Google; and the breaker's own refusal. `callLabel` is the label
 * `gfetch` gives the call, which its own budget carries, so a hung token mint
 * inside the call's budget still counts.
 */
export function googleBreakerVerdictFromError(err: unknown, callLabel?: string): BreakerVerdict {
  if (err instanceof GoogleBreakerOpenError) return "neutral";
  const deadline = findDeadlineExceeded(err);
  if (deadline?.budget && deadline.budget.label !== `google ${callLabel}`) return "neutral";
  return isDefinitiveFailure(reachabilityFromError(err)) ? "answered" : "failure";
}

/** What the breaker announces, once per change of state. */
export type BreakerTransition =
  | { to: "open"; failures: number; lastFailure: string | null }
  | { to: "closed"; openForMs: number };

/** Handed back by `admit` and returned to `record`, so the probe is known. */
export interface BreakerTicket {
  readonly probe: boolean;
}

export type BreakerState = "closed" | "open" | "half-open";

export interface CircuitBreaker {
  /** Throws `GoogleBreakerOpenError` when the call must not be sent. */
  admit(): BreakerTicket;
  /** The outcome of a call `admit` let through. */
  record(ticket: BreakerTicket, verdict: BreakerVerdict, failure?: string): void;
  state(): BreakerState;
  /** Back to closed with no streak, for a test that shares the module's breaker. */
  reset(): void;
}

export function createCircuitBreaker(opts: {
  threshold: number;
  openMs: number;
  now?: () => number;
  onTransition?: (t: BreakerTransition) => void;
}): CircuitBreaker {
  const now = opts.now ?? (() => Date.now());
  let failures = 0;
  let openedAt: number | null = null;
  let retryAt = 0;
  let probing = false;

  const announce = (t: BreakerTransition) => {
    // The listener pages. A page that cannot be sent must never take the call
    // path down with it, and the listener logs its own failure.
    try {
      opts.onTransition?.(t);
    } catch {
      // swallow-ok: see above; the listener owns reporting its failures.
    }
  };

  const state = (): BreakerState => {
    if (openedAt === null) return "closed";
    return now() >= retryAt ? "half-open" : "open";
  };

  return {
    admit() {
      if (openedAt === null) return { probe: false };
      const t = now();
      if (t < retryAt) throw new GoogleBreakerOpenError(retryAt - t);
      // Half open: exactly one call in flight as the probe.
      if (probing) throw new GoogleBreakerOpenError(opts.openMs);
      probing = true;
      return { probe: true };
    },
    record(ticket, verdict, failure) {
      if (openedAt !== null) {
        // Only the probe speaks for an open breaker. A call admitted before it
        // opened says nothing about whether the outage is over.
        if (!ticket.probe) return;
        probing = false;
        if (verdict === "answered") {
          const openForMs = now() - openedAt;
          openedAt = null;
          failures = 0;
          announce({ to: "closed", openForMs });
        } else if (verdict === "failure") {
          retryAt = now() + opts.openMs;
        }
        return;
      }
      if (verdict === "answered") failures = 0;
      else if (verdict === "failure") {
        failures++;
        if (failures >= opts.threshold) {
          openedAt = now();
          retryAt = openedAt + opts.openMs;
          announce({ to: "open", failures, lastFailure: failure ?? null });
        }
      }
    },
    state,
    reset() {
      failures = 0;
      openedAt = null;
      retryAt = 0;
      probing = false;
    },
  };
}
