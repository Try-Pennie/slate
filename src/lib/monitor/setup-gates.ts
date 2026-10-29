/**
 * Which monitor checks may run when a SETUP read failed (#1395).
 *
 * #1281 gave each of the monitor lane's checks its own failure boundary. The
 * reads at the TOP of the handler stayed outside it: the bucket list, the cached
 * slot rows, the org's business hours, the per-agent working hours, and the
 * booking horizon. A throw in any of them ended the whole tick before a single
 * check ran, which took out the availability probe and the cal.com override
 * sweep, both of which exist to catch customer-visible problems, and neither of
 * which needs most of those reads.
 *
 * Containing a read means giving it a fallback, and that is where the real
 * decision is. A fallback must make the checks that DEPENDED on the read skip
 * honestly; it must never let one judge with a guess:
 *
 *  - an unreadable bucket list scored as zero buckets pages the whole ladder;
 *  - an unreadable week scored as an empty week does the same (#1296), which is
 *    why the business-hours read already had a hand-rolled version of this;
 *  - unreadable working hours make every agent look off shift, so every bucket
 *    reads as a dead end;
 *  - an unreadable horizon has the scan compare a probe against a row computed
 *    over a DIFFERENT window and call the difference a data anomaly (#216), and
 *    has the drift probe check times outside the window it meant to check.
 *
 * So the dependency lists live here, in one pure function, beside each other and
 * node-tested (scripts/test-monitor-setup-gates.ts), rather than as five
 * conditionals spread down a thousand-line handler where the next reader cannot
 * see which check needs what.
 */

/** One flag per contained setup read: true when it was actually read. */
export interface SetupReadiness {
  /** The bucket list (`buckets`). */
  buckets: boolean;
  /** The cached slot rows, judged against the org's week (`slotByCode`). */
  slotHealth: boolean;
  /** The org's business hours for this week. */
  businessHours: boolean;
  /** Per-agent working hours and rules, for the on-shift gate. */
  workingHours: boolean;
  /** The org's booking horizon in days. */
  horizonDays: boolean;
  /**
   * The monitor alert settings (#2773): every ARMED switch and the low volume
   * floors. False only when the read failed AND this isolate holds no last known
   * value to fall back on; a failure with one is served from it and reads as true.
   */
  settings: boolean;
}

/** Every read succeeded. Also the base a test mutates one flag at a time. */
export const ALL_SETUP_READ: SetupReadiness = {
  buckets: true,
  slotHealth: true,
  businessHours: true,
  workingHours: true,
  horizonDays: true,
  settings: true,
};

/**
 * Run, or do not run and say what is missing.
 *
 * The reason is not decoration. A check that skipped and a check that found
 * nothing wrong are the same silence, and telling them apart afterwards is what
 * cost a day on #1377. `why` is what the lane logs and what the response reports.
 */
export type SetupGate = { run: true } | { run: false; why: string };

/** Human names, so a skip reason reads as a sentence rather than a field list. */
const READ_NAMES: Record<keyof SetupReadiness, string> = {
  buckets: "the bucket list",
  slotHealth: "the cached slot rows",
  businessHours: "the org's business hours",
  workingHours: "the agents' working hours",
  horizonDays: "the booking horizon",
  settings: "the monitor alert settings",
};

function gate(readiness: SetupReadiness, needs: (keyof SetupReadiness)[]): SetupGate {
  const missing = needs.filter((k) => !readiness[k]);
  if (missing.length === 0) return { run: true };
  // EVERY missing read, not just the first. When a shared outage takes several
  // down at once, naming one sends the reader back for a second tick to discover
  // the rest.
  const names = missing.map((k) => READ_NAMES[k]);
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return { run: false, why: `could not read ${list}` };
}

/**
 * What this tick may check, given which setup reads came back.
 *
 * Only the checks that consume setup state are gated. The others do their own
 * reads inside their own boundaries and are deliberately absent: the whole point
 * is that a failure up here stops touching them.
 */
export function monitorSetupGates(readiness: SetupReadiness): {
  availabilityScan: SetupGate;
  availabilityTruth: SetupGate;
  lowVolume: SetupGate;
  rosterCoverage: SetupGate;
  calendarWindow: SetupGate;
  busyDrift: SetupGate;
  poolFullness: SetupGate;
  tierStaffing: SetupGate;
  belowLeadTier: SetupGate;
  offsiteOrigin: SetupGate;
  regalCallsQuiet: SetupGate;
  failureRate: SetupGate;
  awaitingActivation: SetupGate;
  regalCalls: SetupGate;
  regalCallsUnreadable: SetupGate;
  regalCallOutcomes: SetupGate;
  offeredNobodyFree: SetupGate;
  bufferBreach: SetupGate;
  placeholderCalls: SetupGate;
  transferQueue: SetupGate;
} {
  return {
    // The scan compares every bucket's cached slot count against a live recompute,
    // judged inside the org's week and the agents' shifts, over the horizon the
    // rows were computed for. It needs all five.
    availabilityScan: gate(readiness, [
      "buckets",
      "slotHealth",
      "businessHours",
      "workingHours",
      "horizonDays",
    ]),
    // The drift probe reads what ONE bucket is offering straight from the slot
    // cache and checks it against live Google, so it needs neither the bucket list
    // nor the shift gate. It does need the horizon, because that is the window it
    // asks for: guessing it would check times the bucket is not offering.
    //
    // #2773: and the settings, because `availability_drift_armed` decides whether a
    // drift it finds pages. Every gate below that names "settings" has the same
    // reason: the switch (and for the volume alarm the floors) is the decision to
    // page, and its default is OFF, so judging on a guessed one is the silent
    // disarm this gate exists to prevent. A check needing only a COOLDOWN is not
    // gated on it: a cooldown paces an alarm that has already decided to fire.
    availabilityTruth: gate(readiness, ["horizonDays", "settings"]),
    // #1298: the volume alarm asks "is the org open right now" before deciding that
    // a quiet half hour is worth mentioning, and it now asks the org's REAL hours
    // rather than a second hardcoded copy of them. So it depends on that read, and
    // must SKIP when it fails rather than fall back to a guessed window: guessing
    // open would page for an ordinary closed evening, and guessing shut would
    // silence a genuinely dead Monday morning. Neither is a measurement.
    //
    // #2773: and the settings, which carry both its arming switch and its floors.
    lowVolume: gate(readiness, ["businessHours", "settings"]),
    // #1454: holds the org's advertised week against the union of the agents'
    // rostered hours. It needs both, and must skip on either, for OPPOSITE
    // reasons: with no advertised week there is nothing to hold the roster
    // against, and with no working hours every agent looks off shift, so the
    // whole week would report as uncovered. That second one is the dangerous
    // direction, because being wrong there is indistinguishable from the very
    // finding this check exists to report.
    //
    // #1936: and the horizon, because the range it judges runs from today through
    // the booking horizon plus a week, and the horizon is what splits a live gap
    // (leads are being turned away) from an upcoming one (there is time). A guessed
    // horizon would page a week out gap as live, or quietly file a live one as
    // something that can wait.
    rosterCoverage: gate(readiness, ["businessHours", "workingHours", "horizonDays", "settings"]),
    // #1262: whether every bookable agent's calendar is hydrated past the live
    // booking horizon. The horizon IS the bound being checked, so it must skip
    // when that read fails rather than judge against a guessed window: a guessed
    // shorter horizon reads a starving calendar as covered, and a guessed longer
    // one pages about coverage nobody is serving (#216's shape).
    calendarWindow: gate(readiness, ["horizonDays"]),
    // #1262, #1591: the busy drift sampler (armed report only) compares the cache against live
    // Google over the horizon window. The window IS the comparison's bound, so a
    // guessed horizon has it judging times the cache was never asked to hold and
    // logging the difference as drift (#216's shape, in a log line).
    busyDrift: gate(readiness, ["horizonDays"]),
    // #1256: the nearly full pool whisper reads the supply report (#1254). Every
    // maximum in it is derived from the org's week, the offered times ARE the cached
    // slot rows, and the horizon sets the report's day columns and each pool's own
    // allowance, so a guess at any of the three changes what every share means while
    // it still looks normal. The bucket list is not needed: the report falls back to
    // the cache's own codes. Its cooldown alone is no reason to go dark.
    poolFullness: gate(readiness, ["slotHealth", "businessHours", "horizonDays"]),
    // #2505: does each DEBT TIER offer a bookable time inside the next open
    // business day? It needs the org's week twice over, so it must skip on it
    // rather than guess: the week is where the WINDOW comes from (the next open
    // day, so a closed Sunday is skipped rather than paged about), and it is also
    // the filter the offered times are counted through, so a guessed week would
    // have the alarm judging a tier against times no lead is being shown.
    //
    // And on the cached slot rows, because they ARE the reading. An unreadable
    // slot map would leave every tier unmeasured, which the judge reports honestly
    // but which is not worth a run: skipping says the same thing once, in the
    // lane's own words, instead of five times.
    tierStaffing: gate(readiness, ["businessHours", "slotHealth"]),
    // #2593: holds each upcoming booking's pool tier against the lead's Salesforce
    // tier. The bucket list is where a pool's tier comes from AND which buckets are
    // real rather than the smoke canary's, so it must skip without it: with no
    // list every booking would be unmeasurable, which reads as a quiet day.
    belowLeadTier: gate(readiness, ["buckets", "settings"]),
    // #2715: a real bucket booking from a host page that is not the production
    // site. The bucket list is what says which buckets are REAL, and the test ones
    // are exactly where off site hosts belong, so it must skip without it: guessing
    // every bucket real pages about every partner test, and guessing none real
    // silences the check.
    offsiteOrigin: gate(readiness, ["buckets"]),
    // #2090: "no call from a Slate user across a whole business day" needs the
    // org's week to know which day was the last whole one, and a closed Sunday or
    // a holiday must be skipped rather than judged. So it skips on an unreadable
    // week rather than guess: guessing open pages about a Sunday nobody worked,
    // and guessing shut silences a genuinely dead Monday. The Regal call detector
    // and the unreadable event alarm read the feed alone and are not gated.
    regalCallsQuiet: gate(readiness, ["businessHours", "settings"]),
    // #2773: four checks that do every read of their own and consume no other
    // setup state, but whose decision to page is an armed switch from the
    // settings: the booking failure rate page, the waiting to become bookable
    // page, the Regal call detector and the unreadable Regal events alarm.
    failureRate: gate(readiness, ["settings"]),
    awaitingActivation: gate(readiness, ["settings"]),
    regalCalls: gate(readiness, ["settings"]),
    regalCallsUnreadable: gate(readiness, ["settings"]),
    // #2944: the call outcome ratio does both of its reads itself, and pages on the
    // same Regal arming switch as the three checks above.
    regalCallOutcomes: gate(readiness, ["settings"]),
    // #3381: judges SERVED times with the confirm's own candidate read. The cached slot
    // rows ARE what is served, and the org's week is the filter every served list passes
    // through, so it must skip on either rather than guess: an unreadable row map would
    // judge nothing (and must not read as a quiet day), and a guessed week would have it
    // judging times no lead is being shown. The pools and the candidate reads it does
    // itself, inside its own step.
    offeredNobodyFree: gate(readiness, ["slotHealth", "businessHours"]),
    // #3040: two active calls on one advisor closer than the buffers. It judges the
    // bookings from now to the booking horizon, so the horizon IS its window: a
    // guessed shorter one would post an all clear over pairs it never read, and a
    // guessed longer one would page about calls past what the booker offers. The
    // bookings, event types and buckets it reads itself, inside its own step.
    bufferBreach: gate(readiness, ["horizonDays"]),
    // #4206: a placeholder call past its time with no Regal call to the customer. The
    // bucket list is what says which buckets are REAL, and a test bucket's placeholder
    // call (the test bucket drill) must never page, so it skips without it: guessing every
    // bucket real pages about every drill, and guessing none real silences the check.
    // The bookings, the open pages and the call feed it reads itself. The placeholder
    // seat check consumes no setup read and is deliberately not gated.
    placeholderCalls: gate(readiness, ["buckets"]),
    // #4380: the transfer queue probe reads the endpoint only while the org is open, and
    // judges "never enough advisors free across the last whole business day", so it needs
    // the org's week twice over and skips on it rather than guess: guessing open reads at
    // night and judges a Sunday nobody worked, and guessing shut silences a dead Monday.
    // Its threshold is a booking setting it reads itself, not a monitor setting.
    transferQueue: gate(readiness, ["businessHours"]),
  };
}
