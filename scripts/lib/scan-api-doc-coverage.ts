/**
 * Compare the routes that EXIST against the routes `docs/api.md` documents (#1044).
 *
 * `docs/api.md` opens by calling itself the single authoritative reference for every
 * HTTP endpoint, and nothing held it to that. Guards pin `DEPLOY.md` and the README;
 * this file had none, and by the time it was measured it was missing 20 of 51 routes
 * plus 10 of the 21 cron lanes, while still making the claim.
 *
 * Read BOTH ways, because a one-directional comparison is satisfied by whichever list
 * happens to be the superset:
 *
 *   - every route in the tree appears in the doc, so a new endpoint cannot ship
 *     undocumented;
 *   - every `/api/...` path the doc names exists in the tree, so a deleted route
 *     cannot leave an entry behind that reads as coverage of something real.
 */

export interface DocCoverage {
  /** Routes in the tree that the doc never names. */
  undocumented: string[];
  /** Paths the doc names that no route serves. */
  stale: string[];
}

/**
 * The route path a `route.ts` serves, derived from its position on disk.
 * `src/app/api/bookings/[token]/cancel/route.ts` -> `/api/bookings/[token]/cancel`.
 * The `[param]` form is kept verbatim, which is how the doc writes them too, so the
 * comparison needs no normalisation that could paper over a real difference.
 */
export function routePathOf(file: string): string {
  const m = file.match(/src\/app(\/api\/.*)\/route\.ts$/);
  return m ? m[1]! : "";
}

/**
 * Every `/api/...` path the doc mentions. Deliberately permissive about the
 * surrounding markdown (a table cell, a heading, a backticked run of prose), because
 * the doc's shape is not the thing under test: what matters is that the path is named
 * somewhere a reader will find it.
 *
 * A trailing `*` is a WILDCARD (`/api/cron/*`), and it is deliberately NOT treated as
 * covering the lanes beneath it. That wildcard is exactly how ten cron lanes went
 * unnamed: the line read as though the family were documented while half its members
 * were not written down anywhere.
 */
export function documentedPaths(markdown: string): Set<string> {
  // Source-file references are stripped FIRST. The doc cites the code that serves
  // each surface (`src/app/api/bookings/[token]/cancel/route.ts`), and those contain a
  // `/api/...` run that is a path on disk, not a URL: counted as documentation they
  // would let a file citation stand in for an entry, and counted as URLs they read as
  // routes that do not exist.
  const prose = markdown.replace(/src\/app[A-Za-z0-9\-_[\]/.]*/g, " ");
  const found = new Set<string>();
  for (const m of prose.matchAll(/\/api\/[A-Za-z0-9\-_[\]/*]+/g)) {
    let path = m[0]!;
    // Trim markdown punctuation that can hang off the end of a path in prose.
    path = path.replace(/[.,;:)]+$/, "");
    // A trailing slash names a FAMILY of routes, not one route.
    if (path.endsWith("/")) continue;
    found.add(path);
  }
  return found;
}

/** The two-way comparison. Both lists empty means the doc and the tree agree. */
export function scanApiDocCoverage(routeFiles: string[], markdown: string): DocCoverage {
  const real = routeFiles.map(routePathOf).filter(Boolean);
  const documented = documentedPaths(markdown);
  const undocumented = real.filter((p) => !documented.has(p)).sort();
  const realSet = new Set(real);
  const stale = [...documented]
    // A wildcard cannot be checked against the tree, and is not claimed to cover
    // anything, so it is neither documentation of a route nor a stale entry.
    .filter((p) => !p.includes("*") && !realSet.has(p))
    .sort();
  return { undocumented, stale };
}
