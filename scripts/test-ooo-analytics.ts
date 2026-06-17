// Tests for the OOO analytics core (port of the Apps Script analytics module).
// Run: node --experimental-strip-types scripts/test-ooo-analytics.ts
import {
  approvalStats,
  busiestMonth,
  companyApprovalStats,
  coverageAlerts,
  managerBreakdown,
  medianAdvanceNoticeDays,
  peopleWithNoTimeOff,
} from "../src/lib/ooo/analytics-core.ts";
import type { OooRequest, OooStatus } from "../src/lib/db/types.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`ok: ${msg}`);
  else {
    console.error(`FAIL: ${msg}`);
    failures++;
  }
}

const ZONE = "America/New_York";
// Fixed clock: 2026-06-12 noon ET.
const NOW = Date.parse("2026-06-12T16:00:00Z");

let seq = 0;
function req(p: {
  user: string;
  manager?: string | null;
  status: OooStatus;
  start: string;
  end?: string;
  created?: string;
}): OooRequest {
  return {
    id: `r-${++seq}`,
    org_id: "org",
    user_id: p.user,
    manager_id: p.manager === undefined ? "m1" : p.manager,
    starts_at: p.start,
    ends_at: p.end ?? p.start,
    display_tz_id: ZONE,
    display_tz_label: "ET",
    reason: "trip",
    notes: null,
    status: p.status,
    rejection_note: null,
    decided_by: null,
    decided_at: null,
    cancelled_at: null,
    manager_event_id: null,
    manager_event_calendar_id: null,
    agent_event_id: null,
    busy_block_id: null,
    calcom_synced: false,
    side_effects: {},
    legacy_request_id: null,
    created_at: p.created ?? "2026-06-01T12:00:00Z",
    updated_at: "2026-06-01T12:00:00Z",
  };
}

// --- approval stats ---
{
  const s = approvalStats([
    req({ user: "a", status: "approved", start: "2026-06-20T12:00:00Z" }),
    req({ user: "a", status: "approved", start: "2026-06-21T12:00:00Z" }),
    req({ user: "b", status: "rejected", start: "2026-06-22T12:00:00Z" }),
    req({ user: "b", status: "pending", start: "2026-06-23T12:00:00Z" }),
    req({ user: "b", status: "cancelled", start: "2026-06-24T12:00:00Z" }),
  ]);
  assert(s.total === 4, "cancelled excluded from totals");
  assert(s.rate === 50, "rate = approved / (approved+rejected+pending)");
}
assert(approvalStats([]).rate === 0, "empty stats rate 0");

// --- company stats: median of per-manager rates ---
{
  // m1: 100%, m2: 0%, m3: 50% -> median 50
  const s = companyApprovalStats([
    req({ user: "a", manager: "m1", status: "approved", start: "2026-06-20T12:00:00Z" }),
    req({ user: "b", manager: "m2", status: "rejected", start: "2026-06-20T12:00:00Z" }),
    req({ user: "c", manager: "m3", status: "approved", start: "2026-06-20T12:00:00Z" }),
    req({ user: "c", manager: "m3", status: "rejected", start: "2026-06-21T12:00:00Z" }),
  ]);
  assert(s.rate === 50 && s.managerCount === 3, "odd median of manager rates");
  // even count: m1 100, m2 0 -> 50
  const e = companyApprovalStats([
    req({ user: "a", manager: "m1", status: "approved", start: "2026-06-20T12:00:00Z" }),
    req({ user: "b", manager: "m2", status: "rejected", start: "2026-06-20T12:00:00Z" }),
  ]);
  assert(e.rate === 50, "even median averages the middle pair");
}

// --- manager breakdown sorted by rate ---
{
  const rows = managerBreakdown([
    req({ user: "a", manager: "m1", status: "rejected", start: "2026-06-20T12:00:00Z" }),
    req({ user: "b", manager: "m2", status: "approved", start: "2026-06-20T12:00:00Z" }),
  ]);
  assert(rows[0].managerId === "m2" && rows[0].rate === 100, "highest rate first");
  assert(rows[1].managerId === "m1" && rows[1].rate === 0, "lowest rate last");
}

// --- coverage alerts ---
{
  const team = [
    { id: "a", name: "Aria" },
    { id: "b", name: "Bea" },
    { id: "c", name: "Cal" },
    { id: "d", name: "Dee" },
    { id: "e", name: "Eli" },
  ];
  // exactly 1/5 = 20% on Jun 20 -> alert (>=20); 2/5 = 40% on Jun 21 -> high
  const alerts = coverageAlerts(
    team,
    [
      req({ user: "a", status: "approved", start: "2026-06-20T13:00:00Z", end: "2026-06-21T21:00:00Z" }),
      req({ user: "b", status: "approved", start: "2026-06-21T13:00:00Z", end: "2026-06-21T21:00:00Z" }),
      // overlapping second request from the same person must not double-count
      req({ user: "b", status: "approved", start: "2026-06-21T15:00:00Z", end: "2026-06-21T18:00:00Z" }),
      req({ user: "c", status: "pending", start: "2026-06-21T13:00:00Z", end: "2026-06-21T21:00:00Z" }),
    ],
    NOW,
    ZONE,
  );
  assert(alerts.length === 2, "two alert days");
  assert(alerts[0].date === "2026-06-20" && alerts[0].percent === 20, "20% boundary included");
  assert(alerts[0].severity === "medium", "20% is medium");
  assert(alerts[1].date === "2026-06-21" && alerts[1].percent === 40, "same person deduped per day");
  assert(alerts[1].severity === "high", ">=30% is high");
  assert(alerts[1].people.sort().join(",") === "Aria,Bea", "people named");

  // past days and beyond-horizon days never alert
  const none = coverageAlerts(
    team,
    [
      req({ user: "a", status: "approved", start: "2026-06-01T13:00:00Z", end: "2026-06-02T21:00:00Z" }),
      req({ user: "b", status: "approved", start: "2026-08-01T13:00:00Z", end: "2026-08-02T21:00:00Z" }),
    ],
    NOW,
    ZONE,
  );
  assert(none.length === 0, "past and far-future days ignored");

  // a long request straddling today counts from today forward
  const straddle = coverageAlerts(
    [{ id: "a", name: "Aria" }],
    [req({ user: "a", status: "approved", start: "2026-06-10T13:00:00Z", end: "2026-06-13T21:00:00Z" })],
    NOW,
    ZONE,
  );
  assert(
    straddle.length === 2 && straddle[0].date === "2026-06-12",
    "straddling request counted from today",
  );
}
assert(coverageAlerts([], [], NOW, ZONE).length === 0, "empty team no alerts");

// --- people with no time off ---
{
  const team = [
    { id: "a", name: "Aria" },
    { id: "b", name: "Bea" },
    { id: "c", name: "Cal" },
  ];
  const out = peopleWithNoTimeOff(
    team,
    [
      req({ user: "a", status: "approved", start: "2026-06-20T12:00:00Z" }), // upcoming
      req({ user: "b", status: "approved", start: "2025-06-01T12:00:00Z" }), // long past
      req({ user: "c", status: "rejected", start: "2026-06-20T12:00:00Z" }), // not approved
    ],
    NOW,
  );
  assert(
    out.map((p) => p.id).join(",") === "b,c",
    "only recent/upcoming approved time off counts",
  );
}

// --- median advance notice ---
{
  const m = medianAdvanceNoticeDays([
    req({ user: "a", status: "approved", start: "2026-06-11T12:00:00Z", created: "2026-06-01T12:00:00Z" }), // 10d
    req({ user: "a", status: "pending", start: "2026-06-03T12:00:00Z", created: "2026-06-01T12:00:00Z" }), // 2d
    req({ user: "a", status: "rejected", start: "2026-06-05T12:00:00Z", created: "2026-06-01T12:00:00Z" }), // 4d
    // negative (backdated) notice is excluded
    req({ user: "a", status: "approved", start: "2026-05-01T12:00:00Z", created: "2026-06-01T12:00:00Z" }),
  ]);
  assert(m === 4, "odd-count median, negatives excluded");
  assert(medianAdvanceNoticeDays([]) === 0, "empty median 0");
}

// --- busiest month (forward-looking) ---
{
  const NOW = Date.parse("2026-06-01T00:00:00Z");
  const b = busiestMonth(
    [
      req({ user: "a", status: "approved", start: "2026-07-02T12:00:00Z" }),
      req({ user: "b", status: "approved", start: "2026-07-20T12:00:00Z" }),
      req({ user: "c", status: "approved", start: "2026-08-02T12:00:00Z" }),
      req({ user: "d", status: "pending", start: "2026-08-03T12:00:00Z" }),
      // three approved in May, but they're in the PAST relative to NOW so they
      // must be excluded — otherwise May would wrongly win.
      req({ user: "e", status: "approved", start: "2026-05-02T12:00:00Z" }),
      req({ user: "f", status: "approved", start: "2026-05-09T12:00:00Z" }),
      req({ user: "g", status: "approved", start: "2026-05-15T12:00:00Z" }),
    ],
    ZONE,
    NOW,
  );
  assert(b === "July 2026", "busiest UPCOMING month by approved starts (past excluded)");
  assert(busiestMonth([], ZONE, NOW) === "None ahead", "empty busiest month copy");
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nALL PASSED");
