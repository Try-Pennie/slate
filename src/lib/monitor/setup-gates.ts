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
}

/** Every read succeeded. Also the base a test mutates one flag at a time. */
export const ALL_SETUP_READ: SetupReadiness = {
  buckets: true,
  slotHealth: true,
  businessHours: true,
  workingHours: true,
  horizonDays: true,
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
 * Only the two checks that consume setup state are gated. The other eleven do
 * their own reads inside their own boundaries and are deliberately absent: the
 * whole point is that a failure up here stops touching them.
 */
export function monitorSetupGates(readiness: SetupReadiness): {
  availabilityScan: SetupGate;
  availabilityTruth: SetupGate;
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
    availabilityTruth: gate(readiness, ["horizonDays"]),
  };
}
