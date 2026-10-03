// Enumerate every dynamic route segment under src/app, with its static siblings
// (#3105). Shared by the log shipping route guard so the walk and the judgement
// are testable apart: the judgement runs over synthetic trees as positive controls.
import { readdirSync } from "node:fs";
import { join } from "node:path";

export interface DynamicRoute {
  /** The route as written in the tree, e.g. `/booking/manage/[token]`. */
  route: string;
  /** The STATIC directories beside the dynamic one, sorted. */
  siblings: string[];
}

/** A route group `(x)`, a private folder `_x` or a parallel slot `@x` adds no URL
 *  segment, so a route through one would not match the URL the policy sees. They
 *  are reported rather than guessed at. */
export function isUnsupportedSegment(name: string): boolean {
  return name.startsWith("(") || name.startsWith("_") || name.startsWith("@");
}

export function scanDynamicRoutes(appDir: string): { routes: DynamicRoute[]; unsupported: string[] } {
  const routes: DynamicRoute[] = [];
  const unsupported: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    const dirs = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    const statics = dirs.filter((d) => !d.startsWith("[")).sort();
    for (const name of dirs) {
      const route = `${prefix}/${name}`;
      if (isUnsupportedSegment(name)) unsupported.push(route);
      if (name.startsWith("[")) routes.push({ route, siblings: statics });
      walk(join(dir, name), route);
    }
  };
  walk(appDir, "");
  return { routes: routes.sort((a, b) => a.route.localeCompare(b.route)), unsupported };
}

/** Every disagreement between the tree and a policy, in both directions. */
export function dynamicRouteFaults(
  tree: readonly DynamicRoute[],
  policy: readonly { route: string; siblings: readonly string[] }[],
): string[] {
  const faults: string[] = [];
  const byRoute = new Map(policy.map((p) => [p.route, p]));
  for (const t of tree) {
    const p = byRoute.get(t.route);
    if (!p) {
      faults.push(`${t.route} is a dynamic route with no entry in DYNAMIC_SEGMENT_POLICY, so its value would ship unclassified`);
      continue;
    }
    if (/\[\.\.\.|\[\[/.test(t.route)) faults.push(`${t.route} is a catch all, which the redaction does not model`);
    const want = [...t.siblings].sort().join(",");
    const have = [...p.siblings].sort().join(",");
    if (want !== have) faults.push(`${t.route} has static siblings [${want}] in the tree and [${have}] in the policy`);
  }
  const inTree = new Set(tree.map((t) => t.route));
  for (const p of policy) {
    if (!inTree.has(p.route)) faults.push(`${p.route} is in DYNAMIC_SEGMENT_POLICY and no longer in src/app`);
  }
  return faults;
}
