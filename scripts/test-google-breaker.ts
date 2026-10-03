// The Google Calendar circuit breaker (#3134): the state machine and what counts as
// a failure. Pure, with an injected clock, so every transition is driven without a
// network or a real timer.
//
// The controls that matter: it must NOT open on one call short of the threshold, a
// definitive per agent refusal (a revoked delegation, an account never given
// Calendar) must never count toward an outage, a call cut short by the CONFIRM's
// budget rather than its own deadline must not count either, and the all-clear must
// come only from a probe Google actually answered.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-google-breaker.ts
import {
  createCircuitBreaker,
  googleBreakerVerdictFromError,
  googleBreakerVerdictFromStatus,
  GoogleBreakerOpenError,
  GOOGLE_BREAKER_THRESHOLD,
  GOOGLE_BREAKER_OPEN_MS,
  type BreakerTransition,
} from "../src/lib/google/breaker.ts";
import { GoogleHttpError } from "../src/lib/google/http-error.ts";
import { DeadlineExceededError } from "../src/lib/fetch-within-deadline.ts";
import { assert, finish } from "./lib/harness.ts";

function rig(threshold = 3, openMs = 1000) {
  let t = 10_000;
  const transitions: BreakerTransition[] = [];
  const breaker = createCircuitBreaker({
    threshold,
    openMs,
    now: () => t,
    onTransition: (tr) => transitions.push(tr),
  });
  return {
    breaker,
    transitions,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function refuses(fn: () => unknown): GoogleBreakerOpenError | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof GoogleBreakerOpenError ? err : null;
  }
}

// --- the threshold, both sides of it ---------------------------------------
{
  const { breaker, transitions } = rig(3);
  for (let i = 0; i < 2; i++) breaker.record(breaker.admit(), "failure", "503 backendError");
  assert(breaker.state() === "closed", "two failures under a threshold of three leave it closed");
  assert(transitions.length === 0, "and announce nothing");
  assert(refuses(() => breaker.admit()) === null, "and still admit a call");
  breaker.record(breaker.admit(), "failure", "503 backendError");
  assert(breaker.state() === "open", "the third consecutive failure opens it");
  assert(
    transitions.length === 1 && transitions[0].to === "open" && transitions[0].failures === 3,
    "and announces the open once, with the streak that opened it",
  );
  assert(
    transitions[0].to === "open" && transitions[0].lastFailure === "503 backendError",
    "naming the last failure it saw",
  );
}

// --- an answer resets the streak, a neutral outcome neither counts nor resets -
{
  const { breaker } = rig(3);
  breaker.record(breaker.admit(), "failure", "x");
  breaker.record(breaker.admit(), "failure", "x");
  breaker.record(breaker.admit(), "answered");
  breaker.record(breaker.admit(), "failure", "x");
  breaker.record(breaker.admit(), "failure", "x");
  assert(breaker.state() === "closed", "an answer in between means the failures were not consecutive");
  breaker.record(breaker.admit(), "neutral");
  assert(breaker.state() === "closed", "a neutral outcome does not count toward the threshold");
  breaker.record(breaker.admit(), "failure", "x");
  assert(breaker.state() === "open", "and does not reset the streak either");
}

// --- open: refuse at once, then admit exactly one probe -----------------------
{
  const { breaker, transitions, advance } = rig(2, 1000);
  breaker.record(breaker.admit(), "failure", "x");
  breaker.record(breaker.admit(), "failure", "x");
  const refused = refuses(() => breaker.admit());
  assert(refused !== null, "an open breaker refuses a call before it is sent");
  assert(refused !== null && refused.retryAfterMs === 1000, "and says how long until it tries again");
  advance(999);
  assert(refuses(() => breaker.admit()) !== null, "still refusing one millisecond before the window ends");
  advance(1);
  const probe = breaker.admit();
  assert(probe.probe, "the first call after the window is the probe");
  assert(refuses(() => breaker.admit()) !== null, "a second call while the probe is in flight is refused");

  breaker.record(probe, "failure", "still 503");
  assert(breaker.state() === "open", "a failed probe re-opens it");
  assert(transitions.length === 1, "without announcing a second open: it is the same outage");
  advance(1000);
  const neutral = breaker.admit();
  breaker.record(neutral, "neutral");
  assert(breaker.state() === "half-open", "a probe that measured nothing hands the probe slot back");
  assert(transitions.length === 1, "and announces nothing, because nothing was measured");
  const next = breaker.admit();
  assert(next.probe, "so the next call becomes the probe");
  advance(250);
  breaker.record(next, "answered");
  assert(breaker.state() === "closed", "a probe Google answered closes it");
  assert(
    transitions.length === 2 && transitions[1].to === "closed" && transitions[1].openForMs === 2250,
    "and announces the close with how long calls were held back",
  );
  assert(refuses(() => breaker.admit()) === null, "and calls flow again");
}

// --- a late answer from a call admitted before the open cannot close it ------
{
  const { breaker, transitions } = rig(2);
  const early = breaker.admit();
  breaker.record(breaker.admit(), "failure", "x");
  breaker.record(breaker.admit(), "failure", "x");
  breaker.record(early, "answered");
  assert(breaker.state() === "open", "only the probe may close an open breaker");
  assert(transitions.length === 1, "so no all-clear is announced off a call that predates the outage");
}

// --- a throwing listener never breaks the call path --------------------------
{
  const breaker = createCircuitBreaker({
    threshold: 1,
    openMs: 10,
    now: () => 0,
    onTransition: () => {
      throw new Error("listener blew up");
    },
  });
  let threw = false;
  try {
    breaker.record(breaker.admit(), "failure", "x");
  } catch {
    threw = true;
  }
  assert(!threw && breaker.state() === "open", "a listener that throws does not stop the breaker opening");
}

// --- what counts as a failure: HTTP answers ----------------------------------
for (const status of [500, 502, 503, 504, 429]) {
  assert(googleBreakerVerdictFromStatus(status) === "failure", `${status} counts toward an outage`);
}
for (const status of [200, 204, 400, 401, 403, 404, 409, 410, 412]) {
  assert(
    googleBreakerVerdictFromStatus(status) === "answered",
    `${status} is Google answering, never an outage (a 409 reuse, a 404 gone event, a 410 expired token)`,
  );
}

// --- what counts as a failure: thrown errors ---------------------------------
assert(
  googleBreakerVerdictFromError(new TypeError("fetch failed")) === "failure",
  "a network error counts toward an outage",
);
assert(
  googleBreakerVerdictFromError(new DeadlineExceededError("google freeBusy", 8000)) === "failure",
  "the call's own deadline counts toward an outage",
);
assert(
  googleBreakerVerdictFromError(
    new DeadlineExceededError("google token mint", 3000, { label: "google freeBusy", totalMs: 8000 }),
    "freeBusy",
  ) === "failure",
  "a hung token mint inside the call's own budget counts too",
);
assert(
  googleBreakerVerdictFromError(
    new DeadlineExceededError("google freeBusy", 0, { label: "booking confirm", totalMs: 12000 }),
    "freeBusy",
  ) === "neutral",
  "a call cut short by the CONFIRM's budget says nothing about Google, so it is neutral",
);
assert(
  googleBreakerVerdictFromError(new GoogleHttpError("mint failed: 503", 503)) === "failure",
  "a 5xx token mint counts toward an outage",
);
assert(
  googleBreakerVerdictFromError(new GoogleHttpError("mint failed: 403", 403, "rateLimitExceeded")) ===
    "failure",
  "a rate limited mint is transient, so it counts",
);
assert(
  googleBreakerVerdictFromError(new GoogleHttpError("mint failed: 401", 401, "unauthorized_client")) ===
    "answered",
  "one agent's revoked delegation is definitive and per agent: Google answered",
);
assert(
  googleBreakerVerdictFromError(new GoogleHttpError("403", 403, "notACalendarUser")) === "answered",
  "an account never given Calendar is definitive too, never an outage",
);
assert(
  googleBreakerVerdictFromError(new GoogleBreakerOpenError(1000)) === "neutral",
  "a refusal by the breaker itself is not a new failure",
);

// --- the shipped constants ---------------------------------------------------
assert(GOOGLE_BREAKER_THRESHOLD >= 3, "the shipped threshold is not a hair trigger");
assert(GOOGLE_BREAKER_OPEN_MS > 0 && GOOGLE_BREAKER_OPEN_MS <= 60_000, "the shipped window retries within a minute");

finish();
