// RBAC tests for the agent < manager < admin < super_admin tiers (pure module).
// Run: node --experimental-strip-types scripts/test-roles.ts
import {
  ROLE_RANK,
  atLeast,
  canManageAgents,
  canEditOrgSettings,
  canEditOrgDefaults,
  canAssignRole,
  canSetRole,
  canManageUser,
  canChangeRole,
  roleLabel,
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
  ROLE_RANK.agent < ROLE_RANK.manager &&
    ROLE_RANK.manager < ROLE_RANK.admin &&
    ROLE_RANK.admin < ROLE_RANK.super_admin,
  "rank order: agent < manager < admin < super_admin",
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
  canAssignRole("admin") &&
    canAssignRole("super_admin") &&
    !canAssignRole("manager") &&
    !canAssignRole("agent"),
  "canAssignRole = admin and up",
);

// canEditOrgDefaults — super admins move the org-wide default working hours
assert(
  canEditOrgDefaults("super_admin") &&
    !canEditOrgDefaults("admin") &&
    !canEditOrgDefaults("manager"),
  "canEditOrgDefaults = super_admin only",
);

// canSetRole — only super admins grant or revoke super_admin
assert(
  canSetRole("admin", "agent", "manager") && canSetRole("admin", "manager", "admin"),
  "admin assigns the lower tiers",
);
assert(
  !canSetRole("admin", "agent", "super_admin"),
  "admin cannot grant super_admin",
);
assert(
  !canSetRole("admin", "super_admin", "admin"),
  "admin cannot demote a super_admin",
);
assert(
  canSetRole("super_admin", "agent", "super_admin") &&
    canSetRole("super_admin", "super_admin", "agent"),
  "super_admin can grant and revoke super_admin",
);
assert(
  !canSetRole("manager", "agent", "manager"),
  "managers never assign roles",
);

assert(roleLabel("super_admin") === "super admin", "roleLabel humanizes super_admin");

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

// canChangeRole — last-admin invariant (admins + super admins both hold power)
assert(!canChangeRole("admin", "manager", 1), "cannot demote the last admin");
assert(canChangeRole("admin", "manager", 2), "can demote an admin when another remains");
assert(canChangeRole("agent", "admin", 1), "promoting an agent is always fine");
assert(canChangeRole("admin", "admin", 1), "admin to admin no-op allowed");
assert(
  !canChangeRole("super_admin", "agent", 1),
  "cannot strip power from the last admin-or-above",
);
assert(
  canChangeRole("super_admin", "admin", 1),
  "super_admin to admin keeps org power, so allowed",
);

assert(isRole("super_admin") && !isRole("superuser"), "isRole validates the enum");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
