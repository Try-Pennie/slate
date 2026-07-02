// Tests for the impersonation security gate. This layer is the FLOOR: only a
// real admin-or-above session may act as someone else; everyone below is ignored
// (no privilege escalation). The role CEILING — you can only act as someone who
// ranks strictly below you — needs the target's role and is enforced downstream
// (canImpersonate, exercised in test-roles.ts + auth.ts resolveImpersonationTarget).
// Run: node --experimental-strip-types scripts/test-impersonation.ts
import { resolveEffectiveUserId } from "../src/lib/auth/impersonation.ts";

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

// --- admin can impersonate ---
assert(
  resolveEffectiveUserId("admin", ADMIN, TARGET) === TARGET,
  "admin with a cookie acts as the target",
);
assert(
  resolveEffectiveUserId("admin", ADMIN, undefined) === ADMIN,
  "admin without a cookie acts as themselves",
);
assert(
  resolveEffectiveUserId("admin", ADMIN, ADMIN) === ADMIN,
  "a cookie pointing at the admin is a no-op",
);

// --- super_admin can impersonate too (the secondary bug: exact-match "admin"
// locked them out of the feature entirely) ---
assert(
  resolveEffectiveUserId("super_admin", SUPER, TARGET) === TARGET,
  "super_admin with a cookie acts as the target",
);
assert(
  resolveEffectiveUserId("super_admin", SUPER, undefined) === SUPER,
  "super_admin without a cookie acts as themselves",
);

// --- non-admins can NEVER impersonate, even with a forged cookie ---
assert(
  resolveEffectiveUserId("agent", "agent-id", TARGET) === "agent-id",
  "an agent's impersonation cookie is ignored",
);
assert(
  resolveEffectiveUserId("manager", "mgr-id", ADMIN) === "mgr-id",
  "a manager cannot escalate to admin via a forged cookie",
);
assert(
  resolveEffectiveUserId("agent", "agent-id", undefined) === "agent-id",
  "agent with no cookie is themselves",
);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nALL PASSED");
