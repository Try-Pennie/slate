// Tripwire for the #1024 https redirect WIRING.
//
// src/lib/http/https-redirect.test.ts proves the decision is correct. It cannot
// prove the Worker actually consults it, and an unwired guard is the exact shape
// of defect that keeps shipping here: a tested function nothing calls, sitting
// green while plaintext requests reach the app untouched.
//
// worker/index.ts cannot be imported by a test (it imports .open-next/worker.js,
// which only exists after a build, and is excluded from the app tsconfig), so
// this asserts against the source text, the same approach test-cron-routes.ts
// takes for the cron wiring.
//
// Run: node --experimental-strip-types scripts/test-https-redirect-wiring.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const root = join(import.meta.dirname, "..");
const entry = readFileSync(join(root, "worker/index.ts"), "utf8");

assert(
  /import\s*\{[^}]*\bhttpsRedirect\b[^}]*\}\s*from\s*["']@\/lib\/http\/https-redirect["']/.test(
    entry,
  ),
  "worker/index.ts imports httpsRedirect from the module that owns the decision",
);

/**
 * The guard must run INSIDE fetch and SHORT-CIRCUIT the app: the redirect has to
 * be returned instead of the handler's response, not alongside it. The shipping
 * form is `httpsRedirect(request) ?? app.fetch(...)`, so require the call to
 * appear before `app.fetch` in the fetch body. (`app` is the counted wrapper every
 * call into the app goes through since #3354, `worker/app-invocations.ts`.)
 */
function guardsFetch(source: string): boolean {
  const fetchStart = source.indexOf("fetch:");
  if (fetchStart === -1) return false;
  const scheduledStart = source.indexOf("async scheduled(");
  const fetchBody = source.slice(
    fetchStart,
    scheduledStart === -1 ? source.length : scheduledStart,
  );
  const guardAt = fetchBody.indexOf("httpsRedirect(request)");
  const handlerAt = fetchBody.indexOf("app.fetch");
  return guardAt !== -1 && handlerAt !== -1 && guardAt < handlerAt;
}

assert(guardsFetch(entry), "the redirect guard runs in fetch() before app.fetch");

// Positive control: the assertion above must FAIL on the unwired form, or it is
// decoration. Strip the guard from a copy of the real source and prove it is
// caught. Without this, a regex that silently stops matching (a rename, a
// refactor of the entry) would read as "still wired" forever.
const unwired = entry.replace("httpsRedirect(request) ?? ", "");
assert(
  !guardsFetch(unwired),
  "positive control: removing the guard from fetch() is detected",
);
assert(unwired !== entry, "positive control actually mutated the source it checked");

// The redirect must be method-preserving. A 301/302 lets clients turn a POST into
// a GET and drop the body, which would silently convert an integrator's booking
// call into an empty page request rather than failing loudly.
const decision = readFileSync(join(root, "src/lib/http/https-redirect.ts"), "utf8");
assert(
  /REDIRECT_STATUS\s*=\s*308/.test(decision),
  "the redirect is a 308, so a POST keeps its method and body",
);

finish();
