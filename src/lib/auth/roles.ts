import type { Role } from "@/lib/db/types";

// Five fixed tiers (Slate is single-org, so no per-team membership/PBAC), and one
// role off the ladder:
//   coordinator - #4205: a scheduling coordinator. Opens the coordinator booking
//                 page and nothing else, and is never routed calls. Ranked BELOW
//                 agent, so every `atLeast` gate in the repo refuses it without
//                 having to name it; what it may open is `canUseCoordinatorDesk`.
//   agent       - manage only their own settings/hours
//   manager     - the above, plus edit ANY agent's settings/hours/bookable
//   team_lead   - the above, plus approve/decline time off for ANY agent (not
//                 just their reports); no other admin powers
//   admin       - the above, plus org/app config (incl. the org-wide default
//                 working hours) and role assignment
//   super_admin - the above, plus the only role that can grant or revoke
//                 super_admin
export const ROLE_RANK: Record<Role, number> = {
  coordinator: -1,
  agent: 0,
  manager: 1,
  team_lead: 2,
  admin: 3,
  super_admin: 4,
};
export const ROLES: Role[] = [
  "coordinator",
  "agent",
  "manager",
  "team_lead",
  "admin",
  "super_admin",
];

export const isRole = (v: string): v is Role => (ROLES as string[]).includes(v);

/** Human-facing role label (the stored value uses an underscore). */
export const roleLabel = (role: Role): string =>
  role === "super_admin"
    ? "super admin"
    : role === "team_lead"
      ? "team lead"
      : role;

export const atLeast = (role: Role, min: Role): boolean =>
  ROLE_RANK[role] >= ROLE_RANK[min];

/**
 * Which roles open the staff pages, `/admin` and a person's own `/me` (#4205). A
 * table over the Role union rather than `role !== "coordinator"`, so the next role
 * added makes `tsc` ask the question instead of inheriting an answer (L113).
 *
 * A coordinator opens none of them: `currentUser` (src/lib/auth.ts) answers null for
 * one, which every staff page, server action and API route already treats as signed
 * out, so no page has to remember to refuse them.
 */
const OPENS_STAFF_CONSOLE: Record<Role, boolean> = {
  coordinator: false,
  agent: true,
  manager: true,
  team_lead: true,
  admin: true,
  super_admin: true,
};

export const opensStaffConsole = (role: Role): boolean => OPENS_STAFF_CONSOLE[role];

/**
 * Who may open the coordinator booking page and place calls from it (#4205): the
 * coordinators, and admins, who train them and drill the page. Advisors, managers
 * and team leads do not; widening this is a decision, made here and nowhere else.
 */
const USES_COORDINATOR_DESK: Record<Role, boolean> = {
  coordinator: true,
  agent: false,
  manager: false,
  team_lead: false,
  admin: true,
  super_admin: true,
};

export const canUseCoordinatorDesk = (role: Role): boolean => USES_COORDINATOR_DESK[role];

/** Managers and admins can manage the agent roster (hours/settings/bookable). */
export const canManageAgents = (role: Role): boolean => atLeast(role, "manager");

/**
 * Approve or decline ANY agent's time off, not just your own reports. Team
 * leads and up (admins, super admins); a regular manager stays scoped to the
 * agents who report to them.
 */
export const canModerateAllOoo = (role: Role): boolean =>
  atLeast(role, "team_lead");

/** Only admins touch org/app config (event types, buckets, webhooks). */
export const canEditOrgSettings = (role: Role): boolean => atLeast(role, "admin");

/**
 * Admins edit the org-wide default working hours (the company default
 * schedule), alongside the rest of org config.
 */
export const canEditOrgDefaults = (role: Role): boolean =>
  atLeast(role, "admin");

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
 * Whether `actor` may impersonate (view/act as) `target`. Two conditions, so it
 * can never be a privilege escalation: only admins and up impersonate at all,
 * and only ever someone who ranks STRICTLY below them. This closes #588 — a rank-3
 * admin could impersonate a rank-4 super_admin and inherit their powers. Mirrors
 * `canManageUser`'s strict-outrank rule; the "may impersonate at all" floor lives
 * in `resolveEffectiveUserId` too (which can't see the target's role).
 *
 * #4205: never a coordinator. "View as" shows a person's staff pages, and a
 * coordinator has none, so the session would act as somebody `currentUser` refuses.
 */
export const canImpersonate = (actor: Role, target: Role): boolean =>
  atLeast(actor, "admin") && opensStaffConsole(target) && ROLE_RANK[actor] > ROLE_RANK[target];

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

/**
 * Self-lockout guard: an admin-or-above stripping their OWN org power would lose
 * `/admin` access with no in-product way to restore it (recovery needs a direct
 * DB write). Distinct from the last-admin invariant — this fires even when other
 * admins remain. Returns true if the change is a self-demotion that must be blocked.
 */
export const isSelfDemotion = (
  isSelf: boolean,
  current: Role,
  next: Role,
): boolean => isSelf && atLeast(current, "admin") && !atLeast(next, "admin");
