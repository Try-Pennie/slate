// #4388: Bidspoke's key opens POST /api/program-leads and nothing else.
//
// Bidspoke registers program leads (#4255) with its own key, `BOOKING_API_KEY_BIDSPOKE`
// and its `_2` rotation slot. It is deliberately NOT a booking API caller: the cancel
// (`src/lib/booking/direct-cancel-http.ts`) admits every name in `BOOKING_API_CALLERS`,
// and the booking source vocabulary and the caller sightings derive from that list, so
// joining it would let Bidspoke cancel any lead's booking. Nothing about a route's own
// tests would notice that, because each tests the keys it was written for.
//
// So this judges every key authenticated route at once, found by what it CALLS rather
// than from a list (L96), in three ways:
//
// 1. The booking API key set, at runtime. Every booking key route builds its keys with
//    `configuredBookingApiKeys(callers)`, and every caller list is a subset of
//    `BOOKING_API_CALLERS`, the one the cancel passes. With every booking caller's key
//    AND Bidspoke's set, Bidspoke's is refused by every caller list there is.
// 2. Every single key accessor in `src/lib/env.ts`, at runtime: each one is called with
//    Bidspoke's key set, and only Bidspoke's own two accessors may answer with it. A
//    route checking a bearer against any other accessor therefore refuses it.
// 3. The routes, statically: of every file that calls a credential check, only the
//    program leads route reads Bidspoke's accessors, and that route reads no other key.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-program-lead-key-scope.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { blankComments } from "./lib/strip-comments.ts";

const ROOT = join(import.meta.dirname, "..");
const ROUTE = "src/app/api/program-leads/route.ts";
const BIDSPOKE_ACCESSORS = ["programLeadApiKey", "programLeadApiKey2"];
const BIDSPOKE = "bidspoke-guard-primary";
const BIDSPOKE_NEXT = "bidspoke-guard-rotation";

// Every booking caller's slots get a value of their own, so a list that admits a caller
// really holds a key for it, and Bidspoke's two slots are set beside them.
const api = await import("../src/lib/booking/api-auth.ts");
for (const caller of api.BOOKING_API_CALLERS) {
  process.env[api.bookingApiKeyEnvName(caller, "primary")] = `guard-${caller}-primary`;
  process.env[api.bookingApiKeyEnvName(caller, "secondary")] = `guard-${caller}-secondary`;
}
process.env.BOOKING_API_KEY_BIDSPOKE = BIDSPOKE;
process.env.BOOKING_API_KEY_BIDSPOKE_2 = BIDSPOKE_NEXT;

const { configuredBookingApiKeys } = await import("../src/lib/booking/api-keys.ts");
const env: Record<string, unknown> = await import("../src/lib/env.ts");

// --- 1. no booking API key set admits Bidspoke ----------------------------------------
{
  eq((api.BOOKING_API_CALLERS as readonly string[]).includes("bidspoke"), false, "bidspoke is not a booking API caller");
  const lists: Array<[string, readonly (typeof api.BOOKING_API_CALLERS)[number][]]> = [
    ["BOOKING_API_CALLERS (the cancel's)", api.BOOKING_API_CALLERS],
    ["FULL_API_CALLERS (every other booking route's default)", api.FULL_API_CALLERS],
    ["CANARY_CALLERS (the smoke routes)", api.CANARY_CALLERS],
    ["CANCEL_ONLY_CALLERS", api.CANCEL_ONLY_CALLERS],
  ];
  for (const [name, callers] of lists) {
    const keys = configuredBookingApiKeys(callers);
    // Positive control: the list's own callers ARE admitted, so a refusal below is the
    // key set refusing Bidspoke rather than a set with nothing in it (L98).
    eq(keys.length, callers.length * 2, `${name} holds both slots of each of its callers`);
    for (const caller of callers) {
      assert(api.authenticateBearer(`Bearer guard-${caller}-primary`, keys).ok, `${name} admits ${caller}'s own key`);
    }
    for (const token of [BIDSPOKE, BIDSPOKE_NEXT]) {
      const auth = api.authenticateBearer(`Bearer ${token}`, keys);
      eq(auth.ok ? "admitted" : auth.status, 401, `${name} refuses Bidspoke's key`);
    }
  }
  // And the check can see an admission at all: a key set holding Bidspoke's value admits it.
  const planted = api.parseApiKeys([{ caller: "regal", primary: BIDSPOKE, secondary: "" }]);
  assert(api.authenticateBearer(`Bearer ${BIDSPOKE}`, planted).ok, "a key set holding Bidspoke's value would admit it (positive control)");
}

// --- 2. only Bidspoke's own accessors answer with its key -----------------------------
{
  const answering: string[] = [];
  let called = 0;
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "function" || value.length !== 0) continue;
    let out: unknown;
    try {
      out = (value as () => unknown)();
    } catch {
      continue; // a required setting this process does not hold; it reads something else
    }
    called++;
    const values = Array.isArray(out) ? out : [out];
    if (values.some((v) => v === BIDSPOKE || v === BIDSPOKE_NEXT)) answering.push(name);
  }
  // A sweep that called nothing would find nothing answering (L98).
  assert(called >= 30, `the sweep called the env accessors (${called})`);
  eq(answering.sort(), [...BIDSPOKE_ACCESSORS].sort(), "only Bidspoke's own two accessors read its key");
}

// --- 3. the routes ----------------------------------------------------------------------
const CHECK = /\b(?:bearerTokenMatches|authenticateBearer|authorizeBookingApi|isAuthorizedCron|matchingSecretIndex|timingSafeEqual)\(/;
const ACCESSOR = new RegExp(`\\b(?:${BIDSPOKE_ACCESSORS.join("|")})\\b`);
const OTHER_KEY_SOURCE = /\b(?:authorizeBookingApi|configuredBookingApiKeys|authenticateBearer|isAuthorizedCron|bookingApiKeyFor)\b/;

/** The names a source imports from `@/lib/env`. */
function envImports(code: string): string[] {
  const names: string[] = [];
  for (const m of code.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']@\/lib\/env["']/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

/** Every finding about who reads Bidspoke's key, over a map of path to source. */
function keyScopeFindings(files: Map<string, string>): string[] {
  const found: string[] = [];
  for (const [path, src] of files) {
    const code = blankComments(src);
    if (path === "src/lib/env.ts") continue;
    if (path !== ROUTE && ACCESSOR.test(code)) found.push(`${path} reads Bidspoke's key`);
    // Naming the variable is fine (the load test's secret inventory lists it); reading it
    // anywhere but env.ts would be a second, unguarded accessor.
    if (/process\.env(?:\.|\[\s*["'`])BOOKING_API_KEY_BIDSPOKE/.test(code)) {
      found.push(`${path} reads Bidspoke's key from the environment outside env.ts`);
    }
  }
  const route = files.get(ROUTE);
  if (route === undefined) return [...found, `${ROUTE} is missing`];
  const code = blankComments(route);
  if (!CHECK.test(code)) found.push(`${ROUTE} checks no credential`);
  if (OTHER_KEY_SOURCE.test(code)) found.push(`${ROUTE} reaches another key set`);
  const extra = envImports(code).filter((n) => !BIDSPOKE_ACCESSORS.includes(n));
  if (extra.length > 0) found.push(`${ROUTE} reads ${extra.join(", ")} from env`);
  for (const a of BIDSPOKE_ACCESSORS) if (!new RegExp(`\\b${a}\\(`).test(code)) found.push(`${ROUTE} never calls ${a}`);
  return found;
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

{
  const files = new Map<string, string>();
  for (const p of walk(join(ROOT, "src"))) files.set(relative(ROOT, p), readFileSync(p, "utf8"));
  const authed = [...files].filter(([, src]) => CHECK.test(blankComments(src))).map(([p]) => p);
  // The enumeration finds what it exists to judge: the cancel's handler, a single key
  // route, the cron check, and this route among them.
  assert(authed.length >= 25, `found the key authenticated routes (${authed.length})`);
  for (const must of [ROUTE, "src/lib/booking/direct-cancel-http.ts", "src/app/api/bookings/cancel-duplicate/route.ts", "src/lib/cron.ts"]) {
    assert(authed.includes(must), `the enumeration finds ${must}`);
  }
  eq(keyScopeFindings(files), [], "Bidspoke's key is read by the program leads route alone, which reads no other");

  // Positive controls, planted on a copy of the real tree.
  const plant = (path: string, edit: (s: string) => string): string[] => {
    const copy = new Map(files);
    copy.set(path, edit(copy.get(path) ?? ""));
    return keyScopeFindings(copy);
  };
  const dup = "src/app/api/bookings/cancel-duplicate/route.ts";
  eq(
    plant(dup, (s) => s.replace("duplicateCancelApiKey2()]", "duplicateCancelApiKey2(), programLeadApiKey()]")),
    [`${dup} reads Bidspoke's key`],
    "another route accepting Bidspoke's key is caught",
  );
  const lane = "src/app/api/cron/sync/route.ts";
  eq(
    plant(lane, (s) => `${s}\nconst k = process.env.BOOKING_API_KEY_BIDSPOKE ?? "";\n`),
    [`${lane} reads Bidspoke's key from the environment outside env.ts`],
    "a second reader of Bidspoke's variable is caught",
  );
  eq(
    plant(ROUTE, (s) => s.replace(/import \{([^}]*)\} from "@\/lib\/env";/, 'import {$1, reassignApiKey } from "@/lib/env";')),
    [`${ROUTE} reads reassignApiKey from env`],
    "the program leads route accepting another key is caught",
  );
  eq(
    plant(ROUTE, (s) => `${s}\nconst k = configuredBookingApiKeys();\n`),
    [`${ROUTE} reaches another key set`],
    "the program leads route admitting the booking keys is caught",
  );
}

finish();
