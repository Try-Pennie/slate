// Repo invariant: every internal link and redirect in the app points at a route
// that actually exists.
//
// This exists because #1748 moved /admin/settings/reasons to /admin/booking-reasons
// and left `setReasonOptions` redirecting to the old address on all three of its
// paths. The write succeeded and then the admin landed on a 404, so the save's own
// success message and both of its error messages became unreachable. Nothing
// caught it: tsc cannot see inside a string, the action's own tests assert the
// redirect it performs rather than that the target exists, and the page renders
// perfectly for anyone who never presses Save.
//
// Any move of a route can do this again, and it fails in the worst direction: the
// data is written, the person is told nothing, and the screen says the thing they
// were doing does not exist.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-internal-links.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { stripComments } from "./lib/strip-comments.ts";

const SRC = "src";
const APP = "src/app";

/**
 * Where an internal path is named. `href` is included because a dead link is the
 * same defect arriving one click later, and both were produced by the same move.
 */
const LINK = /(?:redirect|revalidatePath)\(\s*[`"']([^`"']+)[`"']|href=[{]?\s*[`"']([^`"'{]+)[`"']/g;

function walk(dir: string, match: (f: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path, match));
    else if (match(path)) out.push(path);
  }
  return out;
}

/** The URL a page file serves, with route groups removed (they are not addresses). */
function routeFor(file: string): string {
  return (
    file
      .replace(/^src\/app/, "")
      .replace(/\/page\.tsx$/, "")
      .split("/")
      .filter((seg) => !/^\(.*\)$/.test(seg))
      .join("/") || "/"
  );
}

/** A route pattern matches a concrete path when every non-dynamic segment agrees. */
export function matchesRoute(pattern: string, path: string): boolean {
  const p = pattern.split("/").filter(Boolean);
  const c = path.split("/").filter(Boolean);
  if (p.length !== c.length) return false;
  return p.every((seg, i) => /^\[.*\]$/.test(seg) || seg === c[i]);
}

/** The bare path a link names: no query, no fragment, no trailing slash. */
export function barePath(raw: string): string {
  const path = raw.split("?")[0]!.split("#")[0]!;
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

const routes = walk(APP, (f) => f.endsWith("/page.tsx")).map(routeFor);
assert(routes.length >= 20, `read the route tree (${routes.length} routes)`);

// Route handlers answer a URL too (/dev/preview is a route.ts, not a page).
const handlers = walk(APP, (f) => f.endsWith("/route.ts")).map((f) =>
  f.replace(/^src\/app/, "").replace(/\/route\.ts$/, ""),
);
const known = [...routes, ...handlers];

const files = walk(SRC, (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
assert(files.length >= 100, `read the source tree (${files.length} files)`);

/**
 * Only paths this app SERVES are checked. An external URL, an API path, a
 * fragment-only link and a template hole are all out of scope: this guard is
 * about a page move stranding a link, not about link checking in general.
 */
function isInternalPage(raw: string): boolean {
  if (!raw.startsWith("/")) return false;
  if (raw.startsWith("/api/")) return false; // route handlers, checked by their own callers
  if (raw.includes("${")) return false; // a computed path; the id is not knowable here
  return true;
}

const broken: string[] = [];
for (const file of files) {
  const text = stripComments(readFileSync(file, "utf8"));
  for (const m of text.matchAll(LINK)) {
    const raw = m[1] ?? m[2];
    if (!raw || !isInternalPage(raw)) continue;
    const path = barePath(raw);
    if (!known.some((r) => matchesRoute(r, path))) {
      broken.push(`${file}: ${raw}`);
    }
  }
}
assert(
  broken.length === 0,
  broken.length === 0
    ? "every internal link and redirect names a route that exists"
    : `these point at a route that does not exist, so following one lands on a 404: ${broken.join("; ")}`,
);

// --- positive controls --------------------------------------------------------
{
  // The exact shape that shipped: a route that was moved, still named by a caller.
  eq(
    known.some((r) => matchesRoute(r, "/admin/settings/reasons")),
    false,
    "the moved route really is gone, so this guard has something to have caught",
  );
  eq(
    known.some((r) => matchesRoute(r, "/admin/booking-reasons")),
    true,
    "and its replacement really exists",
  );

  // A dynamic segment matches any single value, and only one.
  eq(matchesRoute("/admin/agents/[id]", "/admin/agents/abc-123"), true, "a dynamic segment matches a value");
  eq(matchesRoute("/admin/agents/[id]", "/admin/agents"), false, "and does not match a missing one");
  eq(matchesRoute("/admin/agents", "/admin/agents/abc"), false, "a static route does not match a deeper path");

  // Query and fragment are not part of the route.
  eq(barePath("/admin/booking-reasons?ok=1"), "/admin/booking-reasons", "a query is stripped");
  eq(barePath("/admin#audit"), "/admin", "a fragment is stripped");
  eq(barePath("/"), "/", "the root survives stripping");

  // And the scan really reads links, rather than reporting an empty set (L98).
  const seen = files.reduce((n, f) => {
    const text = stripComments(readFileSync(f, "utf8"));
    return n + [...text.matchAll(LINK)].filter((m) => isInternalPage(m[1] ?? m[2] ?? "")).length;
  }, 0);
  assert(seen >= 30, `the scan found internal links to check (${seen})`);
}

finish();
