// Pure-logic tests for the OOO core: authz, transitions, window validation,
// and the when-line formatter (format parity with the Apps Script).
// Run: node --experimental-strip-types scripts/test-ooo-core.ts
import {
  agentDisplayName,
  managerDisplayName,
  displayName,
  canCancel,
  canHoldManagerOfRecord,
  canModerate,
  canModify,
  managerCannotApproveNotice,
  canRetrySideEffects,
  canTransition,
  formatRequestWhenAndReason,
  formatWhenLine,
  normalizeTzLabel,
  noManagerReviewerCapitalized,
  oooApproverLine,
  oooRequestIntro,
  overlaps,
  validateWindow,
  NO_MANAGER_REVIEWER,
  UNNAMED_MANAGER_REVIEWER,
} from "../src/lib/ooo/core.ts";
import { canModerateAllOoo } from "../src/lib/auth/roles.ts";
import { assert, finish } from "./lib/harness.ts";

const agent = { id: "u-agent", role: "agent" as const };
const manager = { id: "u-mgr", role: "manager" as const };
const otherManager = { id: "u-mgr2", role: "manager" as const };
const admin = { id: "u-admin", role: "admin" as const };
const teamLead = { id: "u-lead", role: "team_lead" as const };
const superAdmin = { id: "u-super", role: "super_admin" as const };
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

// --- #3114: an admin cannot decide their own time off ---
//
// canModerateAllOoo let an admin approve or reject ANY request, their own
// included, so an admin could sign off their own time off. Dan, 2026-10-03: only
// admins change; a team lead approving their own stays allowed. Both directions,
// and every rank, so a rule that refused everyone's own request (or nobody's)
// cannot pass.
{
  for (const self of [admin, superAdmin]) {
    const own = { user_id: self.id, manager_id: null, status: "pending" as const };
    assert(!canModerate(self, own), `${self.role}: cannot moderate their own request`);
    // Not even through the manager-of-record link, which is a separate route to yes.
    assert(
      !canModerate(self, { ...own, manager_id: self.id }),
      `${self.role}: cannot moderate their own request as their own manager of record`,
    );
    // Another admin, or a team lead, still can: the request is routed, not stranded.
    const other = { id: "u-other-admin", role: "admin" as const };
    assert(canModerate(other, own), `another admin can moderate a ${self.role}'s request`);
    assert(canModerate(teamLead, own), `a team lead can moderate a ${self.role}'s request`);
    // And the admin keeps moderating everybody else's.
    assert(canModerate(self, req), `${self.role}: still moderates somebody else's request`);
  }
  const leadOwn = { user_id: teamLead.id, manager_id: null, status: "pending" as const };
  assert(canModerate(teamLead, leadOwn), "a team lead can still moderate their own request (Dan, 2026-10-03)");
}

// --- #1475: the manager of record needs a manager ROLE before the link counts ---
//
// The link used to grant approval with no floor on the named person's own role,
// so an AGENT could approve or decline time off, including a MANAGER's, purely by
// being the value in someone's manager_id. That was live: mjamele (role manager)
// had an agent as his manager of record, so that agent was the approver for a
// manager's time off.
//
// The bar everywhere else in the app is atLeast(role, "manager") to manage agents
// at all, so approving time off through a link was a LOWER bar than editing
// someone's hours.
//
// Both sides asserted, because a rule that only ever refuses is satisfied by a
// function hard-wired to false (L1).
{
  const agentAsManagerOfRecord = { id: "u-agent-mgr", role: "agent" as const };
  const linkedToAgent = { ...req, manager_id: "u-agent-mgr" };
  assert(
    !canModerate(agentAsManagerOfRecord, linkedToAgent),
    "an AGENT named as the manager of record cannot moderate (#1475)",
  );
  // The qualifying side still works, which is the half that proves the rule is a
  // floor rather than a blanket refusal of the link.
  assert(
    canModerate(manager, req),
    "a manager named as the manager of record still moderates",
  );
  // A team lead or admin named as the manager of record is above the floor, and
  // must not be refused by an equality against "manager" (L122: a rank test, never
  // `role === "manager"`, or the ranks ABOVE the floor are the ones turned away).
  assert(
    canModerate({ id: "u-lead-mgr", role: "team_lead" }, { ...req, manager_id: "u-lead-mgr" }),
    "a team lead named as the manager of record moderates (the rank ABOVE the floor is not excluded)",
  );
  assert(
    canModerate({ id: "u-admin-mgr", role: "admin" }, { ...req, manager_id: "u-admin-mgr" }),
    "an admin named as the manager of record moderates",
  );
  // And the fallback the issue asks for: when the named person does not qualify,
  // team leads and up can still act, so the request is never stranded.
  assert(
    canModerate(teamLead, linkedToAgent),
    "a team lead can still moderate a request whose manager of record does not qualify",
  );
  assert(
    canModerate(admin, linkedToAgent),
    "an admin can still moderate a request whose manager of record does not qualify",
  );
}

// --- the floor, named once, so three surfaces cannot disagree (#1475) ---
//
// canModerate (the rule), the notification that decides who to DM, and the queue
// badge that explains why a request is waiting all read canHoldManagerOfRecord.
// Three hand-rolled role tests is how a button and its action end up disagreeing.
{
  assert(!canHoldManagerOfRecord("agent"), "an agent cannot hold the manager-of-record power");
  assert(canHoldManagerOfRecord("manager"), "a manager can");
  assert(canHoldManagerOfRecord("team_lead"), "a team lead can (the rank above the floor)");
  assert(canHoldManagerOfRecord("admin"), "an admin can");
  assert(canHoldManagerOfRecord("super_admin"), "a super admin can (the TOP rank is not excluded)");

  // The predicate and the rule must agree, or the badge tells somebody the opposite
  // of what the approve action does.
  for (const role of ["agent", "manager", "team_lead", "admin", "super_admin"] as const) {
    const person = { id: "u-x", role };
    const req = { user_id: "u-someone", manager_id: "u-x", status: "pending" as const };
    // A team lead and up moderate everything anyway, so the link only DECIDES the
    // outcome below that rank; above it, both must still say yes.
    if (!canHoldManagerOfRecord(role)) {
      assert(!canModerate(person, req), `${role}: predicate and rule agree (neither allows)`);
    } else {
      assert(canModerate(person, req), `${role}: predicate and rule agree (both allow)`);
    }
  }
}

// --- the queue's explanation reads correctly, in every role it can name ---
{
  const forAgent = managerCannotApproveNotice("Andy Approver", "agent");
  assert(forAgent.includes("Andy Approver"), "the notice names the manager of record");
  assert(
    forAgent.includes("does not hold a manager role"),
    "the notice says why they cannot approve",
  );
  assert(
    forAgent.includes("Salesforce"),
    "the notice names where to correct it, so it is not a dead end (L111)",
  );
  // Grammar, checked because the article is computed: "an agent", never "a agent".
  assert(forAgent.includes("they are an agent"), `reads "they are an agent" (got: ${forAgent})`);
  assert(
    !/\ba agent\b/.test(forAgent),
    "never renders the wrong article before a role starting with a vowel",
  );
  // The stored value is `team_lead`; a reader must never see the underscore.
  const forLead = managerCannotApproveNotice("Lee Lead", "team_lead");
  assert(!forLead.includes("team_lead"), `no raw stored role in the copy (got: ${forLead})`);
  assert(forLead.includes("a team lead"), "renders the human role label");
  // No dashes, per the repo's copy rules. Written as escapes, not literals, so this
  // file holds no dash for the pre-push style hook to catch: it cannot tell the line
  // BANNING the character from a line using it.
  const DASHES = /[\u2014\u2013]/;
  assert(
    !DASHES.test(forAgent) && !DASHES.test(forLead),
    "the notice carries no dashes",
  );
}
assert(canCancel(agent, req), "requester can cancel");
assert(canCancel(admin, req), "admin can cancel");
assert(!canCancel(manager, req), "manager cannot cancel (reject instead)");
assert(canModify(agent, req), "requester can modify");
assert(!canModify(admin, req), "admin cannot modify someone's request");

// Retry the calendar updates (#1468). One predicate, so the button that offers
// the repair and the action that performs it can never disagree, and it is a
// RANK test: an equality against a single rank refuses every rank ABOVE it, and
// the holders of those are the ones who actually reach for this control.
//
// #1473 (Dan's call, 2026-08-13: "team leads already moderate every request, so
// they should be able to press the repair when its calendar updates fail"). The
// floor is the SAME rank that gates moderating every request, and it is read
// from that predicate rather than restated, so a change to who moderates cannot
// leave the person who approved a request unable to fix it.
assert(canRetrySideEffects(teamLead), "a team lead who moderates every request can also retry");
assert(canRetrySideEffects(admin), "admin can retry the calendar updates");
assert(
  canRetrySideEffects(superAdmin),
  "super admin can retry too (the rank ABOVE admin is not excluded)",
);
assert(!canRetrySideEffects(manager), "a manager, scoped to their own reports, cannot retry");
assert(!canRetrySideEffects(agent), "an agent cannot retry");

// The floor and the moderation rule agree across the whole hierarchy, which is
// what stops the two drifting apart in one direction only.
for (const role of ["agent", "manager", "team_lead", "admin", "super_admin"] as const) {
  assert(
    canRetrySideEffects({ role }) === canModerateAllOoo(role),
    `${role}: whoever moderates every request may also repair one`,
  );
}

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

// #1014: the same name resolution, but the neutral fallback fits the role.
assert(
  managerDisplayName({ name: "Pat Boss", email: "pat@x.com" }) === "Pat Boss",
  "managerDisplayName prefers the name",
);
assert(
  managerDisplayName({ name: null, email: "pat@x.com" }) === "pat@x.com",
  "managerDisplayName falls back to email when name is null",
);
assert(
  managerDisplayName(null) === "the manager",
  "managerDisplayName uses a manager-appropriate fallback, not 'An agent'",
);
// The shared resolver both delegate to, with a caller-supplied fallback.
assert(
  displayName(null, "somebody") === "somebody",
  "displayName uses the caller-supplied fallback for an unknown person",
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

// --- #1499: the /me copy never names a step the reader cannot perform ---
//
// The refusal this replaced said "ask an admin to set your manager", and after
// #1474 there is no such control: the admin agent profile shows the manager of
// record read only because Salesforce owns the link, and Salesforce holds null
// for all nine of these people. The copy has to name who WILL review it instead
// (L111), and one constant has to be the only spelling of that reviewer, so the
// promise on /me and the pool that can actually act cannot drift.
{
  const withManager = [oooRequestIntro("Mona"), oooApproverLine("Mona")];
  const without = [oooRequestIntro(null), oooApproverLine(null)];
  assert(
    withManager.every((line) => line.includes("Mona")),
    "a named manager is still the one who takes it from there",
  );
  assert(
    without.every((line) => line.toLowerCase().includes(NO_MANAGER_REVIEWER)),
    `with no manager the copy names the moderator pool (got: ${without.join(" | ")})`,
  );
  assert(
    without.every((line) => !/ask an admin|set your manager/i.test(line)),
    "and never names the step nobody can perform",
  );
  assert(
    noManagerReviewerCapitalized().toLowerCase() === NO_MANAGER_REVIEWER,
    "the sentence-start spelling is derived from the constant, not a second copy of it",
  );
}

// --- #1647: the THIRD reviewer state, a manager who exists and could not be read
//
// /me falls back to this when `users` refuses while `manager_id` is set. Neither
// of the other two states is true then: there is no name, and the person is NOT
// somebody with no manager, so routing them to the moderator pool in copy is a
// claim the read never measured (L11).
{
  const unnamed = [
    oooRequestIntro(UNNAMED_MANAGER_REVIEWER),
    oooApproverLine(UNNAMED_MANAGER_REVIEWER),
  ];
  assert(
    unnamed.every((line) => !line.toLowerCase().includes(NO_MANAGER_REVIEWER)),
    `an unreadable manager never renders as having none (got: ${unnamed.join(" | ")})`,
  );
  assert(
    unnamed.every((line) => line.toLowerCase().includes(UNNAMED_MANAGER_REVIEWER)),
    `and still names a reviewer (got: ${unnamed.join(" | ")})`,
  );
  // The subheading opens a sentence, so the descriptor has to be capitalized
  // there and a stored name must NOT be rewritten by the same helper.
  assert(
    oooApproverLine(UNNAMED_MANAGER_REVIEWER).startsWith("Your manager"),
    `the subheading opens the sentence properly (got: ${oooApproverLine(UNNAMED_MANAGER_REVIEWER)})`,
  );
  assert(
    oooApproverLine("mona lisa").startsWith("Mona lisa") &&
      oooApproverLine("Mona Lisa") === "Mona Lisa signs off on these.",
    "a stored name keeps its own spelling past the first letter",
  );
}

finish();
