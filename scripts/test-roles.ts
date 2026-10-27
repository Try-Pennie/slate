// RBAC tests for the agent < manager < admin < super_admin tiers (pure module).
// Run: node --experimental-strip-types scripts/test-roles.ts
import {
  ROLE_RANK,
  atLeast,
  canManageAgents,
  canModerateAllOoo,
  canEditOrgSettings,
  canEditOrgDefaults,
  canAssignRole,
  canSetRole,
  canManageUser,
  canChangeRole,
  canImpersonate,
  isSelfDemotion,
  roleLabel,
  isRole,
  ROLES,
  opensStaffConsole,
  canUseCoordinatorDesk,
} from "../src/lib/auth/roles.ts";
import { assert, finish } from "./lib/harness.ts";

assert(
  ROLE_RANK.agent < ROLE_RANK.manager &&
    ROLE_RANK.manager < ROLE_RANK.team_lead &&
    ROLE_RANK.team_lead < ROLE_RANK.admin &&
    ROLE_RANK.admin < ROLE_RANK.super_admin,
  "rank order: agent < manager < team_lead < admin < super_admin",
);
assert(
  atLeast("admin", "manager") && atLeast("manager", "manager") && !atLeast("agent", "manager"),
  "atLeast respects the hierarchy",
);

assert(
  canManageAgents("manager") && canManageAgents("admin") && !canManageAgents("agent"),
  "canManageAgents = manager and up",
);
// canModerateAllOoo — team leads and up approve everybody; managers are scoped.
assert(
  canModerateAllOoo("team_lead") &&
    canModerateAllOoo("admin") &&
    canModerateAllOoo("super_admin") &&
    !canModerateAllOoo("manager") &&
    !canModerateAllOoo("agent"),
  "canModerateAllOoo = team_lead and up",
);
// A team lead has manager powers but NO admin powers beyond org-wide OOO.
assert(
  canManageAgents("team_lead") &&
    !canEditOrgSettings("team_lead") &&
    !canEditOrgDefaults("team_lead") &&
    !canAssignRole("team_lead"),
  "team_lead = manager powers + moderate-all OOO, nothing else admin",
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

// canEditOrgDefaults — admins and up move the org-wide default working hours
assert(
  canEditOrgDefaults("super_admin") &&
    canEditOrgDefaults("admin") &&
    !canEditOrgDefaults("team_lead") &&
    !canEditOrgDefaults("manager"),
  "canEditOrgDefaults = admin and up",
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
assert(roleLabel("team_lead") === "team lead", "roleLabel humanizes team_lead");

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
// Team lead "manages the managers": outranks a manager, but a manager can't edit them.
assert(
  canManageUser("team_lead", "manager", false) && !canManageUser("manager", "team_lead", false),
  "team_lead can edit a manager but not vice versa",
);

// canImpersonate — the #588 role ceiling: admin+ only, and never someone who
// outranks-or-equals you (so impersonation can never be a privilege escalation).
assert(
  canImpersonate("admin", "agent") &&
    canImpersonate("admin", "manager") &&
    canImpersonate("admin", "team_lead"),
  "admin can impersonate every tier below them",
);
assert(
  !canImpersonate("admin", "admin"),
  "admin cannot impersonate a peer admin (equal rank)",
);
assert(
  !canImpersonate("admin", "super_admin"),
  "admin cannot impersonate a super_admin (the escalation the bug allowed)",
);
assert(
  canImpersonate("super_admin", "admin") && canImpersonate("super_admin", "agent"),
  "super_admin can impersonate admins and below",
);
assert(
  !canImpersonate("super_admin", "super_admin"),
  "super_admin cannot impersonate a peer super_admin",
);
assert(
  !canImpersonate("manager", "agent") && !canImpersonate("team_lead", "agent"),
  "below admin nobody can impersonate, even down-rank",
);

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

// isSelfDemotion — self-lockout guard, independent of how many admins remain
assert(
  isSelfDemotion(true, "admin", "manager") && isSelfDemotion(true, "super_admin", "agent"),
  "self-demoting below admin is blocked",
);
assert(
  !isSelfDemotion(false, "admin", "manager"),
  "demoting someone else is not self-demotion",
);
assert(
  !isSelfDemotion(true, "admin", "admin") && !isSelfDemotion(true, "super_admin", "admin"),
  "keeping org power (admin and up) is not a self-demotion",
);
assert(
  !isSelfDemotion(true, "manager", "agent"),
  "a non-admin self-change can't trigger the org-power lockout",
);

assert(
  isRole("super_admin") && isRole("team_lead") && !isRole("superuser"),
  "isRole validates the enum",
);

// #4205: the coordinator role. It sits BELOW agent, so every rank gate in the repo
// refuses it without naming it, and it is on no staff surface at all.
assert(isRole("coordinator") && ROLES.includes("coordinator"), "coordinator is a role");
assert(ROLE_RANK.coordinator < ROLE_RANK.agent, "a coordinator ranks below an agent");
assert(
  !atLeast("coordinator", "agent") && !canManageAgents("coordinator") && !canEditOrgSettings("coordinator"),
  "no rank gate admits a coordinator",
);
assert(roleLabel("coordinator") === "coordinator", "a coordinator is labelled as such");
assert(!opensStaffConsole("coordinator"), "a coordinator opens no staff page (admin or own pages)");
assert(
  (["agent", "manager", "team_lead", "admin", "super_admin"] as const).every((r) => opensStaffConsole(r)),
  "every other role keeps the staff pages it has today",
);
assert(canUseCoordinatorDesk("coordinator"), "a coordinator opens the coordinator page");
assert(
  canUseCoordinatorDesk("admin") && canUseCoordinatorDesk("super_admin"),
  "admins open it too, to train coordinators and to drill it",
);
assert(
  !canUseCoordinatorDesk("agent") && !canUseCoordinatorDesk("manager") && !canUseCoordinatorDesk("team_lead"),
  "an advisor, manager or team lead does not place calls from it",
);
assert(
  canSetRole("admin", "agent", "coordinator") && canSetRole("admin", "coordinator", "agent"),
  "an admin assigns the coordinator role like the other lower tiers",
);
assert(!canSetRole("manager", "agent", "coordinator"), "a manager never assigns it");
assert(!canImpersonate("super_admin", "coordinator"), "nobody views as a coordinator: their page is not a view of a staff surface");
assert(!canImpersonate("coordinator", "agent"), "and a coordinator impersonates nobody");

finish();
