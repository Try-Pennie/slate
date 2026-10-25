// Reads which locks a cron route really takes, for the lane registry guard (#3468).
//
// A route takes its lane lock with `acquireLock("cron_x", ...)` or `acquireLease(...)`,
// by a string literal or by a constant (`BULK_REASSIGN_LANE_LOCK`) declared in a module
// the route imports.
// A template argument (`anomaly_selfheal:${code}`) is a per item lock, never the lane's,
// so it is reported as dynamic and never counted as a name.

export interface RouteLocks {
  /** The lock names this route passes to acquireLock or acquireLease, resolved. */
  names: string[];
  /** Constants passed as the lock that no source file declares as a string. */
  unresolved: string[];
  /** How many calls pass a template or other expression rather than a name. */
  dynamic: number;
}

// A SCREAMING_CASE identifier is a lock constant to resolve; any other expression (a
// parameter in a wrapper, a template) is dynamic.
const CALL = /\bacquire(?:Lock|Lease)\(\s*(?:"([^"]+)"|'([^']+)'|`([^`$]*)`|([A-Z][A-Z0-9_]*)\s*[,)]|(\S))/g;

/** The string a constant is declared as, from any of the given sources. */
export function resolveConstant(name: string, sources: string[]): string | null {
  const decl = new RegExp(`\\bconst\\s+${name}\\s*(?::\\s*string\\s*)?=\\s*["'\`]([^"'\`$]+)["'\`]`);
  for (const src of sources) {
    const m = decl.exec(src);
    if (m) return m[1];
  }
  return null;
}

/**
 * The locks one route takes. `elsewhere` is every other source a constant may be
 * declared in; the route's own file is searched first.
 */
export function routeLocks(route: string, elsewhere: string[]): RouteLocks {
  const out: RouteLocks = { names: [], unresolved: [], dynamic: 0 };
  for (const m of route.matchAll(CALL)) {
    const literal = m[1] ?? m[2] ?? m[3];
    if (literal !== undefined) {
      out.names.push(literal);
      continue;
    }
    const ident = m[4];
    if (ident !== undefined) {
      const value = resolveConstant(ident, [route, ...elsewhere]);
      if (value === null) out.unresolved.push(ident);
      else out.names.push(value);
      continue;
    }
    out.dynamic += 1;
  }
  return out;
}

export interface LaneRunEntry {
  route: string;
  lock: string | null;
}

/**
 * Every way the registry can disagree with the routes. `routeSource` returns a
 * route's file text, or null when no such route exists; `importedSources` returns
 * the text of the modules a route imports, where a lock constant may be declared.
 *
 * A lane that OWNS its route (the route's last segment is the lane) and records no
 * lock must take none, so a lock added to the route later cannot go unnamed. A sub
 * step lane runs inside another lane's route and records no lock of its own, so the
 * owning lane's entry speaks for that route.
 */
export function laneLockFindings(
  runs: Record<string, LaneRunEntry>,
  routeSource: (route: string) => string | null,
  importedSources: (routeText: string) => string[],
  scheduledRoutes: string[],
): string[] {
  const findings: string[] = [];
  for (const [lane, run] of Object.entries(runs)) {
    if (!scheduledRoutes.includes(run.route)) {
      findings.push(`${lane}: ${run.route} is not a route worker/cron-routes.ts schedules`);
    }
    const src = routeSource(run.route);
    if (src === null) {
      findings.push(`${lane}: no route file for ${run.route}`);
      continue;
    }
    const locks = routeLocks(src, importedSources(src));
    for (const ident of locks.unresolved) {
      findings.push(`${lane}: ${run.route} passes ${ident} as its lock, and no source declares it as a string`);
    }
    const owns = run.route.split("/").pop() === lane;
    if (run.lock !== null) {
      if (!owns) findings.push(`${lane}: runs inside ${run.route}, so a lock recorded for it is that route's, not its own`);
      if (!locks.names.includes(run.lock)) {
        findings.push(
          `${lane}: records ${run.lock}, but ${run.route} takes ${locks.names.length ? locks.names.join(", ") : "no named lock"}`,
        );
      }
    } else if (owns && (locks.names.length > 0 || locks.dynamic > 0)) {
      findings.push(`${lane}: records no lock, but ${run.route} takes ${locks.names.join(", ") || "one"}`);
    }
  }
  return findings;
}
