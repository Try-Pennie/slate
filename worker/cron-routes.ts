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
  // Plus the booking-outbox drain (cron_outbox, #429): its own every-minute
  // lane + lock so it never starves on the sync tail's 25s budget.
  // Plus the self-heal sweeps (cron_selfheal, #433): the #401 deletion drain +
  // #428 cancelled-reconcile + #431 missing-reconcile, moved off the sync tail
  // onto their own lane so a busy tick can't starve booking-safety cleanup.
  "* * * * *": [
    "/api/cron/sync",
    "/api/cron/recompute",
    "/api/cron/outbox",
    "/api/cron/selfheal",
  ],
  // Booking completion sweep + webhook retry queue, the watch-renewal lane
  // (cron_watch): watch TTL is ~7 days, so renewals never needed the 1-min tick,
  // and the availability-health probe (cron_monitor, #371): a DB-only check that
  // a should-be-bookable bucket isn't silently serving empty availability.
  // Plus the bulk coverage-reassign drain (cron_bulk_reassign, #973): its own
  // lock + independent request so a heavy tick (each item does a live verify +
  // a Google reassign) can't starve completion or the health probe.
  "*/5 * * * *": [
    "/api/cron/complete",
    "/api/cron/watch",
    "/api/cron/monitor",
    "/api/cron/bulk-reassign",
  ],
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
  // Daily 3am UTC retention lanes (each under its own lock): prune
  // routing_decisions older than 12 months, blank webhook_deliveries payload PII
  // on terminal deliveries older than the 90-day window (#1073), and redact
  // consumer PII on bookings whose appointment is past the 24-month window (#1071).
  "0 3 * * *": [
    "/api/cron/prune-routing",
    "/api/cron/prune-webhook-payloads",
    "/api/cron/prune-bookings-pii",
  ],
  // Snowflake archival mirror export (#1099): its OWN expression (every 10 min),
  // never co-scheduled, so it gets its own CPU/subrequest budget. Resumable via
  // export_cursor, so a 10-min gap just means the next tick catches up.
  "*/10 * * * *": "/api/cron/snowflake-export",
  // Snowflake mirror reconciliation (#1101): every 6h, its own lane, counts
  // Supabase vs Snowflake per table + a positive control and Slack-alerts on
  // drift. The precondition the future deletion lane must pass.
  "0 */6 * * *": "/api/cron/snowflake-reconcile",
};

/** Every route a cron expression drives (empty array when unmapped). */
export function routesForCron(cron: string): string[] {
  const value = CRON_ROUTES[cron];
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
