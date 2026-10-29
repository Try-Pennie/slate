// Which monitor checks may run when a SETUP read failed (#1395).
//
// #1281 gave each of the monitor lane's checks its own failure boundary. The reads
// at the top of the handler stayed outside it, so a throw in any of them ended the
// whole tick before a single check ran, including the availability probe and the
// cal.com override sweep, both of which exist to catch customer-visible problems.
// That was scoped out deliberately and recorded only in a merged PR description,
// which is a decision nobody will ever find.
//
// Containing them raises the question this file answers: a contained read has a
// FALLBACK, and the fallback must make the checks that needed it skip HONESTLY
// rather than judge with a guess. An unreadable bucket list scored as zero buckets
// would page the whole ladder; an unreadable week scored as an empty week would do
// the same (#1296); an unreadable horizon would have the probe compare a window
// against a different one and call the difference drift.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-monitor-setup-gates.ts
import {
  monitorSetupGates,
  ALL_SETUP_READ,
  type SetupReadiness,
} from "../src/lib/monitor/setup-gates.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const with_ = (over: Partial<SetupReadiness>): SetupReadiness => ({ ...ALL_SETUP_READ, ...over });

// --- everything readable: nothing is gated ------------------------------------
{
  const g = monitorSetupGates(ALL_SETUP_READ);
  assert(g.availabilityScan.run, "a healthy tick runs the availability scan");
  assert(g.availabilityTruth.run, "a healthy tick runs the drift probe");
  assert(g.lowVolume.run, "a healthy tick runs the low-volume alarm");
  assert(g.calendarWindow.run, "a healthy tick runs the calendar window coverage check");
  assert(g.busyDrift.run, "a healthy tick runs the busy drift sampler");
  assert(g.belowLeadTier.run, "a healthy tick runs the below lead tier check");
  assert(g.offsiteOrigin.run, "a healthy tick runs the off site origin check");
  assert(g.offeredNobodyFree.run, "a healthy tick runs the served versus confirm check");
  assert(g.bufferBreach.run, "a healthy tick runs the buffer breach check");
  assert(g.placeholderCalls.run, "a healthy tick runs the unserved placeholder call check");
  assert(g.transferQueue.run, "a healthy tick runs the transfer queue probe");
}

// --- each read, alone, gates exactly the checks that depend on it --------------
// The point of containing the reads: one broken read must not silence a check that
// never needed it. Every case below asserts BOTH directions.
{
  const cases: {
    name: keyof SetupReadiness;
    scan: boolean;
    truth: boolean;
    volume: boolean;
    /** #1262: the calendar window check judges coverage AGAINST the horizon, so
     *  only that read gates it; a guessed horizon reads a starving calendar as
     *  covered or pages about coverage nobody serves. */
    window: boolean;
    /** #1262: the drift sampler compares over the horizon window, so only that
     *  read gates it. */
    drift: boolean;
    /** #2505: the debt tier alarm needs the org's week (which is both the window
     *  it judges against and the filter the offered times are counted through)
     *  and the cached slot rows (which ARE the reading). */
    tiers: boolean;
    /** #2593: the below lead tier check reads each booked pool's tier off the
     *  shared bucket list, and the list is also what says which buckets are real,
     *  so an unreadable one must skip it rather than compare against nothing. */
    below?: boolean;
  }[] = [
    { name: "buckets", scan: false, truth: true, volume: true, window: true, drift: true, tiers: true, below: false },
    { name: "slotHealth", scan: false, truth: true, volume: true, window: true, drift: true, tiers: false },
    // #1298: the volume alarm asks whether the org is open before deciding a quiet
    // half hour is worth mentioning, and it asks the org's REAL hours now rather
    // than a second hardcoded copy. So this read gates it, and neither fallback is
    // acceptable: guessing open pages for an ordinary closed evening, guessing shut
    // silences a genuinely dead Monday morning.
    { name: "businessHours", scan: false, truth: true, volume: false, window: true, drift: true, tiers: false },
    { name: "workingHours", scan: false, truth: true, volume: true, window: true, drift: true, tiers: true },
    // The horizon is the one read BOTH availability checks need: the scan compares a
    // probe against a row computed over that window, and the probe checks the times
    // offered inside it. Guessing it would make the two sides disagree by
    // construction (#216). The volume alarm counts bookings and needs neither.
    { name: "horizonDays", scan: false, truth: false, volume: true, window: false, drift: false, tiers: true },
  ];
  for (const c of cases) {
    const g = monitorSetupGates(with_({ [c.name]: false }));
    eq(g.availabilityScan.run, c.scan, `${c.name} unreadable: availability scan runs = ${c.scan}`);
    eq(g.availabilityTruth.run, c.truth, `${c.name} unreadable: drift probe runs = ${c.truth}`);
    eq(g.lowVolume.run, c.volume, `${c.name} unreadable: low-volume alarm runs = ${c.volume}`);
    eq(g.calendarWindow.run, c.window, `${c.name} unreadable: calendar window check runs = ${c.window}`);
    eq(g.busyDrift.run, c.drift, `${c.name} unreadable: busy drift sampler runs = ${c.drift}`);
    eq(g.tierStaffing.run, c.tiers, `${c.name} unreadable: debt tier alarm runs = ${c.tiers}`);
    const below = c.below ?? true;
    eq(g.belowLeadTier.run, below, `${c.name} unreadable: below lead tier check runs = ${below}`);
    // #2715: the off site origin check needs the bucket list to tell a real bucket
    // from a test one, and nothing else.
    const offsite = c.name !== "buckets";
    eq(g.offsiteOrigin.run, offsite, `${c.name} unreadable: off site origin check runs = ${offsite}`);
    // #3381: the served versus confirm check judges what the stored rows SERVE, through
    // the org's week, so exactly those two reads stand it down; the bucket list, the
    // shifts and the horizon it does not consume must not silence it.
    const offered = c.name !== "slotHealth" && c.name !== "businessHours";
    eq(g.offeredNobodyFree.run, offered, `${c.name} unreadable: served versus confirm check runs = ${offered}`);
    // #3040: the buffer breach check judges bookings from now to the horizon, so the
    // horizon is the one read that stands it down; it reads its own bookings, event
    // types and buckets.
    const buffer = c.name !== "horizonDays";
    eq(g.bufferBreach.run, buffer, `${c.name} unreadable: buffer breach check runs = ${buffer}`);
    // #4206: the unserved placeholder call check needs the bucket list to leave the test
    // buckets' drill calls out, and nothing else.
    const placeholder = c.name !== "buckets";
    eq(g.placeholderCalls.run, placeholder, `${c.name} unreadable: unserved placeholder call check runs = ${placeholder}`);
    // #4380: the transfer queue probe reads only in the org's hours and judges the last
    // whole business day, so the org's week is the one read that stands it down.
    const transfer = c.name !== "businessHours";
    eq(g.transferQueue.run, transfer, `${c.name} unreadable: transfer queue probe runs = ${transfer}`);
  }
}

// --- a blocked gate SAYS WHAT IS MISSING --------------------------------------
// A tick that skipped has to be distinguishable from a tick that found nothing
// wrong, and "skipped" alone does not do that (L11): the reason is the whole value.
{
  const g = monitorSetupGates(with_({ buckets: false }));
  assert(!g.availabilityScan.run, "the scan is blocked");
  if (!g.availabilityScan.run) {
    assert(/bucket/i.test(g.availabilityScan.why), "and names the read that failed");
    assert(g.availabilityScan.why.length > 10, "in words, not a bare flag");
  }
}

// Several reads down at once names ALL of them, so one log line tells the whole
// story instead of sending someone back for a second tick.
{
  const g = monitorSetupGates(with_({ buckets: false, workingHours: false, horizonDays: false }));
  if (!g.availabilityScan.run) {
    const why = g.availabilityScan.why;
    assert(/bucket/i.test(why), "names the bucket list");
    assert(/hours/i.test(why), "names the working hours");
    assert(/horizon/i.test(why), "names the horizon");
  } else {
    assert(false, "the scan is blocked when three of its inputs are unreadable");
  }
}

// --- the nearly full pool whisper (#1256) --------------------------------------
// It reads the supply report, whose maximum is derived from the org's week, whose
// offered times are the cached slot rows, and whose day columns come from the
// horizon. Each of those unreadable stands it down; the bucket list, the working
// hours and the settings do not (the report degrades without the list, and a
// cooldown alone is no reason to go dark). Both directions, per read.
{
  const needs: Record<string, boolean> = {
    buckets: true,
    slotHealth: false,
    businessHours: false,
    workingHours: true,
    horizonDays: false,
    settings: true,
  };
  for (const [read, runs] of Object.entries(needs)) {
    const g = monitorSetupGates(with_({ [read]: false }));
    eq(g.poolFullness.run, runs, `${read} unreadable: nearly full pool whisper runs = ${runs}`);
  }
  assert(monitorSetupGates(ALL_SETUP_READ).poolFullness.run, "a healthy tick runs the nearly full pool whisper");
}

// --- the readiness record must be exhaustive ----------------------------------
// A read added to the handler and forgotten here would default to "readable" and
// silently let a check judge with a guess, which is the exact defect being closed.
{
  const keys = Object.keys(ALL_SETUP_READ).sort();
  eq(
    keys.join(","),
    ["buckets", "businessHours", "horizonDays", "settings", "slotHealth", "workingHours"].join(","),
    "every contained setup read has a readiness flag",
  );
  assert(
    Object.values(ALL_SETUP_READ).every((v) => v === true),
    "ALL_SETUP_READ means every read succeeded, so a test can turn one off at a time",
  );
}

// --- no gate is vacuous -------------------------------------------------------
// Both gates must be reachable in both states, or a gate wired to a constant would
// pass every assertion above while protecting nothing (L1).
{
  const allDown = monitorSetupGates({
    buckets: false,
    slotHealth: false,
    businessHours: false,
    workingHours: false,
    horizonDays: false,
    settings: false,
  });
  assert(
    !allDown.failureRate.run &&
      !allDown.awaitingActivation.run &&
      !allDown.regalCalls.run &&
      !allDown.regalCallsUnreadable.run &&
      !allDown.regalCallOutcomes.run &&
      !allDown.availabilityScan.run &&
      !allDown.availabilityTruth.run &&
      !allDown.lowVolume.run &&
      !allDown.calendarWindow.run &&
      !allDown.busyDrift.run,
    "every gate can block",
  );
  const allUp = monitorSetupGates(ALL_SETUP_READ);
  assert(
    allUp.failureRate.run &&
      allUp.awaitingActivation.run &&
      allUp.regalCalls.run &&
      allUp.regalCallsUnreadable.run &&
      allUp.regalCallOutcomes.run &&
      allUp.availabilityScan.run &&
      allUp.availabilityTruth.run &&
      allUp.lowVolume.run &&
      allUp.calendarWindow.run &&
      allUp.busyDrift.run,
    "and every gate can pass",
  );
}

// --- the monitor alert settings (#2773) ----------------------------------------
// The settings read carries every ARMED switch and the low volume floors. Its old
// fallback was the defaults, and every switch defaults to OFF, so one failed read
// quietly disarmed half the lane for a tick. Now a failure with no last known value
// stands down exactly the checks whose decision to page rests on a switch or a
// floor, and nothing else: a cooldown only paces an alarm that already decided to
// fire, so a check needing only that keeps running. Both directions, per gate.
{
  const g = monitorSetupGates(with_({ settings: false }));
  const expected: Record<keyof typeof g, boolean> = {
    // No switch and no floor: they must keep running through a settings outage.
    availabilityScan: true,
    calendarWindow: true,
    busyDrift: true,
    // #1256: a whisper whose only setting is its cooldown.
    poolFullness: true,
    tierStaffing: true,
    offsiteOrigin: true,
    // #3381: it has no arming switch, only a cooldown, so it keeps judging.
    offeredNobodyFree: true,
    // #3040: no switch, only the coded daily repeat.
    bufferBreach: true,
    // #4206: no switch, only the coded daily repeat.
    placeholderCalls: true,
    // #4380: no switch, only the coded daily repeat; its threshold is a booking setting.
    transferQueue: true,
    // An armed switch (and, for the volume alarm, the floors) decides whether each
    // of these pages, so none may judge on a guessed one.
    availabilityTruth: false,
    lowVolume: false,
    rosterCoverage: false,
    belowLeadTier: false,
    regalCallsQuiet: false,
    failureRate: false,
    awaitingActivation: false,
    regalCalls: false,
    regalCallsUnreadable: false,
    // #2944: on the same Regal arming switch.
    regalCallOutcomes: false,
  };
  for (const [name, runs] of Object.entries(expected) as [keyof typeof g, boolean][]) {
    eq(g[name].run, runs, `settings unreadable: ${name} runs = ${runs}`);
    const gate = g[name];
    if (!gate.run) assert(/alert settings/.test(gate.why), `${name} says the alert settings are what it lacks`);
  }
  // Exhaustive: a gate added later must be decided here rather than defaulting.
  eq(Object.keys(expected).sort().join(","), Object.keys(g).sort().join(","), "every gate is decided for settings");

  // And the other direction: no OTHER read takes down a check that needs only the
  // settings. Each does its own reads inside its own boundary.
  for (const read of ["buckets", "slotHealth", "businessHours", "workingHours", "horizonDays"] as const) {
    const o = monitorSetupGates(with_({ [read]: false }));
    for (const name of ["failureRate", "awaitingActivation", "regalCalls", "regalCallsUnreadable", "regalCallOutcomes"] as const) {
      assert(o[name].run, `${read} unreadable: ${name} still runs`);
    }
  }
}

finish();
