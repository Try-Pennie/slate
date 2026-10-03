import { atLeast } from "@/lib/auth/roles";
import { timingSafeEqual } from "@/lib/bearer-auth";
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
 * How far in the future an issue time may sit before the cookie is refused
 * (#3113). The TTL check is `now - issuedAt`, so a FUTURE issue time never
 * expired at all. A minute covers clock skew between Worker isolates, and
 * nothing this module writes is ever ahead of the clock that reads it by more.
 */
export const IMPERSONATE_FUTURE_SKEW_MS = 60 * 1000;

/**
 * Prefixed onto everything signed, so a MAC minted here can never be replayed as
 * a MAC for anything else signed with the same key (#3113).
 */
const SIGNING_LABEL = "slate-impersonation-v1";

const encoder = new TextEncoder();

function base64Url(bytes: ArrayBuffer): string {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * HMAC-SHA256 over the issuing admin, the target and the issue time (#3113). The
 * issuer is in the MAC, so one admin's cookie is worthless in another admin's
 * browser, and a hand-written cookie (which skipped the `impersonate.start`
 * audit and could carry any issue time it liked) no longer verifies at all.
 */
async function sign(
  secret: string,
  issuerId: string,
  targetId: string,
  issuedAtMs: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = `${SIGNING_LABEL}\n${issuerId}\n${targetId}\n${issuedAtMs}`;
  return base64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/**
 * The cookie value: the target's id, the ms timestamp it was issued at, and the
 * signature, joined by `.`. User ids are UUIDs and the signature is base64url, so
 * neither carries a dot. Pair with `impersonationCookieOutcome`, which verifies
 * the signature and enforces the TTL. Refuses to mint with no secret, because an
 * unsigned cookie would only ever be refused on its next read.
 */
export async function encodeImpersonationCookie(args: {
  issuerId: string;
  targetId: string;
  issuedAtMs: number;
  secret: string;
}): Promise<string> {
  if (!args.secret) throw new Error("impersonation cookie: no signing secret");
  const mac = await sign(args.secret, args.issuerId, args.targetId, args.issuedAtMs);
  return `${args.targetId}.${args.issuedAtMs}.${mac}`;
}

/**
 * Parse a cookie written by `encodeImpersonationCookie`. Returns null for anything
 * malformed (including a legacy cookie with no timestamp or no signature), so
 * callers fail closed and treat it as no impersonation.
 */
function parseImpersonationCookie(
  value: string,
): { targetId: string; issuedAtMs: number; mac: string } | null {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [targetId, issuedAt, mac] = parts;
  if (!targetId || !mac || !/^\d+$/.test(issuedAt)) return null;
  const issuedAtMs = Number(issuedAt);
  if (!Number.isSafeInteger(issuedAtMs)) return null;
  return { targetId, issuedAtMs, mac };
}

/**
 * Extract just the target user id from a cookie value, for callers that need the
 * id regardless of expiry (e.g. the stop-impersonation audit log). A legacy
 * bare-id cookie (no timestamp) is returned as-is; undefined stays undefined.
 */
export function impersonationTargetId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = parseImpersonationCookie(value);
  if (parsed) return parsed.targetId;
  // A legacy cookie: `id.timestamp` before #3113, or a bare id before #653.
  const dot = value.indexOf(".");
  return dot > 0 ? value.slice(0, dot) : value;
}

/**
 * Why an impersonation cookie was or wasn't honored (#652), so callers can tell a
 * silent-drop apart from a plain no-cookie request:
 *   - `none`      no cookie, a non-admin session (never honored), or self-pointing.
 *                 Nothing to notify; the actor is simply themselves.
 *   - `ended`     an admin's cookie that is present but not honored: past the TTL,
 *                 issued in the future, malformed/legacy, or not signed by this
 *                 deployment for this admin (#3113). The session has ended:
 *                 notify + clear it.
 *   - `candidate` a fresh, well-formed cookie pointing at someone else. Still
 *                 needs the target's role/status (the CEILING + deactivation
 *                 checks live downstream in auth.ts), which may turn it into a
 *                 drop of its own.
 * `resolveEffectiveUserId` is defined on top of this so the parse/TTL logic lives
 * in exactly one place. See `scripts/test-impersonation.ts`.
 */
export type ImpersonationCookieOutcome =
  | { kind: "none" }
  | { kind: "ended" }
  | { kind: "candidate"; targetId: string };

export async function impersonationCookieOutcome(args: {
  realRole: Role;
  realId: string;
  cookie: string | undefined;
  nowMs: number;
  /** The signing secret. Empty verifies nothing, so every cookie is `ended`. */
  secret: string;
}): Promise<ImpersonationCookieOutcome> {
  const { realRole, realId, cookie, nowMs, secret } = args;
  if (!atLeast(realRole, "admin")) return { kind: "none" };
  if (!cookie) return { kind: "none" };
  const parsed = parseImpersonationCookie(cookie);
  if (!parsed) return { kind: "ended" };
  if (parsed.targetId === realId) return { kind: "none" };
  if (nowMs - parsed.issuedAtMs >= IMPERSONATE_TTL_MS) return { kind: "ended" };
  // #3113: a future issue time would never reach the TTL above.
  if (parsed.issuedAtMs - nowMs > IMPERSONATE_FUTURE_SKEW_MS) return { kind: "ended" };
  if (!secret) return { kind: "ended" };
  const expected = await sign(secret, realId, parsed.targetId, parsed.issuedAtMs);
  if (!timingSafeEqual(parsed.mac, expected)) return { kind: "ended" };
  return { kind: "candidate", targetId: parsed.targetId };
}

/**
 * Which user id a request should act as. This is the FLOOR gate: impersonation is
 * honored ONLY when the real session is an admin or super_admin — for everyone
 * else the cookie is ignored, so a forged cookie can never escalate privileges. A
 * cookie pointing at the actor themselves is a no-op. Sessions also EXPIRE after
 * `IMPERSONATE_TTL_MS` (#653): a cookie older than the TTL, or malformed/legacy,
 * is ignored and the actor reverts to themselves, as is one issued in the future
 * or not signed for this admin (#3113). The CEILING (you can only ever
 * act as someone ranked strictly below you) needs the target's role and so is
 * enforced downstream in `currentUser()` via `canImpersonate`. See
 * `scripts/test-impersonation.ts`.
 */
export async function resolveEffectiveUserId(
  args: Parameters<typeof impersonationCookieOutcome>[0],
): Promise<string> {
  const outcome = await impersonationCookieOutcome(args);
  return outcome.kind === "candidate" ? outcome.targetId : args.realId;
}
