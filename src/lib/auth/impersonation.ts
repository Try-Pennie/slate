import { atLeast } from "@/lib/auth/roles";
import type { Role } from "@/lib/db/types";

/** Cookie carrying the impersonated user's id + issue time. Only honored for admin+ sessions. */
export const IMPERSONATE_COOKIE = "slate_impersonate";

/**
 * How long a "view as" session lives before it auto-expires (#653). Enforced
 * authoritatively server-side (in `resolveEffectiveUserId`) and mirrored by the
 * cookie's `maxAge` as defense in depth, so a stale session can't linger even if
 * the browser ignores the cookie's own expiry.
 */
export const IMPERSONATE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
export const IMPERSONATE_TTL_SECONDS = IMPERSONATE_TTL_MS / 1000;

/**
 * The cookie value: the target's id and the ms timestamp it was issued at, joined
 * by a `.`. User ids are UUIDs (no dots), so the last segment is unambiguously the
 * timestamp. Pair with `resolveEffectiveUserId`, which enforces the TTL.
 */
export function encodeImpersonationCookie(targetId: string, issuedAtMs: number): string {
  return `${targetId}.${issuedAtMs}`;
}

/**
 * Parse a cookie written by `encodeImpersonationCookie`. Returns null for anything
 * malformed (including a legacy bare-id cookie with no timestamp), so callers fail
 * closed and treat it as no impersonation.
 */
function parseImpersonationCookie(
  value: string,
): { targetId: string; issuedAtMs: number } | null {
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const targetId = value.slice(0, dot);
  const issuedAtMs = Number(value.slice(dot + 1));
  if (!Number.isFinite(issuedAtMs)) return null;
  return { targetId, issuedAtMs };
}

/**
 * Extract just the target user id from a cookie value, for callers that need the
 * id regardless of expiry (e.g. the stop-impersonation audit log). A legacy
 * bare-id cookie (no timestamp) is returned as-is; undefined stays undefined.
 */
export function impersonationTargetId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return parseImpersonationCookie(value)?.targetId ?? value;
}

/**
 * Which user id a request should act as. This is the FLOOR gate: impersonation is
 * honored ONLY when the real session is an admin or super_admin — for everyone
 * else the cookie is ignored, so a forged cookie can never escalate privileges. A
 * cookie pointing at the actor themselves is a no-op. Sessions also EXPIRE after
 * `IMPERSONATE_TTL_MS` (#653): a cookie older than the TTL, or malformed/legacy,
 * is ignored and the actor reverts to themselves. The CEILING (you can only ever
 * act as someone ranked strictly below you) needs the target's role and so is
 * enforced downstream in `currentUser()` via `canImpersonate`. See
 * `scripts/test-impersonation.ts`.
 */
export function resolveEffectiveUserId(
  realRole: Role,
  realId: string,
  impersonateCookie: string | undefined,
  nowMs: number,
): string {
  if (!atLeast(realRole, "admin")) return realId;
  if (!impersonateCookie) return realId;
  const parsed = parseImpersonationCookie(impersonateCookie);
  if (!parsed) return realId;
  if (nowMs - parsed.issuedAtMs >= IMPERSONATE_TTL_MS) return realId;
  if (parsed.targetId === realId) return realId;
  return parsed.targetId;
}
