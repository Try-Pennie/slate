// The load driver resends a request whose connection dropped, once, as the booker does (#3566).
//
// Run 24 (38667918857) failed on one request whose fetch threw `TypeError` after 25ms
// and never reached the Worker, the second such failure in about twenty four runs.
// A lead's booker now sends a dropped confirm once more by itself, so the driver does
// the same and the run measures what a lead meets. What the driver records has to keep
// the evidence: which request was resent, why its first send failed (the cause, not
// just `TypeError`), and the time from the FIRST send, since that is what the lead
// waited.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-loadtest-resend.ts
import {
  afterResend,
  burstSettleAtMs,
  droppedAttempt,
  sendBoundMs,
  transportOutcome,
  BURST_GRACE_DEFAULT_MS,
  REQUEST_TIMEOUT_MS,
  type BookingAttempt,
} from "./loadtest/book-plan.ts";
import { NO_SLOTS_OFFERED, TIMED_OUT, AVAILABILITY_UNREAD } from "./loadtest/outcomes.ts";
import { assert, eq, finish } from "./lib/harness.ts";

function attempt(over: Partial<BookingAttempt> = {}): BookingAttempt {
  return {
    driver: 1,
    n: 131,
    code: "212",
    externalId: "run-1-1-1-131",
    sentAtMs: 1_000,
    wallMs: 25,
    status: 0,
    outcome: "transport: TypeError",
    startIso: "2026-10-16T15:30:00.000Z",
    seenIp: null,
    echo: null,
    ...over,
  };
}

// --- the cause of a transport failure is kept, not just its name ---------------------
{
  // undici's shape: `fetch failed` with the socket's own error on `cause`.
  const reset = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
  });
  assert(
    transportOutcome(reset) === "transport: TypeError (UND_ERR_SOCKET)",
    `a failure carrying a coded cause names the code (got ${transportOutcome(reset)})`,
  );
  const dns = Object.assign(new TypeError("fetch failed"), { cause: new Error("getaddrinfo ENOTFOUND host") });
  assert(
    transportOutcome(dns) === "transport: TypeError (getaddrinfo ENOTFOUND host)",
    `a cause with no code names its message (got ${transportOutcome(dns)})`,
  );
  assert(
    transportOutcome(new TypeError("fetch failed")) === "transport: TypeError",
    "a failure with no cause is named as before, so the judge's reading of it is unchanged",
  );
  const long = Object.assign(new TypeError("x"), { cause: new Error("y".repeat(500)) });
  assert(transportOutcome(long).length <= 140, "and a long cause is cut short, so one record cannot bloat the report");
}

// --- only a request that got no reply of any kind counts as dropped -------------------
{
  assert(droppedAttempt(attempt()), "a transport failure is a dropped request");
  assert(droppedAttempt(attempt({ outcome: "transport: TypeError (UND_ERR_SOCKET)" })), "with or without its cause");
  for (const outcome of [TIMED_OUT, NO_SLOTS_OFFERED, AVAILABILITY_UNREAD]) {
    assert(!droppedAttempt(attempt({ outcome })), `${outcome} is not a dropped request, so it is never resent`);
  }
  assert(!droppedAttempt(attempt({ status: 500, outcome: "INTERNAL" })), "an answer, even a 500, is not dropped");
}

// --- what is recorded after a resend --------------------------------------------------
{
  const first = attempt({ sentAtMs: 1_000, wallMs: 25, outcome: "transport: TypeError (UND_ERR_SOCKET)" });
  const second = attempt({ sentAtMs: 1_530, wallMs: 700, status: 200, outcome: "created", seenIp: "1.2.3.4" });
  const r = afterResend({ result: second, firstFailure: first });
  assert(r.status === 200 && r.outcome === "created" && r.seenIp === "1.2.3.4", "the resend's answer is the record");
  assert(r.sentAtMs === 1_000, "timed from the FIRST send, since that is when the lead pressed");
  assert(r.wallMs === 1_230, `and its wall time covers both sends and the pause (got ${r.wallMs})`);
  assert(r.resentAfter === "transport: TypeError (UND_ERR_SOCKET)", "and it says it was resent, and why");

  const untouched = afterResend({ result: second, firstFailure: null });
  assert(untouched === second && !("resentAfter" in untouched), "a request answered first time is recorded exactly as before");

  const twice = afterResend({ result: attempt({ sentAtMs: 1_530, wallMs: 30 }), firstFailure: first });
  assert(twice.status === 0 && twice.resentAfter !== undefined, "a request that dropped twice is still unanswered, and resent");
}


// --- a resend lives inside the FIRST send's abort bound, never a fresh one -------------
// Every burst window (when its slot is probed, when the tail stops, how long the job
// runs) is derived from one request's bound past the latest a driver may fire. A resend
// with a fresh bound could still be in flight after the probe asked whether the slot was
// taken. So both sends of a request share one abort instant, and the windows hold by
// construction rather than by being widened.
{
  const moment = 1_000_000;
  const firedAt = moment + BURST_GRACE_DEFAULT_MS; // the latest a burst driver may fire
  const abortAt = firedAt + REQUEST_TIMEOUT_MS;
  eq(sendBoundMs(abortAt, firedAt), REQUEST_TIMEOUT_MS, "the first send gets the whole bound, as before");
  for (const resentAt of [firedAt + 525, firedAt + 10_000, firedAt + 29_000]) {
    const end = resentAt + sendBoundMs(abortAt, resentAt);
    assert(
      end <= burstSettleAtMs(moment, BURST_GRACE_DEFAULT_MS, REQUEST_TIMEOUT_MS),
      `a resend at +${resentAt - firedAt}ms is over before the burst settles (ends ${end - moment}ms after the moment)`,
    );
  }
  eq(sendBoundMs(abortAt, abortAt + 5), 1, "a resend with no time left gets the 1ms floor, never a zero or negative bound");
}

finish();
