// #3142: every key authenticated route refuses a bad credential through the failed
// credential throttle (`refuseCredential` / `refuseBearerAuth` in src/lib/bearer-failure.ts,
// or `bearerFailureWithinLimit` directly in the booking API's shared authorizer), so a flood
// of garbage tokens buys a bounded amount of work. The throttle itself is pinned in
// bearer-failure.test.ts and route-auth.test.ts; this pins that it is WIRED (L3).
//
// Judged per CHECK SITE, not per file (L135): each credential check is followed by the block
// that answers its failure, and THAT block must go through the throttle, so a file that
// throttles one refusal cannot carry a second, bare one on the strength of the first.
//
// The routes are ENUMERATED: any file under src/app, or a shared handler under src/lib that
// builds a route's refusal, that calls one of the credential checks below is in scope, so a
// new key authed route is covered by construction (L96).
//
// The cron routes are in scope too since #3174: their check is `isAuthorizedCron`
// (src/lib/cron.ts), and its failure must go through `refuseCronSecret` specifically, not
// the general `refuseCredential`, because that is the one that leaves the Worker's own
// scheduled ticks (an in process request with no client address) uncounted. What is NOT in
// scope, said here so it is not assumed: a credential check inside a module under src/lib
// other than the shared handlers listed below.
//
// The escape hatch is `// credential-throttle-ok: <reason>` on or directly above the check,
// for a check whose failure must not be throttled per address (Google push, whose senders
// share a small pool) or refuses nothing at all (the availability route's canary key).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-bearer-failure-throttle.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { hasOptOutAtOffset } from "./lib/opt-out.ts";
import { blankComments } from "./lib/strip-comments.ts";

const ROOT = join(import.meta.dirname, "..");
const CHECK = /\b(?:bearerTokenMatches|authenticateBearer|timingSafeEqual|isAuthorizedCron)\(/g;
const THROTTLED = /\b(?:refuseCredential|refuseBearerAuth|bearerFailureWithinLimit)\(/;
const CRON_THROTTLED = /\brefuseCronSecret\(/;
const HATCH = "credential-throttle-ok:";

/** The first `{ ... }` block opening after `from`, brace matched, or "" when there is none. */
function nextBlock(code: string, from: number): string {
  const open = code.indexOf("{", from);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return code.slice(open, i + 1);
  }
  return code.slice(open);
}

/** The 1-based lines of every credential check whose failure block skips the throttle. */
export function unthrottledRefusals(src: string): number[] {
  const code = blankComments(src);
  const bad: number[] = [];
  for (const m of code.matchAll(CHECK)) {
    const at = m.index ?? 0;
    if (hasOptOutAtOffset(src, at, HATCH)) continue;
    const wanted = m[0].startsWith("isAuthorizedCron") ? CRON_THROTTLED : THROTTLED;
    if (wanted.test(nextBlock(code, at))) continue;
    bad.push(code.slice(0, at).split("\n").length);
  }
  return bad;
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
const inScope = files.filter((f) => new RegExp(CHECK.source).test(blankComments(readFileSync(f, "utf8"))));
assert(inScope.length >= 10, `found the key authenticated routes (${inScope.length})`);
for (const f of inScope) {
  eq(
    unthrottledRefusals(readFileSync(f, "utf8")).join(","),
    "",
    `${relative(ROOT, f)} refuses every bad credential through the failed credential throttle`,
  );
}

// Positive controls.
{
  const bare = 'if (!bearerTokenMatches(h, key)) {\n  return new NextResponse("unauthorized", { status: 401 });\n}';
  const wired =
    'if (!bearerTokenMatches(h, key)) {\n  return refuseCredential(req.headers, () => new NextResponse("x"));\n}';
  eq(unthrottledRefusals(bare).length, 1, "a bare refusal after a credential check is caught");
  eq(unthrottledRefusals(wired).length, 0, "the throttled refusal passes");
  eq(
    unthrottledRefusals(`${wired}\n${bare}`),
    [4],
    "a second, bare refusal in a file that throttles the first is caught, at its own line",
  );
  eq(
    unthrottledRefusals(`// credential-throttle-ok:\n${bare}`).length,
    1,
    "a hatch with no reason exempts nothing",
  );
  eq(
    unthrottledRefusals(`// credential-throttle-ok: the senders share an address pool\n${bare}`).length,
    0,
    "a reasoned hatch on the check exempts it",
  );
  eq(
    unthrottledRefusals(`// credential-throttle-ok: the senders share an address pool\n${wired}\n${bare}`),
    [5],
    "and exempts only the check it sits on",
  );
  // #3174: the cron check.
  eq(
    unthrottledRefusals('if (!isAuthorizedCron(req)) return new NextResponse("unauthorized", { status: 401 });').length,
    1,
    "a bare cron refusal is caught",
  );
  eq(
    unthrottledRefusals(
      'if (!isAuthorizedCron(req)) {\n  return refuseCronSecret(req.headers, () => new NextResponse("x"));\n}',
    ).length,
    0,
    "the cron refusal through refuseCronSecret passes",
  );
  eq(
    unthrottledRefusals(
      'if (!isAuthorizedCron(req)) {\n  return refuseCredential(req.headers, () => new NextResponse("x"));\n}',
    ).length,
    1,
    "a cron refusal through the general throttle is caught, since it would count the Worker's own ticks",
  );
}

{
  const cronRoutes = inScope.filter((f) => /\bisAuthorizedCron\(/.test(blankComments(readFileSync(f, "utf8"))));
  assert(cronRoutes.length >= 20, `the cron routes are judged (${cronRoutes.length})`);
}

finish();
