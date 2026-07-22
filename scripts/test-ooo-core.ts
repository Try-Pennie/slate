// Pure-logic tests for the OOO core: authz, transitions, window validation,
// and the when-line formatter (format parity with the Apps Script).
// Run: node --experimental-strip-types scripts/test-ooo-core.ts
import {
  agentDisplayName,
  canCancel,
  canModerate,
  canModify,
  canTransition,
  formatRequestWhenAndReason,
  formatWhenLine,
  normalizeTzLabel,
  overlaps,
  validateWindow,
} from "../src/lib/ooo/core.ts";
import { assert, finish } from "./lib/harness.ts";

const agent = { id: "u-agent", role: "agent" as const };
const manager = { id: "u-mgr", role: "manager" as const };
const otherManager = { id: "u-mgr2", role: "manager" as const };
const admin = { id: "u-admin", role: "admin" as const };
const teamLead = { id: "u-lead", role: "team_lead" as const };
const req = { user_id: "u-agent", manager_id: "u-mgr", status: "pending" as const };

// --- authz ---
assert(canModerate(manager, req), "manager of record can moderate");
assert(!canModerate(otherManager, req), "a different manager cannot moderate");
assert(canModerate(admin, req), "admin can moderate any request");
assert(
  canModerate(teamLead, req),
  "a team lead can moderate any request (not just their reports)",
);
assert(!canModerate(agent, req), "the requester cannot moderate their own");
assert(
  !canModerate(manager, { ...req, manager_id: null }),
  "no manager of record means only team leads and up moderate",
);
assert(canCancel(agent, req), "requester can cancel");
assert(canCancel(admin, req), "admin can cancel");
assert(!canCancel(manager, req), "manager cannot cancel (reject instead)");
assert(canModify(agent, req), "requester can modify");
assert(!canModify(admin, req), "admin cannot modify someone's request");

// --- transitions ---
assert(canTransition("pending", "approved"), "pending -> approved");
assert(canTransition("pending", "rejected"), "pending -> rejected");
assert(canTransition("pending", "cancelled"), "pending -> cancelled");
assert(canTransition("approved", "cancelled"), "approved -> cancelled");
assert(canTransition("approved", "pending"), "approved -> pending (modify)");
assert(!canTransition("rejected", "approved"), "rejected is terminal");
assert(!canTransition("cancelled", "pending"), "cancelled is terminal");
assert(!canTransition("pending", "pending"), "no self transition");

// --- window validation ---
assert(
  validateWindow("2026-07-01T13:00:00Z", "2026-07-01T17:00:00Z") === null,
  "valid window passes",
);
assert(
  validateWindow("2026-07-01T17:00:00Z", "2026-07-01T13:00:00Z") !== null,
  "end before start fails",
);
assert(
  validateWindow("2026-07-01T13:00:00Z", "2026-07-01T13:00:00Z") !== null,
  "zero-length window fails",
);
assert(validateWindow("garbage", "2026-07-01T13:00:00Z") !== null, "unparseable fails");

// --- overlap ---
assert(
  overlaps("2026-07-01T13:00Z", "2026-07-01T15:00Z", "2026-07-01T14:00Z", "2026-07-01T16:00Z"),
  "partial overlap detected",
);
assert(
  !overlaps("2026-07-01T13:00Z", "2026-07-01T14:00Z", "2026-07-01T14:00Z", "2026-07-01T15:00Z"),
  "touching windows do not overlap",
);

// --- tz labels ---
assert(normalizeTzLabel("America/New_York") === "ET", "IANA New York -> ET");
assert(normalizeTzLabel("America/Chicago") === "CT", "IANA Chicago -> CT");
assert(normalizeTzLabel("Etc/UTC") === "UTC", "Etc/UTC -> UTC");
assert(normalizeTzLabel("America/New_York", "EST") === "ET", "legacy EST label -> ET");
assert(normalizeTzLabel("Australia/Sydney", "AEST") === "AEST", "unknown keeps preferred label");

// --- when line (format parity with whenLineInTz_) ---
assert(
  formatWhenLine(
    "2025-10-07T20:00:00Z",
    "2025-10-07T22:00:00Z",
    "America/New_York",
    "ET",
  ) === "Tue, Oct 7 2025 from 4:00pm - 6:00pm ET",
  "single-day format",
);
assert(
  formatWhenLine(
    "2025-10-10T23:00:00Z",
    "2025-10-12T23:00:00Z",
    "America/New_York",
    "ET",
  ) === "Fri, Oct 10 2025 7:00pm - Sun, Oct 12 2025 7:00pm ET",
  "multi-day format",
);
// DST fall-back boundary (Nov 2 2025): both instants render in local wall time.
assert(
  formatWhenLine(
    "2025-11-02T04:00:00Z", // 12:00am EDT
    "2025-11-02T14:00:00Z", // 9:00am EST (after fall back)
    "America/New_York",
    "ET",
  ) === "Sun, Nov 2 2025 from 12:00am - 9:00am ET",
  "DST fall-back day renders wall times",
);
assert(
  formatWhenLine("2025-10-07T20:00:00Z", "2025-10-07T22:00:00Z", "not/a_zone", "XX")
    .length > 0,
  "invalid zone falls back instead of throwing",
);
assert(
  !formatWhenLine(
    "2025-10-07T20:00:00Z",
    "2025-10-07T22:00:00Z",
    "America/New_York",
  ).includes("–"),
  "no unicode dashes in the when line",
);

// --- shared pending-request description (#1002) ---
// The digest line and the manager notification both describe one request; the
// agent-name resolution and the "when + reason" body are now defined once here.
assert(
  agentDisplayName({ name: "Jane Smith", email: "jane@x.com" }) === "Jane Smith",
  "agentDisplayName prefers the name",
);
assert(
  agentDisplayName({ name: null, email: "jane@x.com" }) === "jane@x.com",
  "agentDisplayName falls back to email when name is null",
);
assert(
  agentDisplayName(null) === "An agent",
  "agentDisplayName falls back to a neutral label when the agent is unknown",
);

const reqDesc = {
  starts_at: "2025-10-07T20:00:00Z",
  ends_at: "2025-10-07T22:00:00Z",
  display_tz_id: "America/New_York",
  display_tz_label: "ET",
  reason: "vacation",
};
assert(
  formatRequestWhenAndReason(reqDesc) ===
    `${formatWhenLine(reqDesc.starts_at, reqDesc.ends_at, reqDesc.display_tz_id, reqDesc.display_tz_label)}\nReason: vacation`,
  "formatRequestWhenAndReason is the when line then the reason line",
);
assert(
  !formatRequestWhenAndReason(reqDesc).includes("Notes:"),
  "the shared description carries no notes (notes stay with the notification)",
);

finish();
