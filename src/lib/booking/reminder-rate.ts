import {
  judgeFailureRate,
  pruneSamples,
  type CodeCount,
  type RateThresholds,
  type RateVerdict,
  type RateWindowState,
} from "@/lib/monitor/booking-failure-rate";
import type { AlertResolve, ThrottledNotify } from "@/lib/monitor/alert-deps";
import { asEmailSendError } from "@/lib/notify/email-errors";
import { reminderEmailLabel } from "./reminder-template.ts";

/**
 * A wave of reminder emails that did not go out, as distinct from one (#2496).
 *
 * ## The gap this fills
 *
 * `booking_reminder_failed:<id>` (#2359) names one booking. It was once a single
 * key throttled at six hours, so one lead's refused address and EVERY reminder
 * failing arrived as the same single message at the same rate; it is keyed per
 * booking now (2026-10-05), so a wave arrives as one page per lead, which says no
 * more about its size. Those send two different people to do two different
 * things: the first is one address to look at after the fact, the second
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
 * (L131), and the map would grow without bound inside a jsonb column. These are
 * the distinctions that change what somebody does about it.
 */
export type ReminderFailureCode =
  /** 401 / 403 from Gmail, or any 4xx from the token endpoint: the advisor's mailbox
   *  will not accept a send at all. Every reminder from that mailbox fails until the
   *  delegation is repaired. */
  | "not_authorised"
  /** The delegated token could not be had for a reason other than Google refusing
   *  the grant: the mint timed out, the token endpoint answered 429 or 5xx or could
   *  not be reached, or the request could not be built or signed. The token is
   *  minted before the POST, so nothing reached Gmail (2026-10-05). */
  | "token_unavailable"
  /** 400: Gmail refused the message, which on this path is almost always the
   *  recipient. One lead, not a system. */
  | "recipient_refused"
  /** 429, or a 403 whose reason is a rate limit (#917): we are sending faster than
   *  the mailbox is allowed to. */
  | "rate_limited"
  /** 5xx: Google. Usually self healing, and nothing here can fix it. */
  | "provider_unavailable"
  /** Our own refusal before any request: the message had nobody to go to. */
  | "no_recipients"
  /** Everything else, including a transport error with no status. Kept as its own
   *  code rather than folded into a neighbour, because a reader who is told "503"
   *  about a socket error looks at the wrong system. */
  | "unclassified";

/** A Gmail POST status as a code. Shared by the typed and the message paths so the
 *  two can never disagree about what a status means. */
function codeForGmailStatus(status: number | null): ReminderFailureCode {
  if (status === 401 || status === 403) return "not_authorised";
  if (status === 400) return "recipient_refused";
  if (status === 429) return "rate_limited";
  if (status !== null && status >= 500 && status < 600) return "provider_unavailable";
  return "unclassified";
}

/** A token endpoint status as a code: a 4xx other than 429 is the grant being
 *  refused, which is the delegation, and anything that can pass is transient. */
function codeForTokenStatus(status: number): ReminderFailureCode {
  return status === 429 || status >= 500 ? "token_unavailable" : "not_authorised";
}

/**
 * Classify a send failure by what it can actually prove.
 *
 * A typed `EmailSendError` is read first: its stage says whether the failure was the
 * token or the POST, which the incident's mint timeout needed and its message could
 * not say. A plain Error (or a bare message) falls back to the message, which
 * `sendGmailEmail` writes as `Gmail send failed: <status> <body>`, so the status is
 * the one machine readable fact; the body is deliberately NOT read for keywords,
 * because matching English in a provider's prose is how a classifier starts agreeing
 * with whatever wording it was written against. The two mint sentences it does
 * recognise are Slate's own (`dwd.ts`), not a provider's.
 *
 * Everything unrecognised is `unclassified` and still COUNTED. Dropping it would
 * shrink the numerator of the share this exists to measure, and a failure nobody
 * could categorise is exactly the kind worth seeing (L215).
 */
export function classifyReminderSendFailure(err: unknown): ReminderFailureCode {
  const typed = asEmailSendError(err);
  if (typed) {
    if (typed.stage === "compose") {
      return /no recipients/i.test(typed.message) ? "no_recipients" : "unclassified";
    }
    if (typed.stage === "token") {
      if (typed.status !== null) return codeForTokenStatus(typed.status);
      return typed.transient ? "token_unavailable" : "unclassified";
    }
    // A 403 Gmail marked as a rate limit is not the delegation; `sendGmailEmail`
    // read its reason and said so by calling it transient.
    if (typed.status === 403 && typed.transient) return "rate_limited";
    return codeForGmailStatus(typed.status);
  }
  const message = typeof err === "string" ? err : err instanceof Error ? err.message : String(err ?? "");
  if (/no recipients/i.test(message)) return "no_recipients";
  if (/google token mint did not answer/i.test(message)) return "token_unavailable";
  const mintStatus = /Delegated token failed for .*?: (\d{3})\b/.exec(message)?.[1];
  if (mintStatus) return codeForTokenStatus(Number(mintStatus));
  const status = /\bfailed:\s*(\d{3})\b/.exec(message)?.[1];
  return codeForGmailStatus(status ? Number(status) : null);
}

/** One tick's own measurement: what it tried, what failed, and why. */
export interface ReminderTick {
  /** Sends ATTEMPTED. A lead with no address was never attempted and is not here. */
  attempts: number;
  failures: number;
  /** The failures by `ReminderFailureCode`. Sums to `failures`. */
  byCode: Record<string, number>;
  /**
   * The failures whose claim was RELEASED to be tried again next tick, by booking
   * id, with the code each failed with. Already counted in `failures` and `byCode`.
   * Carried so the window can count one booking once however many ticks retry it.
   */
  retried?: Record<string, string>;
  /**
   * How each booking this tick attempted and did NOT hand back ended: `sent`, or
   * `kept` (failed with its claim kept). Only the entries for bookings handed back
   * earlier in the window are stored, which is what lets the judge stop counting a
   * retried booking once it has gone out or been given up.
   */
  settled?: Record<string, ReminderSettlement>;
  /**
   * The tick's sends split by email slug (#4300). Inside the totals above, never added
   * to them, so the combined share reads exactly what it did before.
   */
  byEmail?: Record<string, ReminderEmailTick>;
  /** Every stored email's name by slug, so a per email page names the email (#4300). */
  emailNames?: Record<string, string>;
  /**
   * The slugs switched on this tick, measured from the lane's read of `reminder_emails`
   * (which throws rather than answering empty). An open per email page for any other
   * slug is ended as a stand down (#4300). Absent means not known, which ends nothing.
   */
  enabledSlugs?: string[];
}

/** How an attempted booking that was not handed back ended. */
export type ReminderSettlement = "sent" | "kept";

/** One email's share of a tick (#4300). */
export interface ReminderEmailTick {
  attempts: number;
  failures: number;
  byCode: Record<string, number>;
}

/**
 * The key one send carries in the failure share's window: the bare id for the 24 hour
 * email and `hour:<id>` for the 1 hour email, as they always have (#4282), and
 * `<slug>:<id>` for any other, so one booking's emails are separate attempts.
 *
 * Defined HERE, beside its inverse `reminderShareKeySlug`, so the per email judgement
 * reads the key by the same rule that wrote it (`reminder-send.ts` re-exports it).
 */
export function reminderShareKey(bookingId: string, slug: string): string {
  return slug === "day" ? bookingId : `${slug}:${bookingId}`;
}

/**
 * Which email a share key belongs to: the part before the first colon, or `day` for a
 * bare id. A booking id is a uuid and holds no colon, and a slug is `[a-z][a-z0-9_]*`
 * (migration 0211), so the split is unambiguous.
 */
export function reminderShareKeySlug(key: string): string {
  const at = key.indexOf(":");
  return at < 0 ? "day" : key.slice(0, at);
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
    const retried = tick.retried && Object.keys(tick.retried).length > 0 ? { ...tick.retried } : null;
    // Only the bookings some live sample handed back. Every other settlement is
    // already said by the counts, and storing it would grow the row by every
    // booking sent in four hours for nothing the judge reads.
    const handedBack = new Set(samples.flatMap((s) => Object.keys(s.retried ?? {})));
    const settledEntries = Object.entries(tick.settled ?? {}).filter(([id]) => handedBack.has(id));
    const settled = settledEntries.length > 0 ? Object.fromEntries(settledEntries) : null;
    // Only the emails that attempted a send: an email that tried nothing measured
    // nothing this tick, and the row stays one small entry per sending email (#4300).
    const emailEntries = Object.entries(tick.byEmail ?? {})
      .filter(([, e]) => e.attempts > 0)
      .map(([slug, e]) => [slug, { attempts: e.attempts, failures: e.failures, byCode: { ...e.byCode } }] as const);
    const byEmail = emailEntries.length > 0 ? Object.fromEntries(emailEntries) : null;
    samples.push({
      atMs,
      attempts: tick.attempts,
      failures: tick.failures,
      byCode: { ...tick.byCode },
      ...(retried ? { retried } : {}),
      ...(settled ? { settled } : {}),
      ...(byEmail ? { byEmail } : {}),
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
  token_unavailable:
    "token_unavailable means no delegated token could be had for the mailbox, before anything " +
    "reached Gmail: usually Google's token service being slow or overloaded, which nothing in " +
    "Slate repairs. If it lasts, the reason on the log lines says whether it is Google or Slate's own key.",
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
  /** Of `failures`, the bookings released to be tried again (counted once each). */
  retrying?: number;
  pct: number;
  windowMinutes: number;
  topCodes: CodeCount[];
}): string {
  const codes = codeList(input.topCodes);
  const naming = codes ? ` Failing with: ${codes}.` : "";
  const top = input.topCodes[0]?.code;
  const guidance = top && CODE_GUIDANCE[top] ? ` ${CODE_GUIDANCE[top]}` : "";
  // Two different futures, said apart (2026-10-05). A send that provably did not go
  // out (nothing reached Gmail, or Gmail asked for it later) is handed back to be
  // tried again while the call is far enough away; every other failure keeps its
  // claim. `retrying` counts only bookings whose LATEST outcome in the window is that
  // hand back, so it is never a lead already reminded or one since given up, and the
  // two sentences never count one lead twice. Past tense, because a handed back
  // booking that was cancelled since is not being retried either.
  const retrying = Math.min(Math.max(input.retrying ?? 0, 0), input.failures);
  const kept = input.failures - retrying;
  const retried =
    retrying > 0
      ? ` ${retrying} of them did not go out and ${retrying === 1 ? "was" : "were"} handed back to be ` +
        `tried again, with no send since.`
      : "";
  const keptLine =
    kept > 0
      ? ` For ${plural(kept, "lead")}, no retry is set: the send was refused, may already have been ` +
        `accepted, came too close to the call to try again, or could not be confirmed as handed back.`
      : "";
  return (
    `${input.failures} of ${input.attempts} reminder emails failed to send in the last ` +
    `${input.windowMinutes} minutes (${input.pct}%).${retried}${keptLine}${naming}${guidance} ` +
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

/**
 * The shared verdict, plus what became of the bookings handed back in the window:
 * `retrying` (their latest outcome is still the hand back, and inside `failures`)
 * and `recovered` (sent since, so in neither the failures nor the page).
 */
export type ReminderRateVerdict = RateVerdict & { retrying: number; recovered: number };

/**
 * Judge the window with each RETRIED booking counted once (2026-10-05).
 *
 * A send that provably did not go out is released and tried again on the next tick, so
 * one booking stuck behind a slow token service appears in every sample for as long
 * as it is retried: 48 samples in a four hour window. Counted per send that is 48
 * failures, enough to trip the share on its own and to report 48 leads who are one.
 *
 * So every retried send is taken back out of its sample, and each distinct booking
 * judged by its LATEST outcome in the window:
 *
 *   still handed back: put back as ONE attempt and ONE failure under the last
 *     code it failed with, and counted as `retrying`.
 *   sent since: nothing is put back, because the send that delivered it is
 *     already an attempt in its own sample, and a lead who was reminded is not a
 *     failure. Counted as `recovered`, so a blip that healed itself cannot hold
 *     the window in breach for four hours.
 *   kept since: nothing is put back, because the failure that gave it up is
 *     already in its own sample, so the lead is one failure, never two.
 *
 * Many different bookings still handed back (a token outage for every mailbox) count
 * once each and still page, which is the case this share exists for.
 *
 * The collapsed totals go through the SAME `judgeFailureRate` the booking share
 * uses, as one synthetic sample, so the floor, the threshold and the rounding stay
 * one rule (L370).
 */
export function judgeReminderWindow(
  state: RateWindowState,
  atMs: number,
  thresholds: RateThresholds,
): ReminderRateVerdict {
  const live = pruneSamples(state.samples, atMs, thresholds.windowMs);
  let attempts = 0;
  let failures = 0;
  const byCode: Record<string, number> = {};
  type Latest = { atMs: number; outcome: "retried"; code: string } | { atMs: number; outcome: ReminderSettlement };
  const latest = new Map<string, Latest>();
  const note = (id: string, event: Latest) => {
    const seen = latest.get(id);
    // A settlement wins a tie: one tick cannot both hand a booking back and settle it.
    if (!seen || event.atMs > seen.atMs || (event.atMs === seen.atMs && event.outcome !== "retried")) {
      latest.set(id, event);
    }
  };
  for (const s of live) {
    const retried = Object.entries(s.retried ?? {});
    attempts += s.attempts - retried.length;
    failures += s.failures - retried.length;
    for (const [code, n] of Object.entries(s.byCode)) byCode[code] = (byCode[code] ?? 0) + n;
    for (const [id, code] of retried) {
      byCode[code] = (byCode[code] ?? 0) - 1;
      note(id, { atMs: s.atMs, outcome: "retried", code });
    }
  }
  // Settlements are read only for bookings handed back inside the live window; one
  // whose hand back has aged out is an ordinary send already counted in its sample.
  for (const s of live) {
    for (const [id, outcome] of Object.entries(s.settled ?? {})) {
      if (latest.has(id) && (outcome === "sent" || outcome === "kept")) note(id, { atMs: s.atMs, outcome });
    }
  }
  let retrying = 0;
  let recovered = 0;
  for (const event of latest.values()) {
    if (event.outcome === "retried") {
      retrying += 1;
      attempts += 1;
      failures += 1;
      byCode[event.code] = (byCode[event.code] ?? 0) + 1;
    } else if (event.outcome === "sent") {
      recovered += 1;
    }
  }
  for (const [code, n] of Object.entries(byCode)) if (n <= 0) delete byCode[code];
  const collapsed: RateWindowState = {
    ...state,
    samples: [{ atMs, attempts: Math.max(attempts, 0), failures: Math.max(failures, 0), byCode }],
  };
  return { ...judgeFailureRate(collapsed, atMs, thresholds), retrying, recovered };
}

// --------------------------------------------------------------- per email (#4300)

/** The condition key for one email whose own sends are failing. */
export const REMINDER_EMAIL_FAILING_PREFIX = "reminder_email_failing";
export const reminderEmailFailingKey = (slug: string): string => `${REMINDER_EMAIL_FAILING_PREFIX}:${slug}`;

/**
 * How many failures, with NOTHING sent beside them, saturate an email whatever its
 * volume (L139). The share's floor of ten attempts exists so one bad address in two
 * cannot read as a 50 percent outage; it also means an email sending three times in
 * four hours is never judged at all, and three of three failing is the clearest sign
 * its path is broken. Three, not one or two: one refused address, or two in a quiet
 * hour, is a lead's problem rather than the email's, and the per booking incident
 * already names each of those.
 */
export const REMINDER_EMAIL_SATURATION_FAILURES = 3;

/**
 * One email's verdict. `saturated` is every send failing at or past the saturation
 * floor; `healthy` is either the share measured under the threshold or, below the
 * floor, sends that all went out (a measured clean read, small as it is).
 */
export interface ReminderEmailShareVerdict {
  slug: string;
  status: "breach" | "saturated" | "healthy" | "insufficient";
  attempts: number;
  failures: number;
  retrying: number;
  pct: number;
  topCodes: CodeCount[];
}

/**
 * One email's view of the window: every live sample that carries the per email split,
 * with this email's counts, and the retried and settled entries whose share key is
 * this email's. A sample written before the split shipped is left out entirely, its
 * retried entries included, or they would be taken off counts it never held.
 */
function emailWindow(state: RateWindowState, slug: string, atMs: number, windowMs: number): RateWindowState {
  const ofEmail = <T>(m: Record<string, T> | undefined): Record<string, T> | undefined => {
    if (!m) return undefined;
    const kept = Object.entries(m).filter(([key]) => reminderShareKeySlug(key) === slug);
    return kept.length > 0 ? Object.fromEntries(kept) : undefined;
  };
  const samples = pruneSamples(state.samples, atMs, windowMs)
    .filter((s) => s.byEmail !== undefined)
    .map((s) => {
      const e = s.byEmail?.[slug];
      const retried = ofEmail(s.retried);
      const settled = ofEmail(s.settled);
      return {
        atMs: s.atMs,
        attempts: e?.attempts ?? 0,
        failures: e?.failures ?? 0,
        byCode: { ...(e?.byCode ?? {}) },
        ...(retried ? { retried } : {}),
        ...(settled ? { settled } : {}),
      };
    });
  return { ...state, samples };
}

/**
 * Judge every email that sent in the window, each on its own sends (#4300).
 *
 * Through `judgeReminderWindow`, so one booking retried every tick is one failure here
 * exactly as it is in the combined share, and for its own email only: the retried key
 * names the email (`reminderShareKey`). The share uses the shipped thresholds; beside it
 * the saturation rule judges an email too small for the share's floor (L139).
 */
export function judgeReminderEmailWindows(
  state: RateWindowState,
  atMs: number,
  thresholds: RateThresholds,
): ReminderEmailShareVerdict[] {
  const slugs = new Set<string>();
  for (const s of pruneSamples(state.samples, atMs, thresholds.windowMs)) {
    for (const slug of Object.keys(s.byEmail ?? {})) slugs.add(slug);
  }
  const out: ReminderEmailShareVerdict[] = [];
  for (const slug of [...slugs].sort()) {
    // A floor of one so the share and its codes are computed whatever the volume; the
    // real floor is applied below, where it decides only whether the SHARE may judge.
    const v = judgeReminderWindow(emailWindow(state, slug, atMs, thresholds.windowMs), atMs, { ...thresholds, minAttempts: 1 });
    if (v.status === "insufficient") {
      out.push({ slug, status: "insufficient", attempts: v.attempts, failures: v.failures, retrying: v.retrying, pct: 0, topCodes: [] });
      continue;
    }
    const measured = v.attempts >= thresholds.minAttempts;
    let status: ReminderEmailShareVerdict["status"];
    if (measured && v.status === "breach") status = "breach";
    else if (v.failures >= REMINDER_EMAIL_SATURATION_FAILURES && v.failures === v.attempts) status = "saturated";
    else if (measured || v.failures === 0) status = "healthy";
    else status = "insufficient";
    out.push({ slug, status, attempts: v.attempts, failures: v.failures, retrying: v.retrying, pct: v.pct, topCodes: v.topCodes });
  }
  return out;
}

/** The email's stored name as a page says it (`reminderEmailLabel`). */
const emailWords = reminderEmailLabel;

/**
 * The per email page. It names the email and says that this is its OWN share, which is
 * what separates it from the combined page: the others may be going out fine.
 */
export function reminderEmailFailingAlert(input: {
  name: string;
  attempts: number;
  failures: number;
  retrying: number;
  pct: number;
  windowMinutes: number;
  topCodes: CodeCount[];
}): string {
  const codes = codeList(input.topCodes);
  const naming = codes ? ` Failing with: ${codes}.` : "";
  const top = input.topCodes[0]?.code;
  const guidance = top && CODE_GUIDANCE[top] ? ` ${CODE_GUIDANCE[top]}` : "";
  const retrying = Math.min(Math.max(input.retrying, 0), input.failures);
  const retried =
    retrying > 0
      ? ` ${retrying} of them did not go out and ${retrying === 1 ? "was" : "were"} handed back to be tried again, with no send since.`
      : "";
  return (
    `The ${emailWords(input.name)} email failed to send for ${input.failures} of ${input.attempts} leads in the last ` +
    `${input.windowMinutes} minutes (${input.pct}%). This counts that email's own sends, so other reminder emails ` +
    `going out cannot hide it.${retried}${naming}${guidance} The per booking detail is in the booking-reminder log lines.`
  );
}

/** The per email all clear, off a measured read of that email's own sends. */
export function reminderEmailFailingAllClear(input: {
  name: string;
  attempts: number;
  failures: number;
  pct: number;
  windowMinutes: number;
}): string {
  const measured =
    input.failures === 0
      ? `none of its ${input.attempts} ${input.attempts === 1 ? "send" : "sends"} in the last ${input.windowMinutes} minutes failed`
      : `${input.failures} of its ${input.attempts} sends failed in the last ${input.windowMinutes} minutes (${input.pct}%)`;
  return `The ${emailWords(input.name)} email is going out again: ${measured}.`;
}

/** The stand down for an open per email page once that email is no longer switched on. */
export function reminderEmailFailingStandDown(name: string | undefined): string {
  return name
    ? `The ${emailWords(name)} email is no longer switched on, so its sends are no longer being judged. Nothing was repaired.`
    : "A reminder email that was failing no longer exists or is switched off, so its sends are no longer being judged. Nothing was repaired.";
}

export type ReminderRateResult =
  /** The window could not be read, so this tick claims nothing in either direction.
   *  Deliberately NOT folded into an empty window scored as zero failures. */
  | { status: "unverified"; why: "state" }
  | { status: "checked"; verdict: ReminderRateVerdict; state: RateWindowState; emails: ReminderEmailShareVerdict[] };

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
  notify: ThrottledNotify;
  resolve: AlertResolve;
  /**
   * The slugs with an open per email page (`firingFamilyMembers`), so one for an email
   * no longer switched on can be ended (#4300). THROWS on a failed read, which ends
   * nothing this tick. Absent, no stand down is attempted.
   */
  loadFiringEmailSlugs?: () => Promise<string[]>;
  /** Structurally the log helper's field shape, spelled out rather than imported so
   *  this module keeps no dependency on the logger. */
  log?: (fields: Record<string, string | number | boolean | null | undefined>) => void;
  onError?: (context: "saveState" | "notify" | "resolve" | "firing", err: unknown) => void;
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
  const verdict = judgeReminderWindow(state, deps.nowMs, deps.thresholds);

  deps.log?.({
    msg: "reminder failure rate",
    status: verdict.status,
    window_min: windowMinutes,
    attempts: verdict.attempts,
    failures: verdict.failures,
    retrying: verdict.retrying,
    recovered: verdict.recovered,
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

  // Each email on its own sends (#4300), after the combined page so that page's firing
  // marker is on record first: while it fires, a per email page it explains waits
  // (`ALERT_FOLDS`), and one cause is said once.
  const emails = judgeReminderEmailWindows(state, deps.nowMs, deps.thresholds);
  const names = deps.tick.emailNames ?? {};
  for (const e of emails) {
    const key = reminderEmailFailingKey(e.slug);
    const name = names[e.slug] ?? e.slug;
    deps.log?.({
      msg: "reminder email failure share",
      email: e.slug,
      status: e.status,
      attempts: e.attempts,
      failures: e.failures,
      retrying: e.retrying,
    });
    if (e.status === "breach" || e.status === "saturated") {
      await deps
        .notify(key, deps.cooldownMs, reminderEmailFailingAlert({ ...e, name, windowMinutes }))
        .catch((err) => deps.onError?.("notify", err));
    } else if (e.status === "healthy") {
      await deps
        .resolve(key, reminderEmailFailingAllClear({ ...e, name, windowMinutes }))
        .catch((err) => deps.onError?.("resolve", err));
    }
  }

  // An open page for an email no longer switched on has no sends left to judge, so it
  // would hold for ever: it is ended in words that say nothing was repaired. Only off a
  // MEASURED list of enabled emails; an unknown one ends nothing.
  if (deps.loadFiringEmailSlugs && deps.tick.enabledSlugs) {
    const enabled = new Set(deps.tick.enabledSlugs);
    let firing: string[] = [];
    try {
      firing = await deps.loadFiringEmailSlugs();
    } catch (err) {
      deps.onError?.("firing", err);
    }
    for (const slug of firing) {
      if (enabled.has(slug)) continue;
      const key = reminderEmailFailingKey(slug);
      await deps.resolve(key, reminderEmailFailingStandDown(names[slug])).catch((err) => deps.onError?.("resolve", err));
    }
  }
  return { status: "checked", verdict, state, emails };
}
