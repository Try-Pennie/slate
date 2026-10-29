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
    // The 24 hour reminder email (#2359). Five minutes is the precision it needs:
    // the reminder lands within five minutes of the mark, and a booking made inside
    // the window is reminded on the next tick rather than by a second schedule.
    // Deliberately NOT on the every minute trigger, which is the invocation already
    // short of CPU headroom (#1245, #2021), and it makes a Gmail call per lead.
    "/api/cron/booking-reminders",
  ],
  // Hourly roster reconcile: Salesforce agent/team sync (deactivate-not-delete
  // reaper) + default hours, through the SINGLE locked path (#267). New agents
  // arrive bookable=false; the sync never re-activates anyone. Runs hourly (was
  // daily) so a new hire is eligible within the hour; the unlocked */15 reaper
  // on the retired slate-cron worker is gone.
  // Plus the hourly coverage-reassign RETRY (cron_bulk_reassign_retry, #3485): it re-arms
  // every still-upcoming unplaceable call so the */5 drain re-attempts it. A cheap
  // database-only re-arm (no Google calls), under its own lock and independent request, so
  // it never contends with the roster reconcile beside it.
  "0 * * * *": ["/api/cron/agents", "/api/cron/bulk-reassign-retry"],
  // Pending-OOO morning digest. Two UTC slots straddle DST so it lands at 9am
  // ET on weekdays; the route's isDigestTime gate lets exactly one fire.
  // Weekdays are written as NAMES: Cloudflare counts 1 = Sunday, so `1-5` ran
  // Sunday to Thursday and Friday never fired (#2814).
  // scripts/test-cron-weekday-names.ts refuses a numeric weekday field.
  "0 13 * * MON-FRI": "/api/cron/ooo-digest",
  "0 14 * * MON-FRI": "/api/cron/ooo-digest",
  // Daily 7am ET email of yesterday's OOO approvals (CSV). Two UTC slots
  // straddle DST; the route's isApprovalsDigestTime gate lets one fire.
  "0 11 * * *": "/api/cron/ooo-approvals",
  "0 12 * * *": "/api/cron/ooo-approvals",
  // Daily 03:05 UTC retention lanes (each under its own lock): prune
  // routing_decisions older than 12 months, blank webhook_deliveries payload PII
  // on terminal deliveries older than the 90-day window (#1073), redact
  // consumer PII on bookings whose appointment is past the 24-month window (#1071),
  // and delete cached busy_blocks whose end is far enough past to be unreadable
  // (#1252: that table had no retention at all and reached 403k rows), and clear
  // the same 24-month contact data from the Snowflake mirror (#1180). The prune
  // sits here rather than on the every-minute trigger deliberately, because that
  // invocation is the one already short of CPU headroom.
  //
  // 03:05 rather than 03:00 (#1713): every retention lane gates on the export lane
  // being current, and the export lane then fired on every tenth minute, so an
  // exact 03:00 start had the gate reading the mirror while the tick it was judging
  // was still working through six tables. The export now runs at :14 and :44
  // (#4349); scripts/test-cron-routes.ts pins this minute off the export's minutes.
  "5 3 * * *": [
    "/api/cron/prune-routing",
    "/api/cron/prune-webhook-payloads",
    "/api/cron/prune-bookings-pii",
    "/api/cron/prune-busy-blocks",
    // #1180: the warehouse half of the same 24 month window prune-bookings-pii
    // enforces in Supabase. Co-scheduled here rather than given its own
    // expression because it needs no new cron slot and its budget cost is small
    // (one select, four updates and a verify), and because the retention gate
    // stopped making Snowflake calls in #1139, so this invocation has the
    // headroom the every-minute one does not.
    //
    // Concurrent with prune-bookings-pii on purpose, and safe in either order:
    // that lane refuses to redact a row the warehouse has not confirmed, but the
    // confirmation asks only whether the id is PRESENT and its watermark current,
    // never whether a contact column holds anything, so a row this sweep has
    // already cleared still verifies as archived.
    "/api/cron/prune-warehouse-pii",
    // #2090: the inbound Regal call feed, a few days of events kept and the rest
    // deleted in one statement. Here with its siblings rather than on the
    // every-minute trigger for the reason given above. It also prunes dead
    // rate_limits limiter rows (#3109), one more statement in the same lane.
    "/api/cron/prune-regal-calls",
    // #2726: the alert_state rows of alerts keyed by booking, once that booking is
    // a week past. One paged read per family, one bookings read and one delete, so
    // it costs this invocation a handful of subrequests.
    "/api/cron/prune-booking-alert-state",
  ],
  // Calendar hydration rotation (#1261): re-bootstrap a slice of the calendars every 15
  // minutes, sized from the live count so every calendar is refreshed at least once a day.
  // Its OWN expression, never co-scheduled: the every-minute invocation is the one already
  // short of CPU headroom (#1245), and this lane makes real Google calls per calendar.
  // Hydration is load-bearing once anything filters or prunes the cache by window, so it
  // stamps its own heartbeat with a matching bound in LANE_STALE_BOUNDS_MS.
  "*/15 * * * *": "/api/cron/hydrate-calendars",
  // Snowflake archival mirror export (#1099): its OWN expression, never
  // co-scheduled, so it gets its own CPU/subrequest budget. Every 30 minutes since
  // #4349 (Dan, 2026-10-28: each run wakes the warehouse, and lead traffic around
  // the clock made that nearly every run), at :14 and :44: clear of the hourly
  // lanes at :00 and of the 03:05 retention lanes, whose export lag gate must
  // never read mid tick (scripts/test-cron-routes.ts). Resumable via export_cursor, so a missed tick means the next
  // one catches up.
  "14,44 * * * *": "/api/cron/snowflake-export",
  // Snowflake mirror reconciliation (#1101) + erasure content-audit (#1103):
  // every 6h, each under its own lock. Reconcile counts Supabase vs Snowflake per
  // table + a positive control and alerts on drift; the audit reads the pii.erasure
  // trail and alerts if the warehouse still holds PII for an erased booking (the
  // operator's manual purge is incomplete). Each stamps its OWN heartbeat, judged
  // against MIRROR_STALE_BOUNDS_MS (#1123). Co-scheduling does NOT let one cover the
  // other: this comment used to claim reconcile's dead-man's switch covered both,
  // when reconcile's own stamp was read by no bound and a failing audit hid behind
  // reconcile's fresh one.
  // The reconcile lane ALSO runs the live warehouse self-check at its tail (#1144),
  // which stamps a THIRD heartbeat (`snowflake-check`) only when the probe is
  // healthy. That check used to run solely when an admin opened the admin page,
  // which is how #1143's SQL compilation error reached prod past 1,100 green tests.
  "0 */6 * * *": ["/api/cron/snowflake-reconcile", "/api/cron/erasure-audit"],
  // The daily advisor photo refresh from the Google directory (#3027). Its OWN
  // expressions, never co-scheduled: it makes about 130 Google reads and writes
  // image rows, so it gets an invocation of its own. Minute 17 shares a moment
  // with no other trigger (the every 5 and 15 minute lanes, the export at :14 and
  // :44, and the hourly one).
  // The 10:17 run is the automatic re attempt (L533): the route stands down when
  // the 04:17 run already reached a verdict today, so a healthy day reads Google
  // once. Both expressions drive the one lane, under one lock.
  "17 4 * * *": "/api/cron/advisor-photos",
  "17 10 * * *": "/api/cron/advisor-photos",
  // The daily busy minute check (#3124): has a minute of more than a tenth of the load
  // run's bar happened on 3 of the last 7 days? Its OWN expressions, never co-scheduled:
  // it pages through about 25 paced cal.com reads, about half a minute of wall clock.
  // 05:41 UTC, and 09:41 as the automatic re attempt (L533), which stands down once the
  // first run reached a verdict. Night ET on purpose: cal.com meters the endpoint per
  // key, and the same key does the working day's time off writes. Minute 41 shares a
  // moment with no other trigger. src/lib/monitor/busy-minutes.ts holds the pair, and
  // scripts/test-busy-minutes.ts holds this map to it.
  "41 5 * * *": "/api/cron/busy-minutes",
  "41 9 * * *": "/api/cron/busy-minutes",
  // Team capacity history (#3940): each advisor's calls saved as they pass, so a past day shows
  // how it ended. Every half hour on its OWN expression: minutes 23 and 53 share a moment with no
  // other trigger. Its cursor catches up a missed tick, so the cadence sets only how soon a passed
  // call is saved. It stamps its own heartbeat, bounded in LANE_STALE_BOUNDS_MS.
  "23,53 * * * *": "/api/cron/capacity-history",
  // Booking pace readings (#4102): each page day's calls open and how many were taken since the
  // last reading, read at the half hour it falls in. Its OWN expression: minutes 13 and 43 share a
  // moment with no other trigger. Not 8 and 38 (the issue's first choice): those leave no clear
  // gradual deploy window for 22.5 minutes, past the 20 minute bound scripts/test-gradual-deploy.ts
  // holds the deploy job's timeout to; 13 and 43 keep the worst wait at today's 19.5. A missed run
  // is measured by the next over the longer interval. It stamps its own heartbeat, bounded in
  // LANE_STALE_BOUNDS_MS.
  "13,43 * * * *": "/api/cron/capacity-fill",
};

/** The every minute trigger. Cloudflare has stopped delivering it on its own while every
 *  other schedule fired (2026-10-26, 2026-10-27, 2026-10-29), so its lanes have a backstop. */
export const MINUTE_CRON = "* * * * *";

/**
 * The trigger whose tick also starts any every minute lane that has not claimed a tick in
 * three minutes (worker/lane-backstop.ts, 2026-10-29). Five minutes because it is the most
 * frequent other trigger: a skipped minute trigger then costs at most about five minutes of
 * those lanes, never the 14 it cost on 2026-10-29.
 */
export const BACKSTOP_CRON = "*/5 * * * *";

/** Every route a cron expression drives (empty array when unmapped). */
export function routesForCron(cron: string): string[] {
  const value = CRON_ROUTES[cron];
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
