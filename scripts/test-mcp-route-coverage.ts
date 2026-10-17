// #3536 / #3544: every Slate route is covered by an MCP tool, exempt with a reason,
// or in the shrinking ratchet, judged against a manifest built from THIS checkout.
//
//   - the manifest generator finds a deliberately added fixture route (route groups,
//     dynamic segments, a const export, a cron lane), so it cannot quietly miss one
//     (L96, L247);
//   - the real tree passes, the booking server's five internal routes are COVERED by
//     its registry, and every `/api/bookings` route is classified on its own (the
//     plan's reality check 10);
//   - each way the check can fail is seen to fail: an unclassified route, a stale
//     ratchet entry, a ratchet entry now classified, a declared route no route serves,
//     an empty manifest, an exemption with no reason, and one matching nothing.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-mcp-route-coverage.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRouteManifest, judgeCoverage, type CoverageInput } from "./lib/route-manifest.ts";
import { CATEGORY_EXEMPTIONS, ROUTE_EXEMPTIONS } from "./lib/mcp-route-classification.ts";
import { BOOKING_TOOLS } from "../worker/mcp-booking/registry.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const RATCHET_FILE = join(ROOT, "scripts", "mcp-route-ratchet.json");
const ratchet = (JSON.parse(readFileSync(RATCHET_FILE, "utf8")) as { routes: string[] }).routes;
const declared = BOOKING_TOOLS.map((t) => ({ route: t.route, tool: `booking:${t.name}` }));

// --- the generator, on a fixture tree ------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "slate-route-manifest-"));
  try {
    const put = (rel: string, body: string) => {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), body);
    };
    put("src/app/api/thing/route.ts", "export async function GET() {}\nexport async function POST() {}\n");
    put("src/app/(marketing)/hello/[id]/route.ts", "export const DELETE = make();\n");
    put("src/app/api/re/route.ts", "const h = () => 1;\nexport { h as PATCH };\n");
    put("src/app/api/thing/page.tsx", "export default function Page() {}\n");
    put("worker/cron-routes.ts", 'export const CRON_ROUTES = { "* * * * *": ["/api/cron/sync", "/api/cron/lonely"] };\n');
    put("src/app/api/cron/sync/route.ts", "export async function GET() {}\n");
    const m = buildRouteManifest(dir);
    eq(
      m.map((r) => `${r.path} ${r.methods.join("+")}`),
      ["/api/cron/lonely GET", "/api/cron/sync GET", "/api/re PATCH", "/api/thing GET+POST", "/hello/[id] DELETE"],
      "the generator finds every fixture route: a group dropped, a dynamic segment kept, a const and a renamed export read, a lane only cron schedules added, a page ignored",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- the real tree ----------------------------------------------------------------------
const manifest = buildRouteManifest(ROOT);
const real: CoverageInput = { manifest, declared, categories: CATEGORY_EXEMPTIONS, routes: ROUTE_EXEMPTIONS, ratchet };
const report = judgeCoverage(real);
eq(report.problems, [], "every Slate route is covered, exempt with a reason, or in the ratchet");
assert(manifest.length > 70, `the manifest really holds Slate's routes (${manifest.length})`);
eq(report.covered.sort(), BOOKING_TOOLS.map((t) => t.route).sort(), "the booking server's five internal routes are covered by its registry");
for (const r of manifest.filter((x) => x.path.startsWith("/api/bookings"))) {
  assert(!ratchet.includes(r.path), `${r.path} is classified on its own, not left in the ratchet`);
}
console.log(`  coverage: ${report.covered.length} covered, ${report.exempt.length} exempt, ${report.ratcheted.length} in the ratchet, of ${manifest.length}`);

// --- each failure, seen to fail -------------------------------------------------------------
const fails = (over: Partial<CoverageInput>, needle: string, label: string) => {
  const p = judgeCoverage({ ...real, ...over }).problems;
  assert(p.some((x) => x.includes(needle)), `${label} (got ${JSON.stringify(p.slice(0, 2))})`);
};
fails({ manifest: [...manifest, { path: "/api/brand-new", methods: ["POST"], source: "src/app/api/brand-new/route.ts" }] }, "/api/brand-new", "a new unclassified route fails at once");
fails({ ratchet: [...ratchet, "/api/long-gone"] }, "/api/long-gone", "a ratchet entry no route serves fails, so the file only shrinks");
fails({ ratchet: [...ratchet, "/api/bookings"] }, "classified now", "a ratchet entry that is now classified fails");
fails({ declared: [...declared, { route: "/api/internal/mcp-booking/teleport", tool: "booking:teleport" }] }, "teleport", "a tool declaring a route nothing serves fails");
fails({ manifest: [] }, "empty", "an empty manifest is a failure, never a pass");
fails({ routes: [...ROUTE_EXEMPTIONS.slice(1), { path: "/api/bookings", reason: "" }] }, "carries no reason", "an exemption with no reason fails");
fails({ categories: [...CATEGORY_EXEMPTIONS, { category: "ghost", prefix: "/api/ghost", reason: "Nothing lives here at all." }] }, "matches no route", "an exemption matching nothing fails");
fails({ routes: [...ROUTE_EXEMPTIONS, { path: "/api/internal/mcp-booking/book", reason: "Pretend it is out of scope." }] }, "both covered and exempt", "a covered route that is also exempted fails");

finish();
