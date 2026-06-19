/**
 * Pure: which app route(s) each Cloudflare cron expression drives. The custom
 * worker entry (worker/index.ts) dispatches scheduled events through this map;
 * wrangler.jsonc's triggers.crons must list exactly these keys -
 * scripts/test-cron-routes.ts pins both directions.
 *
 * A single expression may drive MORE THAN ONE route (an array): Cloudflare's
 * cron granularity is one minute, so two every-minute lanes have to share the
 * `* * * * *` trigger. The dispatcher fires each route as an independent
 * request with its own lock, so co-scheduled lanes still can't starve one
 * another (#273).
 */
export const CRON_ROUTES: Record<string, string | string[]> = {
  // Two independent every-minute lanes, each under its own lock: backstop sync
  // + watch renewals (cron_sync), and bucket_slots recompute (cron_recompute).
  // Splitting them stops a busy sync tick from starving the slot refresh.
  "* * * * *": ["/api/cron/sync", "/api/cron/recompute"],
  // Booking completion sweep + webhook retry queue, plus the watch-renewal lane
  // (cron_watch): watch TTL is ~7 days, so renewals never needed the 1-min tick.
  "*/5 * * * *": ["/api/cron/complete", "/api/cron/watch"],
  // Hourly roster reconcile: Salesforce agent/team sync (deactivate-not-delete
  // reaper) + default hours, through the SINGLE locked path (#267). New agents
  // arrive bookable=false; the sync never re-activates anyone. Runs hourly (was
  // daily) so a new hire is eligible within the hour; the unlocked */15 reaper
  // on the retired slate-cron worker is gone.
  "0 * * * *": "/api/cron/agents",
  // Pending-OOO morning digest. Two UTC slots straddle DST so it lands at 9am
  // ET on weekdays; the route's isDigestTime gate lets exactly one fire.
  "0 13 * * 1-5": "/api/cron/ooo-digest",
  "0 14 * * 1-5": "/api/cron/ooo-digest",
  // Daily 7am ET email of yesterday's OOO approvals (CSV). Two UTC slots
  // straddle DST; the route's isApprovalsDigestTime gate lets one fire.
  "0 11 * * *": "/api/cron/ooo-approvals",
  "0 12 * * *": "/api/cron/ooo-approvals",
};

/** Every route a cron expression drives (empty array when unmapped). */
export function routesForCron(cron: string): string[] {
  const value = CRON_ROUTES[cron];
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
