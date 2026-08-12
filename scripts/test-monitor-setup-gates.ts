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
}

// --- each read, alone, gates exactly the checks that depend on it --------------
// The point of containing the reads: one broken read must not silence a check that
// never needed it. Every case below asserts BOTH directions.
{
  const cases: { name: keyof SetupReadiness; scan: boolean; truth: boolean }[] = [
    { name: "buckets", scan: false, truth: true },
    { name: "slotHealth", scan: false, truth: true },
    { name: "businessHours", scan: false, truth: true },
    { name: "workingHours", scan: false, truth: true },
    // The horizon is the one read BOTH need: the scan compares a probe against a
    // row computed over that window, and the probe checks the times offered inside
    // it. Guessing it would make the two sides disagree by construction (#216).
    { name: "horizonDays", scan: false, truth: false },
  ];
  for (const c of cases) {
    const g = monitorSetupGates(with_({ [c.name]: false }));
    eq(g.availabilityScan.run, c.scan, `${c.name} unreadable: availability scan runs = ${c.scan}`);
    eq(g.availabilityTruth.run, c.truth, `${c.name} unreadable: drift probe runs = ${c.truth}`);
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

// --- the readiness record must be exhaustive ----------------------------------
// A read added to the handler and forgotten here would default to "readable" and
// silently let a check judge with a guess, which is the exact defect being closed.
{
  const keys = Object.keys(ALL_SETUP_READ).sort();
  eq(
    keys.join(","),
    ["buckets", "businessHours", "horizonDays", "slotHealth", "workingHours"].join(","),
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
  });
  assert(!allDown.availabilityScan.run && !allDown.availabilityTruth.run, "both gates can block");
  const allUp = monitorSetupGates(ALL_SETUP_READ);
  assert(allUp.availabilityScan.run && allUp.availabilityTruth.run, "and both can pass");
}

finish();
