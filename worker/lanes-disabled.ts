/**
 * Which cron lanes a deployment is configured NOT to run (#2242).
 *
 * The load test environment inherits every cron trigger, deliberately: the run is
 * meant to measure recompute freshness and the outbox drain UNDER the booking
 * load, so those lanes have to be live. What must not be live are the lanes that
 * reach a system outside the isolated branch. `/api/cron/ooo-approvals` emails
 * salesmanagers@trypennie.com, `/api/cron/agents` reads Salesforce and rewrites
 * the roster, `/api/cron/monitor` pages Slack, the two Snowflake lanes write the
 * warehouse, and the two PII prunes redact rows against a mirror the branch does
 * not have. None of those is stubbed by `SLATE_LOADTEST`, so a load run with the
 * crons inherited and nothing else would send real mail about a synthetic roster.
 *
 * `SLATE_LANES_DISABLED` is a comma separated list of lane names (the last path
 * segment of the route), set as a var on `env.loadtest` only.
 *
 * **A name that matches no route refuses the whole tick**, rather than being
 * ignored. An operation that finds its target by matching text reports success
 * when it matches nothing (L100), and here the thing it failed to match is a lane
 * that then runs: a typo in `ooo-aprovals` would put real email about a fake
 * roster into a real inbox, and nothing would say the disable had missed. Refusing
 * is loud, immediate and recoverable (the freshness sampler goes red within a
 * minute); a sent email is not. This is the same fail-closed direction the rest of
 * the load test guards take.
 */
import { CRON_ROUTES } from "./cron-routes";

/** The lane name a cron route is known by: the last path segment. */
export function laneName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Every lane any cron expression drives, derived from the route map itself.
 *
 *  Derived rather than listed beside it (L41): a hand kept second list is how a
 *  lane added later is exempt from the check written to catch it (L96).
 */
export function allLaneNames(): string[] {
  const names = new Set<string>();
  for (const value of Object.values(CRON_ROUTES)) {
    for (const path of Array.isArray(value) ? value : [value]) names.add(laneName(path));
  }
  return [...names].sort();
}

export interface LaneDecision {
  /** The routes this tick should actually drive. */
  run: string[];
  /** The routes this deployment is configured not to run. */
  skipped: string[];
  /** Names in the setting that match no lane. Non-empty means refuse the tick. */
  unknown: string[];
}

/**
 * Split a tick's routes into what runs and what is held back.
 *
 * An absent or empty setting disables nothing, which is production: the var is set
 * on the load test environment only, and `scripts/test-wrangler-loadtest-env.ts`
 * asserts it appears nowhere else.
 */
export function laneDecision(paths: string[], raw: string | undefined): LaneDecision {
  const wanted = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (wanted.length === 0) return { run: [...paths], skipped: [], unknown: [] };

  const known = new Set(allLaneNames());
  const unknown = [...new Set(wanted.filter((name) => !known.has(name)))].sort();
  if (unknown.length > 0) return { run: [], skipped: [...paths], unknown };

  const off = new Set(wanted);
  const run: string[] = [];
  const skipped: string[] = [];
  for (const path of paths) (off.has(laneName(path)) ? skipped : run).push(path);
  return { run, skipped, unknown: [] };
}
