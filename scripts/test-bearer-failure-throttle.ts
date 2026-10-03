// #3142: every key authenticated route refuses a bad credential through the failed
// credential throttle (`refuseCredential` in src/lib/bearer-failure.ts, or
// `bearerFailureWithinLimit` directly in the booking API's shared authorizer), so a flood of
// garbage tokens buys a bounded amount of work. The throttle itself is pinned in
// bearer-failure.test.ts and route-auth.test.ts; this pins that it is WIRED (L3).
//
// The routes are ENUMERATED: any file under src/app, or a shared handler under src/lib that
// builds a route's refusal, that calls one of the credential checks below is in scope, so a
// new key authed route is covered by construction (L96). What is NOT in scope, said here so
// it is not assumed: the cron routes, which check their secret through `isAuthorizedCron`
// (src/lib/cron.ts) rather than calling a check themselves.
//
// The escape hatch is `// credential-throttle-ok: <reason>` in the file, for a check whose
// failure refuses nothing (the availability route reads a canary key only to decide whether
// a test bucket may be shown).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-bearer-failure-throttle.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { textHasOptOut } from "./lib/opt-out.ts";

const ROOT = join(import.meta.dirname, "..");
const CHECKS = /\b(?:bearerTokenMatches|authenticateBearer|timingSafeEqual)\(/;
const THROTTLED = /\b(?:refuseCredential|refuseBearerAuth|bearerFailureWithinLimit)\(/;
const HATCH = "credential-throttle-ok:";

/** Whether one file checks a credential and then refuses without the throttle. */
export function unthrottledRefusal(src: string): boolean {
  return CHECKS.test(src) && !THROTTLED.test(src) && !textHasOptOut(src, HATCH);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

/** The shared handlers that build a route's refusal on a route's behalf. */
const SHARED_HANDLERS = ["src/lib/offboarding/route-handler.ts", "src/lib/booking/route-auth.ts"];

const files = [...walk(join(ROOT, "src", "app")), ...SHARED_HANDLERS.map((f) => join(ROOT, f))];
const inScope = files.filter((f) => CHECKS.test(readFileSync(f, "utf8")));
assert(inScope.length >= 10, `found the key authenticated routes (${inScope.length})`);
for (const f of inScope) {
  eq(
    unthrottledRefusal(readFileSync(f, "utf8")),
    false,
    `${relative(ROOT, f)} refuses a bad credential through the failed credential throttle`,
  );
}

// Positive controls: a bare refusal is caught, the throttled one passes, and a hatch needs a reason.
{
  const bare = 'if (!bearerTokenMatches(h, key)) return new NextResponse("unauthorized", { status: 401 });';
  assert(unthrottledRefusal(bare), "a bare refusal after a credential check is caught");
  const wired =
    'if (!bearerTokenMatches(h, key)) return refuseCredential(req.headers, () => new NextResponse("x"));';
  assert(!unthrottledRefusal(wired), "the throttled refusal passes");
  assert(unthrottledRefusal(`// credential-throttle-ok:\n${bare}`), "a hatch with no reason exempts nothing");
}

finish();
