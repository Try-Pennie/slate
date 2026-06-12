/**
 * Pure: which app route each Cloudflare cron expression drives. The custom
 * worker entry (worker/index.ts) dispatches scheduled events through this map;
 * wrangler.jsonc's triggers.crons must list exactly these keys -
 * scripts/test-cron-routes.ts pins both directions.
 */
export const CRON_ROUTES: Record<string, string> = {
  // Backstop sync + watch renewals (availability cache freshness).
  "* * * * *": "/api/cron/sync",
  // Booking completion sweep + webhook retry queue.
  "*/5 * * * *": "/api/cron/complete",
  // Daily roster maintenance: Salesforce agent/team sync + default hours.
  "0 6 * * *": "/api/cron/agents",
  // Pending-OOO morning digest. Two UTC slots straddle DST so it lands at 9am
  // ET on weekdays; the route's isDigestTime gate lets exactly one fire.
  "0 13 * * 1-5": "/api/cron/ooo-digest",
  "0 14 * * 1-5": "/api/cron/ooo-digest",
};

export function routeForCron(cron: string): string | null {
  return CRON_ROUTES[cron] ?? null;
}
