// #3536 (plan phase 2.2): Slate's route manifest, generated from the tree at the same
// revision as the routes it describes (L398, L88), and the MCP route coverage check.
//
// The manifest is every `src/app/**/route.ts` (each with the HTTP methods it exports)
// plus every lane `worker/cron-routes.ts` schedules. Every route is then one of:
//
//   - COVERED: an MCP tool declares it (the booking server's registry today, the ops
//     server's when it exists);
//   - EXEMPT by CATEGORY (a path prefix, with a reason) or per ROUTE (with a reason);
//   - in the RATCHET, the routes unclassified when coverage first landed (L538).
//
// The check fails on an unclassified route outside the ratchet, a ratchet entry that is
// now classified or gone (the file only shrinks), a declared route missing from the
// manifest, an empty manifest (L98), an exemption with no reason or one matching
// nothing (L346), and a reason that does not begin with a word (L675).
//
// The kit's coverage engine (pennie-mcp-kit#6) does not exist yet; this is Slate's
// half, written to the same rules so the engine can take it over.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface ManifestRoute {
  /** The URL path, Next's own segments kept: `/api/bookings/[token]/cancel`. */
  path: string;
  methods: string[];
  /** Where it came from: the route file, or `worker/cron-routes.ts` for a lane. */
  source: string;
}

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (entry === "route.ts") out.push(p);
  }
  return out;
}

/** The URL path a route file serves: route groups `(x)` dropped, other segments kept. */
export function routePathOf(appDir: string, file: string): string {
  const parts = relative(appDir, file).split(sep).slice(0, -1).filter((s) => !(s.startsWith("(") && s.endsWith(")")));
  return `/${parts.join("/")}`;
}

/** The HTTP methods a route module exports, as a function or as a const. */
export function exportedMethods(source: string): string[] {
  return HTTP_METHODS.filter((m) =>
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b|export\\s+const\\s+${m}\\s*=|export\\s*\\{[^}]*\\bas\\s+${m}\\b[^}]*\\}`).test(source),
  );
}

/** The lanes `worker/cron-routes.ts` schedules, read off its source (it imports nothing). */
export function cronLanePaths(cronRoutesSource: string): string[] {
  return [...new Set([...cronRoutesSource.matchAll(/["'](\/api\/cron\/[a-z0-9-]+)["']/g)].map((m) => m[1]!))].sort();
}

export function buildRouteManifest(root: string): ManifestRoute[] {
  const appDir = join(root, "src", "app");
  const routes: ManifestRoute[] = walk(appDir).map((file) => ({
    path: routePathOf(appDir, file),
    methods: exportedMethods(readFileSync(file, "utf8")),
    source: relative(root, file),
  }));
  const seen = new Set(routes.map((r) => r.path));
  for (const lane of cronLanePaths(readFileSync(join(root, "worker", "cron-routes.ts"), "utf8"))) {
    if (!seen.has(lane)) routes.push({ path: lane, methods: ["GET"], source: "worker/cron-routes.ts" });
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path));
}

export interface CategoryExemption {
  category: string;
  /** A path prefix; `/booking` covers `/booking` and `/booking/...`. */
  prefix: string;
  reason: string;
}
export interface RouteExemption {
  path: string;
  reason: string;
}

export interface CoverageInput {
  manifest: ManifestRoute[];
  /** Routes some MCP tool declares, with the tool that declares each. */
  declared: { route: string; tool: string }[];
  categories: CategoryExemption[];
  routes: RouteExemption[];
  ratchet: string[];
}

export interface CoverageReport {
  covered: string[];
  exempt: string[];
  ratcheted: string[];
  problems: string[];
}

const matchesPrefix = (path: string, prefix: string) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);

/** A reason has to say something: it begins with a word and runs to three of them (L675). */
export function isReason(reason: string): boolean {
  return /^[A-Za-z]/.test(reason.trim()) && reason.trim().split(/\s+/).length >= 3;
}

export function judgeCoverage(input: CoverageInput): CoverageReport {
  const problems: string[] = [];
  if (input.manifest.length === 0) problems.push("the route manifest is empty, so nothing was judged");
  const paths = new Set(input.manifest.map((r) => r.path));
  const declared = new Set(input.declared.map((d) => d.route));
  for (const d of input.declared) {
    if (!paths.has(d.route)) problems.push(`${d.tool} declares ${d.route}, which no route serves`);
  }
  for (const c of input.categories) {
    if (!isReason(c.reason)) problems.push(`the ${c.category} exemption carries no reason`);
    if (!input.manifest.some((r) => matchesPrefix(r.path, c.prefix))) problems.push(`the ${c.category} exemption (${c.prefix}) matches no route`);
  }
  for (const r of input.routes) {
    if (!isReason(r.reason)) problems.push(`the exemption for ${r.path} carries no reason`);
    if (!paths.has(r.path)) problems.push(`the exemption for ${r.path} names no route`);
  }
  const routeExempt = new Set(input.routes.map((r) => r.path));
  const ratchet = new Set(input.ratchet);
  const covered: string[] = [];
  const exempt: string[] = [];
  const ratcheted: string[] = [];
  for (const r of input.manifest) {
    const isCovered = declared.has(r.path);
    const isExempt = routeExempt.has(r.path) || input.categories.some((c) => matchesPrefix(r.path, c.prefix));
    if (isCovered) covered.push(r.path);
    else if (isExempt) exempt.push(r.path);
    else if (ratchet.has(r.path)) ratcheted.push(r.path);
    else problems.push(`${r.path} (${r.source}) is not covered by any MCP tool, not exempt, and not in the ratchet: classify it`);
    if ((isCovered || isExempt) && ratchet.has(r.path)) problems.push(`${r.path} is classified now, so remove it from the ratchet`);
    if (isCovered && isExempt) problems.push(`${r.path} is both covered and exempt: drop the exemption`);
  }
  for (const entry of input.ratchet) {
    if (!paths.has(entry)) problems.push(`the ratchet lists ${entry}, which no route serves any more: remove it`);
  }
  return { covered, exempt, ratcheted, problems };
}
