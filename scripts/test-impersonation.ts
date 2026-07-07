// Tests for the impersonation security gate. This layer is the FLOOR: only a
// real admin-or-above session may act as someone else; everyone below is ignored
// (no privilege escalation). The role CEILING — you can only act as someone who
// ranks strictly below you — needs the target's role and is enforced downstream
// (canImpersonate, exercised in test-roles.ts + auth.ts resolveImpersonationTarget).
// Run: node --experimental-strip-types scripts/test-impersonation.ts
import {
  resolveEffectiveUserId,
  encodeImpersonationCookie,
  impersonationTargetId,
  IMPERSONATE_TTL_MS,
} from "../src/lib/auth/impersonation.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`ok: ${msg}`);
  else {
    console.error(`FAIL: ${msg}`);
    failures++;
  }
}

const ADMIN = "admin-id";
const SUPER = "super-id";
const TARGET = "target-id";
const NOW = 1_700_000_000_000;
// A freshly-issued cookie (this instant).
const fresh = (id: string) => encodeImpersonationCookie(id, NOW);

// --- admin can impersonate ---
assert(
  resolveEffectiveUserId("admin", ADMIN, fresh(TARGET), NOW) === TARGET,
  "admin with a fresh cookie acts as the target",
);
assert(
  resolveEffectiveUserId("admin", ADMIN, undefined, NOW) === ADMIN,
  "admin without a cookie acts as themselves",
);
assert(
  resolveEffectiveUserId("admin", ADMIN, fresh(ADMIN), NOW) === ADMIN,
  "a cookie pointing at the admin is a no-op",
);

// --- super_admin can impersonate too (the secondary bug: exact-match "admin"
// locked them out of the feature entirely) ---
assert(
  resolveEffectiveUserId("super_admin", SUPER, fresh(TARGET), NOW) === TARGET,
  "super_admin with a fresh cookie acts as the target",
);
assert(
  resolveEffectiveUserId("super_admin", SUPER, undefined, NOW) === SUPER,
  "super_admin without a cookie acts as themselves",
);

// --- non-admins can NEVER impersonate, even with a forged cookie ---
assert(
  resolveEffectiveUserId("agent", "agent-id", fresh(TARGET), NOW) === "agent-id",
  "an agent's impersonation cookie is ignored",
);
assert(
  resolveEffectiveUserId("manager", "mgr-id", fresh(ADMIN), NOW) === "mgr-id",
  "a manager cannot escalate to admin via a forged cookie",
);
assert(
  resolveEffectiveUserId("agent", "agent-id", undefined, NOW) === "agent-id",
  "agent with no cookie is themselves",
);

// --- expiry (#653): a stale impersonation cookie auto-ends ---
assert(
  resolveEffectiveUserId(
    "admin",
    ADMIN,
    encodeImpersonationCookie(TARGET, NOW - IMPERSONATE_TTL_MS - 1),
    NOW,
  ) === ADMIN,
  "a cookie older than the TTL is ignored (session expired, acts as self)",
);
assert(
  resolveEffectiveUserId(
    "admin",
    ADMIN,
    encodeImpersonationCookie(TARGET, NOW - IMPERSONATE_TTL_MS + 1000),
    NOW,
  ) === TARGET,
  "a cookie just inside the TTL is still honored",
);
assert(
  resolveEffectiveUserId(
    "admin",
    ADMIN,
    encodeImpersonationCookie(TARGET, NOW - IMPERSONATE_TTL_MS),
    NOW,
  ) === ADMIN,
  "a cookie at exactly the TTL boundary has expired (acts as self)",
);
// --- legacy / malformed cookies fail closed (ignored → acts as self) ---
assert(
  resolveEffectiveUserId("admin", ADMIN, TARGET, NOW) === ADMIN,
  "a legacy bare-id cookie (no timestamp) is ignored",
);
assert(
  resolveEffectiveUserId("admin", ADMIN, `${TARGET}.notanumber`, NOW) === ADMIN,
  "a cookie with a non-numeric timestamp is ignored",
);
assert(
  resolveEffectiveUserId("admin", ADMIN, "", NOW) === ADMIN,
  "an empty cookie is ignored",
);

// --- impersonationTargetId extracts the clean id for the stop audit (#653) ---
assert(
  impersonationTargetId(encodeImpersonationCookie(TARGET, NOW)) === TARGET,
  "decodes the target id out of an encoded cookie",
);
assert(
  impersonationTargetId(TARGET) === TARGET,
  "returns a legacy bare-id cookie as-is",
);
assert(
  impersonationTargetId(undefined) === undefined,
  "undefined cookie stays undefined",
);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nALL PASSED");
