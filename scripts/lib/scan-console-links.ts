// Which manager-reachable surfaces point at a route the console hides (#2119).
//
// THE FAILURE THIS MEASURES. Every page under `/admin` except `/admin/ooo` calls
// `consoleHiddenFor` and redirects everyone below super admin to `/admin/ooo`. A
// control on a manager-reachable page that points into the console therefore does
// not refuse and does not explain: it lands on a real page, so no error is raised
// anywhere, and when that page is the one the reader was already on it appears to
// do nothing at all (L109). Nothing failed while `View the coverage sweep` was
// dead for every manager for as long as it shipped.
//
// EVERYTHING HERE IS DERIVED, because a guard driven by a hand written list checks
// only what the list happens to hold and the next surface is exempt from the very
// rule it exists to enforce (L96):
//
//  - the HIDDEN routes are the pages whose own source calls `consoleHiddenFor`,
//    read off the tree rather than enumerated;
//  - the REACHABLE surfaces are every other page, likewise;
//  - the FILES to scan are each reachable page's transitive local imports, so a
//    link inside a component three levels down is covered by construction.
//
// The rule is about the ELEMENT, not the address: a raw `<a>` or `<Link>` goes
// wherever it is pointed, while `ConsoleLink` is the component that resolves the
// viewer's access and draws a Coming soon state instead. So a call site is
// compliant by USING the component, which is a change a reviewer can see, rather
// than by carrying a comment.
import { dirname, join, relative, resolve, sep } from "node:path";
import { blankComments, importSpecifiers } from "./scan-local-import-graph.ts";

export interface ConsoleLinkIo {
  readFile(path: string): string;
  exists(path: string): boolean;
  /** Every file under `dir`, recursively, absolute. */
  listFiles(dir: string): string[];
}

/** A page route, its file, and whether reaching it redirects a hidden viewer. */
export interface RouteEntry {
  /** The URL path, with dynamic segments left as written (`/admin/agents/[id]`). */
  route: string;
  file: string;
  hidden: boolean;
}

/** A raw link from a reachable surface into a hidden route. */
export interface DeadLink {
  /** The file the element was written in, repo relative. */
  file: string;
  /** The element: `a` or `Link`. */
  element: string;
  /** The href exactly as written. */
  href: string;
  /** The hidden route it resolves to. */
  route: string;
  /** The reachable page whose import graph reaches this file, repo relative. */
  reachedFrom: string;
}

const PAGE_FILE = /(^|[\\/])page\.tsx$/;

/** The URL path a `src/app/**\/page.tsx` serves, with route groups dropped. */
export function routeOfPageFile(appDir: string, file: string): string {
  const rel = relative(appDir, dirname(file)).split(sep).filter(Boolean);
  // `(group)` folders organise files and contribute no URL segment; `@slot`
  // parallel routes likewise. Both would otherwise invent a path that no link can
  // ever match, so the guard would silently compare against nothing.
  const segments = rel.filter((s) => !(s.startsWith("(") && s.endsWith(")")) && !s.startsWith("@"));
  return `/${segments.join("/")}`.replace(/\/$/, "") || "/";
}

/**
 * Whether a page REDIRECTS a console-hidden viewer away, read from its source.
 *
 * Merely mentioning `consoleHiddenFor` is NOT the question, and getting that wrong
 * breaks the guard in the direction nobody sees. The page this guard exists for,
 * `/admin/ooo`, now calls `consoleHiddenFor` itself, to decide whether to draw a
 * link or a Coming soon state. Treating any mention as hidden would drop that page
 * out of the reachable set, and the guard would go on passing while blind to the
 * only surface it was written about (L98, L324).
 *
 * Two shapes REDIRECT, and both are in the tree:
 *
 *  - `if (consoleHiddenFor(me.role)) redirect("/admin/ooo")`, the ordinary guard;
 *  - `oooOnly: consoleHiddenFor`, a bare REFERENCE handed to a loader that
 *    redirects on it (`admin/bookings/[id]`). A reference is not a call, so a
 *    pattern requiring `consoleHiddenFor(` reads that page as reachable. That is
 *    the same shape that hid nine alert keys from the alert-key scanner for three
 *    releases (#1400), and it cost this guard a false finding on its first run.
 *
 * Anything else is a page that consults the flag to decide what to DRAW, which is
 * a reachable page by definition: it is still rendering for that viewer.
 */
export function redirectsHiddenViewer(src: string): boolean {
  // The IMPORT is not a use. Every page that mentions the flag at all has to name
  // it on an import line, where it is never followed by `(`, so a bare-reference
  // test that reads imports calls EVERY such page hidden. That includes
  // `/admin/ooo`, the one surface this guard exists for, and the guard would then
  // pass for ever while looking at nothing (L98).
  const code = blankComments(src).replace(/^\s*import\s[\s\S]*?from\s*["'][^"']*["'];?/gm, "");
  // A bare reference: the name not followed by `(`. It can only be going somewhere
  // that will call it, and in this codebase that is a loader which redirects.
  if (/\bconsoleHiddenFor\b(?!\s*\()/.test(code)) return true;
  // A call whose result reaches a `redirect`, allowing for the brace, the newline
  // and a `return` in between. Bounded, so a `redirect` far below an unrelated
  // call is not read as this one.
  return /\bconsoleHiddenFor\s*\([^)]*\)[^;{]*[{)]?[\s\S]{0,80}?\bredirect\s*\(/.test(code);
}

/**
 * Every page route in the app, and whether reaching it redirects a hidden viewer.
 *
 * Comments are blanked first, so a file explaining the flag (several do, at
 * length) is not read as using it: that would mark a reachable page hidden and
 * take it out of the scan, which fails in the GREEN direction and is exactly how a
 * guard rots into a no-op (L103).
 */
export function readRoutes(appDir: string, io: ConsoleLinkIo): RouteEntry[] {
  return io
    .listFiles(appDir)
    .filter((f) => PAGE_FILE.test(f))
    .map((file) => ({
      route: routeOfPageFile(appDir, file),
      file,
      hidden: redirectsHiddenViewer(io.readFile(file)),
    }))
    .sort((a, b) => a.route.localeCompare(b.route));
}

/** Resolve one import specifier to a file inside the tree, or null. */
function resolveLocal(from: string, spec: string, srcDir: string, io: ConsoleLinkIo): string | null {
  const base = spec.startsWith("@/")
    ? join(srcDir, spec.slice(2))
    : spec.startsWith(".")
      ? resolve(dirname(from), spec)
      : null;
  if (base === null) return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (io.exists(candidate)) return candidate;
  }
  return null;
}

/** Every local file an entry reaches, entry included. */
export function reachableFiles(entry: string, srcDir: string, io: ConsoleLinkIo): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    let src: string;
    try {
      src = io.readFile(file);
    } catch {
      // A file that cannot be read contributes no edges. It cannot hide a link
      // either, because the link would have to be IN it.
      continue;
    }
    for (const spec of importSpecifiers(src)) {
      const resolved = resolveLocal(file, spec, srcDir, io);
      if (resolved) queue.push(resolved);
    }
  }
  return [...seen].sort();
}

export interface RawLink {
  element: string;
  href: string;
}

/**
 * Every `<a href=...>` and `<Link href=...>` in a source file.
 *
 * Deliberately NOT every `href=`: `<ConsoleLink href=...>` carries one too, and it
 * is the sanctioned way to offer a console destination. Matching on the element is
 * what lets the guard tell a link that navigates unconditionally from one that
 * resolves the viewer's access first.
 *
 * Both an attribute string (`href="/admin/x"`) and a braced expression
 * (`href={`/admin/agents/${id}`}`) are read, because the live instance was the
 * second and a scanner that saw only the first would have reported the file clean
 * (L98).
 */
export function rawLinks(src: string): RawLink[] {
  // Blanking is idempotent, so a caller that has already done it (the scan, which
  // caches one blanked copy per file) pays nothing here, and a caller handing raw
  // source is still safe.
  const code = blankComments(src);
  const out: RawLink[] = [];
  // The element name, then anything up to the href that is not a tag close, so
  // other attributes before it (a className, a key) do not hide the match.
  // `[\s\S]` rather than the `s` flag: `tsconfig.scripts.json` targets a version
  // that refuses it, and a guard that cannot compile is a guard that never runs.
  const re = /<(a|Link)\s([\s\S]*?)href=/g;
  for (const m of code.matchAll(re)) {
    const value = readAttributeValue(code, m.index + m[0].length);
    if (value !== null) out.push({ element: m[1]!, href: value });
  }
  return out;
}

/**
 * The attribute value starting at `i`: a quoted string, or a braced expression
 * read by BALANCING braces rather than by a regex.
 *
 * Balancing is not fussiness. The live instance was
 * `` href={`/admin/agents/${r.user_id}?job=${j}#coverage`} ``, and a lazy `[^}]*`
 * stops at the `}` closing `${r.user_id}`, so the scanner captured half a template
 * literal, failed to read it as a path, and reported the file CLEAN. A guard that
 * cannot parse the exact shape of the defect it was written for is worth nothing
 * (L98), and this one passed its own tree while doing it.
 */
function readAttributeValue(src: string, i: number): string | null {
  const q = src[i];
  if (q === '"' || q === "'") {
    const end = src.indexOf(q, i + 1);
    return end === -1 ? null : src.slice(i + 1, end);
  }
  if (q !== "{") return null;
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === "{") depth += 1;
    else if (src[j] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(i + 1, j).trim();
    }
  }
  return null;
}

/**
 * The route an href points at, or null when it leaves the app.
 *
 * A template literal is reduced by replacing every `${...}` with a placeholder, so
 * `` `/admin/agents/${id}?job=${j}#coverage` `` becomes `/admin/agents/*`. The
 * query and fragment go: they never change which page answers.
 */
export function routeOfHref(href: string): string | null {
  let path = href.trim();
  // A braced expression that is a template literal or a quoted string; anything
  // else (a variable, a function call, a conditional) cannot be resolved
  // statically and is reported by the caller rather than guessed at.
  const literal = /^[`'"]([^`'"]*)[`'"]$/.exec(path);
  if (literal) path = literal[1]!;
  else if (/^[`'"]/.test(path)) return null;

  if (!path.startsWith("/")) return null;
  path = path.replace(/\$\{[^}]*\}/g, "*");
  return path.split("?")[0]!.split("#")[0]!.replace(/\/$/, "") || "/";
}

/**
 * Whether an href path reaches a route, allowing for dynamic segments.
 *
 * `/admin/agents/*` matches `/admin/agents/[id]`, and `/admin/agents` does not:
 * they are different pages with different guards, and treating a prefix as a match
 * would report a link to an open page as dead.
 */
export function hrefReachesRoute(hrefPath: string, route: string): boolean {
  const h = hrefPath.split("/").filter(Boolean);
  const r = route.split("/").filter(Boolean);
  if (h.length !== r.length) return false;
  return r.every((seg, i) => {
    if (seg.startsWith("[")) return true;
    return seg === h[i];
  });
}

/** A file that offers a Coming soon control with nothing to describe it. */
export interface DanglingNote {
  /** The reachable page, repo relative. */
  page: string;
  /** The file rendering the control, repo relative. */
  file: string;
}

export interface ScanResult {
  dead: DeadLink[];
  /** Controls whose description points at a note no reachable page renders. */
  dangling: DanglingNote[];
  /** How many reachable pages were walked. Zero is a broken scan, never a clean tree. */
  pagesScanned: number;
  /** How many hidden routes were found. Zero means the flag moved, not that all is well. */
  hiddenRoutes: number;
}

/**
 * The scan. Walks every page a hidden viewer is NOT redirected away from, and
 * reports each raw link from it into a route they ARE redirected away from.
 */
export function scanConsoleLinks(
  opts: { appDir: string; srcDir: string; repoRoot: string; io: ConsoleLinkIo },
): ScanResult {
  const { appDir, srcDir, repoRoot, io } = opts;
  // Every file this scan touches is read several times: once to find links, once
  // to check the control-and-note pairing, and once more for every page whose
  // graph reaches it. The tree is the same throughout one scan, so it is read once
  // and remembered (L286). Comments are blanked here too, since every reader wants
  // them gone and blanking is the expensive part.
  const srcCache = new Map<string, string | null>();
  const read = (f: string): string | null => {
    if (srcCache.has(f)) return srcCache.get(f)!;
    let out: string | null;
    try {
      out = blankComments(io.readFile(f));
    } catch {
      out = null;
    }
    srcCache.set(f, out);
    return out;
  };

  const routes = readRoutes(appDir, io);
  const hidden = routes.filter((r) => r.hidden);
  const reachable = routes.filter((r) => !r.hidden);
  const dead: DeadLink[] = [];
  const rel = (f: string) => relative(repoRoot, f);

  // One walk per page, shared by both checks below: the graph does not change
  // between them, and walking it twice was most of this scan's cost.
  const graphs = new Map<string, string[]>(
    reachable.map((page) => [page.file, reachableFiles(page.file, srcDir, io)]),
  );

  for (const page of reachable) {
    for (const file of graphs.get(page.file)!) {
      const src = read(file);
      if (src === null) continue;
      for (const link of rawLinks(src)) {
        const path = routeOfHref(link.href);
        if (path === null) continue;
        const hit = hidden.find((h) => hrefReachesRoute(path, h.route));
        if (!hit) continue;
        dead.push({
          file: rel(file),
          element: link.element,
          href: link.href,
          route: hit.route,
          reachedFrom: rel(page.file),
        });
      }
    }
  }

  // A page that renders the control must also render the note it describes itself
  // with. The id is a constant so no call site can invent one, but a page can
  // still forget the note entirely, which leaves every control on it pointing at
  // an element that is not there: the state is drawn, the reason is announced to
  // nobody, and nothing anywhere reports it. A rule each call site has to remember
  // is enforced by nothing (L621, L27), so it is checked here.
  const dangling: DanglingNote[] = [];
  for (const page of reachable) {
    // The component's own module defines both, so it is not evidence that a PAGE
    // renders either. Judged over the page's graph minus the definition.
    const rendering = graphs.get(page.file)!.filter((f) => !f.endsWith(CONSOLE_LINK_MODULE));
    const holds = (re: RegExp) => (f: string) => re.test(read(f) ?? "");
    const usesControl = rendering.some(holds(/<ConsoleLink[\s>]/));
    const hasNote = rendering.some(holds(/<ConsoleComingSoonNote[\s/>]/));
    if (usesControl && !hasNote) {
      dangling.push({
        page: rel(page.file),
        file: rel(rendering.find(holds(/<ConsoleLink[\s>]/))!),
      });
    }
  }

  const key = (d: DeadLink) => `${d.file}|${d.href}|${d.reachedFrom}`;
  const seen = new Set<string>();
  return {
    dead: dead.filter((d) => (seen.has(key(d)) ? false : (seen.add(key(d)), true))),
    dangling,
    pagesScanned: reachable.length,
    hiddenRoutes: hidden.length,
  };
}

/** The module that DEFINES the pair, which is never evidence of a page using it. */
const CONSOLE_LINK_MODULE = join("components", "ui", "ConsoleLink.tsx");

/** One line per dangling note, naming what to do rather than only what is wrong. */
export function describeDangling(dangling: DanglingNote[]): string {
  return dangling
    .map(
      (d) =>
        `  ${d.file}\n` +
        `    renders <ConsoleLink> but no page reaching it renders <ConsoleComingSoonNote>,\n` +
        `    so every Coming soon control on ${d.page} describes itself with an element that is not there.\n` +
        `    Add <ConsoleComingSoonNote /> beside the controls.`,
    )
    .join("\n");
}

/** One line per finding, naming what to do rather than only what is wrong (L109). */
export function describeDeadLinks(dead: DeadLink[]): string {
  return dead
    .map(
      (d) =>
        `  ${d.file}\n` +
        `    <${d.element} href=${d.href}> points at ${d.route}, which redirects a hidden viewer away.\n` +
        `    Reached from ${d.reachedFrom}.\n` +
        `    Use <ConsoleLink consoleHidden={...} href={...}> so it says Coming soon instead.`,
    )
    .join("\n");
}
