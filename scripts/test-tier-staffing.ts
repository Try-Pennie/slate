// The debt tier staffing alarm (#2505). Run:
//        node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-tier-staffing.ts
import {
  TIER_STAFFING_ALERT_KEY,
  tierStaffingKey,
  judgeTier,
  planTierAlerts,
  tierUnstaffedMessage,
  tierNoSlotsMessage,
  tierRecoveredMessage,
  type TierReading,
} from "../src/lib/monitor/tier-staffing.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.UTC(2026, 8, 17, 14, 0);
const WINDOW_END = NOW + 36 * 3600_000;

function reading(over: Partial<TierReading> = {}): TierReading {
  return {
    tier: "5",
    label: "Ultra High",
    agents: { measured: true, count: 5 },
    slots: { measured: true, firstSlotMs: NOW + 3600_000 },
    ...over,
  };
}

// --- the healthy day, which is every day on today's roster -------------------
//
// This is the case that must stay silent, and it is also the case that makes the
// alarm indistinguishable from a broken one, which is why every branch below is
// driven in BOTH directions (L1).
eq(judgeTier(reading(), WINDOW_END).kind, "serving", "a tier offering a time inside the window is serving");

// A slot beyond the window is not a slot in the window.
eq(
  judgeTier(reading({ slots: { measured: true, firstSlotMs: WINDOW_END + 60_000 } }), WINDOW_END).kind,
  "no-slots",
  "a tier whose first time is past the window is not serving",
);
// And the boundary itself counts as inside, so a tier offering the very last
// minute of the next open day is not paged about.
eq(
  judgeTier(reading({ slots: { measured: true, firstSlotMs: WINDOW_END } }), WINDOW_END).kind,
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
    reading({ agents: { measured: true, count: 0 }, slots: { measured: true, firstSlotMs: null } }),
    WINDOW_END,
  ).kind,
  "unstaffed",
  "a tier with nobody assigned is unstaffed",
);
eq(
  judgeTier(
    reading({ agents: { measured: true, count: 4 }, slots: { measured: true, firstSlotMs: null } }),
    WINDOW_END,
  ).kind,
  "no-slots",
  "a tier with agents and no times is a different finding",
);

// A tier with NOBODY that is somehow still offering times is SERVING, and says so
// rather than paging: whatever the roster read thinks, a lead can book. The two
// disagreeing is a fault, but it is not one a lead is suffering from, and paging
// on it would be an alarm about our own bookkeeping worded as a customer outage.
eq(
  judgeTier(reading({ agents: { measured: true, count: 0 } }), WINDOW_END).kind,
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
  const v = judgeTier(reading(over), WINDOW_END);
  eq(v.kind, "unmeasured", `an unreadable ${want} read concludes nothing`);
  assert(
    v.kind === "unmeasured" && v.why.includes(want),
    `and the reason names ${want} (got ${v.kind === "unmeasured" ? v.why : v.kind})`,
  );
}
// Both unreadable names both, rather than the first it happened to check (L679).
{
  const v = judgeTier(reading({ agents: { measured: false }, slots: { measured: false } }), WINDOW_END);
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
        slots: { measured: true, firstSlotMs: null },
      }),
      reading({
        tier: "4",
        label: "Very High",
        agents: { measured: true, count: 19 },
        slots: { measured: true, firstSlotMs: null },
      }),
      reading({ tier: "3", label: "High", agents: { measured: false } }),
    ],
    WINDOW_END,
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
    ["1", "2", "3", "4", "5"].map((t) => reading({ tier: t, agents: { measured: false } })),
    WINDOW_END,
  );
  eq(plan.page.length, 0, "a blind run pages nothing");
  eq(plan.recovered.length, 0, "and clears nothing");
  eq(plan.unmeasured.length, 5, "and says so about every tier");
  assert(!plan.measuredAny, "a blind run reports that it measured nothing");
}
// And the control the other way, so `measuredAny` is not hard wired (L1).
assert(planTierAlerts([reading()], WINDOW_END).measuredAny, "a run that measured a tier says so");

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
  tierNoSlotsMessage({ tier: "5", label: "Ultra High", agents: 5, firstSlotMs: null }, { measured: false }),
  tierNoSlotsMessage({ tier: "1", label: "Low", agents: 1, firstSlotMs: null }, { measured: false }),
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
    tierNoSlotsMessage({ tier: "5", label: "Ultra High", agents: 5, firstSlotMs: null }, { measured: false }),
  "the two findings have different copy",
);
// The agent count agrees with its verb, which is the 2026-07-28 page this rule
// comes from ("1 of 97 bookable agent").
assert(
  /\b1 agent\b/.test(tierNoSlotsMessage({ tier: "1", label: "Low", agents: 1, firstSlotMs: null }, { measured: false })),
  "one agent reads as one agent",
);
assert(
  /\b5 agents\b/.test(tierNoSlotsMessage({ tier: "5", label: "Ultra High", agents: 5, firstSlotMs: null }, { measured: false })),
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
      { slotCount: 3, computedAtMs: NOW, firstSlotMs: NOW + 3600_000 },
    ]),
  );

  const healthy = tierReadings({ agentCounts: counts, slotByCode: health });
  eq(healthy.length, 5, "one reading per debt tier");
  eq(healthy[4].label, "Ultra High", "the label comes from the shared vocabulary");
  assert(
    healthy.every((r) => r.agents.measured && r.slots.measured),
    "a run where both reads came back measures every tier",
  );
  eq(
    planTierAlerts(healthy, WINDOW_END).page.length,
    0,
    "today's production shape pages nothing",
  );

  // An unreadable ROSTER measures no tier, and must not arrive as zero agents.
  const noRoster = tierReadings({ agentCounts: null, slotByCode: health });
  assert(noRoster.every((r) => !r.agents.measured), "a failed roster read measures no tier");
  const blindRoster = planTierAlerts(noRoster, WINDOW_END);
  eq(blindRoster.page.length, 0, "and pages nothing");
  // THE SILENT PATH: a tick that could not read its signal announces no recovery
  // (#1134, #1152). This is the assertion `test-all-clear-failure-coverage.ts`
  // requires the monitor lane's all-clear-proof to point at.
  eq(blindRoster.recovered.length, 0, "and clears nothing");

  // An unreadable SLOT map is the same, by the other half.
  const noSlots = tierReadings({ agentCounts: counts, slotByCode: null });
  assert(noSlots.every((r) => !r.slots.measured), "a failed slot read measures no tier");

  // A tier with no cached row for its pool code is UNMEASURED, not "offering
  // nothing": nothing said what it is offering, so nothing may be concluded.
  const missingRow = tierReadings({
    agentCounts: counts,
    slotByCode: new Map([...health].filter(([c]) => c !== "511")),
  });
  const ultra = missingRow.find((r) => r.tier === "5")!;
  assert(!ultra.slots.measured, "a tier with no cached row is unmeasured");
  eq(
    planTierAlerts(missingRow, WINDOW_END).unmeasured.join(","),
    "5",
    "and is named as unmeasured rather than paged",
  );

  // A row whose count could not be judged (a payload with no duration) is
  // unmeasured too, rather than reading as zero slots.
  const unjudgeable = tierReadings({
    agentCounts: counts,
    slotByCode: new Map([...health, ["511", { slotCount: null, computedAtMs: NOW, firstSlotMs: null }]]),
  });
  assert(
    !unjudgeable.find((r) => r.tier === "5")!.slots.measured,
    "a row that could not be judged is unmeasured",
  );

  // A tier absent from a roster map that WAS read is a real zero: no agent
  // carries that tier. That is a finding, not a blindness.
  const ultraEmpty = tierReadings({
    agentCounts: new Map([...counts].filter(([t]) => t !== "5")),
    slotByCode: new Map([...health, ["511", { slotCount: 0, computedAtMs: NOW, firstSlotMs: null }]]),
  });
  const plan = planTierAlerts(ultraEmpty, WINDOW_END);
  eq(plan.page.map((p) => `${p.tier}:${p.kind}`).join(","), "5:unstaffed", "an absent tier reads as unstaffed");
}

finish();
