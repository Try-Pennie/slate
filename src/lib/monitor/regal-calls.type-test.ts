/**
 * Compile-time guard for #2090: a sixth role fails the build rather than being
 * silently exempted from, or silently subjected to, the Regal call alert.
 *
 * `REGAL_ROLE_EXEMPT` is a `Record<Role, boolean>`, which is what makes `tsc`
 * refuse a Role union that has grown a member the table does not name. This file
 * proves the table really is that type: widening Role by one member must NOT be
 * satisfied by the table. If somebody loosened the table to `Record<string,
 * boolean>` (or wrote `role !== "agent"` in its place), the assignment below would
 * compile, the `@ts-expect-error` would become unused, and `tsc --noEmit` (CI and
 * the pre-push gate) fails on that instead.
 *
 * Never imported at runtime; it exists only to be type-checked.
 */
import { REGAL_ROLE_EXEMPT } from "@/lib/monitor/regal-calls";
import type { Role } from "@/lib/db/types";

type WithASixthRole = Role | "contractor";

// @ts-expect-error the table names no entry for "contractor", so a sixth role is a build failure
export const _sixthRoleIsRefused: Record<WithASixthRole, boolean> = REGAL_ROLE_EXEMPT;

// And the table still satisfies the union as it stands.
export const _currentRolesAccepted: Record<Role, boolean> = REGAL_ROLE_EXEMPT;
