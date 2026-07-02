// Tests for the server-side Google Workspace domain gate (pure module).
// Guards #589: any non-domain Google account must be rejected before it can
// provision a Slate users row.
// Run: node --experimental-strip-types scripts/test-auth-domain.ts
import { isAllowedEmail } from "../src/lib/auth/domain.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

// Empty domain = the open PoC mode: every account is allowed.
assert(isAllowedEmail("anyone@gmail.com", ""), "empty domain allows any account");
assert(isAllowedEmail("", ""), "empty domain allows even an empty email");

// A configured domain admits its own members, case-insensitively.
assert(
  isAllowedEmail("dwright@trypennie.com", "trypennie.com"),
  "matching domain is allowed",
);
assert(
  isAllowedEmail("DWright@TryPennie.COM", "trypennie.com"),
  "domain match ignores case on both sides",
);
assert(
  isAllowedEmail("dwright@trypennie.com", " TRYPENNIE.COM "),
  "configured domain is trimmed and lowercased",
);

// Outsiders and look-alikes are rejected.
assert(
  !isAllowedEmail("attacker@gmail.com", "trypennie.com"),
  "non-domain account is rejected",
);
assert(
  !isAllowedEmail("attacker@trypennie.com.evil.com", "trypennie.com"),
  "suffix look-alike domain is rejected",
);
assert(
  !isAllowedEmail("attacker@evil.trypennie.com", "trypennie.com"),
  "subdomain is not the domain and is rejected",
);
assert(
  !isAllowedEmail("attacker@sub.trypennie.com", "trypennie.com"),
  "an arbitrary subdomain is rejected (exact match only)",
);

// Malformed emails never satisfy a configured domain.
assert(!isAllowedEmail("no-at-sign", "trypennie.com"), "email with no @ is rejected");
assert(!isAllowedEmail("", "trypennie.com"), "empty email is rejected");
assert(!isAllowedEmail("trailing@", "trypennie.com"), "empty domain part is rejected");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
