// Repo invariant (#1751): every admin screen is reachable from the navigation, and
// every navigation entry opens a screen that exists and lets that person in.
//
// The failure this exists to catch is silent in the worst way. An orphaned page
// works perfectly for anyone who already knows its address, so it is invisible to
// every test, every build and every person who wrote it. It is found only by
// somebody hunting for it under pressure. That happened on 2026-09-02: Slate was
// offering times on Labor Day (#1742) and the person who needed to close the date
// could not find the screen that does it, because /admin/drain, /admin/erasure,
// /admin/booking-outcomes and the reason options were all reachable ONLY from a
// page whose own only entry point was a card labelled "Alert settings".
//
// #1748 fixed that instance by putting every section behind a sidebar. It does not
// stop the next admin page being added with no link to it, which is this.
//
// Reachability is judged from the NAV SOURCES ONLY: the sidebar's map and the
// global header. A link anywhere else in the tree does not count, because a stray
// link inside an unrelated page satisfies a check like this while measuring
// nothing, and that is precisely the state #1748 was cleaning up.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-admin-nav-reachability.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { stripComments } from "./lib/strip-comments.ts";
import { ADMIN_NAV, adminNavHrefs } from "@/lib/admin/nav.ts";
import { readTextOptOut } from "./lib/opt-out.ts";

const ADMIN_DIR = "src/app/admin";
const HEADER = "src/components/AppHeader.tsx";

/**
 * `// nav-ok: <reason>`, anywhere in the file.
 *
 * `[^\S\n]*` and not `\s*`: `\s` matches a newline, so `\s*(\S.*)` after a bare
 * `// nav-ok:` skips to the NEXT line and captures whatever code is there as the
 * reason. Every future orphan would then be excused by an empty annotation, which
 * is the guard being decoration while reading as enforcement. The control below
 * caught exactly that.
 */
/** The file scoped exemption, read through the one shared reader (#2200). */
const navExemption = (text: string): string | null => {
  const found = readTextOptOut(text, "nav-ok:");
  return found.present && found.reasoned ? found.reason : null;
};

function pages(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...pages(path));
    else if (entry === "page.tsx") out.push(path);
  }
  return out;
}

/**
 * The URL a page file serves. Route groups (`(name)`) are removed because they
 * shape the file tree and not the address, so a guard that kept them would compare
 * a path nobody can type against a nav full of real ones and report every page in
 * a group as unreachable.
 */
export function routeFor(file: string): string {
  return (
    file
      .replace(/^src\/app/, "")
      .replace(/\/page\.tsx$/, "")
      .split("/")
      .filter((seg) => !/^\(.*\)$/.test(seg))
      .join("/") || "/"
  );
}

/** Whether a route has a dynamic segment, so it is opened from a row, not a link. */
export function isDynamic(route: string): boolean {
  return route.includes("[");
}

const all = pages(ADMIN_DIR);
// A scan that found nothing reports the same empty result as a fully linked tree,
// and this whole file is about a failure that renders as nothing (L98).
assert(all.length >= 20, `read the admin tree (${all.length} pages)`);

// --- what the nav actually reaches -------------------------------------------
const navHrefs = new Set(adminNavHrefs());
assert(navHrefs.size >= 15, `the sidebar names routes (${navHrefs.size})`);

const headerText = stripComments(readFileSync(HEADER, "utf8"));
const headerHrefs = new Set(
  [...headerText.matchAll(/href:\s*"(\/admin[^"]*)"/g)].map((m) => m[1]!),
);
assert(
  headerHrefs.size >= 1,
  `the header names admin routes (${[...headerHrefs].join(", ") || "none"})`,
);

const reachable = new Set([...navHrefs, ...headerHrefs]);

// --- every screen is reached, or says why not --------------------------------
const unreachable: string[] = [];
const exempted: [string, string][] = [];
for (const file of all) {
  const route = routeFor(file);
  if (reachable.has(route)) continue;
  const reason = navExemption(readFileSync(file, "utf8"));
  if (reason) exempted.push([route, reason]);
  else unreachable.push(`${route} (${file})`);
}
assert(
  unreachable.length === 0,
  unreachable.length === 0
    ? `every admin screen is reached from the sidebar or the header, or is exempt (${exempted.length} exempt)`
    : `no navigation reaches these, so they are findable only by typing the address: ${unreachable.join(", ")}`,
);

// A dynamic route is opened from a row rather than from a link, so it can never be
// in the nav. It still has to SAY so: an exemption with no reason is indistinguishable
// from one nobody thought about (L233).
const dynamicRoutes = all.map(routeFor).filter(isDynamic);
assert(dynamicRoutes.length >= 2, `the tree has record detail routes (${dynamicRoutes.length})`);
for (const route of dynamicRoutes) {
  assert(
    exempted.some(([r]) => r === route),
    `${route} carries a nav-ok reason (a row opens it, so no link can)`,
  );
}

// --- and every nav entry opens something that exists -------------------------
// The other direction, which nothing else looks at: a renamed or deleted route
// leaves an entry in the sidebar that 404s, and the sidebar is the one surface a
// person trusts to tell them what exists.
const routes = new Set(all.map(routeFor));
const dead = [...navHrefs].filter((h) => !routes.has(h));
assert(
  dead.length === 0,
  dead.length === 0
    ? "every sidebar entry opens a route that exists"
    : `these sidebar entries open nothing: ${dead.join(", ")}`,
);

// --- the sidebar's gate is the route's gate ----------------------------------
// The nav declares who may see each entry; the page enforces it. Two hand written
// copies of one rule drift, and they drift in a way both sides read as correct:
// a link that outlives its page being gated tighter shows somebody a control that
// can only refuse them (L96).
const GATE_CALL: Record<string, RegExp> = {
  manager: /canManageAgents\(me\.role\)/,
  admin: /canEditOrgSettings\(me\.role\)/,
  super_admin: /me\.role !== "super_admin"|atLeast\(me\.role, "super_admin"\)/,
};
const fileFor = (route: string) =>
  all.find((f) => routeFor(f) === route)!;

const mismatched: string[] = [];
for (const group of ADMIN_NAV) {
  for (const item of group.items) {
    const text = stripComments(readFileSync(fileFor(item.href), "utf8"));
    if (!GATE_CALL[item.gate]!.test(text)) {
      mismatched.push(`${item.href} is listed as ${item.gate} but its page does not check that`);
    }
  }
}
assert(
  mismatched.length === 0,
  mismatched.length === 0
    ? "every sidebar entry declares the gate its own page enforces"
    : mismatched.join("; "),
);

// --- positive controls --------------------------------------------------------
//
// These drive the PREDICATES rather than writing a page into src/app, because a
// test that creates real route files leaves a real route behind when it dies part
// way through, and this suite runs in parallel. The real-file version was run by
// hand while writing this (2026-09-02): an empty page at
// src/app/admin/orphan-control/page.tsx was reported by name, and adding a bare
// `// nav-ok:` to it did NOT excuse it. If this file is ever widened, do that
// again rather than trusting the synthetic controls alone.
{
  // 1. an unlinked admin route. Built by asking the same predicate about a route
  //    that is really absent from the nav, since a guard that never read the tree
  //    and a fully linked tree produce the same empty result.
  const planted = "/admin/nobody-links-here";
  eq(reachable.has(planted), false, "an unlinked admin route is not reachable");
  eq(
    navExemption("export default function Orphan() {}") !== null,
    false,
    "and with no nav-ok reason it is reported rather than excused",
  );

  // 2. an exemption with no REASON does not excuse anything, or every future
  //    orphan gets a bare `// nav-ok:` and the guard is decoration.
  eq(navExemption("// nav-ok:\nexport default function X() {}"), null, "a bare nav-ok excuses nothing");
  eq(
    navExemption("// nav-ok: a row opens this\nexport default function X() {}"),
    "a row opens this",
    "a nav-ok with a reason is accepted, and the reason is captured",
  );

  // 3. route groups do not change the address, so a page inside one is compared
  //    by the URL a person can actually type.
  eq(routeFor("src/app/admin/(console)/buckets/page.tsx"), "/admin/buckets", "a route group is not part of the address");
  eq(routeFor("src/app/admin/page.tsx"), "/admin", "the index page is the bare route");
  eq(isDynamic("src/app/admin/agents/[id]"), true, "a dynamic segment is recognised");

  // 4. the gate check really reads the page, rather than passing on any file. A
  //    real admin-only page must fail the manager predicate.
  const adminOnly = ADMIN_NAV.flatMap((g) => g.items).find((i) => i.gate === "admin")!;
  const text = stripComments(readFileSync(fileFor(adminOnly.href), "utf8"));
  eq(
    GATE_CALL.manager!.test(text),
    false,
    `${adminOnly.href} does not check the manager gate, so the gate check discriminates`,
  );
}

finish();
