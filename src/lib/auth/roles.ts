import type { Role } from "@/lib/db/types";

// Four fixed tiers (Slate is single-org, so no per-team membership/PBAC):
//   agent       - manage only their own settings/hours
//   manager     - the above, plus edit ANY agent's settings/hours/bookable
//   admin       - the above, plus org/app config and role assignment
//   super_admin - the above, plus the org-wide default working hours; the only
//                 role that can grant or revoke super_admin
export const ROLE_RANK: Record<Role, number> = {
  agent: 0,
  manager: 1,
  admin: 2,
  super_admin: 3,
};
export const ROLES: Role[] = ["agent", "manager", "admin", "super_admin"];

export const isRole = (v: string): v is Role => (ROLES as string[]).includes(v);

/** Human-facing role label (the stored value uses an underscore). */
export const roleLabel = (role: Role): string =>
  role === "super_admin" ? "super admin" : role;

export const atLeast = (role: Role, min: Role): boolean =>
  ROLE_RANK[role] >= ROLE_RANK[min];

/** Managers and admins can manage the agent roster (hours/settings/bookable). */
export const canManageAgents = (role: Role): boolean => atLeast(role, "manager");

/** Only admins touch org/app config (event types, buckets, webhooks). */
export const canEditOrgSettings = (role: Role): boolean => atLeast(role, "admin");

/**
 * Only super admins edit the org-wide default working hours. Regular admins
 * configure everything else but can't move the company default schedule.
 */
export const canEditOrgDefaults = (role: Role): boolean =>
  atLeast(role, "super_admin");

/** Admins and super admins assign roles (managers never promote/demote). */
export const canAssignRole = (actor: Role): boolean => atLeast(actor, "admin");

/**
 * Whether `actor` may move `target` from `current` to `next`. Admins assign the
 * lower tiers, but granting or revoking `super_admin` is reserved to super
 * admins — a regular admin can never mint a peer above themselves nor demote
 * one. (Last-admin protection is enforced separately by `canChangeRole`.)
 */
export const canSetRole = (actor: Role, current: Role, next: Role): boolean => {
  if (!canAssignRole(actor)) return false;
  const touchesSuper = current === "super_admin" || next === "super_admin";
  return touchesSuper ? actor === "super_admin" : true;
};

/**
 * Whether `actor` may edit `target`'s settings. Editing yourself is always
 * allowed; otherwise the actor must be a manager+ AND strictly outrank the
 * target. This blocks a manager from editing peers or admins (escalation) — a
 * gap cal.com leaves open (its cross-user check ignores role hierarchy).
 */
export const canManageUser = (
  actor: Role,
  target: Role,
  isSelf: boolean,
): boolean =>
  isSelf || (canManageAgents(actor) && ROLE_RANK[actor] > ROLE_RANK[target]);

/**
 * Last-admin invariant: stripping org-config power from the final admin-or-above
 * would brick the org (also covers self-demotion of the only one). `adminCount`
 * is the current number of users with admin power (admins + super admins).
 * Returns true if the role change is allowed.
 */
export const canChangeRole = (
  targetCurrent: Role,
  next: Role,
  adminCount: number,
): boolean => {
  const losesOrgPower = atLeast(targetCurrent, "admin") && !atLeast(next, "admin");
  if (losesOrgPower && adminCount <= 1) {
    return false;
  }
  return true;
};
