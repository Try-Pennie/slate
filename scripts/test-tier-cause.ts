// Why a debt tier has no times (#3037). Run:
//        node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-tier-cause.ts
//
// The tier alarm used to end on three possible causes ("calendars are full,
// working hours do not reach the window, or sync has stopped"). On 2026-10-02 the
// Ultra High page listed all three while the real answer was one sentence long:
// every agent was booked or off for the rest of Friday, and Saturday had one agent
// who was fully booked. These cases drive the diagnosis per agent and per day and
// read the composed page as a sentence, including the path where the extra reads
// failed, which must keep the old wording and say the cause could not be read
// rather than guessing (L215, L11).
//
// Both ends of the clock are pinned: NOW is a fixed Friday afternoon and the
// window end is DERIVED from the same business hours the lane uses, then asserted,
// so a fixture that drifted into a different day fails here rather than passing
// against the wrong window (L130).
import { DateTime } from "luxon";
import {
  diagnoseTierCause,
  isCalendarSyncStopped,
  tierCauseAgents,
  type CauseAgent,
  type CauseCalendar,
  type TierCauseInput,
} from "../src/lib/monitor/tier-cause.ts";
import { judgeTier, planTierAlerts, tierNoSlotsMessage } from "../src/lib/monitor/tier-staffing.ts";
import { nextOpenDayEndMs } from "../src/lib/booking/business-hours.ts";
import type { WorkingRule } from "../src/lib/availability/compute.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const NY = "America/New_York";
const et = (day: number, hour: number, minute = 0) =>
  DateTime.fromObject({ year: 2026, month: 10, day, hour, minute }, { zone: NY }).toMillis();

// Friday 2 October 2026, 4:30pm ET: the moment the Ultra High page fired.
const NOW = et(2, 16, 30);
eq(DateTime.fromMillis(NOW, { zone: NY }).weekday, 5, "the fixture's now is a Friday");

// The org's week: Monday to Saturday, 8am to 8pm ET, as production holds it.
const BUSINESS_HOURS = {
  zone: NY,
  rules: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_minute: 480, end_minute: 1200 })),
  exceptions: [],
};
const WINDOW_END = nextOpenDayEndMs(BUSINESS_HOURS, NOW)!;
eq(WINDOW_END, et(3, 20), "the window ends when Saturday closes at 8pm ET");

const SLOT = {
  durationMin: 20,
  bufferBeforeMin: 10,
  bufferAfterMin: 10,
  minNoticeMin: 5,
  dailyCap: null,
  businessHours: BUSINESS_HOURS,
};

const healthy: CauseCalendar[] = [
  { consecutive_failures: 0, last_success_at: new Date(NOW - 30_000).toISOString(), last_failure_kind: null },
];

function rules(weekdays: number[], start: number, end: number): WorkingRule[] {
  return weekdays.map((weekday) => ({ weekday, start_minute: start, end_minute: end }));
}
const WEEKDAYS = [1, 2, 3, 4, 5];
const WITH_SATURDAY = [1, 2, 3, 4, 5, 6];

function agent(id: string, over: Partial<CauseAgent> = {}): CauseAgent {
  return {
    id,
    timezone: NY,
    rules: rules(WEEKDAYS, 540, 1080),
    calendars: healthy,
    busy: [],
    ...over,
  };
}
const slateCall = (start: number, end: number) => ({ start, end, slateBooking: true });
const outside = (start: number, end: number) => ({ start, end, slateBooking: false });

function input(agents: CauseAgent[]): TierCauseInput {
  return {
    agents,
    slot: SLOT,
    slotIntervalMin: 10,
    businessHours: BUSINESS_HOURS,
    nowMs: NOW,
    windowEndMs: WINDOW_END,
  };
}

// --- the 2026-10-02 shape ----------------------------------------------------
//
// Six agents booked with Slate calls to the end of their Friday, one held by an
// outside meeting, three whose Friday ends at 4pm, and one Saturday agent whose
// Saturday is solid with Slate calls.
const issueRoster: CauseAgent[] = [
  ...[1, 2, 3, 4, 5].map((n) => agent(`booked${n}`, { busy: [slateCall(et(2, 16), et(2, 18))] })),
  ...[1, 2, 3].map((n) => agent(`early${n}`, { rules: rules(WEEKDAYS, 540, 960) })),
  agent("meeting", { busy: [outside(et(2, 15), et(2, 18))] }),
  agent("saturday", {
    rules: rules(WITH_SATURDAY, 540, 1080),
    busy: [slateCall(et(2, 16), et(2, 18)), slateCall(et(3, 9), et(3, 18))],
  }),
];
const issue = diagnoseTierCause(input(issueRoster));
eq(issue.total, 10, "every agent on the tier is counted");
eq(issue.syncStopped, 0, "nobody's sync has stopped");
eq(issue.days.map((d) => d.label).join("|"), "the rest of today|Saturday", "the window's two open days, named");
eq(
  issue.days.map((d) => `${d.off}/${d.slate}/${d.outside}/${d.open}`).join("|"),
  "3/6/1/0|9/1/0/0",
  "today: 3 off, 6 booked with Slate calls, 1 held; Saturday: 9 off, 1 booked",
);

const FIRST_SLOT = et(5, 11, 30);
const page = { tier: "5", label: "Ultra High", agents: 10, firstSlotMs: FIRST_SLOT };
eq(
  tierNoSlotsMessage(page, { measured: true, cause: issue }),
  "The Ultra High debt tier has no booking times until Mon, Oct 5 at 11:30am ET. " +
    "It has 10 agents. " +
    "The rest of today, only 7 of 10 work: 6 are fully booked with Slate calls and 1 is held by other meetings or time off. " +
    "Saturday, only 1 of 10 works, and they are fully booked with Slate calls. " +
    "Leads asking for Ultra High are being served by a lower tier until it clears.",
  "the 2026-10-02 page names the actual cause and the next time",
);

// --- each cause alone --------------------------------------------------------

// Nobody works in the window at all.
{
  const c = diagnoseTierCause(input([agent("a", { rules: rules(WEEKDAYS, 540, 960) }), agent("b", { rules: rules(WEEKDAYS, 540, 960) })]));
  eq(c.days.map((d) => `${d.off}/${d.slate}/${d.outside}/${d.open}`).join("|"), "2/0/0/0|2/0/0/0", "two agents off both days");
  const m = tierNoSlotsMessage({ ...page, agents: 2 }, { measured: true, cause: c });
  assert(m.includes("The rest of today, none of the 2 works."), `nobody works today reads plainly: ${m}`);
  assert(m.includes("Saturday, none of the 2 works."), `nobody works Saturday reads plainly: ${m}`);
}

// Everybody works and every one is held by outside meetings.
{
  const c = diagnoseTierCause(
    input(
      ["a", "b"].map((id) =>
        agent(id, { rules: rules(WITH_SATURDAY, 540, 1080), busy: [outside(et(2, 15), et(3, 19))] }),
      ),
    ),
  );
  eq(c.days.map((d) => `${d.off}/${d.slate}/${d.outside}/${d.open}`).join("|"), "0/0/2/0|0/0/2/0", "both held, both days");
  const m = tierNoSlotsMessage({ ...page, agents: 2 }, { measured: true, cause: c });
  assert(
    m.includes("The rest of today, both work, and both are held by other meetings or time off."),
    `all held reads as every one: ${m}`,
  );
}

// An approved time off block is a Slate row with no booking, and it is time off,
// not a Slate call.
{
  const c = diagnoseTierCause(input([agent("a", { busy: [{ start: et(2, 9), end: et(2, 18), slateBooking: false }] })]));
  eq(c.days[0].outside, 1, "a time off block reads as held, not booked");
}

// One agent, sync stopped: the whole message is about the sync.
{
  const stopped: CauseCalendar[] = [
    { consecutive_failures: 4, last_success_at: new Date(NOW - 3_600_000).toISOString(), last_failure_kind: "gone" },
  ];
  const c = diagnoseTierCause(input([agent("a", { calendars: stopped })]));
  eq(c.syncStopped, 1, "a stopped calendar is counted");
  eq(c.days.map((d) => d.off + d.slate + d.outside + d.open).join("|"), "0|0", "and is left out of the day tallies");
  const m = tierNoSlotsMessage({ ...page, agents: 1 }, { measured: true, cause: c });
  assert(m.includes("The calendar sync has stopped for its only agent"), `sync stopped is named: ${m}`);
  assert(!m.includes("The rest of today"), `no day sentence about nobody: ${m}`);
}

// An agent who looks open on a fresh check means the cached times are behind.
{
  const c = diagnoseTierCause(input([agent("a"), agent("b", { busy: [slateCall(et(2, 16), et(2, 18))] })]));
  eq(c.days[0].open, 1, "an agent with a bookable instant reads as open");
  const m = tierNoSlotsMessage({ ...page, agents: 2 }, { measured: true, cause: c });
  assert(m.includes("the offered times are behind the calendars"), `an open agent is called out: ${m}`);
}

// --- mixed causes ------------------------------------------------------------
{
  const stopped: CauseCalendar[] = [
    { consecutive_failures: 2, last_success_at: new Date(NOW - 120_000).toISOString(), last_failure_kind: "not-provisioned" },
  ];
  const c = diagnoseTierCause(
    input([
      agent("sync", { calendars: stopped }),
      agent("booked", { busy: [slateCall(et(2, 16), et(2, 18))] }),
      agent("off", { rules: rules(WEEKDAYS, 540, 960) }),
    ]),
  );
  eq(c.syncStopped, 1, "not provisioned counts as stopped through isDefinitiveFailure");
  const m = tierNoSlotsMessage({ ...page, agents: 3 }, { measured: true, cause: c });
  assert(m.includes("The calendar sync has stopped for 1 of the 3 agents"), `the sync share is named: ${m}`);
  assert(
    m.includes("The rest of today, only 1 of the other 2 works, and they are fully booked with Slate calls."),
    `the day sentence counts the other agents: ${m}`,
  );
  assert(m.includes("Saturday, none of the other 2 works."), `and so does Saturday: ${m}`);
}

// --- the sync predicate, both directions (L1) --------------------------------
eq(isCalendarSyncStopped(healthy, NOW), false, "a calendar synced a moment ago is running");
eq(isCalendarSyncStopped([], NOW), true, "no calendar at all cannot be read");
eq(
  isCalendarSyncStopped(
    [{ consecutive_failures: 2, last_success_at: new Date(NOW - 120_000).toISOString(), last_failure_kind: "transient" }],
    NOW,
  ),
  false,
  "a short transient streak with a recent success is still running",
);
eq(
  isCalendarSyncStopped(
    [{ consecutive_failures: 30, last_success_at: new Date(NOW - 40 * 60_000).toISOString(), last_failure_kind: "transient" }],
    NOW,
  ),
  true,
  "a transient streak past the staleness threshold has stopped",
);
eq(
  isCalendarSyncStopped([{ consecutive_failures: 0, last_success_at: "not a date", last_failure_kind: null }], NOW),
  true,
  "an unreadable success stamp is stopped, never fresh",
);

// --- assembling agents from the lane's reads ---------------------------------
{
  const agents = tierCauseAgents({
    agentIds: ["a", "b"],
    shiftFor: (id) => ({ timezone: id === "a" ? "America/Phoenix" : NY, rules: rules(WEEKDAYS, 540, 1080) }),
    calendars: [{ user_id: "a", consecutive_failures: 0, last_success_at: healthy[0].last_success_at, last_failure_kind: null }],
    busy: [
      { user_id: "a", starts_at: new Date(et(2, 16)).toISOString(), ends_at: new Date(et(2, 17)).toISOString(), booking_id: "x" },
      { user_id: "b", starts_at: new Date(et(2, 16)).toISOString(), ends_at: new Date(et(2, 17)).toISOString(), booking_id: null },
      { user_id: "b", starts_at: "garbage", ends_at: new Date(et(2, 17)).toISOString(), booking_id: null },
    ],
  });
  eq(agents[0].timezone, "America/Phoenix", "each agent keeps their OWN zone");
  eq(agents[0].busy[0].slateBooking, true, "a block with a booking is a Slate call");
  eq(agents[1].busy[0].slateBooking, false, "a block with no booking is not");
  eq(agents[1].calendars.length, 0, "an agent with no calendar row carries none");
  // An unreadable interval must never read as free time: it blocks the whole window.
  assert(
    agents[1].busy.some((b) => b.start <= NOW && b.end >= WINDOW_END),
    "an unreadable busy row blocks rather than freeing time",
  );
}

// --- an agent judged in their own zone ---------------------------------------
//
// A Phoenix agent working 9 to 6 their time is still working at 4:40pm ET (1:40pm
// in Phoenix). Judging them in Eastern would call them off.
{
  const c = diagnoseTierCause(
    input([agent("phx", { timezone: "America/Phoenix", busy: [slateCall(et(2, 16), et(2, 21))] })]),
  );
  eq(c.days[0].slate, 1, "a Phoenix agent is working, and booked, on Friday afternoon ET");
  eq(c.days[0].off, 0, "and is not read as off");
}

// --- the failed read fallback ------------------------------------------------
//
// The old wording stays, the next time is still named (it needs no extra read),
// and one clause says the cause could not be read. Never silence, never a guess.
{
  const m = tierNoSlotsMessage(page, { measured: false });
  assert(m.includes("their calendars are full"), `the fallback keeps the three possibilities: ${m}`);
  assert(m.includes("Mon, Oct 5 at 11:30am ET"), `and still names the next time: ${m}`);
  assert(m.includes("could not be read"), `and says the cause could not be read: ${m}`);
}
// A tier offering nothing at all in the cached horizon names that, not a time.
{
  const m = tierNoSlotsMessage({ ...page, firstSlotMs: null }, { measured: true, cause: issue });
  assert(m.startsWith("The Ultra High debt tier has no booking times anywhere"), `no next time reads as none: ${m}`);
}

// --- the page carries the tier's first offered time ---------------------------
{
  const v = judgeTier(
    { tier: "5", label: "Ultra High", agents: { measured: true, count: 10 }, slots: { measured: true, firstSlotMs: FIRST_SLOT, offeredMs: [FIRST_SLOT] } },
    WINDOW_END,
  );
  assert(v.kind === "no-slots" && v.firstSlotMs === FIRST_SLOT, "the no-slots verdict carries the first offered time");
  const plan = planTierAlerts(
    [{ tier: "5", label: "Ultra High", agents: { measured: true, count: 10 }, slots: { measured: true, firstSlotMs: FIRST_SLOT, offeredMs: [FIRST_SLOT] } }],
    WINDOW_END,
  );
  eq(plan.page[0].firstSlotMs, FIRST_SLOT, "and so does the page");
}

// --- the lane's orchestration: due first, then the reads, then the copy -------
{
  const { tierNoSlotsPageText } = await import("../src/lib/monitor/tier-cause.ts");

  // Not due: no read is made and nothing is built.
  let loads = 0;
  const notDue = await tierNoSlotsPageText(page, {
    isDue: async () => false,
    loadCauseInput: async () => {
      loads++;
      return input(issueRoster);
    },
    onCauseError: () => {},
  });
  eq(notDue, null, "a page inside its cooldown is not built");
  eq(loads, 0, "and spends no diagnostic read");

  // Due, and the reads succeed: the measured cause.
  const measured = await tierNoSlotsPageText(page, {
    isDue: async () => true,
    loadCauseInput: async () => input(issueRoster),
    onCauseError: () => {},
  });
  eq(measured, tierNoSlotsMessage(page, { measured: true, cause: issue }), "a due page carries the measured cause");

  // Due, and a read throws: the page still goes out, in the fallback wording, and
  // the error is handed on to be logged rather than swallowed.
  const errors: unknown[] = [];
  const failed = await tierNoSlotsPageText(page, {
    isDue: async () => true,
    loadCauseInput: async () => {
      throw new Error("busy_blocks read failed");
    },
    onCauseError: (err) => errors.push(err),
  });
  eq(failed, tierNoSlotsMessage(page, { measured: false }), "a failed read keeps the page, in the fallback wording");
  eq(errors.length, 1, "and reports the error once");
  assert(failed !== null && !failed.includes("fully booked"), "and never guesses a cause");

  // The cooldown read itself throws: the page is not lost and the step does not
  // fail. It goes out in the fallback wording with no diagnostic read spent (the
  // dispatcher still applies its own cooldown), and the error is reported once.
  const dueErrors: unknown[] = [];
  let dueLoads = 0;
  const dueFailed = await tierNoSlotsPageText(page, {
    isDue: async () => {
      throw new Error("alert_state read failed");
    },
    loadCauseInput: async () => {
      dueLoads++;
      return input(issueRoster);
    },
    onCauseError: (err) => dueErrors.push(err),
  });
  eq(dueFailed, tierNoSlotsMessage(page, { measured: false }), "an unreadable cooldown keeps the page, in the fallback wording");
  eq(dueLoads, 0, "and spends no diagnostic read");
  eq(dueErrors.length, 1, "and reports the error once");
}

// --- copy rules over every composed state --------------------------------------
for (const m of [
  tierNoSlotsMessage(page, { measured: true, cause: issue }),
  tierNoSlotsMessage(page, { measured: false }),
]) {
  assert(!/[\u2014\u2013]/.test(m), `no dashes in: ${m}`);
  assert(!/^Slate\b/.test(m), `no message opens with Slate: ${m}`);
  assert(!/undefined|NaN|\[object Object\]|null/.test(m), `nothing leaks into: ${m}`);
}

finish();
