import type { Role } from "@/lib/db/types";

// Three fixed tiers (Slate is single-org, so no per-team membership/PBAC):
//   agent   - manage only their own settings/hours
//   manager - the above, plus edit ANY agent's settings/hours/bookable
//   admin   - the above, plus org/app config and role assignment
export const ROLE_RANK: Record<Role, number> = { agent: 0, manager: 1, admin: 2 };
export const ROLES: Role[] = ["agent", "manager", "admin"];

export const isRole = (v: string): v is Role => (ROLES as string[]).includes(v);

export const atLeast = (role: Role, min: Role): boolean =>
  ROLE_RANK[role] >= ROLE_RANK[min];

/** Managers and admins can manage the agent roster (hours/settings/bookable). */
export const canManageAgents = (role: Role): boolean => atLeast(role, "manager");

/** Only admins touch org/app config (defaults, event types, buckets, webhooks). */
export const canEditOrgSettings = (role: Role): boolean => atLeast(role, "admin");

/** Only admins assign roles (managers never promote/demote anyone). */
export const canAssignRole = (actor: Role): boolean => actor === "admin";

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
 * Last-admin invariant: demoting the final admin would brick the org (also
 * covers self-demotion of the only admin). `adminCount` is the current number
 * of admins. Returns true if the role change is allowed.
 */
export const canChangeRole = (
  targetCurrent: Role,
  next: Role,
  adminCount: number,
): boolean => {
  if (targetCurrent === "admin" && next !== "admin" && adminCount <= 1) {
    return false;
  }
  return true;
};
