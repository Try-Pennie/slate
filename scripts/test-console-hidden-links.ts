// No manager-reachable surface may offer a control into a route the console hides
// (#2119).
//
// THE DEFECT. Team Time Off carried `View the coverage sweep` on an approved
// request, pointing at `/admin/agents/{id}?job=...#coverage`. Every console route
// calls `consoleHiddenFor` and redirects everyone below super admin to
// `/admin/ooo`, which is the page the reader was already on. So the button did not
// refuse and did not explain: it appeared to do nothing (L109, L148). Nothing
// failed anywhere for as long as it shipped, because the redirect lands on a real
// page: this is a silent failure by construction, which is what makes a static
// guard the only thing that can see it.
//
// It was the ONLY such link a manager could reach, because `adminNavFor` gives
// them no sidebar at all. That is the argument FOR this guard rather than against
// it: nothing stopped the next one being added the same way, and the person adding
// it would have no symptom to notice.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-console-hidden-links.ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  describeDangling,
  describeDeadLinks,
  readRoutes,
  hrefReachesRoute,
  rawLinks,
  reachableFiles,
  routeOfHref,
  redirectsHiddenViewer,
  routeOfPageFile,
  scanConsoleLinks,
  type ConsoleLinkIo,
} from "./lib/scan-console-links.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(repoRoot, "src");
const appDir = join(srcDir, "app");

const listFiles = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
};

// The five scans below (four controls plus the real tree) all read the same tree
// off the same disk, so it is read once for the whole suite rather than once per
// scan (L286). The memo cannot hide a stale read: nothing here writes to the repo,
// and the overlays substitute in memory rather than on disk.
const fileCache = new Map<string, string>();
const readCached = (p: string): string => {
  const hit = fileCache.get(p);
  if (hit !== undefined) return hit;
  const src = readFileSync(p, "utf8");
  fileCache.set(p, src);
  return src;
};
const listCache = new Map<string, string[]>();
const listCached = (dir: string): string[] => {
  const hit = listCache.get(dir);
  if (hit !== undefined) return hit;
  const files = listFiles(dir);
  listCache.set(dir, files);
  return files;
};
const existsCache = new Map<string, boolean>();
const existsCached = (p: string): boolean => {
  const hit = existsCache.get(p);
  if (hit !== undefined) return hit;
  const ok = existsSync(p) && statSync(p).isFile();
  existsCache.set(p, ok);
  return ok;
};

const realIo: ConsoleLinkIo = {
  readFile: readCached,
  exists: existsCached,
  listFiles: listCached,
};

/** The real tree with one file's content replaced in memory. Nothing is written. */
const overlayIo = (overlay: Record<string, string>): ConsoleLinkIo => ({
  readFile: (p) => (p in overlay ? overlay[p]! : readCached(p)),
  exists: (p) => p in overlay || existsCached(p),
  listFiles: listCached,
});

// --- the pure decisions, driven by hand rather than by the tree ------------

{
  eq(routeOfPageFile("/a", "/a/admin/ooo/page.tsx"), "/admin/ooo", "a plain route");
  eq(routeOfPageFile("/a", "/a/admin/agents/[id]/page.tsx"), "/admin/agents/[id]", "a dynamic segment");
  eq(routeOfPageFile("/a", "/a/page.tsx"), "/", "the root");
  // A route group contributes no URL segment, so treating it as one would invent a
  // path no link can match and the guard would compare against nothing (L98).
  eq(routeOfPageFile("/a", "/a/(admin)/admin/x/page.tsx"), "/admin/x", "a route group is not a segment");
}

{
  eq(routeOfHref('"/admin/agents"'), "/admin/agents", "a quoted attribute");
  eq(routeOfHref("`/admin/agents/${id}`"), "/admin/agents/*", "a template literal");
  // The live instance carried both a query and a fragment, and neither changes
  // which page answers.
  eq(
    routeOfHref("`/admin/agents/${r.user_id}?job=${j}#coverage`"),
    "/admin/agents/*",
    "the query and the fragment are dropped",
  );
  eq(routeOfHref('"/admin/ooo/"'), "/admin/ooo", "a trailing slash is the same route");
  eq(routeOfHref('"https://example.com/admin/agents"'), null, "an absolute URL leaves the app");
  eq(routeOfHref("someVariable"), null, "an expression this cannot read statically");
}

{
  assert(hrefReachesRoute("/admin/agents/*", "/admin/agents/[id]"), "a value fills a dynamic segment");
  assert(hrefReachesRoute("/admin/ooo", "/admin/ooo"), "an exact match");
  // Different pages with different guards. A prefix match would report a link to
  // the open list page as though it went to the hidden detail page.
  assert(!hrefReachesRoute("/admin/agents", "/admin/agents/[id]"), "a prefix is NOT the same route");
  assert(!hrefReachesRoute("/admin/agents/a/b", "/admin/agents/[id]"), "nor is a deeper path");
}

{
  // The element is what decides, not the address: `ConsoleLink` carries an href
  // too and is the sanctioned way to offer a console destination.
  const found = rawLinks(`
    <a href="/x">one</a>
    <Link href={"/y"}>two</Link>
    <ConsoleLink href={"/z"}>three</ConsoleLink>
  `);
  eq(found.length, 2, "reads <a> and <Link>, and not <ConsoleLink>");
  eq(found.map((f) => f.element).join(","), "a,Link", "names the element it found");

  // Attributes BEFORE the href, and the braced form, are both the shape the live
  // instance had. A scanner that read only `href="..."` would have reported the
  // real file clean (L98).
  const spread = rawLinks('<a\n  className={btnSecondaryCls}\n  href={`/admin/agents/${id}`}\n>go</a>');
  eq(spread.length, 1, "finds an href behind other attributes and across lines");
  eq(routeOfHref(spread[0]!.href), "/admin/agents/*", "and reads it");

  // A comment that QUOTES the pattern is not an instance of it. These files
  // explain the rule at length, and reading the explanation as the code would fail
  // a correct file (L103).
  eq(rawLinks('// <a href="/admin/agents">do not do this</a>\n').length, 0, "a commented link is not a link");
}

// --- which pages redirect a hidden viewer, and which merely consult the flag

{
  // The ordinary guard.
  assert(
    redirectsHiddenViewer('if (consoleHiddenFor(me.role)) {\n  redirect("/admin/ooo");\n}'),
    "a call that redirects is hidden",
  );
  assert(
    redirectsHiddenViewer('if (consoleHiddenFor(me.role)) redirect("/admin/ooo");'),
    "with or without the brace",
  );
  // A bare REFERENCE handed to a loader that redirects on it. A pattern requiring
  // `consoleHiddenFor(` reads this as reachable, which is the shape that hid nine
  // alert keys from the alert-key scanner for three releases (#1400) and produced
  // this guard's first false finding.
  assert(
    redirectsHiddenViewer("const r = await load(id, { oooOnly: consoleHiddenFor });"),
    "a bare reference is hidden too, because it can only be going somewhere that calls it",
  );
  // And the case that would blind the guard to the surface it exists for: the page
  // that consults the flag to decide what to DRAW is still rendering for that
  // viewer, so it is reachable (L324).
  assert(
    !redirectsHiddenViewer("const consoleHidden = consoleHiddenFor(me.role);\nreturn <ConsoleLink consoleHidden={consoleHidden} />;"),
    "a call whose result decides what to draw is NOT a redirect",
  );
  assert(
    !redirectsHiddenViewer("// consoleHiddenFor used to redirect here\nreturn null;"),
    "and an explanation of the flag is not a use of it",
  );
}

// --- the load bearing classifications, against the real tree ---------------
//
// The guard's whole reach rests on these three, and each fails in a way nothing
// else would report: a misread of /admin/ooo takes the one surface this exists for
// out of the scan, and a misread of either console page stops it being a
// destination worth reporting.

{
  const routes = readRoutes(appDir, realIo);
  const byRoute = new Map(routes.map((r) => [r.route, r]));
  for (const [route, expected, why] of [
    ["/admin/ooo", false, "the one console page a manager may reach, and the surface this guard is about"],
    ["/admin/agents/[id]", true, "the destination the dead button pointed at"],
    ["/admin/bookings/[id]", true, "hidden through a bare reference rather than a call"],
  ] as const) {
    const entry = byRoute.get(route);
    assert(entry !== undefined, `${route} is in the tree`);
    eq(entry!.hidden, expected, `${route} is ${expected ? "hidden" : "reachable"}: ${why}`);
  }
}

// --- the positive control: it must catch the real defect -------------------
//
// A guard that has never been seen to fail is not a guard (L1). This puts the
// SHIPPED pre-fix code back, in memory, and requires it to be caught and blamed on
// the right file.

{
  const oooPage = join(appDir, "admin", "ooo", "page.tsx");
  const real = readCached(oooPage);
  assert(real.includes("ConsoleLink"), "the real page uses ConsoleLink, which is what the fix was");

  const reverted = real.replace(
    /<ConsoleLink\s+consoleHidden=\{consoleHidden\}\s+href=\{([\s\S]*?)\}\s*>([\s\S]*?)<\/ConsoleLink>/,
    "<a className={btnSecondaryCls} href={$1}>$2</a>",
  );
  assert(reverted !== real, "the revert actually changed the file, so the control is not vacuous");

  const caught = scanConsoleLinks({
    appDir,
    srcDir,
    repoRoot,
    io: overlayIo({ [oooPage]: reverted }),
  });
  // The SPECIFIC finding, not merely a non-empty list: any other dead link
  // anywhere in the tree would satisfy `length > 0`, and the control would pass
  // while proving nothing about the revert it just made (L140). That is not
  // hypothetical here: on this guard's first run an unrelated finding satisfied
  // exactly that assertion and hid a misclassification of the OOO page itself.
  const hit = caught.dead.find((d) => d.file.endsWith(join("admin", "ooo", "page.tsx")));
  assert(hit !== undefined, `the pre-fix anchor is CAUGHT, in the file that holds it. Found: ${JSON.stringify(caught.dead)}`);
  eq(hit!.element, "a", "and named as a raw anchor");
  eq(hit!.route, "/admin/agents/[id]", "and resolved to the hidden route it reaches");
  assert(describeDeadLinks([hit!]).includes("ConsoleLink"), "and the message names the remedy");

  // And the tree WITHOUT the revert is clean, so the control is measuring the
  // revert rather than something that was already there.
  const before = scanConsoleLinks({ appDir, srcDir, repoRoot, io: realIo });
  eq(before.dead.length, 0, "the real tree has no such link, so the catch above came from the revert");
}

// A link hidden in a COMPONENT, which is the case the import walk exists for and
// the one a scan of page files alone would miss entirely. Blamed on the component
// that holds it AND named with the page that reaches it, because those are two
// different people's questions.
{
  const component = join(srcDir, "components", "ui", "ConsoleLink.tsx");
  const planted =
    readFileSync(component, "utf8") +
    '\nexport const Sneaky = () => <a href="/admin/agents">go</a>;\n';

  const caught = scanConsoleLinks({
    appDir,
    srcDir,
    repoRoot,
    io: overlayIo({ [component]: planted }),
  });
  const hit = caught.dead.find((d) => d.file.endsWith(join("ui", "ConsoleLink.tsx")));
  assert(hit !== undefined, `a link inside a component is caught. Found: ${JSON.stringify(caught.dead)}`);
  eq(hit!.route, "/admin/agents", "and resolved to the hidden route");
  assert(
    hit!.reachedFrom.endsWith(join("admin", "ooo", "page.tsx")),
    `and names the page that reaches it, got ${hit!.reachedFrom}`,
  );
}

// A page that renders the control WITHOUT the note it describes itself with. The
// id is a constant so no call site can invent one, but a page can still forget the
// note, and then every control on it is announced with an element that is not
// there: the state is drawn, the reason reaches nobody, and nothing reports it.
{
  const oooPage = join(appDir, "admin", "ooo", "page.tsx");
  const real = readCached(oooPage);
  assert(real.includes("<ConsoleComingSoonNote"), "the real page renders the note");

  const withoutNote = real.replace(/<ConsoleComingSoonNote[^>]*\/>/g, "null");
  assert(withoutNote !== real, "the revert changed the file, so the control is not vacuous");

  const caught = scanConsoleLinks({
    appDir,
    srcDir,
    repoRoot,
    io: overlayIo({ [oooPage]: withoutNote }),
  });
  const hit = caught.dangling.find((d) => d.page.endsWith(join("admin", "ooo", "page.tsx")));
  assert(hit !== undefined, `a control with no note is caught. Found: ${JSON.stringify(caught.dangling)}`);
  assert(describeDangling([hit!]).includes("ConsoleComingSoonNote"), "and the message names the remedy");

  // The module that DEFINES both must not count as a page rendering either, or
  // this check can never fail: ConsoleLink.tsx mentions both names by necessity.
  eq(
    scanConsoleLinks({ appDir, srcDir, repoRoot, io: realIo }).dangling.length,
    0,
    "and the real tree is paired, so the catch above came from the revert",
  );
}

// --- the real tree ---------------------------------------------------------

const result = scanConsoleLinks({ appDir, srcDir, repoRoot, io: realIo });

// Zero of either is the shape of a broken scan, never a healthy tree (L98). If
// the flag is ever removed both of these become the thing to update, deliberately.
assert(result.pagesScanned > 0, `walked ${result.pagesScanned} reachable pages`);
assert(result.hiddenRoutes > 0, `found ${result.hiddenRoutes} routes the console hides`);

// And the scan must actually have FOLLOWED imports: a page whose specifiers
// resolved to nothing would walk one file and report clean, so a link inside a
// component would be invisible while the guard looked healthy (L98).
{
  const oooReach = reachableFiles(join(appDir, "admin", "ooo", "page.tsx"), srcDir, realIo);
  assert(oooReach.length > 5, `followed the OOO page's imports (${oooReach.length} files)`);
  assert(
    oooReach.some((f) => f.endsWith(join("components", "ui", "ConsoleLink.tsx"))),
    "including into src/components, which is where a link is most likely to hide",
  );
}

assert(
  result.dead.length === 0,
  `no manager-reachable surface links into a hidden console route\n${describeDeadLinks(result.dead)}`,
);

assert(
  result.dangling.length === 0,
  `every Coming soon control has a note to describe it\n${describeDangling(result.dangling)}`,
);

// A file the scan could not read contributes no links, which is the same empty
// result a file with no links gives, so skipping one silently would make an
// unreadable tree indistinguishable from a clean one (L11, L98).
eq(result.unreadable.length, 0, `every file the scan reached was readable: ${result.unreadable.join(", ")}`);

// And that refusal is real rather than a field nothing can populate: a page whose
// source cannot be read is REPORTED.
{
  const missing = join(appDir, "admin", "ooo", "page.tsx");
  const blinded = scanConsoleLinks({
    appDir,
    srcDir,
    repoRoot,
    io: {
      readFile: (f) => {
        if (f === missing) throw new Error("ENOENT");
        return readCached(f);
      },
      exists: existsCached,
      listFiles: listCached,
    },
  });
  assert(
    blinded.unreadable.some((f) => f.endsWith(join("admin", "ooo", "page.tsx"))),
    `an unreadable file is reported, not skipped. Got: ${JSON.stringify(blinded.unreadable)}`,
  );
}

finish();
