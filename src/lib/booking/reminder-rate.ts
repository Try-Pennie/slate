import {
  judgeFailureRate,
  pruneSamples,
  type CodeCount,
  type RateThresholds,
  type RateVerdict,
  type RateWindowState,
} from "@/lib/monitor/booking-failure-rate";

/**
 * A wave of reminder emails that did not go out, as distinct from one (#2496).
 *
 * ## The gap this fills
 *
 * `booking_reminder_failed` (#2359) names one booking and is throttled at six
 * hours, so one lead's refused address and EVERY reminder failing arrive as the
 * same single message at the same rate. Those send two different people to do two
 * different things: the first is one address to look at after the fact, the second
 * is a broken mailbox delegation or a Gmail outage that is costing every lead their
 * reminder right now. L77 is the rule: an error deliberately classified as expected
 * must still be counted against a RATE, or the systemic case stays invisible for as
 * long as it lasts.
 *
 * ## Why a window rather than the tick
 *
 * The lane runs every five minutes and reminders follow the bookings they belong
 * to, so a tick attempts a handful at peak and none at all through the night. A
 * share judged over one tick would be one of one for most of the day, which is a
 * number and not a measurement. So the samples accumulate into a rolling window,
 * exactly as `booking-failure-rate` does, and the SAME `judgeFailureRate` decides:
 * below the floor the window is `insufficient` and speaks in neither direction.
 *
 * The one structural difference from its sibling is where the numbers come from.
 * That check differences a cumulative daily counter somebody else writes, and so
 * needs rebase handling for the midnight reset. This lane MEASURES its own tick, so
 * a sample is the tick, and the day to date totals it keeps beside the window are
 * for a reader rather than for the arithmetic.
 *
 * No IO: the caller injects the window's storage and both Slack calls, so every
 * branch below is driven offline by `scripts/test-booking-reminder-rate.ts`.
 */

/** The alert_state key for the page and its all-clear. ONE constant, so the two can
 *  never drift onto different keys and leave a page nothing can clear. */
export const REMINDER_FAILURE_RATE_KEY = "booking_reminders_failing";

/**
 * Why a reminder did not go out, in a vocabulary small enough to be a MAP KEY.
 *
 * Keying the window on the provider's raw message would give one key per message,
 * so the "top reason" the page names would be whichever wording happened to repeat
 * (L131), and the map would grow without bound inside a jsonb column. These six are
 * the distinctions that change what somebody does about it.
 */
export type ReminderFailureCode =
  /** 401 / 403: the advisor's mailbox will not accept a send at all. Every reminder
   *  from that mailbox fails until the delegation is repaired. */
  | "not_authorised"
  /** 400: Gmail refused the message, which on this path is almost always the
   *  recipient. One lead, not a system. */
  | "recipient_refused"
  /** 429: we are sending faster than the mailbox is allowed to. */
  | "rate_limited"
  /** 5xx: Google. Usually self healing, and nothing here can fix it. */
  | "provider_unavailable"
  /** Our own refusal before any request: the message had nobody to go to. */
  | "no_recipients"
  /** Everything else, including a transport error with no status. Kept as its own
   *  code rather than folded into a neighbour, because a reader who is told "503"
   *  about a socket error looks at the wrong system. */
  | "unclassified";

/**
 * Classify a send failure by what its message can actually prove.
 *
 * `sendGmailEmail` throws `Gmail send failed: <status> <body>`, so the status is
 * the one machine readable fact available, and the body is deliberately NOT read
 * for keywords: matching English in a provider's prose is how a classifier starts
 * agreeing with whatever wording it was written against.
 *
 * Everything unrecognised is `unclassified` and still COUNTED. Dropping it would
 * shrink the numerator of the share this exists to measure, and a failure nobody
 * could categorise is exactly the kind worth seeing (L215).
 */
export function classifyReminderSendFailure(message: string): ReminderFailureCode {
  if (/no recipients/i.test(message)) return "no_recipients";
  const status = /\bfailed:\s*(\d{3})\b/.exec(message)?.[1];
  if (status === "401" || status === "403") return "not_authorised";
  if (status === "400") return "recipient_refused";
  if (status === "429") return "rate_limited";
  if (status && status.startsWith("5")) return "provider_unavailable";
  return "unclassified";
}

/** One tick's own measurement: what it tried, what failed, and why. */
export interface ReminderTick {
  /** Sends ATTEMPTED. A lead with no address was never attempted and is not here. */
  attempts: number;
  failures: number;
  /** The failures by `ReminderFailureCode`. Sums to `failures`. */
  byCode: Record<string, number>;
}

/**
 * Fold one tick into the window.
 *
 * A tick that attempted NOTHING writes no sample. It measured nothing, and the lane
 * has nothing to do for most of the day and all of the night, so a sample per tick
 * would fill the row with readings that say nothing while pushing real ones out of
 * an aged window that is supposed to hold four hours of them.
 *
 * The day to date counters restart at the ET day the caller passes, and the WINDOW
 * deliberately does not: those samples are still true on either side of midnight,
 * and emptying it at the rollover would blind the check for a whole window every
 * night, which is the shape of a detector that is quiet when it should speak.
 */
export function advanceReminderWindow(
  prev: RateWindowState | null,
  tick: ReminderTick,
  day: string,
  atMs: number,
  windowMs: number,
): RateWindowState {
  const sameDay = prev !== null && prev.day === day;
  const byCode: Record<string, number> = sameDay ? { ...prev.byCode } : {};
  for (const [code, n] of Object.entries(tick.byCode)) byCode[code] = (byCode[code] ?? 0) + n;

  const samples = pruneSamples(prev?.samples ?? [], atMs, windowMs);
  if (tick.attempts > 0) {
    samples.push({
      atMs,
      attempts: tick.attempts,
      failures: tick.failures,
      byCode: { ...tick.byCode },
    });
  }

  return {
    day,
    attempts: (sameDay ? prev.attempts : 0) + tick.attempts,
    failures: (sameDay ? prev.failures : 0) + tick.failures,
    byCode,
    samples,
  };
}

/**
 * The one sentence saying what to DO about the code that is failing most.
 *
 * Only the codes whose repair is not guessable from the name carry one, and the
 * empty default is deliberate rather than an omission (L111, and the same rule the
 * booking failure rate's `CODE_GUIDANCE` follows): a generic sentence bolted onto a
 * code that already speaks for itself says less than the code does.
 */
const CODE_GUIDANCE: Record<string, string> = {
  not_authorised:
    "not_authorised means the advisor's mailbox is refusing Slate outright, so every reminder " +
    "from it fails until the Workspace delegation is repaired.",
  recipient_refused:
    "recipient_refused means Gmail rejected the address on the booking, which is usually one " +
    "lead rather than a fault in the lane.",
  rate_limited:
    "rate_limited means the mailbox is being sent to faster than Google allows, so look at how " +
    "many reminders one advisor is carrying.",
};

/** "1 lead" / "3 leads": the count reads as a sentence either way. */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The top few codes as "not_authorised (24), unclassified (1)". */
function codeList(codes: CodeCount[]): string {
  return codes
    .slice(0, 3)
    .map((c) => `${c.code} (${c.count})`)
    .join(", ");
}

/**
 * The page.
 *
 * It says what it MEASURED, over what window, and what is failing, because that is
 * what separates it from the per booking incident beside it: a reader who has both
 * needs to know at a glance whether this is one address or the whole roster. It
 * points at where the detail lives rather than pasting any of it (#1133), and it
 * does not open with the word Slate, which every one of these already carries in
 * the Slack app's own name.
 */
export function formatReminderFailureRateAlert(input: {
  attempts: number;
  failures: number;
  pct: number;
  windowMinutes: number;
  topCodes: CodeCount[];
}): string {
  const codes = codeList(input.topCodes);
  const naming = codes ? ` Failing with: ${codes}.` : "";
  const top = input.topCodes[0]?.code;
  const guidance = top && CODE_GUIDANCE[top] ? ` ${CODE_GUIDANCE[top]}` : "";
  return (
    `${input.failures} of ${input.attempts} reminder emails did not go out in the last ` +
    `${input.windowMinutes} minutes (${input.pct}%), leaving ${plural(input.failures, "lead")} ` +
    `with no reminder of their call and none coming: a failed send is deliberately not ` +
    `retried, because a retry can deliver a second copy.${naming}${guidance} ` +
    `The per booking detail is in the booking-reminder log lines.`
  );
}

/** The all-clear. Hung off a MEASURED healthy window, never off a quiet tick, so it
 *  can only ever say something the check actually observed. */
export function formatReminderFailureRateAllClear(input: {
  attempts: number;
  failures: number;
  pct: number;
  windowMinutes: number;
}): string {
  return (
    `Reminder emails are going out again: ${input.failures} of ${input.attempts} attempts ` +
    `failed in the last ${input.windowMinutes} minutes (${input.pct}%).`
  );
}

export type ReminderRateResult =
  /** The window could not be read, so this tick claims nothing in either direction.
   *  Deliberately NOT folded into an empty window scored as zero failures. */
  | { status: "unverified"; why: "state" }
  | { status: "checked"; verdict: RateVerdict; state: RateWindowState };

/**
 * Measure this tick, judge the window, and decide whether a human hears about it.
 *
 * Fail soft throughout, and that is not a stylistic preference: this runs INSIDE the
 * lane that sends real email to real leads, so a flaky Slack or a failed state write
 * must never be able to stop the reminders. Every soft failure is still reported
 * through `onError`, because a caught error that reaches no sink is invisible twice
 * (L13).
 *
 * The all-clear hangs off a MEASURED healthy verdict, never off "we did not page
 * this tick", which is also true of every tick that could not measure (#1134).
 */
export async function runReminderFailureRateCheck(deps: {
  nowMs: number;
  /** The ET day the day to date counters belong to. */
  day: string;
  tick: ReminderTick;
  thresholds: RateThresholds;
  cooldownMs: number;
  /** THROWS on a read error, which is why "no window yet" and "could not read the
   *  window" stay distinct outcomes rather than both arriving as an empty one. */
  loadState: () => Promise<RateWindowState | null>;
  saveState: (state: RateWindowState) => Promise<void>;
  notify: (key: string, cooldownMs: number, text: string) => Promise<void>;
  resolve: (key: string, text: string) => Promise<boolean>;
  /** Structurally the log helper's field shape, spelled out rather than imported so
   *  this module keeps no dependency on the logger. */
  log?: (fields: Record<string, string | number | boolean | null | undefined>) => void;
  onError?: (context: "saveState" | "notify" | "resolve", err: unknown) => void;
}): Promise<ReminderRateResult> {
  let prev: RateWindowState | null;
  try {
    prev = await deps.loadState();
  } catch {
    // Nothing is written and nothing is said. An empty window here is
    // indistinguishable from a healthy one, so guessing either way would report a
    // share nobody measured, and OVERWRITING it would destroy the real one.
    deps.log?.({ msg: "reminder failure rate unverified", why: "state unreadable" });
    return { status: "unverified", why: "state" };
  }

  const windowMinutes = Math.round(deps.thresholds.windowMs / 60_000);
  const state = advanceReminderWindow(
    prev,
    deps.tick,
    deps.day,
    deps.nowMs,
    deps.thresholds.windowMs,
  );
  // Persist BEFORE notifying: a hung Slack must not cost us the window.
  await deps.saveState(state).catch((err) => deps.onError?.("saveState", err));
  const verdict = judgeFailureRate(state, deps.nowMs, deps.thresholds);

  deps.log?.({
    msg: "reminder failure rate",
    status: verdict.status,
    window_min: windowMinutes,
    attempts: verdict.attempts,
    failures: verdict.failures,
    pct: verdict.status === "insufficient" ? null : verdict.pct,
    top_code: verdict.status === "insufficient" ? null : (verdict.topCodes[0]?.code ?? null),
  });

  if (verdict.status === "breach") {
    await deps
      .notify(
        REMINDER_FAILURE_RATE_KEY,
        deps.cooldownMs,
        formatReminderFailureRateAlert({ ...verdict, windowMinutes }),
      )
      .catch((err) => deps.onError?.("notify", err));
  }
  if (verdict.status === "healthy") {
    await deps
      .resolve(
        REMINDER_FAILURE_RATE_KEY,
        formatReminderFailureRateAllClear({ ...verdict, windowMinutes }),
      )
      .catch((err) => deps.onError?.("resolve", err));
  }
  return { status: "checked", verdict, state };
}
