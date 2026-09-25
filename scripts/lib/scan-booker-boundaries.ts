// Every route that renders the booker is covered by the booker's OWN error
// boundary, never by the root backstop (#2732).
//
// `global-error` replaces the whole document. Inside the embed that is a blank
// frame: nothing said to the lead and nothing said to the host page, whose
// funnel then records a lead who viewed the booker and vanished. #2658 gave
// `/book` a boundary that keeps the layout and announces `linkFailed`, and
// `/booking/[id]`, the entry every trypennie link uses, was left on the
// backstop. So this derives the booker routes from what the code RENDERS (a
// page importing the Booker) rather than from a hand kept list (L96), and asks
// of each one that the nearest `error.tsx` at or above it renders the one shared
// boundary component rather than a copy of it (L613).
//
// Pure over a path to text map, so the decision is driven without a filesystem.

export const SHARED_BOUNDARY = "@/components/BookerErrorBoundary";

/** Paths are posix, relative to the repo root, e.g. `src/app/book/page.tsx`. */
export type SourceTree = ReadonlyMap<string, string>;

export type BoundaryFinding = { route: string; problem: string };

const APP = "src/app";
const IMPORTS_BOOKER = /from\s+["']@\/components\/Booker["']/;
const IMPORTS_SHARED = new RegExp(
  `from\\s+["']${SHARED_BOUNDARY.replace(/[/@]/g, (c) => `\\${c}`)}["']`,
);

/** Every `page.tsx` under `src/app` that renders the booker. */
export function bookerRoutes(tree: SourceTree): string[] {
  return [...tree.keys()]
    .filter((p) => p.startsWith(`${APP}/`) && p.endsWith("/page.tsx"))
    .filter((p) => IMPORTS_BOOKER.test(tree.get(p) ?? ""))
    .sort();
}

/**
 * The nearest `error.tsx` that would catch a throw in this page: the page's own
 * segment first, then each parent up to and including `src/app` itself. Null
 * means the throw reaches `global-error`.
 */
export function nearestBoundary(tree: SourceTree, page: string): string | null {
  let dir = page.slice(0, page.lastIndexOf("/"));
  while (dir.startsWith(APP)) {
    const candidate = `${dir}/error.tsx`;
    if (tree.has(candidate)) return candidate;
    if (dir === APP) break;
    dir = dir.slice(0, dir.lastIndexOf("/"));
  }
  return null;
}

export function scanBookerBoundaries(tree: SourceTree): BoundaryFinding[] {
  const findings: BoundaryFinding[] = [];
  for (const route of bookerRoutes(tree)) {
    const boundary = nearestBoundary(tree, route);
    if (!boundary) {
      findings.push({
        route,
        problem: "no error.tsx at or above it, so a throw reaches global-error and blanks the embedded frame",
      });
      continue;
    }
    const src = tree.get(boundary) ?? "";
    if (!IMPORTS_SHARED.test(src)) {
      findings.push({
        route,
        problem: `${boundary} does not render ${SHARED_BOUNDARY}, so it is a copy that can drift or a boundary that tells the host nothing`,
      });
    }
  }
  // The announcement itself lives in the shared component only. A second
  // boundary posting linkFailed on its own is the copy this exists to prevent.
  for (const [path, src] of tree) {
    if (!path.startsWith(`${APP}/`) || !path.endsWith("/error.tsx")) continue;
    if (/bookerCrashed|postMessage\(/.test(src)) {
      findings.push({
        route: path,
        problem: "announces the crash itself rather than through the shared boundary component",
      });
    }
  }
  return findings;
}
