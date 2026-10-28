// The failure share judged PER reminder email (#4300). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-reminder-email-share.ts
//
// `booking_reminders_failing` judges every email's sends in one window, so a small
// email failing on every send is hidden by the larger ones going out: three of three
// 30 minute emails failing beside forty 24 hour emails sent is 7% of the whole, which
// is healthy. So each email is also judged on its own sends, from the SAME window row
// (each sample carries its emails' own counts), with a saturation rule beside the
// share whose floor is far smaller (L139): every send of an email failing is the
// clearest evidence there is that its path is broken, however few sends there were.
//
// The two directions that matter: a small email failing every time pages under its own
// key while the combined share stays healthy, and nothing is counted twice: one booking
// retried every tick is one failure for its email, and only for its email.
import {
  advanceReminderWindow,
  judgeReminderEmailWindows,
  reminderEmailFailingAlert,
  reminderEmailFailingAllClear,
  reminderEmailFailingKey,
  reminderEmailFailingStandDown,
  reminderShareKey,
  reminderShareKeySlug,
  REMINDER_EMAIL_SATURATION_FAILURES,
  REMINDER_FAILURE_RATE_KEY,
  runReminderFailureRateCheck,
  type ReminderTick,
} from "../src/lib/booking/reminder-rate.ts";
import { SHIPPED_REMINDER_FAILURE_RATE_THRESHOLDS } from "../src/lib/monitor/failure-rate-thresholds.ts";
import type { RateWindowState } from "../src/lib/monitor/booking-failure-rate.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 27, 15, 0, 0);
const DAY = "2026-10-27";
const TH = SHIPPED_REMINDER_FAILURE_RATE_THRESHOLDS;
const NAMES = { day: "24 hour reminder", hour: "1 hour reminder", half: "30 minute nudge" };

/** A tick whose sends are split by email: `{ slug: [attempts, failures] }`. */
function tickOf(per: Record<string, [number, number]>, extra: Partial<ReminderTick> = {}): ReminderTick {
  const entries = Object.entries(per);
  const attempts = entries.reduce((n, [, [a]]) => n + a, 0);
  const failed = entries.reduce((n, [, [, f]]) => n + f, 0);
  const byEmail = Object.fromEntries(
    entries.map(([slug, [a, f]]) => [slug, { attempts: a, failures: f, byCode: f > 0 ? { not_authorised: f } : {} }]),
  );
  return {
    attempts,
    failures: failed,
    byCode: failed > 0 ? { not_authorised: failed } : {},
    byEmail,
    emailNames: NAMES,
    enabledSlugs: Object.keys(NAMES),
    ...extra,
  };
}

function fold(ticks: [number, ReminderTick][]): RateWindowState {
  let state: RateWindowState | null = null;
  for (const [minutesAgo, t] of ticks) state = advanceReminderWindow(state, t, DAY, NOW - minutesAgo * MINUTE, TH.windowMs);
  return state!;
}

interface Spy {
  paged: { key: string; text: string }[];
  resolved: { key: string; text: string }[];
}

async function judgeTick(state: RateWindowState | null, t: ReminderTick, over: Partial<Parameters<typeof runReminderFailureRateCheck>[0]> = {}) {
  const spy: Spy = { paged: [], resolved: [] };
  const result = await runReminderFailureRateCheck({
    nowMs: NOW,
    day: DAY,
    tick: t,
    thresholds: TH,
    cooldownMs: 60_000,
    loadState: async () => state,
    saveState: async () => {},
    notify: async (key, _ms, text) => {
      spy.paged.push({ key, text });
    },
    resolve: async (key, text) => {
      spy.resolved.push({ key, text });
      return true;
    },
    ...over,
  });
  return { spy, result };
}

// --- the share key and its inverse are one rule ------------------------------------
{
  for (const slug of ["day", "hour", "half", "twelve_hour"]) {
    eq(reminderShareKeySlug(reminderShareKey("b7f1c2e4-9a3d-4c88-b0f2-15ac7d9e6431", slug)), slug, `${slug} round trips`);
  }
  eq(reminderShareKey("bk-1", "day"), "bk-1", "the 24 hour email keeps the bare id in the window, as it always has");
  eq(reminderShareKey("bk-1", "hour"), "hour:bk-1", "and the 1 hour email hour:<id>");
}

// --- a small email failing every time pages while the combined share is healthy -----
{
  const state = fold([
    [120, tickOf({ day: [20, 0], half: [1, 1] })],
    [60, tickOf({ day: [20, 0], half: [1, 1] })],
  ]);
  const t = tickOf({ day: [4, 0], half: [1, 1] });
  const { spy, result } = await judgeTick(state, t);
  assert(result.status === "checked", "a readable window is judged");
  if (result.status !== "checked") throw new Error("unreachable");
  eq(result.verdict.status, "healthy", "3 of 47 is healthy for the combined share, which is the gap");
  const half = result.emails.find((e) => e.slug === "half");
  eq(half?.status, "saturated", "the 30 minute email, failing on all three of its sends, is saturated");
  eq(spy.paged.map((p) => p.key), [reminderEmailFailingKey("half")], "and pages under its own key alone");
  assert(spy.paged[0]!.text.includes("30 minute nudge"), `the page names the email by its stored name (${spy.paged[0]?.text})`);
  assert(spy.paged[0]!.text.includes("3 of 3"), `and says how many of its sends failed (${spy.paged[0]?.text})`);
  const day = result.emails.find((e) => e.slug === "day");
  eq(day?.status, "healthy", "the 24 hour email, all sent, is measured healthy");
  eq(
    spy.resolved.map((c) => c.key),
    [REMINDER_FAILURE_RATE_KEY, reminderEmailFailingKey("day")],
    "so the combined key is cleared as before, and the 24 hour email's own key (a no op unless it was paging)",
  );
}

// --- saturation has its own small floor: one or two failures are not a pattern -----
{
  const state = fold([[60, tickOf({ half: [1, 1] })]]);
  const { spy, result } = await judgeTick(state, tickOf({ half: [1, 1] }));
  if (result.status !== "checked") throw new Error("unreachable");
  eq(REMINDER_EMAIL_SATURATION_FAILURES, 3, "three failures, all of them, is the saturation floor");
  eq(result.emails.find((e) => e.slug === "half")?.status, "insufficient", "two of two is not yet saturated");
  eq(spy.paged.length, 0, "and pages nobody");
  eq(spy.resolved.length, 0, "nor clears anything");
}

// --- the share still applies per email above the floor ----------------------------
{
  const state = fold([[90, tickOf({ day: [30, 0], hour: [10, 3] })]]);
  const { spy, result } = await judgeTick(state, tickOf({ day: [4, 0], hour: [2, 1] }));
  if (result.status !== "checked") throw new Error("unreachable");
  eq(result.verdict.status, "healthy", "4 of 46 is healthy combined");
  const hour = result.emails.find((e) => e.slug === "hour");
  eq(hour?.status, "breach", "4 of 12 for the 1 hour email is over 20 percent");
  eq(spy.paged.map((p) => p.key), [reminderEmailFailingKey("hour")], "so the 1 hour email pages on its own");
}

// --- one booking retried every tick is one failure, for its email only --------------
{
  const retried = (minutesAgo: number): [number, ReminderTick] => [
    minutesAgo,
    tickOf({ day: [2, 0], half: [1, 1] }, { retried: { [reminderShareKey("bk-stuck", "half")]: "token_unavailable" } }),
  ];
  const state = fold([retried(60), retried(55), retried(50), retried(45), retried(40)]);
  const { result } = await judgeTick(state, tickOf({ day: [1, 0] }));
  if (result.status !== "checked") throw new Error("unreachable");
  const half = result.emails.find((e) => e.slug === "half");
  eq([half?.attempts, half?.failures, half?.retrying], [1, 1, 1], "five retries of one booking are one attempt and one failure");
  eq(half?.status, "insufficient", "so one stuck booking cannot saturate an email");
  const day = result.emails.find((e) => e.slug === "day");
  eq([day?.attempts, day?.failures], [11, 0], "and the 24 hour email's count carries none of the other email's retries");
}

// --- the combined window is unchanged by the per email counts -----------------------
{
  const withEmails = fold([[60, tickOf({ day: [5, 1], hour: [5, 1] })]]);
  const without = fold([[60, { attempts: 10, failures: 2, byCode: { not_authorised: 2 } }]]);
  const a = await judgeTick(withEmails, { attempts: 0, failures: 0, byCode: {} });
  const b = await judgeTick(without, { attempts: 0, failures: 0, byCode: {} });
  if (a.result.status !== "checked" || b.result.status !== "checked") throw new Error("unreachable");
  eq(a.result.verdict, b.result.verdict, "the combined verdict reads the same totals with or without the per email split");
}

// --- a sample from before this shipped carries no per email counts ------------------
//
// Its retried entries must not be subtracted from an email it never counted, which
// would drive that email's attempts negative and read as healthy.
{
  const old = fold([
    [60, { attempts: 3, failures: 3, byCode: { token_unavailable: 3 }, retried: { [reminderShareKey("bk-old", "half")]: "token_unavailable" } }],
  ]);
  eq(judgeReminderEmailWindows(old, NOW, TH), [], "an old sample is judged for no email at all");
}

// --- an email switched off while its page is open stands down in its own words ------
{
  const { spy } = await judgeTick(null, tickOf({ day: [1, 0] }, { enabledSlugs: ["day"] }), {
    loadFiringEmailSlugs: async () => ["half", "day"],
  });
  const stood = spy.resolved.find((c) => c.key === reminderEmailFailingKey("half"));
  assert(stood !== undefined, "the open page of an email no longer switched on is ended");
  eq(stood?.text, reminderEmailFailingStandDown(NAMES.half), "saying it was switched off, never that it recovered");
  assert(
    !spy.resolved.some((c) => c.key === reminderEmailFailingKey("day") && c.text.includes("switched off")),
    "an email still on is never stood down that way",
  );
}

// --- an email switched off with failures still in the window is never paged afresh -----
//
// Its old failed samples stay in the window for hours, so judging it would post a new page
// that the stand down below then ends in the same tick. Off emails are only stood down.
{
  const state = fold([[60, tickOf({ half: [3, 3] })], [30, tickOf({ half: [2, 2] })]]);
  const { spy } = await judgeTick(state, tickOf({ day: [1, 0] }, { enabledSlugs: ["day", "hour"] }), {
    loadFiringEmailSlugs: async () => ["half"],
  });
  assert(!spy.paged.some((c) => c.key === reminderEmailFailingKey("half")), "a switched off email posts no new failure page");
  assert(
    spy.resolved.some((c) => c.key === reminderEmailFailingKey("half") && c.text === reminderEmailFailingStandDown(NAMES.half)),
    "its open page is stood down instead",
  );
  // Control: the same window with half switched on does page.
  const on = await judgeTick(state, tickOf({ day: [1, 0] }, { enabledSlugs: ["day", "hour", "half"] }));
  assert(on.spy.paged.some((c) => c.key === reminderEmailFailingKey("half")), "while switched on, the same failures page");
}

// --- a failed read of the open pages ends nothing, and costs nothing else ----------
{
  const state = fold([[60, tickOf({ day: [20, 0], half: [1, 1] })], [30, tickOf({ half: [1, 1] })]]);
  const errors: string[] = [];
  // day is off, so a working read would stand its page down; half is on and failing.
  const { spy } = await judgeTick(state, tickOf({ half: [1, 1] }, { enabledSlugs: ["half"] }), {
    loadFiringEmailSlugs: async () => {
      throw new Error("alert_state read failed");
    },
    onError: (ctx) => errors.push(ctx),
  });
  assert(!spy.resolved.some((c) => c.text.includes("switched off")), "nothing is stood down off a read that failed");
  eq(errors, ["firing"], "and the failure is reported");
  eq(spy.paged.map((p) => p.key), [reminderEmailFailingKey("half")], "while the measured per email page still goes out");
}

// --- a window that could not be read claims nothing for any email --------------------
{
  const { spy, result } = await judgeTick(null, tickOf({ half: [9, 9] }), {
    loadState: async () => {
      throw new Error("state read failed");
    },
    loadFiringEmailSlugs: async () => ["half"],
  });
  eq(result.status, "unverified", "unverified");
  eq(spy.paged.length, 0, "no email pages off a window nobody read");
  eq(spy.resolved.length, 0, "and none clears off it");
}

// --- the copy --------------------------------------------------------------------
{
  const text = reminderEmailFailingAlert({
    name: "30 minute nudge",
    attempts: 3,
    failures: 3,
    retrying: 0,
    pct: 100,
    windowMinutes: 240,
    topCodes: [{ code: "not_authorised", count: 3 }],
  });
  assert(text.startsWith("The 30 minute nudge email failed"), `opens with the email, never "Slate" (${text})`);
  assert(text.includes("not_authorised (3)"), "names what is failing");
  assert(text.includes("delegation"), "and what to do about the top code");
  const clear = reminderEmailFailingAllClear({ name: "30 minute nudge", attempts: 4, failures: 0, pct: 0, windowMinutes: 240 });
  assert(clear.includes("none of its 4 sends"), `the all clear says what it measured (${clear})`);
}

finish();
