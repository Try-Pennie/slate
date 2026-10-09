// The debt tier staffing alarm (#2505). Run:
//        node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-tier-staffing.ts
import {
  TIER_STAFFING_ALERT_KEY,
  tierStaffingKey,
  judgeTier,
  planTierAlerts,
  planTierRecovery,
  tierHoldKey,
  tierUnstaffedMessage,
  tierNoSlotsMessage,
  tierRecoveredMessage,
  type TierReading,
  type TierAlertState,
  type TierRecoveryPolicy,
} from "../src/lib/monitor/tier-staffing.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.UTC(2026, 8, 17, 14, 0);
const WINDOW_END = NOW + 36 * 3600_000;
const DAYS = ["2026-09-17", "2026-09-18", "2026-09-19"];

function reading(over: Partial<TierReading> = {}): TierReading {
  return {
    tier: "5",
    label: "Ultra High",
    agents: { measured: true, count: 5 },
    slots: { measured: true, firstSlotMs: NOW + 3600_000, offeredMs: [NOW + 3600_000] },
    window: { measured: true, endMs: WINDOW_END, days: DAYS },
    ...over,
  };
}

// --- the healthy day, which is every day on today's roster -------------------
//
// This is the case that must stay silent, and it is also the case that makes the
// alarm indistinguishable from a broken one, which is why every branch below is
// driven in BOTH directions (L1).
eq(judgeTier(reading()).kind, "serving", "a tier offering a time inside the window is serving");

// A slot beyond the window is not a slot in the window.
eq(
  judgeTier(reading({ slots: { measured: true, firstSlotMs: WINDOW_END + 60_000, offeredMs: [WINDOW_END + 60_000] } })).kind,
  "no-slots",
  "a tier whose first time is past the window is not serving",
);
// And the boundary itself counts as inside, so a tier offering the very last
// minute of the next open day is not paged about.
eq(
  judgeTier(reading({ slots: { measured: true, firstSlotMs: WINDOW_END, offeredMs: [WINDOW_END] } })).kind,
  "serving",
  "the window end is inside the window",
);

// --- the two findings, which must never share a message (L11) ----------------
//
// No times has two opposite repairs: hire somebody or tag them, against fix a
// schedule or a calendar. A single "this tier is offering nothing" sentence would
// send half the readers to do the wrong thing.
eq(
  judgeTier(
    reading({ agents: { measured: true, count: 0 }, slots: { measured: true, firstSlotMs: null, offeredMs: [] } })
  ).kind,
  "unstaffed",
  "a tier with nobody assigned is unstaffed",
);
eq(
  judgeTier(
    reading({ agents: { measured: true, count: 4 }, slots: { measured: true, firstSlotMs: null, offeredMs: [] } })
  ).kind,
  "no-slots",
  "a tier with agents and no times is a different finding",
);

// A tier with NOBODY that is somehow still offering times is SERVING, and says so
// rather than paging: whatever the roster read thinks, a lead can book. The two
// disagreeing is a fault, but it is not one a lead is suffering from, and paging
// on it would be an alarm about our own bookkeeping worded as a customer outage.
eq(
  judgeTier(reading({ agents: { measured: true, count: 0 } })).kind,
  "serving",
  "a tier offering times is serving even when the roster read says nobody",
);

// --- an unmeasured tier concludes NOTHING, in either direction ---------------
//
// Zero and unreadable are different facts (L215). A tier whose reads failed must
// not page (it may be perfectly healthy) and must not clear (it may be dead), and
// the reason names WHICH read, because "could not check" sends somebody to a
// different place depending on which half is broken.
for (const [over, want] of [
  [{ agents: { measured: false } as const }, "roster"],
  [{ slots: { measured: false } as const }, "times"],
] as const) {
  const v = judgeTier(reading(over));
  eq(v.kind, "unmeasured", `an unreadable ${want} read concludes nothing`);
  assert(
    v.kind === "unmeasured" && v.why.includes(want),
    `and the reason names ${want} (got ${v.kind === "unmeasured" ? v.why : v.kind})`,
  );
}
// #3559: the window is the booker's own, read off the tier's cached event type. A
// tier whose window could not be worked out is judged against nothing, so it
// concludes nothing either way, and the reason says so.
{
  const v = judgeTier(reading({ window: { measured: false } }));
  eq(v.kind, "unmeasured", "an unreadable window concludes nothing");
  assert(v.kind === "unmeasured" && v.why.includes("window"), `and the reason names the window (got ${JSON.stringify(v)})`);
  // Even a tier with no times at all: paging it against a guessed window would
  // hold it to days nobody can see (L215).
  eq(
    judgeTier(reading({ window: { measured: false }, slots: { measured: true, firstSlotMs: null, offeredMs: [] } })).kind,
    "unmeasured",
    "an unreadable window never pages",
  );
}
// Each tier carries its OWN window, as the booker computes one per pool from that
// pool's notice. A time inside one tier's window is past another's.
{
  const t = NOW + 30 * 3600_000;
  const slots = { measured: true, firstSlotMs: t, offeredMs: [t] } as const;
  const plan = planTierAlerts([
    reading({ tier: "1", label: "Low", slots }),
    reading({ tier: "2", label: "Medium", slots, window: { measured: true, endMs: NOW + 20 * 3600_000, days: DAYS.slice(0, 1) } }),
  ]);
  eq(plan.recovered.map((r) => r.tier).join(","), "1", "the tier whose window reaches the time is serving");
  eq(plan.page.map((p) => p.tier).join(","), "2", "and the tier whose window stops short of it pages");
}

// Both unreadable names both, rather than the first it happened to check (L679).
{
  const v = judgeTier(reading({ agents: { measured: false }, slots: { measured: false } }));
  assert(
    v.kind === "unmeasured" && v.why.includes("roster") && v.why.includes("times"),
    "both unreadable names both reads",
  );
}

// --- the plan: which tiers page, which clear, which are left alone -----------
{
  const plan = planTierAlerts(
    [
      reading({ tier: "1", label: "Low" }),
      reading({
        tier: "5",
        label: "Ultra High",
        agents: { measured: true, count: 0 },
        slots: { measured: true, firstSlotMs: null, offeredMs: [] },
      }),
      reading({
        tier: "4",
        label: "Very High",
        agents: { measured: true, count: 19 },
        slots: { measured: true, firstSlotMs: null, offeredMs: [] },
      }),
      reading({ tier: "3", label: "High", agents: { measured: false } }),
    ]
  );
  eq(plan.page.map((p) => p.tier).sort().join(","), "4,5", "the two findings page");
  eq(plan.recovered.map((c) => c.tier).join(","), "1", "only the MEASURED healthy tier clears");
  eq(plan.unmeasured.join(","), "3", "the unreadable tier is named and left alone");
  // The clear list is what an all-clear is hung off, and a tier nobody could read
  // must never reach it: that is the #1152 defect, a recovery announced off a run
  // that measured nothing.
  assert(
    !plan.recovered.some((c) => c.tier === "3"),
    "a tier that could not be read never clears",
  );
  assert(plan.page.every((p) => p.kind === "unstaffed" || p.kind === "no-slots"), "every page carries its kind");
}

// A run where NOTHING could be read pages nothing and clears nothing.
{
  const plan = planTierAlerts(
    ["1", "2", "3", "4", "5"].map((t) => reading({ tier: t, agents: { measured: false } }))
  );
  eq(plan.page.length, 0, "a blind run pages nothing");
  eq(plan.recovered.length, 0, "and clears nothing");
  eq(plan.unmeasured.length, 5, "and says so about every tier");
  assert(!plan.measuredAny, "a blind run reports that it measured nothing");
}
// And the control the other way, so `measuredAny` is not hard wired (L1).
assert(planTierAlerts([reading()]).measuredAny, "a run that measured a tier says so");

// --- the key space ----------------------------------------------------------
eq(TIER_STAFFING_ALERT_KEY, "empty_tier", "one constant for the key");
eq(tierStaffingKey("5"), "empty_tier:5", "the key names the debt tier");
// A debt tier digit can never collide with a three digit bucket code, so the
// retired `empty_buckets:<code>` pages cannot be cleared by accident from here.
assert(!/^[1-5][0-3][0-2]$/.test("5"), "a tier digit is not a bucket code");

// --- the copy ---------------------------------------------------------------
//
// Read as sentences, because a substring assertion passes happily on "1 of 97
// bookable agent". No dashes and no emoji (copy rule), and no alert may open with
// the word Slate.
const messages = [
  tierUnstaffedMessage({ tier: "5", label: "Ultra High" }),
  tierNoSlotsMessage({ tier: "5", label: "Ultra High", agents: 5, firstSlotMs: null, days: DAYS }, { measured: false }),
  tierNoSlotsMessage({ tier: "1", label: "Low", agents: 1, firstSlotMs: null, days: DAYS }, { measured: false }),
  tierRecoveredMessage({ tier: "5", label: "Ultra High" }),
];
for (const m of messages) {
  assert(m.length > 0, "every message says something");
  assert(!/[\u2014\u2013]/.test(m), `no dashes in: ${m}`);
  assert(!/^Slate\b/.test(m), `no message opens with Slate: ${m}`);
  assert(!/undefined|NaN|\[object Object\]|null/.test(m), `nothing leaks into: ${m}`);
  assert(m.includes("Ultra High") || m.includes("Low"), `the tier is named in: ${m}`);
}
// The two findings must not read alike, or the distinction above is cosmetic.
assert(
  tierUnstaffedMessage({ tier: "5", label: "Ultra High" }) !==
    tierNoSlotsMessage({ tier: "5", label: "Ultra High", agents: 5, firstSlotMs: null, days: DAYS }, { measured: false }),
  "the two findings have different copy",
);
// The agent count agrees with its verb, which is the 2026-07-28 page this rule
// comes from ("1 of 97 bookable agent").
assert(
  /\b1 agent\b/.test(tierNoSlotsMessage({ tier: "1", label: "Low", agents: 1, firstSlotMs: null, days: DAYS }, { measured: false })),
  "one agent reads as one agent",
);
assert(
  /\b5 agents\b/.test(tierNoSlotsMessage({ tier: "5", label: "Ultra High", agents: 5, firstSlotMs: null, days: DAYS }, { measured: false })),
  "five agents read as five agents",
);
// The recovery must not claim somebody was hired when the tier simply has times
// again, and must not repeat the page's remediation (the fault is over).
assert(
  !/check|fix|add/i.test(tierRecoveredMessage({ tier: "5", label: "Ultra High" })),
  "the all clear carries no remediation",
);

// --- assembling the readings from the lane's two reads -----------------------
//
// The assembly is where a failed read turns into `measured: false` rather than a
// zero, so it is driven directly for every combination.
{
  const { tierReadings, DEBT_TIERS } = await import("../src/lib/monitor/tier-staffing-load.ts");
  eq(DEBT_TIERS.join(","), "1,2,3,4,5", "the five debt tiers come from the shared vocabulary");

  const counts = new Map([["1", 75], ["2", 66], ["3", 43], ["4", 19], ["5", 5]]);
  const health = new Map(
    // The tier's WHOLE pool code, which is what the alarm asks about.
    ["111", "211", "311", "411", "511"].map((code) => [
      code,
      { slotCount: 3, computedAtMs: NOW, firstSlotMs: NOW + 3600_000, offeredMs: [NOW + 3600_000, NOW + 7200_000, NOW + 10_800_000], slotCountWithoutLow: null },
    ]),
  );

  const windows = new Map(["1", "2", "3", "4", "5"].map((t) => [t, { measured: true as const, endMs: WINDOW_END, days: DAYS }]));
  const healthy = tierReadings({ agentCounts: counts, slotByCode: health, windows });
  eq(healthy.length, 5, "one reading per debt tier");
  eq(healthy[4].label, "Ultra High", "the label comes from the shared vocabulary");
  assert(
    healthy.every((r) => r.agents.measured && r.slots.measured),
    "a run where both reads came back measures every tier",
  );
  eq(
    planTierAlerts(healthy).page.length,
    0,
    "today's production shape pages nothing",
  );

  // An unreadable ROSTER measures no tier, and must not arrive as zero agents.
  const noRoster = tierReadings({ agentCounts: null, slotByCode: health, windows });
  assert(noRoster.every((r) => !r.agents.measured), "a failed roster read measures no tier");
  const blindRoster = planTierAlerts(noRoster);
  eq(blindRoster.page.length, 0, "and pages nothing");
  // THE SILENT PATH: a tick that could not read its signal announces no recovery
  // (#1134, #1152). This is the assertion `test-all-clear-failure-coverage.ts`
  // requires the monitor lane's all-clear-proof to point at.
  eq(blindRoster.recovered.length, 0, "and clears nothing");

  // An unreadable SLOT map is the same, by the other half.
  const noSlots = tierReadings({ agentCounts: counts, slotByCode: null, windows });
  assert(noSlots.every((r) => !r.slots.measured), "a failed slot read measures no tier");

  // A tier with no cached row for its pool code is UNMEASURED, not "offering
  // nothing": nothing said what it is offering, so nothing may be concluded.
  const missingRow = tierReadings({
    agentCounts: counts,
    slotByCode: new Map([...health].filter(([c]) => c !== "511")),
    windows,
  });
  const ultra = missingRow.find((r) => r.tier === "5")!;
  assert(!ultra.slots.measured, "a tier with no cached row is unmeasured");
  eq(
    planTierAlerts(missingRow).unmeasured.join(","),
    "5",
    "and is named as unmeasured rather than paged",
  );

  // A row whose count could not be judged (a payload with no duration) is
  // unmeasured too, rather than reading as zero slots.
  const unjudgeable = tierReadings({
    agentCounts: counts,
    slotByCode: new Map([...health, ["511", { slotCount: null, computedAtMs: NOW, firstSlotMs: null, offeredMs: null, slotCountWithoutLow: null }]]),
    windows,
  });
  assert(
    !unjudgeable.find((r) => r.tier === "5")!.slots.measured,
    "a row that could not be judged is unmeasured",
  );

  // A tier absent from a roster map that WAS read is a real zero: no agent
  // carries that tier. That is a finding, not a blindness.
  const ultraEmpty = tierReadings({
    agentCounts: new Map([...counts].filter(([t]) => t !== "5")),
    slotByCode: new Map([...health, ["511", { slotCount: 0, computedAtMs: NOW, firstSlotMs: null, offeredMs: [], slotCountWithoutLow: null }]]),
    windows,
  });
  const plan = planTierAlerts(ultraEmpty);
  eq(plan.page.map((p) => `${p.tier}:${p.kind}`).join(","), "5:unstaffed", "an absent tier reads as unstaffed");

  // A tier missing from the window map is unmeasured, never judged against a
  // neighbour's window or a guess.
  const noWindow = tierReadings({ agentCounts: counts, slotByCode: health, windows: new Map([...windows].filter(([t]) => t !== "5")) });
  eq(planTierAlerts(noWindow).unmeasured.join(","), "5", "a tier with no window is unmeasured");
}

// --- the window each tier is judged over, from its cached pool row (#3559) ---
{
  const { tierWindows } = await import("../src/lib/monitor/tier-staffing-load.ts");
  const HOURS = {
    zone: "America/New_York",
    rules: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_minute: 480, end_minute: 1200 })),
    exceptions: [],
  };
  // Friday 2026-10-09 at 8:11am EDT, the morning Low paged with times on Monday.
  const FRI = Date.parse("2026-10-09T12:11:00.000Z");
  const row = (code: string, minNotice: unknown) => ({ bucket_code: code, payload: { eventType: { min_notice_min: minNotice } } });
  const w = tierWindows({
    rows: [row("111", 120), row("211", 120), row("311", "soon"), row("411", 120)],
    hours: HOURS,
    nowMs: FRI,
  });
  const low = w.get("1");
  assert(low?.measured === true && low.days.join(",") === "2026-10-09,2026-10-10,2026-10-12", `Low is judged Friday, Saturday and Monday (got ${JSON.stringify(low)})`);
  // Monday 9:10am, Low's next time on 2026-10-09, is INSIDE that window, so the
  // page that fired that morning does not fire now.
  const monday = Date.parse("2026-10-12T13:10:00.000Z");
  assert(low?.measured === true && monday <= low.endMs, "Monday 9:10am is inside Low's window");
  eq(w.get("3")?.measured, false, "an unreadable notice is no window");
  eq(w.get("5")?.measured, false, "a tier with no cached row is no window");
  eq(
    tierWindows({ rows: [row("111", 120)], hours: { ...HOURS, rules: [] }, nowMs: FRI }).get("1")?.measured,
    false,
    "an org never open is no window",
  );
}

// --- how many open times a tier offers inside the window (#3227) ------------
//
// The all clear needs a COUNT, not just a first time, and it is counted from the
// same served list the first time comes from, so the two can never disagree.
{
  const v = judgeTier(
    reading({
      slots: {
        measured: true,
        firstSlotMs: NOW + 3600_000,
        offeredMs: [NOW + 3600_000, NOW + 7200_000, WINDOW_END, WINDOW_END + 60_000],
      },
    })
  );
  assert(v.kind === "serving" && v.openTimes === 3, `times inside the window are counted, the one past it is not (got ${JSON.stringify(v)})`);
  const plan = planTierAlerts([reading({ tier: "1", label: "Low" })]);
  eq(plan.recovered[0]?.openTimes, 1, "the recovered list carries the count");
}

// --- the all clear waits for a real recovery (#3227) -------------------------
//
// On 2026-10-04 Low paged, then one cancelled call opened a single Monday time and
// the all clear went out, and since an all clear also resets the cooldown, the
// next booking of that time paged again at once. L160: a condition is over only
// after a re-arm window of health, never on the first good sample.
//
// The lane is simulated with the same rules the dispatcher keeps: a page goes out
// only once its cooldown has passed and opens the page; a delivered all clear
// closes it AND resets the cooldown, which is exactly what made the flap.
const MIN = 60_000;
const POLICY: TierRecoveryPolicy = { minOpenTimes: 3, holdMs: 30 * MIN };
const PAGE_COOLDOWN = 6 * 60 * MIN;

function low(open: number | "unmeasured"): TierReading {
  if (open === "unmeasured") return reading({ tier: "1", label: "Low", slots: { measured: false } });
  const offeredMs = Array.from({ length: open }, (_, i) => NOW + 3600_000 + i * 30 * MIN);
  return reading({
    tier: "1",
    label: "Low",
    agents: { measured: true, count: 75 },
    slots: { measured: true, firstSlotMs: offeredMs[0] ?? null, offeredMs },
  });
}

function lane(policy: TierRecoveryPolicy = POLICY) {
  const st = { firing: false, cooldownUntil: 0, hold: null as number | null, pages: 0, allClears: 0, stateReadable: true };
  return {
    st,
    tick(nowMs: number, r: TierReading) {
      const plan = planTierAlerts([r]);
      for (const p of plan.page) {
        void p;
        if (nowMs >= st.cooldownUntil) {
          st.pages++;
          st.firing = true;
          st.cooldownUntil = nowMs + PAGE_COOLDOWN;
        }
      }
      const state: TierAlertState = st.stateReadable
        ? {
            readable: true,
            firing: new Set(st.firing ? ["1"] : []),
            holdSinceMs: new Map(st.hold === null ? [] : [["1", st.hold]]),
          }
        : { readable: false };
      const out = planTierRecovery(plan, state, policy, nowMs);
      for (const t of out.startHold) if (t === "1") st.hold = nowMs;
      for (const t of out.clearHold) if (t === "1") st.hold = null;
      for (const t of out.allClear) {
        if (t.tier !== "1" || !st.firing) continue;
        st.allClears++;
        st.firing = false;
        st.cooldownUntil = 0;
        st.hold = null;
      }
      return out;
    },
  };
}

// (a) one slot opening, filling and reopening is ONE page and no all clear.
{
  const l = lane();
  let t = NOW;
  for (const open of [0, 1, 0, 1, 0, 1, 0]) {
    l.tick(t, low(open));
    t += 5 * MIN;
  }
  eq(l.st.pages, 1, "a slot opening and filling on a full day pages once");
  eq(l.st.allClears, 0, "and sends no all clear");
  assert(l.st.firing, "and the page stays open");
}

// (b) the all clear goes out once N or more has held for M minutes, and not one
// tick earlier.
{
  const l = lane();
  l.tick(NOW, low(0));
  const t1 = NOW + 5 * MIN;
  l.tick(t1, low(3));
  eq(l.st.hold, t1, "reaching N with a page open starts the hold");
  for (let m = 1; m < 30; m++) l.tick(t1 + m * MIN, low(3));
  eq(l.st.allClears, 0, "nothing is cleared one tick before the hold is up");
  l.tick(t1 + 30 * MIN, low(4));
  eq(l.st.allClears, 1, "the all clear goes out once the hold is up");
  eq(l.st.hold, null, "and the hold is cleared with it");
  l.tick(t1 + 31 * MIN, low(4));
  eq(l.st.allClears, 1, "and it goes out once");
}

// (c) dipping below N inside the hold resets it, and so does a page.
{
  const l = lane();
  l.tick(NOW, low(0));
  const t1 = NOW + 5 * MIN;
  l.tick(t1, low(3));
  l.tick(t1 + 20 * MIN, low(2));
  eq(l.st.hold, null, "falling below N inside the hold resets it");
  l.tick(t1 + 25 * MIN, low(3));
  eq(l.st.hold, t1 + 25 * MIN, "and the next good tick starts it again");
  l.tick(t1 + 31 * MIN, low(3));
  eq(l.st.allClears, 0, "so the old start does not count");
  l.tick(t1 + 40 * MIN, low(0));
  eq(l.st.hold, null, "a tier back at zero drops its hold");
  eq(l.st.pages, 1, "while the page it is under stays the same page");
  l.tick(t1 + 45 * MIN, low(5));
  l.tick(t1 + 75 * MIN, low(5));
  eq(l.st.allClears, 1, "a full hold after the reset clears it");
}

// (d) an unmeasured tick neither advances nor resets the hold, and clears nothing.
{
  const l = lane();
  l.tick(NOW, low(0));
  const t1 = NOW + 5 * MIN;
  l.tick(t1, low(3));
  const out = l.tick(t1 + 10 * MIN, low("unmeasured"));
  eq(l.st.hold, t1, "an unmeasured tier leaves the hold where it was");
  eq(out.startHold.length + out.clearHold.length + out.allClear.length, 0, "and asks for nothing at all");
  l.tick(t1 + 30 * MIN, low("unmeasured"));
  eq(l.st.allClears, 0, "an unmeasured tick clears nothing, even past the hold");
  l.st.stateReadable = false;
  const blind = l.tick(t1 + 32 * MIN, low(3));
  eq(blind.startHold.length + blind.clearHold.length + blind.allClear.length, 0, "an unreadable alert state asks for nothing");
  eq(l.st.hold, t1, "and leaves the hold alone");
  l.st.stateReadable = true;
  l.tick(t1 + 33 * MIN, low(3));
  eq(l.st.allClears, 1, "the next measured tick at N clears it, because nothing reset the hold");
}
// An unmeasured tick never STARTS a hold either.
{
  const l = lane();
  l.tick(NOW, low(0));
  l.tick(NOW + 5 * MIN, low("unmeasured"));
  eq(l.st.hold, null, "an unmeasured tick starts no hold");
}

// No page open: nothing to clear and nothing to hold, and a stale hold is dropped.
{
  const out = planTierRecovery(
    planTierAlerts([low(5)]),
    { readable: true, firing: new Set(), holdSinceMs: new Map([["1", NOW - 60 * MIN]]) },
    POLICY,
    NOW,
  );
  eq(out.allClear.length, 0, "a tier with no page open sends no all clear");
  eq(out.startHold.length, 0, "and starts no hold");
  eq(out.clearHold.join(","), "1", "and a leftover hold is dropped");
}
// A hold of zero minutes clears on the first tick at N, so the setting means what it says.
{
  const l = lane({ minOpenTimes: 3, holdMs: 0 });
  l.tick(NOW, low(0));
  l.tick(NOW + MIN, low(3));
  eq(l.st.allClears, 1, "a zero minute hold clears at once");
}
// Below N with a page open is reported, so the log says why the page is still up.
{
  const out = planTierRecovery(
    planTierAlerts([low(1)]),
    { readable: true, firing: new Set(["1"]), holdSinceMs: new Map() },
    POLICY,
    NOW,
  );
  eq(out.short.map((s) => `${s.tier}:${s.openTimes}`).join(","), "1:1", "a page held open below N names its count");
}
eq(tierHoldKey("1"), "empty_tier_healthy_since:1", "the hold has its own key, away from the page and its marker");
assert(!tierHoldKey("1").startsWith(`${TIER_STAFFING_ALERT_KEY}:`), "the hold key cannot be read as a page key");

// --- the lane's wiring of the hold (#3227), driven through its seams ----------
//
// What the route does with the plan: read the state once, start and drop holds,
// send each all clear, and drop a hold only once its notice was delivered. Every
// failure path here concludes nothing rather than clearing.
{
  const { settleTierRecovery } = await import("../src/lib/monitor/tier-staffing.ts");
  function fakes(over: Partial<{ state: TierAlertState | Error; resolve: (key: string) => Promise<boolean> }> = {}) {
    const calls = { started: [] as string[], cleared: [] as string[], resolved: [] as string[], warned: [] as string[], reads: 0 };
    return {
      calls,
      deps: {
        loadState: async () => {
          calls.reads++;
          const st = over.state ?? { readable: true as const, firing: new Set(["1"]), holdSinceMs: new Map([["1", NOW - 31 * MIN]]) };
          if (st instanceof Error) throw st;
          return st;
        },
        startHolds: async (tiers: string[]) => void calls.started.push(...tiers),
        clearHolds: async (tiers: string[]) => void calls.cleared.push(...tiers),
        resolve: async (key: string) => {
          calls.resolved.push(key);
          return over.resolve ? over.resolve(key) : true;
        },
        warn: (msg: string) => void calls.warned.push(msg),
      },
    };
  }
  const healthy = planTierAlerts([low(4)]);

  // The good path: held long enough, the notice goes out and its hold is dropped.
  {
    const f = fakes();
    const out = await settleTierRecovery(healthy, POLICY, NOW, f.deps);
    eq(f.calls.resolved.join(","), "empty_tier:1", "a held tier is cleared on its page key");
    eq(f.calls.cleared.join(","), "1", "and its hold is dropped once the notice went out");
    eq(out.cleared.join(","), "1", "and the run says which tiers it cleared");
  }
  // A notice that did not go out keeps its hold, so the next tick retries it.
  for (const [what, resolve] of [
    ["was refused", async () => false],
    ["threw", async () => { throw new Error("slack down"); }],
  ] as const) {
    const f = fakes({ resolve });
    const out = await settleTierRecovery(healthy, POLICY, NOW, f.deps);
    eq(f.calls.cleared.length, 0, `a notice that ${what} keeps the hold`);
    eq(out.cleared.length, 0, `and nothing is reported cleared when the notice ${what}`);
    if (what === "threw") assert(f.calls.warned.length > 0, "and the throw is logged");
  }
  // An alert state that cannot be read sends nothing and touches no hold.
  {
    const f = fakes({ state: new Error("alert_state refused") });
    const out = await settleTierRecovery(healthy, POLICY, NOW, f.deps);
    eq(f.calls.resolved.length + f.calls.started.length + f.calls.cleared.length, 0, "an unreadable state clears nothing and holds nothing");
    eq(out.cleared.length, 0, "and reports nothing cleared");
    assert(f.calls.warned.length > 0, "and says so in the log");
  }
  // A run that measured no tier does not spend the read at all.
  {
    const f = fakes();
    await settleTierRecovery(planTierAlerts([low("unmeasured")]), POLICY, NOW, f.deps);
    eq(f.calls.reads, 0, "a blind run does not read the alert state");
    eq(f.calls.resolved.length, 0, "and clears nothing");
  }
  // A tier reaching the count for the first time starts its hold and sends nothing.
  {
    const f = fakes({ state: { readable: true, firing: new Set(["1"]), holdSinceMs: new Map() } });
    await settleTierRecovery(healthy, POLICY, NOW, f.deps);
    eq(f.calls.started.join(","), "1", "the first tick at N starts the hold");
    eq(f.calls.resolved.length, 0, "and sends no all clear yet");
  }
}

finish();
