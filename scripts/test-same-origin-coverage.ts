// Repo invariant (#1046): every cookie-authed MUTATION route refuses a request that
// says it did not come from Slate.
//
// The bug class this guards: these routes carry no CSRF token, so what stops a third
// party page making a signed-in manager's browser POST a cancellation is that
// Supabase's SSR cookies default to SameSite=Lax. That default is a third party
// library's, asserted nowhere here. Each route therefore checks Origin and
// Sec-Fetch-Site through `crossOriginRefusal` (src/lib/api/same-origin.ts).
//
// One route was wired five times, which means the sixth one gets forgotten. So the
// subject list is DERIVED from the routes (a mutating method plus a session guard),
// never written down: a hand list can only check what somebody remembered to add to
// it, and the forgotten route is exactly what this exists to catch (L96).
//
// Three things are asserted, and the first matters most:
//
//   1. the scan actually FOUND subjects in the real tree. A scan that enumerated
//      nothing reports the same empty result as a fully guarded tree (L98), and the
//      enumeration is the fragile half (it reads source text).
//   2. the real tree is clean.
//   3. positive controls: synthetic fixtures for each way a route becomes a
//      subject, plus an overlay of a REAL route file with its guard call stripped,
//      which must be caught and blamed on that file.
//
// Run: node --experimental-strip-types scripts/test-same-origin-coverage.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  scanSameOriginCoverage,
  subjectRoutes,
  REFUSAL_HELPER,
  type RouteSource,
} from "./lib/scan-same-origin-coverage.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const API_DIR = "src/app/api";

/** Every route.ts under src/app/api, with its text. */
function readRoutes(dir: string): RouteSource[] {
  const out: RouteSource[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...readRoutes(path));
    else if (entry === "route.ts") out.push({ path, text: readFileSync(path, "utf8") });
  }
  return out;
}

const routes = readRoutes(API_DIR);
assert(routes.length > 20, `read the api tree (${routes.length} route files)`);

// --- 1. the enumeration reaches real subjects ---
const subjects = subjectRoutes(routes);
// Four, not five: `erasure-purge` left the set in #1961 when its session path
// was removed, and it is asserted below to be OUT rather than merely absent.
assert(
  subjects.length >= 4,
  `found the cookie-authed mutation routes (${subjects.length}): ${subjects
    .map((s) => s.path.replace(`${API_DIR}/`, ""))
    .join(", ")}`,
);

// The two routes whose loss would be least noticed: a booking cancel (the highest
// consequence write on the surface) and the bulk reassign (admin-only and rarely
// exercised). Named so a refactor that stops the scan seeing them fails here
// rather than quietly shrinking the subject list.
//
// `erasure-purge` used to hold the second place. It moved to the list below in
// #1961: its session path was removed with the purge buttons, so its credential
// is no longer ambient and a browser-shaped check on it would be wrong. The
// assertion was inverted in the same change rather than deleted, because an
// assertion whose premise a change has consumed goes permanently red for a
// reason that looks exactly like a real defect (L373).
for (const needle of ["bookings/[id]/cancel", "bulk-reassign"]) {
  assert(
    subjects.some((s) => s.path.includes(needle)),
    `the scan sees ${needle} as a subject`,
  );
}

// A key-authed mutation must NOT be a subject: its credential is not ambient, and
// pulling it in would put a browser-shaped check on a machine caller.
for (const needle of ["bookings/reassign", "users/bookable", "smoke/heartbeat", "erasure-purge"]) {
  assert(
    !subjects.some((s) => s.path.includes(needle)),
    `${needle} is not a subject (its credential is not ambient)`,
  );
}

// --- 2. the real tree is clean ---
const unguarded = scanSameOriginCoverage(routes);
assert(
  unguarded.length === 0,
  unguarded.length === 0
    ? "every cookie-authed mutation route carries the same-origin refusal"
    : `unguarded: ${unguarded
        .map((u) => `${u.path} (${u.methods.join("/")}, ${u.guard})`)
        .join("; ")}`,
);

// --- 3a. synthetic positive controls ---
const guarded = `import { crossOriginRefusal } from "@/lib/api/same-origin";
export async function POST(req: NextRequest) {
  const x = crossOriginRefusal(req, "r"); if (x) return x;
  const actor = await requireManager();
  return NextResponse.json({ ok: true });
}`;
const bare = guarded
  .replace('import { crossOriginRefusal } from "@/lib/api/same-origin";\n', "")
  .replace('  const x = crossOriginRefusal(req, "r"); if (x) return x;\n', "");

eq(scanSameOriginCoverage([{ path: "a/route.ts", text: guarded }]).length, 0, "a guarded route passes");
eq(scanSameOriginCoverage([{ path: "b/route.ts", text: bare }]).length, 1, "an unguarded route is caught");

// A DELETE counts as a mutation, not only POST.
eq(
  scanSameOriginCoverage([
    { path: "c/route.ts", text: "export async function DELETE(){ await requireAdmin(); }" },
  ]).length,
  1,
  "an unguarded session-authed DELETE is caught",
);
// A read is not a subject.
eq(
  scanSameOriginCoverage([
    { path: "d/route.ts", text: "export async function GET(){ await requireManager(); }" },
  ]).length,
  0,
  "a session-authed GET is not a subject",
);
// Nor is a mutation with no session guard.
eq(
  scanSameOriginCoverage([
    { path: "e/route.ts", text: "export async function POST(){ bearerTokenMatches(h, k); }" },
  ]).length,
  0,
  "a key-authed mutation is not a subject",
);

// --- 3b. the real-file overlay ---
// The synthetic fixtures above are shaped by the same hand that wrote the scanner.
// This one takes a real route's real text and removes only its guard call, so the
// control is the actual shape that ships.
const realCancel = routes.find((r) => r.path.includes("bookings/[id]/cancel"))!;
assert(
  realCancel.text.includes(REFUSAL_HELPER),
  "the real cancel route carries the refusal (the overlay has something to remove)",
);
const stripped = realCancel.text.replace(new RegExp(`\\b${REFUSAL_HELPER}\\b`, "g"), "notTheGuard");
const overlay = routes.map((r) => (r.path === realCancel.path ? { ...r, text: stripped } : r));
const caught = scanSameOriginCoverage(overlay);
eq(caught.length, 1, "stripping the guard from the real cancel route is caught");
eq(caught[0]?.path, realCancel.path, "and it is blamed on that file");

finish();
