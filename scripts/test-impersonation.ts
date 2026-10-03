// Tests for the impersonation security gate. This layer is the FLOOR: only a
// real admin-or-above session may act as someone else; everyone below is ignored
// (no privilege escalation). The role CEILING (you can only act as someone who
// ranks strictly below you) needs the target's role and is enforced downstream
// (canImpersonate, exercised in test-roles.ts + auth.ts resolveImpersonationTarget).
//
// #3113 added the two things the cookie could not prove before: that THIS
// deployment minted it for THIS admin (an HMAC over issuer, target and issue
// time), and that its issue time is not in the future (a future time made
// `now - issuedAt` negative, so it never expired).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-impersonation.ts
import {
  resolveEffectiveUserId,
  impersonationCookieOutcome,
  encodeImpersonationCookie,
  impersonationTargetId,
  IMPERSONATE_TTL_MS,
  IMPERSONATE_FUTURE_SKEW_MS,
} from "../src/lib/auth/impersonation.ts";
import type { Role } from "../src/lib/db/types.ts";
import { assert, finish } from "./lib/harness.ts";

const ADMIN = "admin-id";
const SUPER = "super-id";
const TARGET = "target-id";
const NOW = 1_700_000_000_000;
const SECRET = "test-signing-secret";

const cookieFor = (issuerId: string, targetId: string, issuedAtMs = NOW, secret = SECRET) =>
  encodeImpersonationCookie({ issuerId, targetId, issuedAtMs, secret });

async function actsAs(realRole: Role, realId: string, cookie: string | undefined, nowMs = NOW) {
  return resolveEffectiveUserId({ realRole, realId, cookie, nowMs, secret: SECRET });
}
async function outcome(realRole: Role, realId: string, cookie: string | undefined, nowMs = NOW) {
  return impersonationCookieOutcome({ realRole, realId, cookie, nowMs, secret: SECRET });
}

// --- admin can impersonate ---
assert(
  (await actsAs("admin", ADMIN, await cookieFor(ADMIN, TARGET))) === TARGET,
  "admin with a fresh cookie acts as the target",
);
assert((await actsAs("admin", ADMIN, undefined)) === ADMIN, "admin without a cookie acts as themselves");
assert(
  (await actsAs("admin", ADMIN, await cookieFor(ADMIN, ADMIN))) === ADMIN,
  "a cookie pointing at the admin is a no-op",
);

// --- super_admin can impersonate too (exact-match "admin" once locked them out) ---
assert(
  (await actsAs("super_admin", SUPER, await cookieFor(SUPER, TARGET))) === TARGET,
  "super_admin with a fresh cookie acts as the target",
);
assert((await actsAs("super_admin", SUPER, undefined)) === SUPER, "super_admin without a cookie acts as themselves");

// --- non-admins can NEVER impersonate, even with a validly signed cookie ---
assert(
  (await actsAs("agent", "agent-id", await cookieFor("agent-id", TARGET))) === "agent-id",
  "an agent's impersonation cookie is ignored",
);
assert(
  (await actsAs("manager", "mgr-id", await cookieFor("mgr-id", ADMIN))) === "mgr-id",
  "a manager cannot escalate to admin via a cookie",
);
assert((await actsAs("agent", "agent-id", undefined)) === "agent-id", "agent with no cookie is themselves");

// --- expiry (#653): a stale impersonation cookie auto-ends ---
assert(
  (await actsAs("admin", ADMIN, await cookieFor(ADMIN, TARGET, NOW - IMPERSONATE_TTL_MS - 1))) === ADMIN,
  "a cookie older than the TTL is ignored (session expired, acts as self)",
);
assert(
  (await actsAs("admin", ADMIN, await cookieFor(ADMIN, TARGET, NOW - IMPERSONATE_TTL_MS + 1000))) === TARGET,
  "a cookie just inside the TTL is still honored",
);
assert(
  (await actsAs("admin", ADMIN, await cookieFor(ADMIN, TARGET, NOW - IMPERSONATE_TTL_MS))) === ADMIN,
  "a cookie at exactly the TTL boundary has expired (acts as self)",
);

// --- #3113: a future issue time is refused, even when correctly signed ---
{
  const farFuture = await cookieFor(ADMIN, TARGET, NOW + 365 * 24 * 60 * 60 * 1000);
  assert((await outcome("admin", ADMIN, farFuture)).kind === "ended", "a cookie issued a year ahead -> ended");
  // It must STAY refused as time passes, which is the whole defect: before, it
  // was honored until the clock caught up, a year later.
  assert(
    (await outcome("admin", ADMIN, farFuture, NOW + IMPERSONATE_TTL_MS * 10)).kind === "ended",
    "and is still refused long after it would have expired had it been honest",
  );
  const beyondSkew = await cookieFor(ADMIN, TARGET, NOW + IMPERSONATE_FUTURE_SKEW_MS + 1);
  assert((await outcome("admin", ADMIN, beyondSkew)).kind === "ended", "one millisecond past the skew -> ended");
  // The positive side: ordinary clock skew between isolates is tolerated.
  const withinSkew = await cookieFor(ADMIN, TARGET, NOW + IMPERSONATE_FUTURE_SKEW_MS);
  const o = await outcome("admin", ADMIN, withinSkew);
  assert(o.kind === "candidate" && o.targetId === TARGET, "a cookie at the skew limit is still honored");
}

// --- #3113: only a cookie this deployment signed for this admin is honored ---
{
  // The pre-#3113 shape, which anybody could write by hand.
  assert((await outcome("admin", ADMIN, `${TARGET}.${NOW}`)).kind === "ended", "an unsigned id.timestamp cookie -> ended");
  const real = await cookieFor(ADMIN, TARGET);
  const [, , mac] = real.split(".");
  assert(
    (await outcome("admin", ADMIN, `other-target.${NOW}.${mac}`)).kind === "ended",
    "a signature moved onto another target -> ended",
  );
  assert(
    (await outcome("admin", ADMIN, `${TARGET}.${NOW + 1000}.${mac}`)).kind === "ended",
    "a signature moved onto another issue time (the hand extended session) -> ended",
  );
  assert(
    (await outcome("admin", "other-admin", real)).kind === "ended",
    "one admin's cookie is refused in another admin's session",
  );
  assert(
    (await outcome("admin", ADMIN, await cookieFor(ADMIN, TARGET, NOW, "some-other-secret"))).kind === "ended",
    "a cookie signed with another key -> ended",
  );
  assert(
    (await impersonationCookieOutcome({ realRole: "admin", realId: ADMIN, cookie: real, nowMs: NOW, secret: "" }))
      .kind === "ended",
    "with no secret to verify against, nothing is honored (fails closed)",
  );
  let threw = false;
  try {
    await cookieFor(ADMIN, TARGET, NOW, "");
  } catch {
    threw = true;
  }
  assert(threw, "minting a cookie with no secret refuses rather than writing an unsigned one");
}

// --- legacy / malformed cookies fail closed (ignored, acts as self) ---
assert((await actsAs("admin", ADMIN, TARGET)) === ADMIN, "a legacy bare-id cookie is ignored");
assert((await actsAs("admin", ADMIN, `${TARGET}.notanumber.x`)) === ADMIN, "a non-numeric timestamp is ignored");
assert((await actsAs("admin", ADMIN, `${TARGET}.-5.x`)) === ADMIN, "a negative timestamp is ignored");
assert((await actsAs("admin", ADMIN, "")) === ADMIN, "an empty cookie is ignored");

// --- impersonationTargetId extracts the clean id for the stop audit (#653) ---
assert(impersonationTargetId(await cookieFor(ADMIN, TARGET)) === TARGET, "decodes the target id out of a signed cookie");
assert(impersonationTargetId(`${TARGET}.${NOW}`) === TARGET, "and out of a pre-#3113 id.timestamp cookie");
assert(impersonationTargetId(TARGET) === TARGET, "returns a legacy bare-id cookie as-is");
assert(impersonationTargetId(undefined) === undefined, "undefined cookie stays undefined");

// --- impersonationCookieOutcome classifies WHY a cookie was honored or not
//     (#652): 'none' (ignore silently), 'ended' (present but not honored ->
//     notify), 'candidate' (valid, still needs the downstream DB check) ---
assert((await outcome("admin", ADMIN, undefined)).kind === "none", "no cookie -> none");
assert(
  (await outcome("agent", "agent-id", await cookieFor("agent-id", TARGET))).kind === "none",
  "a non-admin's cookie -> none (never a drop notice for them)",
);
assert((await outcome("admin", ADMIN, await cookieFor(ADMIN, ADMIN))).kind === "none", "a self-pointing cookie -> none");
{
  const o = await outcome("admin", ADMIN, await cookieFor(ADMIN, TARGET));
  assert(o.kind === "candidate" && o.targetId === TARGET, "a fresh cookie pointing elsewhere -> candidate(targetId)");
}
assert(
  (await outcome("admin", ADMIN, await cookieFor(ADMIN, TARGET, NOW - IMPERSONATE_TTL_MS))).kind === "ended",
  "an expired cookie -> ended (session timed out)",
);
assert((await outcome("admin", ADMIN, TARGET)).kind === "ended", "a legacy bare-id cookie -> ended (stale, clear it)");
assert((await outcome("admin", ADMIN, `${TARGET}.nope`)).kind === "ended", "a malformed-timestamp cookie -> ended");

finish();
