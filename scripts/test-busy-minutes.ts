// The daily check that says when the booking load run's bar needs raising (#3124).
//
// Dan's rule, 2026-10-20: once a day, look at the last 7 days of routed bookings and say
// so when a minute holding MORE THAN A TENTH of the bar happened on 3 or more different
// days. Until cutover the count is cal.com's routed responses plus Slate's own routed
// bookings, added minute by minute, because Slate alone would have missed the busiest
// minute there has been (7 on cal.com, 0 on Slate, 2026-10-01 14:20 UTC).
//
// The wrong answers this pins, each of which reads as a quiet week:
//  - a threshold that drifts from the bar (a second number nobody updates);
//  - the two halves judged apart, so 4 plus 4 in one minute never reaches 8;
//  - a cal.com read that failed, came back partial, or came back empty while cal.com is
//    still live, counted as cal.com having had no traffic;
//  - a failed Slate read counted as Slate having had no bookings;
//  - an all clear or a verdict stamp off a run that measured nothing.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-busy-minutes.ts
import { assert, eq, finish } from "./lib/harness.ts";
import { LOAD_RUN_BOOKINGS_PER_MINUTE, busyMinuteThreshold } from "../src/lib/load-bar.ts";
import {
  BUSY_DAYS_TO_ALERT,
  BUSY_MINUTES_CRONS,
  BUSY_MINUTES_ROUTE,
  alreadyMeasuredToday,
  busyWindow,
  isFinalAttempt,
  judgeBusyMinutes,
  planBusyMinutesActions,
  slateMinutesFrom,
  type BusyVerdict,
  type CalcomHalf,
  type SlateHalf,
} from "../src/lib/monitor/busy-minutes.ts";
import {
  loadBarOutgrownAlert,
  loadBarOutgrownRecovery,
  loadBarUnreadAlert,
  loadBarUnreadRecovery,
} from "../src/lib/monitor/busy-minutes-copy.ts";
import { CRON_ROUTES } from "../worker/cron-routes.ts";

const MIN = 60_000;
const at = (iso: string): number => Date.parse(iso);
const minuteOf = (iso: string): number => Math.floor(at(iso) / MIN);

// --- The threshold comes from the bar, and only from the bar --------------------------
{
  eq(LOAD_RUN_BOOKINGS_PER_MINUTE, 70, "the bar is 70 a minute (Dan, 2026-10-20)");
  eq(busyMinuteThreshold(70), 8, "more than a tenth of 70 is 8 or more");
  eq(busyMinuteThreshold(60), 7, "more than a tenth of 60 is 7 or more");
  eq(busyMinuteThreshold(65), 7, "more than a tenth of 65 (6.5) is 7 or more");
  eq(busyMinuteThreshold(80), 9, "a later raise to 80 moves the alert to 9 with no second number to update");
  for (const bad of [0, -10, 70.5, Number.NaN]) {
    let threw = false;
    try {
      busyMinuteThreshold(bad);
    } catch {
      threw = true;
    }
    assert(threw, `a bar of ${bad} is refused rather than turned into a threshold`);
  }
}

// --- The window: the last 7 whole UTC days --------------------------------------------
const NOW = at("2026-10-20T05:41:00Z");
const W = busyWindow(NOW);
{
  eq(new Date(W.fromMs).toISOString(), "2026-10-13T00:00:00.000Z", "the window starts 7 UTC days before today");
  eq(new Date(W.toMs).toISOString(), "2026-10-20T00:00:00.000Z", "and ends at today's UTC midnight, so every day in it is whole");
  const retry = busyWindow(at("2026-10-20T09:41:00Z"));
  eq([retry.fromMs, retry.toMs], [W.fromMs, W.toMs], "the retry run judges exactly the window the first run did");
}

// Fixtures. Slate's half arrives as the RPC answers it, minutes since the epoch.
const slate = (...pairs: [string, number][]): SlateHalf =>
  slateMinutesFrom(pairs.map(([iso, n]) => [minuteOf(iso), n]), W);
let nextId = 1;
const routed = (...stamps: string[]): { id: string; createdAt: string }[] =>
  stamps.map((createdAt) => ({ id: String(nextId++), createdAt }));
const calcom = (...stamps: string[]): CalcomHalf => ({ kind: "read", routed: routed(...stamps) });
const times = (iso: string, n: number): string[] => Array.from({ length: n }, () => iso);
const judge = (s: SlateHalf, c: CalcomHalf, bar = 70): BusyVerdict =>
  judgeBusyMinutes({ barPerMinute: bar, window: W, slate: s, calcom: c });
const measured = (v: BusyVerdict) => {
  if (v.kind !== "measured") throw new Error(`expected a measured verdict, got ${JSON.stringify(v)}`);
  return v;
};
const quietCal = calcom("2026-10-15T14:00:10Z");

// --- Slate's RPC answer is judged before anything counts it ----------------------------
{
  assert(!slateMinutesFrom(null, W).ok, "a null answer is not an empty week");
  assert(!slateMinutesFrom({ minutes: [] }, W).ok, "an answer that is not a list is refused");
  assert(!slateMinutesFrom([[minuteOf("2026-10-15T14:00:00Z")]], W).ok, "a pair missing its count is refused");
  assert(!slateMinutesFrom([[minuteOf("2026-10-15T14:00:00Z"), -1]], W).ok, "a negative count is refused");
  assert(!slateMinutesFrom([[minuteOf("2026-10-15T14:00:00Z"), 1.5]], W).ok, "a fractional count is refused");
  assert(!slateMinutesFrom([[minuteOf("2026-10-20T01:00:00Z"), 1]], W).ok, "a minute outside the window asked for is refused");
  const ok = slateMinutesFrom([[minuteOf("2026-10-15T14:00:00Z"), 3]], W);
  assert(ok.ok && ok.minutes.length === 1, "a well formed answer is accepted");
  const empty = slateMinutesFrom([], W);
  assert(empty.ok && empty.minutes.length === 0, "an empty list is a real answer: no booking in any minute");
}

// --- 3 days of 7 cross: the alert; 2 days: quiet --------------------------------------
{
  const three = measured(
    judge(
      slate(["2026-10-14T14:20:00Z", 8], ["2026-10-15T15:30:00Z", 9], ["2026-10-17T13:23:00Z", 8]),
      quietCal,
    ),
  );
  eq(three.threshold, 8, "the verdict carries the threshold it judged at");
  eq(three.crossingDays.length, 3, "three different days crossed");
  assert(three.raise, `${BUSY_DAYS_TO_ALERT} days of 7 is the alert`);

  const two = measured(judge(slate(["2026-10-14T14:20:00Z", 8], ["2026-10-15T15:30:00Z", 9]), quietCal));
  assert(!two.raise, "two odd spikes stay quiet");
  eq(two.crossingDays.length, 2, "and are still counted");

  const edge = measured(
    judge(slate(["2026-10-14T14:20:00Z", 7], ["2026-10-15T15:30:00Z", 7], ["2026-10-17T13:23:00Z", 7]), quietCal),
  );
  assert(!edge.raise && edge.crossingDays.length === 0, "7 is exactly a tenth of 70, not more, so it never counts");

  const sameDay = measured(
    judge(
      slate(["2026-10-14T14:20:00Z", 8], ["2026-10-14T15:30:00Z", 10], ["2026-10-14T16:00:00Z", 9], ["2026-10-15T15:30:00Z", 8]),
      quietCal,
    ),
  );
  assert(!sameDay.raise, "three busy minutes on ONE day are one day, not three");
  eq(sameDay.crossingDays.length, 2, "two different days");
  const d14 = sameDay.crossingDays[0]!;
  eq(new Date(d14.busiest.atMs).toISOString(), "2026-10-14T15:30:00.000Z", "a day is named by its busiest minute");
  eq(d14.busiest.total, 10, "with that minute's count");

  // Days are UTC days, said in the code: 23:59 and 00:00 UTC are two days.
  const utcEdge = measured(
    judge(slate(["2026-10-14T23:59:00Z", 8], ["2026-10-15T00:00:00Z", 8], ["2026-10-16T00:30:00Z", 8]), quietCal),
  );
  assert(utcEdge.raise, "a minute either side of UTC midnight lands on two different days");
}

// --- The two halves are added MINUTE BY MINUTE ----------------------------------------
{
  // 4 on Slate and 4 on cal.com in one minute is 8; in two minutes it is 4 and 4.
  const combined = measured(
    judge(
      slate(["2026-10-14T14:20:00Z", 4], ["2026-10-15T15:30:00Z", 4], ["2026-10-17T13:23:00Z", 4]),
      calcom(
        ...times("2026-10-14T14:20:05Z", 4),
        ...times("2026-10-15T15:30:59Z", 4),
        ...times("2026-10-17T13:23:30Z", 4),
      ),
    ),
  );
  assert(combined.raise, "4 on Slate plus 4 on cal.com in the same minute is 8, on three days");
  const first = combined.crossingDays[0]!.busiest;
  eq([first.total, first.slate, first.calcom], [8, 4, 4], "each half's share of the minute is kept for the alert to say");

  const apart = measured(
    judge(
      slate(["2026-10-14T14:20:00Z", 4], ["2026-10-15T15:30:00Z", 4], ["2026-10-17T13:23:00Z", 4]),
      calcom(...times("2026-10-14T14:21:00Z", 4), ...times("2026-10-15T15:31:00Z", 4), ...times("2026-10-17T13:24:00Z", 4)),
    ),
  );
  assert(!apart.raise && apart.crossingDays.length === 0, "4 and 4 in neighbouring minutes is never 8");

  // The measured case Dan named: 7 on cal.com, 0 on Slate, at the old bar of 60.
  const calOnly = measured(
    judge(
      slate(["2026-10-15T09:00:00Z", 1]),
      calcom(...times("2026-10-14T14:20:10Z", 7), ...times("2026-10-15T13:23:00Z", 7), ...times("2026-10-16T12:00:00Z", 7)),
      60,
    ),
  );
  assert(calOnly.raise, "a minute busy only on cal.com counts: Slate alone would have missed the peak");
  eq(calOnly.threshold, 7, "at a bar of 60 the threshold is 7");

  // A response read twice (cal.com's paging shifted under a new arrival) counts once.
  const dup = { id: "dup", createdAt: "2026-10-14T14:20:10Z" };
  const twice = measured(
    judge(slate(["2026-10-14T14:20:00Z", 6]), { kind: "read", routed: [dup, dup, ...routed("2026-10-16T10:00:00Z")] }),
  );
  eq(twice.busiest?.total, 7, "the same cal.com response read twice is one booking, so 6 plus 1 is 7, not 8");
  eq(twice.crossingDays.length, 0, "and the minute does not cross");

  // cal.com's read has no upper bound, so today's responses and anything before the
  // window must not land in it.
  const edges = measured(
    judge(
      slate(["2026-10-14T14:20:00Z", 1]),
      calcom(...times("2026-10-20T01:00:00Z", 9), ...times("2026-10-12T23:59:59Z", 9), "2026-10-15T10:00:00Z"),
    ),
  );
  eq(edges.crossingDays.length, 0, "a response from today or before the window is left out");
  eq(edges.calcomRouted, 1, "and only the one inside it is counted");
}

// --- A half that could not be counted is never a quiet week ----------------------------
{
  const busySlate = slate(["2026-10-14T14:20:00Z", 9], ["2026-10-15T15:30:00Z", 9], ["2026-10-17T13:23:00Z", 9]);
  const reasonsOf = (v: BusyVerdict): string[] => (v.kind === "unmeasured" ? v.reasons.map((r) => r.kind) : []);

  const partial = judge(busySlate, { kind: "unreadable", status: 429, formName: "Debt relief" });
  eq(partial.kind, "unmeasured", "a cal.com page refused part way is not a count, even when Slate alone already crosses");
  eq(reasonsOf(partial), ["calcom-unreadable"], "and says it was cal.com's read");

  const threw = judge(busySlate, { kind: "unreadable", status: 0 });
  eq(reasonsOf(threw), ["calcom-unreadable"], "a cal.com read that never answered is the same");

  const failedSlate = judge({ ok: false }, quietCal);
  eq(failedSlate.kind, "unmeasured", "a failed Slate read is not a week with no Slate bookings");
  eq(reasonsOf(failedSlate), ["slate-unreadable"], "and says it was Slate's read");

  eq(reasonsOf(judge({ ok: false }, { kind: "unreadable", status: 500 })), ["slate-unreadable", "calcom-unreadable"], "both failures are named, not only the first");

  // Before cutover cal.com is most of the traffic, so an empty cal.com while it is not
  // marked retired is a read gone wrong, not a quiet cal.com.
  const emptyLive = judge(busySlate, { kind: "read", routed: [] });
  eq(reasonsOf(emptyLive), ["calcom-empty"], "an empty cal.com half while cal.com is live reads as could not count");
  const onlyOutside = judge(busySlate, calcom("2026-10-20T01:00:00Z"));
  eq(reasonsOf(onlyOutside), ["calcom-empty"], "and so does one whose only responses fall outside the window");

  eq(reasonsOf(judge(busySlate, { kind: "not-configured" })), ["calcom-not-configured"], "no cal.com key while cal.com is not retired cannot count");
  eq(reasonsOf(judge(busySlate, { kind: "retired-unknown" })), ["calcom-retired-unknown"], "an unreadable retired switch cannot say whether cal.com belongs in the count");

  const badStamp = judge(busySlate, { kind: "read", routed: [{ id: "x", createdAt: "not a time" }, ...routed("2026-10-15T10:00:00Z")] });
  eq(reasonsOf(badStamp), ["calcom-bad-stamp"], "a routed response with an unreadable time is a booking the count would lose");
}

// --- After cutover: cal.com retired, Slate alone ---------------------------------------
{
  const after = measured(
    judge(slate(["2026-10-14T14:20:00Z", 8], ["2026-10-15T15:30:00Z", 8], ["2026-10-17T13:23:00Z", 8]), { kind: "retired" }),
  );
  assert(after.raise, "with cal.com retired Slate's own minutes are the whole count");
  assert(!after.calcomCounted, "and the verdict says cal.com was not part of it");

  const nothing = judge(slate(), { kind: "retired" });
  eq(nothing.kind, "unmeasured", "a week with no routed booking anywhere is not a quiet week");
  eq(nothing.kind === "unmeasured" ? nothing.reasons.map((r) => r.kind) : [], ["nothing-counted"], "it says nothing was counted");
}

// --- What a run does with each verdict ---------------------------------------------------
{
  const unmeasured = judge({ ok: false }, quietCal);
  const first = planBusyMinutesActions(unmeasured, { finalAttempt: false });
  eq(first, { pageUnread: false, resolveUnread: false, pageOutgrown: false, resolveOutgrown: false, stampVerdict: false }, "a first attempt that could not count waits for the retry and touches nothing");
  const last = planBusyMinutesActions(unmeasured, { finalAttempt: true });
  eq(last, { pageUnread: true, resolveUnread: false, pageOutgrown: false, resolveOutgrown: false, stampVerdict: false }, "the day's last attempt says it could not count, and clears nothing");

  const raise = measured(judge(slate(["2026-10-14T14:20:00Z", 8], ["2026-10-15T15:30:00Z", 8], ["2026-10-17T13:23:00Z", 8]), quietCal));
  eq(planBusyMinutesActions(raise, { finalAttempt: false }), { pageUnread: false, resolveUnread: true, pageOutgrown: true, resolveOutgrown: false, stampVerdict: true }, "a measured crossing says so, ends any could not count page and stamps the verdict");
  const quiet = measured(judge(slate(["2026-10-14T14:20:00Z", 8]), quietCal));
  eq(planBusyMinutesActions(quiet, { finalAttempt: true }), { pageUnread: false, resolveUnread: true, pageOutgrown: false, resolveOutgrown: true, stampVerdict: true }, "the all clear hangs off a measured quiet week only");
}

// --- The schedule: a first run and its retry, each on its own expression ---------------
{
  eq(BUSY_MINUTES_CRONS, ["41 5 * * *", "41 9 * * *"], "05:41 and 09:41 UTC, at night ET so cal.com's shared rate limit is idle");
  for (const cron of BUSY_MINUTES_CRONS) {
    eq(CRON_ROUTES[cron], BUSY_MINUTES_ROUTE, `${cron} drives ${BUSY_MINUTES_ROUTE} and nothing else`);
  }
  assert(!isFinalAttempt(at("2026-10-20T05:41:30Z")), "the 05:41 run is not the day's last attempt");
  assert(!isFinalAttempt(at("2026-10-20T08:59:59Z")), "nor is anything before the retry hour");
  assert(isFinalAttempt(at("2026-10-20T09:41:30Z")), "the 09:41 run is");
  assert(isFinalAttempt(at("2026-10-20T09:00:00Z")), "and so is an early start of it");
  assert(alreadyMeasuredToday(at("2026-10-20T05:42:00Z"), at("2026-10-20T09:41:00Z")), "a verdict this UTC day stands the retry down");
  assert(!alreadyMeasuredToday(at("2026-10-19T23:59:00Z"), at("2026-10-20T09:41:00Z")), "yesterday's does not");
  assert(!alreadyMeasuredToday(null, at("2026-10-20T09:41:00Z")), "nor does none at all");
}

// --- The words ------------------------------------------------------------------------
{
  const raise = measured(
    judge(
      slate(["2026-10-14T14:20:00Z", 4], ["2026-10-15T15:30:00Z", 9], ["2026-10-17T13:23:00Z", 8]),
      calcom(...times("2026-10-14T14:20:30Z", 5)),
    ),
  );
  const text = loadBarOutgrownAlert(raise);
  assert(!/^\s*Slate\b/i.test(text), "the alert does not open with Slate, which Slack already shows");
  for (const want of ["70 a minute", "8 or more", "3 of the last 7 days", "#3124"]) {
    assert(text.includes(want), `the alert says "${want}": ${text}`);
  }
  for (const when of ["Oct 14 at 10:20am ET", "Oct 15 at 11:30am ET", "Oct 17 at 9:23am ET"]) {
    assert(text.includes(when), `the alert names the busy minute ${when} in ET: ${text}`);
  }
  assert(/raise the booking load run's bar/i.test(text) && /rerun/i.test(text), "and says what to do");
  assert(text.includes("4 on Slate and 5 on cal.com"), "and how the minute splits between the two systems");

  const retired = measured(
    judge(slate(["2026-10-14T14:20:00Z", 8], ["2026-10-15T15:30:00Z", 8], ["2026-10-17T13:23:00Z", 8]), { kind: "retired" }),
  );
  assert(/Slate alone/i.test(loadBarOutgrownAlert(retired)), "after cutover it says the count is Slate's alone");

  const recovery = loadBarOutgrownRecovery(measured(judge(slate(["2026-10-14T14:20:00Z", 8]), quietCal)));
  assert(recovery.includes("1 of the last 7 days") && recovery.includes("70 a minute"), `the all clear says what it measured: ${recovery}`);

  const unread = judge({ ok: false }, { kind: "unreadable", status: 429, formName: "Debt relief" });
  if (unread.kind !== "unmeasured") throw new Error("fixture");
  const u = loadBarUnreadAlert(unread.reasons);
  assert(/could not count/i.test(u), `the could not count page says so: ${u}`);
  assert(u.includes("429") && u.includes("Debt relief"), "names the refused form and its status");
  assert(/Slate's own bookings could not be read/i.test(u), "and Slate's half");
  assert(!u.includes("{") && !u.includes("Error:"), "with no raw error in it");
  const empty = judge(slate(["2026-10-15T10:00:00Z", 1]), { kind: "read", routed: [] });
  if (empty.kind !== "unmeasured") throw new Error("fixture");
  assert(/mark(ed)? .*retired/i.test(loadBarUnreadAlert(empty.reasons)), "an empty cal.com while live points at the retired switch");
  assert(loadBarUnreadRecovery().length > 0 && !/^\s*Slate\b/.test(loadBarUnreadRecovery()), "the could not count all clear reads on its own");
}

finish();
