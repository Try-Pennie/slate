/**
 * The address Slate SAW, echoed back to a load run (#2243). Off everywhere else.
 *
 * A booking path load run has to attribute its write 429s, and the per address
 * ceiling is keyed on `cf-connecting-ip`. The runner cannot work that out for
 * itself: a CI runner sits behind egress NAT, so it shares an address with
 * everything else on that host, and a run that assumed its own address would
 * report the limiter refusing IT when something else had spent the budget.
 *
 * Gated ENTIRELY behind `SLATE_LOADTEST`, exactly as the Google stub is. Echoing a
 * caller's address back is a small disclosure and it has no business on a
 * production response, so the gate is the feature: with the flag unset this adds
 * a header to nothing.
 */
import { LOADTEST } from "@/lib/google/loadtest-stub";
import { clientIp } from "@/lib/rate-limit-core";

export const SEEN_IP_HEADER = "x-loadtest-seen-ip";

/**
 * Stamp the header on a response, and return the SAME response so a call site can
 * wrap a return without restructuring it.
 *
 * It reads the address through `clientIp`, the same function the limiter keys on,
 * rather than reading the header itself: two readings of one fact would be free to
 * disagree, and the disagreement would be invisible precisely when somebody is
 * using this to explain a refusal (L70).
 */
export function stampSeenIp<T extends Response>(res: T, headers: Headers): T {
  if (!LOADTEST) return res;
  try {
    res.headers.set(SEEN_IP_HEADER, clientIp(headers));
  } catch {
    // An immutable response head is not worth failing a booking over: the run loses
    // one attribution and the booking is unaffected.
  }
  return res;
}

/** The header the refusal's own classification is echoed on. */
export const REFUSED_BY_HEADER = "x-loadtest-refused-by";

/**
 * Stamp WHICH ceiling refused (#2339), and return the SAME response.
 *
 * The per key ceiling and the per address one answer with the same status through
 * the same refusal, so from outside the deployment a 429 says only that something
 * refused. A load run whose whole purpose is to prove the per ADDRESS ceiling
 * would count a per key refusal as proof of it, and pass a bar the ceiling it was
 * measuring never met (L11).
 *
 * The reason is the one the authorizer already classified, passed in rather than
 * re-derived here: two readings of one decision are free to disagree, and the
 * disagreement would be invisible exactly when somebody is using this to explain a
 * refusal (L70).
 *
 * Gated behind `SLATE_LOADTEST` like the address echo. Which of our ceilings a
 * caller met is our own shaping, and telling an unknown caller that has no place
 * on a production response.
 */
export function stampRefusedBy<T extends Response>(res: T, reason: string): T {
  if (!LOADTEST) return res;
  try {
    res.headers.set(REFUSED_BY_HEADER, reason);
  } catch {
    // Same reading as the address echo: the run loses one attribution and the
    // refusal it is attached to is unaffected.
  }
  return res;
}

// ---------------------------------------------------------------------------------
// The shared confirm line, echoed to a load run (#3325).
//
// The load run's burst has to know WHICH confirm line served each confirm, and when
// the deployment built each answer, because those are the two things the burst
// clauses judge: every burst confirm took the shared line, and every SLOT_TAKEN was
// answered within a bound of the last winner. Neither is visible from outside: a
// SLOT_TAKEN reads the same whichever line produced it, and the four runners' clocks
// disagree with each other and with the deployment's.
//
// ONE definition, imported by both sides (L41): the deployment writes through the
// builders below, and the driver reads through `readLoadtestEcho`. Gated behind
// `SLATE_LOADTEST` like the address echo, because which line a caller met is our own
// shaping and has no business on a production response.
// ---------------------------------------------------------------------------------

/** Which line served the confirm: `shared`, `isolate` or `fallback`. */
export const CONFIRM_LINE_HEADER = "x-loadtest-confirm-line";
/** Why it was that line. */
export const CONFIRM_LINE_REASON_HEADER = "x-loadtest-confirm-line-reason";
/** Which kind of key the line was entered under. */
export const CONFIRM_LINE_KEY_HEADER = "x-loadtest-confirm-line-key";
/** Whole milliseconds the confirm spent in calls to the line. */
export const CONFIRM_LINE_MS_HEADER = "x-loadtest-confirm-line-ms";
/** The deployment's own epoch milliseconds when it built the response. */
export const ANSWERED_AT_HEADER = "x-loadtest-answered-at";

export const CONFIRM_LINES = ["shared", "isolate", "fallback"] as const;
export type ConfirmLine = (typeof CONFIRM_LINES)[number];

export const CONFIRM_LINE_REASONS = [
  "ok",
  "off",
  "unread-default",
  "unbound",
  "reach-timeout",
  "enter-error",
  "gone",
  "bad-answer",
  "abandoned",
] as const;
export type ConfirmLineReason = (typeof CONFIRM_LINE_REASONS)[number];

export const CONFIRM_LINE_KEYS = ["ladder", "code", "link", "none"] as const;
export type ConfirmLineKey = (typeof CONFIRM_LINE_KEYS)[number];

/** What the deployment says about the line one confirm took. */
export interface ConfirmLineEcho {
  line: ConfirmLine;
  reason: ConfirmLineReason;
  key: ConfirmLineKey;
  /** Time spent in calls to the line, in milliseconds. */
  lineMs: number;
}

/**
 * The header pairs for one confirm's line, the one way they are written.
 *
 * A time that is not a finite, non negative number is LEFT OFF rather than written
 * as a zero, so the run reads it as absent: a zero is the cheapest possible reading
 * and would pull every percentile down while looking like a measurement (L90).
 */
export function confirmLineEchoHeaders(echo: ConfirmLineEcho): [string, string][] {
  const out: [string, string][] = [
    [CONFIRM_LINE_HEADER, echo.line],
    [CONFIRM_LINE_REASON_HEADER, echo.reason],
    [CONFIRM_LINE_KEY_HEADER, echo.key],
  ];
  if (Number.isFinite(echo.lineMs) && echo.lineMs >= 0) {
    out.push([CONFIRM_LINE_MS_HEADER, String(Math.round(echo.lineMs))]);
  }
  return out;
}

/** The answer stamp's header pair, in whole epoch milliseconds. */
export function answeredAtEchoHeader(nowMs: number): [string, string] {
  return [ANSWERED_AT_HEADER, String(Math.trunc(nowMs))];
}

/**
 * Stamp the line one confirm took (#3325), and return the SAME response.
 *
 * Off everywhere but a load test deployment, exactly like the address echo. An
 * immutable head loses the run one attribution and never the booking.
 */
export function stampConfirmLine<T extends Response>(res: T, echo: ConfirmLineEcho): T {
  if (!LOADTEST) return res;
  try {
    for (const [name, value] of confirmLineEchoHeaders(echo)) res.headers.set(name, value);
  } catch {
    // The booking is unaffected; the run reads this confirm's line as not said.
  }
  return res;
}

/**
 * Stamp when the deployment built the response (#3325), and return the SAME response.
 *
 * The burst's speed clause compares every SLOT_TAKEN against the last winner, and
 * four runners' clocks cannot answer that: they disagree with each other by more
 * than the bound being judged. One clock, the deployment's, can. A Worker's clock
 * reads the time of its last I/O, and a response is built straight after the read or
 * the write that decided it, so the stamp is the moment the answer was settled.
 */
export function stampAnsweredAt<T extends Response>(res: T, nowMs: number = Date.now()): T {
  if (!LOADTEST) return res;
  try {
    const [name, value] = answeredAtEchoHeader(nowMs);
    res.headers.set(name, value);
  } catch {
    // Same reading as the address echo: the run loses one stamp, which its judge
    // reports as unmeasured, and the booking is unaffected.
  }
  return res;
}

/**
 * One echoed field as the run reads it. Three states, never two: a header the
 * deployment did not send (it predates the line, or the flag is off) and one it sent
 * with a value this contract does not know are different facts, and neither may
 * read as a value (L11, L90).
 */
export type EchoField<T> =
  | { state: "absent" }
  | { state: "unreadable"; raw: string }
  | { state: "read"; value: T };

/** Everything the deployment echoed about one booking response. */
export interface LoadtestEcho {
  line: EchoField<ConfirmLine>;
  reason: EchoField<ConfirmLineReason>;
  key: EchoField<ConfirmLineKey>;
  lineMs: EchoField<number>;
  answeredAtMs: EchoField<number>;
}

/** Anything with a `get`, so a fetch Response's headers and a test's Headers both fit. */
interface HeaderSource {
  get(name: string): string | null;
}

function oneOf<T extends string>(raw: string | null, allowed: readonly T[]): EchoField<T> {
  if (raw === null) return { state: "absent" };
  const v = raw.trim();
  return (allowed as readonly string[]).includes(v) ? { state: "read", value: v as T } : { state: "unreadable", raw: v };
}

/** Whole, non negative milliseconds, or positive ones when `positive` is set. */
function wholeMs(raw: string | null, positive: boolean): EchoField<number> {
  if (raw === null) return { state: "absent" };
  const v = raw.trim();
  if (!/^\d+$/.test(v)) return { state: "unreadable", raw: v };
  const n = Number(v);
  if (!Number.isSafeInteger(n) || (positive && n === 0)) return { state: "unreadable", raw: v };
  return { state: "read", value: n };
}

/**
 * Read every echo the deployment sent on one response, the one way it is read.
 *
 * An epoch stamp of zero is unreadable rather than 1970: no deployment answered then,
 * and a zero that parsed would land every comparison on the healthy side.
 */
export function readLoadtestEcho(headers: HeaderSource): LoadtestEcho {
  return {
    line: oneOf(headers.get(CONFIRM_LINE_HEADER), CONFIRM_LINES),
    reason: oneOf(headers.get(CONFIRM_LINE_REASON_HEADER), CONFIRM_LINE_REASONS),
    key: oneOf(headers.get(CONFIRM_LINE_KEY_HEADER), CONFIRM_LINE_KEYS),
    lineMs: wholeMs(headers.get(CONFIRM_LINE_MS_HEADER), false),
    answeredAtMs: wholeMs(headers.get(ANSWERED_AT_HEADER), true),
  };
}
