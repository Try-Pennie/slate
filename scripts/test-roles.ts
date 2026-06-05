// RBAC tests for the agent < manager < admin tiers (pure roles module).
// Run: node --experimental-strip-types scripts/test-roles.ts
import {
  ROLE_RANK,
  atLeast,
  canManageAgents,
  canEditOrgSettings,
  canAssignRole,
  canManageUser,
  canChangeRole,
  isRole,
} from "../src/lib/auth/roles.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

assert(
  ROLE_RANK.agent < ROLE_RANK.manager && ROLE_RANK.manager < ROLE_RANK.admin,
  "rank order: agent < manager < admin",
);
assert(
  atLeast("admin", "manager") && atLeast("manager", "manager") && !atLeast("agent", "manager"),
  "atLeast respects the hierarchy",
);

assert(
  canManageAgents("manager") && canManageAgents("admin") && !canManageAgents("agent"),
  "canManageAgents = manager and up",
);
assert(
  canEditOrgSettings("admin") && !canEditOrgSettings("manager") && !canEditOrgSettings("agent"),
  "canEditOrgSettings = admin only",
);
assert(
  canAssignRole("admin") && !canAssignRole("manager") && !canAssignRole("agent"),
  "canAssignRole = admin only",
);

// canManageUser — the escalation guard cal.com leaves open
assert(canManageUser("manager", "agent", false), "manager can edit an agent");
assert(!canManageUser("manager", "manager", false), "manager cannot edit a peer manager");
assert(!canManageUser("manager", "admin", false), "manager cannot edit an admin");
assert(
  canManageUser("admin", "manager", false) && canManageUser("admin", "agent", false),
  "admin can edit managers and agents",
);
assert(canManageUser("agent", "agent", true), "agent can edit self");
assert(!canManageUser("agent", "agent", false), "agent cannot edit another agent");
assert(canManageUser("manager", "manager", true), "anyone can edit self");

// canChangeRole — last-admin invariant
assert(!canChangeRole("admin", "manager", 1), "cannot demote the last admin");
assert(canChangeRole("admin", "manager", 2), "can demote an admin when another remains");
assert(canChangeRole("agent", "admin", 1), "promoting an agent is always fine");
assert(canChangeRole("admin", "admin", 1), "admin to admin no-op allowed");

assert(isRole("manager") && !isRole("superuser"), "isRole validates the enum");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
