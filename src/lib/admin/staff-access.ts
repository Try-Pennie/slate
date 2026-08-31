import {
  atLeast,
  canChangeRole,
  canSetRole,
  isSelfDemotion,
  roleLabel,
} from "../auth/roles.ts";
import { isAllowedEmail } from "../auth/domain.ts";
import type { Role } from "../db/types.ts";

/**
 * Granting elevated access to somebody who is not a Salesforce debt team agent
 * (#160).
 *
 * Nothing creates these people: they are not in the agent feed, so before this
 * every admin, team lead and manager who was not an agent arrived by a developer
 * hand editing the users table. That had a second, worse cost. `provisionUser`
 * matches a login to a row BY EMAIL, so a seeded row keyed to an address that is
 * not the person's real Google login is never used: they sign in, get a fresh
 * `agent` row, and the seeded access sits there forever with nothing reporting it.
 *
 * This module is the whole decision, kept pure so every refusal has a test and so
 * the wording lives beside the rule that produces it rather than at the call site.
 *
 * Three things it deliberately does NOT do:
 *
 *  - It never widens `canSetRole`. Every path runs the same guard the per user
 *    role editor runs, so this surface can only ever be a narrower door.
 *  - It never mints a `super_admin`. That role is the only one that can grant or
 *    revoke itself, and doing it from a typed address means the target is a string
 *    rather than a row somebody has looked at. It stays on the per user editor.
 *  - It never treats an unreadable admin count as a number. #1165 scored a FAILED
 *    count as zero and refused with "cannot remove the last admin", a claim the
 *    check had not measured. Here `adminCount: null` means "could not tell" and
 *    gets its own refusal, in its own words.
 */

/** The roles this surface may grant. Deliberately excludes agent and super admin. */
export const GRANTABLE_STAFF_ROLES: Role[] = ["manager", "team_lead", "admin"];

/**
 * Every way this can end, success and refusal alike, as a runtime list so the
 * message map is checked against the real vocabulary rather than a second hand
 * written copy of it (the `AUDIT_ACTIONS` lesson).
 */
export const STAFF_ACCESS_OUTCOMES = [
  "granted",
  "updated",
  "unchanged",
  "invalid_email",
  "wrong_domain",
  "invalid_role",
  "not_authorized",
  "self_change",
  "deactivated",
  "other_org",
  "lookup_failed",
  "write_failed",
  "admin_count_unreadable",
  "last_admin",
] as const;

export type StaffAccessOutcome = (typeof STAFF_ACCESS_OUTCOMES)[number];

export const isStaffAccessOutcome = (v: string): v is StaffAccessOutcome =>
  (STAFF_ACCESS_OUTCOMES as readonly string[]).includes(v);

/** The row the address already resolves to, if any. */
export interface StaffAccessTarget {
  id: string;
  org_id: string;
  role: Role;
  deactivated_at: string | null;
  auth_user_id: string | null;
}

export type StaffAccessPlan =
  | { ok: true; outcome: "granted"; email: string; role: Role }
  | { ok: true; outcome: "updated"; userId: string; email: string; from: Role; role: Role }
  | { ok: true; outcome: "unchanged"; userId: string; email: string; role: Role }
  | { ok: false; outcome: StaffAccessOutcome };

export interface StaffAccessInput {
  actorRole: Role;
  actorId: string;
  actorOrgId: string;
  /** The Workspace domain sign in is gated on; empty means any account may sign in. */
  allowedDomain: string;
  email: string;
  requestedRole: string;
  existing: StaffAccessTarget | null;
  /** The org's admin count, or null when the read FAILED. Never defaulted to 0. */
  adminCount: number | null;
}

/** Login matches on the stored address, so the stored address is what login sees. */
export const normalizeStaffEmail = (raw: string): string => raw.trim().toLowerCase();

/** Only a super admin may grant staff access, and it is checked here as well as at the route. */
export const canGrantStaffAccess = (actor: Role): boolean => actor === "super_admin";

export const isGrantableStaffRole = (v: string): v is Role =>
  (GRANTABLE_STAFF_ROLES as string[]).includes(v);

/**
 * A readable refusal for an address that cannot be a Google login, or null when
 * the shape is usable. Deliberately shape only: whether the ACCOUNT exists is a
 * question this repo cannot ask (see `pending-access.ts`).
 */
export function staffEmailError(email: string): string | null {
  const value = normalizeStaffEmail(email);
  if (!value) return "Enter the work email address this person signs in with.";
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value)) {
    return "That does not look like an email address. Check it and try again.";
  }
  return null;
}

/**
 * Whether the admin count decides this change. It only does when org power is
 * being taken away, so a broken count read can never block a grant that never
 * depended on it.
 */
export const requiresAdminCount = (current: Role, next: Role): boolean =>
  atLeast(current, "admin") && !atLeast(next, "admin");

/**
 * Everything that can be judged from the SUBMISSION alone, with no database read:
 * who is asking, whether the address could ever be a login, and whether the role
 * is one this surface offers.
 *
 * Split out so the action can refuse before it touches the database AND
 * `planStaffAccess` can apply the same rules, from one definition. A second copy
 * beside the call site is how two gates drift apart while both read as correct.
 */
export function staffAccessInputError(input: {
  actorRole: Role;
  email: string;
  requestedRole: string;
  allowedDomain: string;
}): StaffAccessOutcome | null {
  if (!canGrantStaffAccess(input.actorRole)) return "not_authorized";
  const email = normalizeStaffEmail(input.email);
  if (staffEmailError(email)) return "invalid_email";
  // Sign in is gated on the Workspace domain (#589), so an address outside it can
  // never become a session. Granting to one is a guaranteed silent failure, and
  // this is the one mismatch Slate can catch at the moment of typing.
  if (!isAllowedEmail(email, input.allowedDomain)) return "wrong_domain";
  if (!isGrantableStaffRole(input.requestedRole)) return "invalid_role";
  return null;
}

export function planStaffAccess(input: StaffAccessInput): StaffAccessPlan {
  const { actorRole, actorId, actorOrgId, allowedDomain, existing, adminCount } = input;

  const email = normalizeStaffEmail(input.email);
  const next = input.requestedRole;
  const inputError = staffAccessInputError({ actorRole, email, requestedRole: next, allowedDomain });
  if (inputError) return { ok: false, outcome: inputError };
  if (!isGrantableStaffRole(next)) return { ok: false, outcome: "invalid_role" };

  // A brand new row starts where `provisionUser` would start it, so the same
  // `canSetRole` question is asked of a create as of a promotion.
  const current: Role = existing?.role ?? "agent";
  if (!canSetRole(actorRole, current, next)) return { ok: false, outcome: "not_authorized" };

  if (!existing) return { ok: true, outcome: "granted", email, role: next };

  // Email is globally unique, so an address held by another org is a collision,
  // not an absence. Refused by name rather than being quietly reused or hitting
  // the unique index as an unexplained write failure.
  if (existing.org_id !== actorOrgId) return { ok: false, outcome: "other_org" };
  if (existing.deactivated_at) return { ok: false, outcome: "deactivated" };
  if (existing.role === next) {
    return { ok: true, outcome: "unchanged", userId: existing.id, email, role: next };
  }
  if (isSelfDemotion(existing.id === actorId, current, next)) {
    return { ok: false, outcome: "self_change" };
  }
  if (requiresAdminCount(current, next)) {
    if (adminCount === null) return { ok: false, outcome: "admin_count_unreadable" };
    if (!canChangeRole(current, next, adminCount)) return { ok: false, outcome: "last_admin" };
  }
  return { ok: true, outcome: "updated", userId: existing.id, email, from: current, role: next };
}

export interface StaffAccessMessage {
  tone: "success" | "error" | "info";
  text: string;
}

/**
 * What the super admin reads after pressing the button. Every outcome gets its
 * own sentence, because two refusals that render the same are one refusal in
 * practice, and the reader cannot act on a cause nobody named.
 */
export function staffAccessMessage(
  outcome: StaffAccessOutcome,
  email: string,
  role?: Role,
): StaffAccessMessage {
  const asRole = role ? ` as ${roleLabel(role)}` : "";
  switch (outcome) {
    case "granted":
      return {
        tone: "success",
        text: `${email} now has access${asRole}. They get it the first time they sign in with that exact address, so check it reads correctly here.`,
      };
    case "updated":
      return {
        tone: "success",
        text: `${email} has been updated${asRole}.`,
      };
    case "unchanged":
      return {
        tone: "info",
        text: `${email} already had that access, so nothing changed.`,
      };
    case "invalid_email":
      return {
        tone: "error",
        text: "That does not look like an email address. Check it and try again.",
      };
    case "wrong_domain":
      return {
        tone: "error",
        text: `${email} is outside the company Google domain, so it could never sign in. Use their work address.`,
      };
    case "invalid_role":
      return {
        tone: "error",
        text: "Pick one of the roles offered. Super admin is granted from the person's own page, not from here.",
      };
    case "not_authorized":
      return { tone: "error", text: "You need a super admin account to grant access." };
    case "self_change":
      return {
        tone: "error",
        text: "You cannot take away your own admin access here, because nothing in Slate could give it back.",
      };
    case "deactivated":
      return {
        tone: "error",
        text: `${email} has left, so their account is closed. Reactivate them on their own page first, then set the role.`,
      };
    case "other_org":
      return {
        tone: "error",
        text: `${email} already belongs to another organisation, so it cannot be added here.`,
      };
    case "lookup_failed":
      return {
        tone: "error",
        text: "Slate could not check whether that address already has an account, so nothing was changed. Try again in a moment.",
      };
    case "write_failed":
      return {
        tone: "error",
        text: "The change could not be saved, so nothing was changed. Try again in a moment.",
      };
    case "admin_count_unreadable":
      return {
        tone: "error",
        text: "Slate could not count how many admins remain, so the role was left as it was. Try again in a moment.",
      };
    case "last_admin":
      return {
        tone: "error",
        text: "That would leave Pennie with no admin, so the role was left as it was.",
      };
  }
}
