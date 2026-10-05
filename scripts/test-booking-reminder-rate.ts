// Telling a MASS reminder failure apart from a single one (#2496). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booking-reminder-rate.ts
//
// `booking_reminder_failed:<id>` fires per booking, so one lead's refused address and
// EVERY reminder failing look alike one page at a time, with nothing saying how many
// share a cause (L77: an error classified as expected must still be counted against a RATE, or
// a benign instance and a systemic outage travel the same path and the second stays
// invisible for as long as it lasts).
//
// So the lane also measures a SHARE over a rolling window, in the shape
// `booking-failure-rate` already uses, and this suite drives every branch of it with
// no database, no Slack and no real clock.
//
// The two assertions that matter most are the ones a green suite would otherwise be
// silent about: a single failure must NOT page (or the new signal says nothing the
// per booking incident did not), and a tick that could not READ its own window must
// neither page nor all-clear (L98, #1134: a recovery notice hung off a signal that
// was never read is this repo's most repeated defect).
import {
  advanceReminderWindow,
  classifyReminderSendFailure,
  formatReminderFailureRateAlert,
  formatReminderFailureRateAllClear,
  judgeReminderWindow,
  REMINDER_FAILURE_RATE_KEY,
  runReminderFailureRateCheck,
  type ReminderTick,
} from "../src/lib/booking/reminder-rate.ts";
import { EmailSendError } from "../src/lib/notify/email-errors.ts";
import { SHIPPED_REMINDER_FAILURE_RATE_THRESHOLDS } from "../src/lib/monitor/failure-rate-thresholds.ts";
import type { RateWindowState } from "../src/lib/monitor/booking-failure-rate.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 8, 17, 15, 0, 0);
const DAY = "2026-09-17";
const TH = SHIPPED_REMINDER_FAILURE_RATE_THRESHOLDS;

const tick = (attempts: number, failures: number, code = "provider_unavailable"): ReminderTick => ({
  attempts,
  failures,
  byCode: failures > 0 ? { [code]: failures } : {},
});

/** A window already holding `attempts`/`failures`, spread over one sample. */
function windowWith(attempts: number, failures: number, atMs = NOW - MINUTE): RateWindowState {
  return {
    day: DAY,
    attempts,
    failures,
    byCode: failures > 0 ? { provider_unavailable: failures } : {},
    samples: [
      {
        atMs,
        attempts,
        failures,
        byCode: failures > 0 ? { provider_unavailable: failures } : {},
      },
    ],
  };
}

interface Spy {
  paged: string[];
  cleared: string[];
  saved: RateWindowState[];
  errors: string[];
}

function run(
  over: Partial<Parameters<typeof runReminderFailureRateCheck>[0]> = {},
  spy: Spy = { paged: [], cleared: [], saved: [], errors: [] },
) {
  return {
    spy,
    result: runReminderFailureRateCheck({
      nowMs: NOW,
      day: DAY,
      tick: tick(0, 0),
      thresholds: TH,
      cooldownMs: 60_000,
      loadState: async () => null,
      saveState: async (s) => {
        spy.saved.push(s);
      },
      notify: async (_key, _cooldownMs, text) => {
        spy.paged.push(text);
      },
      resolve: async (_key, text) => {
        spy.cleared.push(text);
        return true;
      },
      onError: (context) => spy.errors.push(context),
      ...over,
    }),
  };
}

// --- the shipped floor makes ONE failure structurally unable to page -------------
//
// This is the whole point of the issue in one assertion. A signal that pages on a
// single bad address is the per booking incident again under a second name, and the
// reader learns nothing from having both.
{
  const spy: Spy = { paged: [], cleared: [], saved: [], errors: [] };
  const { result } = run(
    { loadState: async () => windowWith(19, 0), tick: tick(1, 1, "recipient_refused") },
    spy,
  );
  const r = await result;
  assert(r.status === "checked", "a readable window is judged");
  eq(r.status === "checked" ? r.verdict.status : "", "healthy", "one failure in twenty is healthy");
  eq(spy.paged.length, 0, "and pages nobody");
}

// --- and every reminder failing DOES page ----------------------------------------
{
  const spy: Spy = { paged: [], cleared: [], saved: [], errors: [] };
  const { result } = run(
    { loadState: async () => windowWith(20, 20), tick: tick(4, 4) },
    spy,
  );
  const r = await result;
  eq(r.status === "checked" ? r.verdict.status : "", "breach", "a wave of failures is a breach");
  eq(spy.paged.length, 1, "and pages once");
  assert(spy.paged[0]!.includes("24"), "the page says how many leads were not reminded");
  assert(
    spy.paged[0]!.includes("100%"),
    `and the share, so a total outage does not read as an ordinary hour (${spy.paged[0]})`,
  );
  eq(spy.cleared.length, 0, "a breach clears nothing");
}

// --- a window too small to judge neither pages nor all-clears ---------------------
//
// One of one attempts failing is 100 percent and means nothing. It must not page,
// and it must not send a recovery notice either: a window below the floor measured
// no share at all, so an all-clear off it would claim something nobody observed.
{
  const spy: Spy = { paged: [], cleared: [], saved: [], errors: [] };
  const { result } = run({ loadState: async () => null, tick: tick(1, 1) }, spy);
  const r = await result;
  eq(
    r.status === "checked" ? r.verdict.status : "",
    "insufficient",
    "one attempt is not a measurement",
  );
  eq(spy.paged.length, 0, "so nobody is paged");
  eq(spy.cleared.length, 0, "and nothing is cleared");
}

// --- THE failure path: a window that could not be READ claims nothing -------------
//
// #1134 / #1152, the defect this repo keeps meeting. A state read that threw must not
// arrive as an empty window scored as zero failures, because that is the healthy
// answer at exactly the moment we stopped measuring.
{
  const spy: Spy = { paged: [], cleared: [], saved: [], errors: [] };
  const { result } = run(
    {
      loadState: async () => {
        throw new Error("booking_failure_rate_state read failed");
      },
      tick: tick(40, 40),
    },
    spy,
  );
  const r = await result;
  eq(r.status, "unverified", "an unreadable window is unverified, never healthy");
  eq(spy.paged.length, 0, "it pages nobody off a window it never read");
  eq(spy.cleared.length, 0, "and, above all, all-clears nobody");
  eq(spy.saved.length, 0, "nor does it overwrite the window it could not read");
}

// --- a measured healthy window clears a live page --------------------------------
{
  const spy: Spy = { paged: [], cleared: [], saved: [], errors: [] };
  const { result } = run({ loadState: async () => windowWith(40, 0), tick: tick(4, 0) }, spy);
  const r = await result;
  eq(r.status === "checked" ? r.verdict.status : "", "healthy", "a measured clean window");
  eq(spy.cleared.length, 1, "clears the page");
  assert(
    spy.cleared[0]!.toLowerCase().includes("again"),
    `and says the condition ended (${spy.cleared[0]})`,
  );
}

// --- a flaky Slack or a failed write must never fail the lane ---------------------
//
// This lane sends real email to real leads; a monitor bolted onto it must not be able
// to stop it. Each fail-soft path is still REPORTED, or a caught error reaches no
// sink at all (L13).
{
  const spy: Spy = { paged: [], cleared: [], saved: [], errors: [] };
  const { result } = run(
    {
      loadState: async () => windowWith(20, 20),
      tick: tick(4, 4),
      saveState: async () => {
        throw new Error("write failed");
      },
      notify: async () => {
        throw new Error("slack down");
      },
    },
    spy,
  );
  const r = await result;
  eq(r.status, "checked", "the tick still reports its verdict");
  assert(spy.errors.includes("saveState"), "a failed state write is reported");
  assert(spy.errors.includes("notify"), "and so is a failed page");
}

// --- the window is the unit, so a tick that attempted nothing records no sample ----
//
// A reminder lane runs every five minutes around the clock and has nothing to do for
// most of them. Appending an empty sample per tick would fill the row with rows that
// measured nothing, and an attempt count of zero is not evidence of anything.
{
  const state = advanceReminderWindow(null, tick(0, 0), DAY, NOW, TH.windowMs);
  eq(state.samples.length, 0, "a tick with no attempts writes no sample");
  const next = advanceReminderWindow(state, tick(3, 1), DAY, NOW + MINUTE, TH.windowMs);
  eq(next.samples.length, 1, "and a tick that attempted something does");
  eq(next.attempts, 3, "the day to date total counts it");
  eq(next.failures, 1, "failures too");
}

// --- samples age out of the window ------------------------------------------------
{
  const old = advanceReminderWindow(null, tick(5, 5), DAY, NOW, TH.windowMs);
  const later = advanceReminderWindow(
    old,
    tick(5, 0),
    DAY,
    NOW + TH.windowMs + MINUTE,
    TH.windowMs,
  );
  eq(later.samples.length, 1, "the sample older than the window is gone");
  eq(later.samples[0]!.failures, 0, "and the surviving one is the fresh reading");
}

// --- the ET day rolls the day to date totals, and keeps the window ----------------
//
// The samples are true either side of midnight and the window is time based, so
// emptying it at the rollover would blind the check for a whole window every night.
// Only the day to date counters restart.
{
  const before = advanceReminderWindow(null, tick(10, 2), DAY, NOW, TH.windowMs);
  const after = advanceReminderWindow(before, tick(1, 0), "2026-09-18", NOW + MINUTE, TH.windowMs);
  eq(after.day, "2026-09-18", "the day moves on");
  eq(after.attempts, 1, "the day to date total restarts");
  eq(after.failures, 0, "and so does its failure count");
  eq(after.samples.length, 2, "while the window keeps what it measured");
}

// --- a send failure is classified into a bounded vocabulary -----------------------
//
// Keying the window's reasons on the provider's raw message would give the map one
// key per message and make the top reason meaningless (L131). The codes are
// chosen because they send different people to do different things: a refused
// mailbox is a delegation repair, a refused recipient is one lead's address.
{
  eq(
    classifyReminderSendFailure("Gmail send failed: 403 {\"error\":\"forbidden\"}"),
    "not_authorised",
    "a refused mailbox is a delegation repair",
  );
  eq(
    classifyReminderSendFailure("Gmail send failed: 401 unauthorized"),
    "not_authorised",
    "and so is an expired credential",
  );
  eq(
    classifyReminderSendFailure("Gmail send failed: 400 Invalid To header"),
    "recipient_refused",
    "a rejected address is one lead's problem",
  );
  eq(
    classifyReminderSendFailure("Gmail send failed: 429 rateLimitExceeded"),
    "rate_limited",
    "a rate limit is its own thing",
  );
  eq(
    classifyReminderSendFailure("Gmail send failed: 503 backendError"),
    "provider_unavailable",
    "a 5xx is Google",
  );
  eq(
    classifyReminderSendFailure("sendGmailEmail: no recipients"),
    "no_recipients",
    "and a send with nobody to send to is ours",
  );
  eq(
    classifyReminderSendFailure("socket hang up"),
    "unclassified",
    "anything else is unclassified rather than forced into a neighbouring code",
  );
  // A code nobody can read must still be a code: dropping it would shrink the
  // denominator of the very share this exists to measure (L215).
  eq(classifyReminderSendFailure(""), "unclassified", "an empty message is still counted");
}

// --- a typed send failure is classified by what it PROVES (2026-10-05) -----------
//
// The incident's mint timeout and a mint refusal both fell to `unclassified`, which
// told the reader nothing about the system to look at. The typed error is read first
// and the message is only the fallback for a plain Error.
{
  const typed = (
    outcome: "never_sent" | "refused" | "unknown",
    stage: "compose" | "token" | "post",
    status: number | null,
    transient: boolean,
    message = "x",
  ) => new EmailSendError(message, { outcome, stage, status, transient });

  eq(
    classifyReminderSendFailure(typed("never_sent", "token", null, true, "google token mint did not answer within 8000ms")),
    "token_unavailable",
    "a mint that timed out is token_unavailable: nothing reached Gmail",
  );
  eq(
    classifyReminderSendFailure(typed("never_sent", "token", 503, true)),
    "token_unavailable",
    "and so is a token endpoint 5xx",
  );
  eq(
    classifyReminderSendFailure(typed("never_sent", "token", 403, false)),
    "not_authorised",
    "a token endpoint 4xx is the mailbox delegation, the existing not_authorised",
  );
  eq(
    classifyReminderSendFailure(typed("never_sent", "token", 400, false)),
    "not_authorised",
    "including a 400, which is the token endpoint refusing the grant, never the lead's address",
  );
  eq(
    classifyReminderSendFailure(typed("refused", "post", 429, true)),
    "rate_limited",
    "a Gmail 429 is still rate_limited",
  );
  eq(
    classifyReminderSendFailure(typed("refused", "post", 400, false)),
    "recipient_refused",
    "a Gmail 400 is still the address",
  );
  eq(
    classifyReminderSendFailure(typed("unknown", "post", 503, true)),
    "provider_unavailable",
    "a Gmail 5xx is still Google",
  );
  eq(
    classifyReminderSendFailure(typed("unknown", "post", null, true, "Gmail send failed: no response (fetch failed)")),
    "unclassified",
    "a POST with no answer has no status to classify by",
  );
  eq(
    classifyReminderSendFailure(typed("never_sent", "compose", null, false, "sendGmailEmail: no recipients")),
    "no_recipients",
    "a compose failure with nobody to send to is ours",
  );
  // The fallback, for a plain Error carrying the mint's own sentences.
  eq(
    classifyReminderSendFailure(new Error("google token mint did not answer within 8000ms")),
    "token_unavailable",
    "a plain mint deadline is recognised by the deadline's own label",
  );
  eq(
    classifyReminderSendFailure(new Error('Delegated token failed for a@b.com: 403 {"error":"unauthorized_client"}')),
    "not_authorised",
    "and a plain mint refusal by the mint's own wording",
  );
}

// --- one booking retried every tick is ONE lead, not a wave (2026-10-05) ----------
//
// A send that never reached Gmail is released and tried again five minutes later,
// so one stuck booking appears in every sample of a four hour window. Counted per
// send it would be 48 failures and trip the share on its own, reporting 48 leads
// who are one. Counted per booking it is one failure.
{
  const retriedTick = (id: string): ReminderTick => ({
    attempts: 1,
    failures: 1,
    byCode: { token_unavailable: 1 },
    retried: { [id]: "token_unavailable" },
  });
  let state: RateWindowState | null = advanceReminderWindow(null, tick(20, 0), DAY, NOW - 200 * MINUTE, TH.windowMs);
  for (let i = 0; i < 40; i++) {
    state = advanceReminderWindow(state, retriedTick("bk-stuck"), DAY, NOW - (195 - i * 5) * MINUTE, TH.windowMs);
  }
  const v = judgeReminderWindow(state!, NOW, TH);
  eq(v.attempts, 21, "the forty retries of one booking count as one attempt beside the twenty sends");
  eq(v.failures, 1, "and as one failure");
  eq(v.retrying, 1, "naming one booking being retried");
  eq(v.status, "healthy", "so one stuck booking cannot page as a wave");

  // The control: fifteen DIFFERENT bookings released is a wave (a mint outage for
  // every mailbox), and must still page. Without it the collapse could be hiding
  // every retried failure rather than collapsing repeats.
  let wide: RateWindowState | null = advanceReminderWindow(null, tick(20, 0), DAY, NOW - 100 * MINUTE, TH.windowMs);
  for (let i = 0; i < 15; i++) {
    wide = advanceReminderWindow(wide, retriedTick(`bk-${i}`), DAY, NOW - (95 - i * 5) * MINUTE, TH.windowMs);
  }
  const w = judgeReminderWindow(wide!, NOW, TH);
  eq([w.attempts, w.failures, w.retrying], [35, 15, 15], "fifteen bookings retried count fifteen times");
  eq(w.status, "breach", "and are a wave");
  eq(w.status === "breach" ? w.topCodes[0]?.code : "", "token_unavailable", "named by the code they failed with");
}

// --- the page says which failed leads are being retried ---------------------------
{
  const page = formatReminderFailureRateAlert({
    attempts: 30,
    failures: 15,
    retrying: 12,
    pct: 50,
    windowMinutes: 240,
    topCodes: [{ code: "token_unavailable", count: 12 }],
  });
  assert(page.includes("15 of 30"), `the page still says what it measured (${page})`);
  assert(/12 (of them )?never reached Gmail/.test(page), `and that 12 never reached Gmail (${page})`);
  assert(/3 leads? will not/.test(page), `and that the other 3 will not be sent one (${page})`);
  assert(!/none coming: a failed send is deliberately not retried/.test(page), "the old claim that nothing is retried is gone");
  assert(page.includes("token_unavailable"), "and the code is named");

  const none = formatReminderFailureRateAlert({
    attempts: 24,
    failures: 24,
    pct: 100,
    windowMinutes: 240,
    topCodes: [{ code: "not_authorised", count: 24 }],
  });
  assert(!/never reached Gmail/.test(none), `with nothing retried, no retry is claimed (${none})`);
  assert(/24 leads will not/.test(none), `and every failed lead is said to get none (${none})`);
}

// --- the copy says what was measured, and names what to do ------------------------
{
  const page = formatReminderFailureRateAlert({
    attempts: 24,
    failures: 24,
    pct: 100,
    windowMinutes: 240,
    topCodes: [{ code: "not_authorised", count: 24 }],
  });
  assert(page.includes("24 of 24"), `the page says what it measured (${page})`);
  assert(page.includes("240 minutes"), "over what window");
  assert(
    page.toLowerCase().includes("mailbox"),
    `and what to do about the code that is failing (${page})`,
  );
  assert(!page.startsWith("Slate"), "and does not open with the app's own name");

  const quiet = formatReminderFailureRateAlert({
    attempts: 20,
    failures: 5,
    pct: 25,
    windowMinutes: 240,
    topCodes: [{ code: "unclassified", count: 5 }],
  });
  assert(
    quiet.includes("unclassified"),
    `a code with no canned advice is still named (${quiet})`,
  );

  const clear = formatReminderFailureRateAllClear({
    attempts: 40,
    failures: 0,
    pct: 0,
    windowMinutes: 240,
  });
  assert(clear.includes("0 of 40"), `the all-clear says what it measured (${clear})`);
}

// --- the key is ONE constant, so a page can always be cleared ---------------------
{
  eq(REMINDER_FAILURE_RATE_KEY, "booking_reminders_failing", "the alert key is pinned");
}

// --- the shipped floor is reachable by the traffic it judges -----------------------
//
// #2484 measured the pilot page at a median of 18 Low leads an hour, and a reminder
// is one per BOOKING rather than one per lead, so a floor fitted to lead volume is
// one no reminder wave can clear. These assertions pin the shape of that argument:
// the window has to be long enough to accumulate the floor, and the floor high
// enough that one failure cannot carry the share on its own.
{
  assert(TH.minAttempts >= 10, "the floor is high enough that one failure cannot page");
  assert(
    TH.windowMs >= 2 * 60 * 60_000,
    "and the window long enough for a reminder wave to reach it",
  );
  assert(
    TH.failPct > 0 && TH.failPct < 100,
    "a share of nothing, or of everything, is not a threshold",
  );
  // At the floor it takes THREE failures, not one and not two, which is the
  // property that separates this from the per booking incident.
  const atFloor = Math.floor((TH.minAttempts * TH.failPct) / 100) + 1;
  assert(atFloor >= 3, `at the floor it takes at least three failures (takes ${atFloor})`);
}

finish();
