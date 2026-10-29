/**
 * Every alert key Slate can send, and what KIND of thing it reports (#1151).
 *
 * The distinction that matters, and the one this file exists to make explicit,
 * is CONDITION versus INCIDENT:
 *
 *   condition - an ongoing state that is true until something changes it: a lane
 *               is quiet, a mirror has drifted, retention is stopped, an endpoint
 *               is dead-lettering. Someone reads the page, and then needs to know
 *               when it is over. A condition MUST have a recovery path
 *               (`resolveAlert` on the same key), or it pages once and leaves the
 *               reader with no way to tell whether it is still happening.
 *
 *   incident  - a past event that has already finished: this booking's event
 *               insert failed, this reassign was abandoned mid-flight, this
 *               request hit an unexpected 500. There is no healthy state to
 *               observe, so an "all-clear" would be noise pretending to be
 *               information. An incident carries NO recovery, and says why.
 *
 *   info      - a whisper on the info channel that never needed action, so it
 *               must never send a recovery notice either (#1134).
 *
 * Getting this wrong in either direction is a real defect. A condition with no
 * all-clear is the confusion #1134 was filed about. An all-clear for something
 * that never needed action is pure noise, and noise is how a pager gets ignored
 * (L36). Keeping the classification in one list, checked against the code by
 * scripts/test-alert-recovery-coverage.ts, is what stops the next alert from
 * shipping as whichever the author happened to assume.
 *
 * A key ending in `:*` is a family: the code appends a bucket code, an endpoint
 * id, a lane name. Every member of the family shares the kind.
 */

export type AlertKind = "condition" | "incident" | "info";

/**
 * What the part after `family:` is, for a `:*` family (#2726). Every family must
 * say, because it decides whether the family GROWS `alert_state`:
 *
 *   booking - a booking id. One row pair per booking, and an incident never
 *             resolves, so these accumulate with booking volume. Every such family
 *             is pruned by `prune-booking-alert-state` once the booking is past
 *             (`src/lib/notify/alert-state-retention.ts` derives its list from here).
 *   bounded - something the roster or the code bounds: a bucket code, an agent or
 *             manager id, a lane, a tier, an endpoint, a rate limited area.
 *
 * There is deliberately no third value for text taken from a request. There used
 * to be (`caller`, for the page path a browser error report named), and it named
 * a family whose keys any caller could mint without limit, one throttle bucket and
 * one row pair per invented path (#2755). A suffix derived from a request must be
 * MAPPED onto a fixed set first (`clientErrorSurface` is the worked example: the
 * route list plus `other`), and is then bounded like any other.
 *
 * `alert_state` left the capped read guard's SAFE_TABLES because the first of
 * these made it a growth table while it was still listed as roster bounded.
 * `scripts/test-alert-state-retention.ts` fails a family that declares nothing.
 */
export const ALERT_KEY_SUFFIXES = ["booking", "bounded"] as const;
export type AlertKeySuffix = (typeof ALERT_KEY_SUFFIXES)[number];

export interface AlertEntry {
  /** The key, or a `prefix:*` family. */
  key: string;
  kind: AlertKind;
  /** Why it is that kind. For an incident, what healthy state does NOT exist. */
  why: string;
  /** For a `prefix:*` family only: what the suffix is (#2726). */
  suffix?: AlertKeySuffix;
}

export const ALERT_CATALOG: AlertEntry[] = [
  // --- Conditions: something is wrong NOW and will stop being wrong ----------
  {
    key: "booker_empty_reason",
    kind: "condition",
    why: "The booker cannot say why a week is empty; the config becomes readable again and the monitor lane sees it on its next pass.",
  },
  {
    key: "roster_coverage_gap",
    kind: "condition",
    why: "The org advertises hours nobody is rostered for inside the booking horizon; a schedule or the business hours are edited and the monitor lane sees it on its next pass.",
  },
  {
    key: "roster_coverage_upcoming_gap",
    kind: "condition",
    why: "The org will advertise hours nobody is rostered for in the week past the booking horizon; a schedule or the business hours are edited and the monitor lane sees the range clear on its next pass.",
  },
  {
    key: "sync_failures",
    kind: "condition",
    why: "Agents' calendars are failing to sync; the fleet recovers and the sync lane can see it.",
  },
  {
    key: "watch_lapse",
    kind: "condition",
    why: "Push-watch channels have lapsed; renewal restores them and the watch lane can see it.",
  },
  {
    key: "snowflake_healthcheck",
    kind: "condition",
    why: "The warehouse self-check is failing; it passes again and the reconcile lane can see it.",
  },
  {
    key: "roster_filling_up",
    kind: "condition",
    why:
      "The roster's call capacity on each of the next two days leads can book is booked at or over the nearly " +
      "full line set on Team capacity (#2590, #4219), the point to think about ad spend. It holds while every " +
      "one of those days stays there and ends when the capacity history lane measures any of them under the line. " +
      "It posts and clears only from 8 AM up to 6 PM New York time, every day (posting-hours.ts).",
  },
  {
    key: "db_saturation",
    kind: "condition",
    why: "The database's committed memory is critically high (#3588), which slows every booking and availability request; it falls back under the threshold and the monitor lane sees it on its next pass.",
  },
  {
    key: "cron_lanes_stale",
    kind: "condition",
    why:
      "One or more Worker cron lanes are not running, named on one page because they share a schedule " +
      "and stop together; it ends when every one of them stamps a heartbeat inside its bound again.",
  },
  {
    key: "minute_backstop_unreadable",
    kind: "condition",
    why:
      "The five minute tick's backstop for the every minute lanes cannot read lane_runs, so it would not start them if " +
      "Cloudflare skipped that trigger (2026-10-29); it stays true until the read answers, and the next measured read " +
      "is the healthy result that ends it.",
  },
  {
    key: "cron_lane_stale:*",
    kind: "condition",
    suffix: "bounded",
    why: "A cron lane is not running; it stamps a heartbeat again and the watchdog can see it.",
  },
  {
    key: "monitor_step_failing:*",
    kind: "condition",
    suffix: "bounded",
    why:
      "A check on the monitor lane is throwing rather than reporting, so whatever it " +
      "watches is unwatched. It stays true until somebody deploys a fix, and the lane " +
      "measures the step on every run that does its work, so it ends when the step completes " +
      "again (#2382). A run that stood down measured nothing and ends nothing (#3955).",
  },
  {
    key: "detector_unpark:*",
    kind: "condition",
    suffix: "bounded",
    why:
      "A parked detector has started reaching verdicts, so it is switched off while able to watch. It ends two ways and each says so in its own words: deleting the registry entry arms it, or the verdict lapses and the park stands with nobody having armed anything (#1562).",
  },
  {
    key: "completion_sweep_saturated",
    kind: "condition",
    why: "The completion sweep cannot drain its backlog; a tick under the cap ends it.",
  },
  {
    key: "completion_sweep_failing",
    kind: "condition",
    why:
      "The completion sweep is throwing rather than falling behind, so finished bookings " +
      "are not being marked complete at all. It ends when a run comes back with a result, " +
      "which the lane measures every five minutes (#2544).",
  },
  {
    key: "webhook_retry_sweep_failing",
    kind: "condition",
    why:
      "The failed webhook delivery retry is throwing, so a delivery that failed once is " +
      "never re-attempted. It ends when a run comes back with a result (#2544).",
  },
  {
    key: "demo_auto_cancel_failing",
    kind: "condition",
    why:
      "The demo booking auto cancel is throwing, so calls booked through the /demo link " +
      "stay on the test agent's calendar past their 30 minutes. It ends when a run comes " +
      "back with a result, which the lane measures every five minutes (#3424).",
  },
  {
    key: "outbox_drain_failing",
    kind: "condition",
    why:
      "The booking outbox drain on the outbox lane is throwing, so a booking's unfinished " +
      "follow up (calendar invite, Regal webhook) is not retried. It ends when a run " +
      "comes back with a result, which the lane measures every minute (#3846).",
  },
  {
    key: "reservation_drain_failing",
    kind: "condition",
    why:
      "The booking crash recovery drain on the outbox lane is throwing, so a lead booking " +
      "that crashed part way is not resumed. It ends when a run comes back with a result, " +
      "which the lane measures every minute (#3077).",
  },
  {
    key: "reschedule_pin_sweep_failing",
    kind: "condition",
    why:
      "The abandoned reschedule cleanup on the outbox lane is throwing, so a lost reschedule " +
      "is neither cleaned up nor reported. It ends when a run comes back with a result (#3077).",
  },
  {
    key: "reassign_intent_sweep_failing",
    kind: "condition",
    why:
      "The abandoned reassign cleanup on the outbox lane is throwing, so a lost reassign is " +
      "neither cleaned up nor reported. It ends when a run comes back with a result (#3077).",
  },
  {
    key: "coverage_retry_sweep_failing",
    kind: "condition",
    why:
      "The hourly coverage reassignment retry is throwing, so stranded calls are not being " +
      "re-attempted as calendars open. It ends when a run comes back with a result, which the " +
      "lane measures every hour (#3485).",
  },
  {
    key: "reconcile_cancelled_saturated",
    kind: "condition",
    why: "The cancelled-booking reconcile sweep is saturated; a tick under the cap ends it.",
  },
  {
    key: "reconcile_missing_saturated",
    kind: "condition",
    why: "The missing-busy-block sweep is saturated; a tick under the cap ends it.",
  },
  {
    key: "deletion_drain_saturated",
    kind: "condition",
    why: "The deletion drain is saturated; a tick under the cap ends it.",
  },
  {
    key: "snowflake_reconcile_drift",
    kind: "condition",
    why: "The mirror disagrees with the source until the export catches up or the missed rows are re-exported; reconcile re-measures every 6h.",
  },
  {
    key: "snowflake_erasure_residual",
    kind: "condition",
    why: "An erasure is incomplete until the operator runs the purge; the audit re-measures every 6h.",
  },
  {
    key: "snowflake_erasure_residual_test",
    kind: "info",
    why:
      "The same incomplete warehouse erasure as its paging sibling, but on a SMOKE " +
      "fixture, so the contact data it names is fabricated and nothing is exposed. " +
      "Worth saying so the rows get cleared off the worklist, never worth waking " +
      "for, and there is no incident to declare over: the paging key owns the " +
      "all-clear for a real residual.",
  },
  {
    key: "snowflake_purge_sql_broken",
    kind: "condition",
    why: "The purge SQL stays broken until someone fixes it; the 6h probe re-runs it against the warehouse.",
  },
  {
    key: "snowflake_credential_residual",
    kind: "condition",
    why:
      "The warehouse still holds a booking manage token after the sweep, so a warehouse " +
      "reader can reschedule or cancel those bookings. It stays true until a sweep measures " +
      "zero residual, which is the recovery.",
  },
  {
    key: "agent_sync_failures",
    kind: "condition",
    why: "The Salesforce roster sync is failing on consecutive runs; a successful run ends it.",
  },
  {
    key: "advisor_photos_unread",
    kind: "condition",
    why: "The daily advisor photo refresh measured nothing from Google (no subject, a refused subject, an unanswering directory, or a failed save); it stays true until a run reads the directory and at least one photo, which is the recovery (#3027).",
  },
  {
    key: "advisor_photos_held",
    kind: "condition",
    why: "A measured photo refresh held something back for a person (a wave of lost photos, a repeated image, somebody failing three days running, somebody never read whose read failed, somebody missing from the directory); it ends when a measured run has none of those, which is the recovery (#3027).",
  },
  {
    key: "load_bar_outgrown",
    kind: "condition",
    why: "A minute of more than a tenth of the booking load run's bar happened on 3 or more of the last 7 days, which stays true until the bar is raised or the busy days roll out of the window; the daily check that MEASURED a week with fewer such days is the recovery (#3124).",
  },
  {
    key: "load_bar_unread",
    kind: "condition",
    why: "The daily busy minute check could not count a week (a half unreadable, partial or empty while live), which stays true until a run counts both halves; that measured run is the recovery (#3124).",
  },
  {
    key: "twilio_sync_failures",
    kind: "condition",
    why: "The roster sync cannot read Twilio, so the Redistribute tag is not being acted on; it stays true until a run reads Twilio successfully, which is the recovery.",
  },
  {
    key: "departed_sessions_unconverged",
    kind: "condition",
    why:
      "Two roster runs in a row could not bring sign in access in line with the roster (an " +
      "unreadable or partial account list, a refused ban, or somebody active still locked out); " +
      "it ends when a run converges cleanly, which is the recovery (#2459).",
  },
  {
    key: "twilio_write_failures",
    kind: "condition",
    why: "The roster sync can read Twilio and cannot finish acting on it: a flip, a coverage move or a routing attribute write keeps throwing. It stays true until a run lands them all, which is the recovery.",
  },
  {
    key: "demotion_trigger_failures",
    kind: "condition",
    why:
      "The automatic reroute for advisors Twilio demoted could not finish on two roster runs in a " +
      "row: its on/off switch could not be read, a changed agent could not be checked, a move could " +
      "not be queued, or a demotion record would not save (#3615). It stays true until a run " +
      "completes all of them, which is the recovery.",
  },
  {
    key: "twilio_marked_no_worker",
    kind: "condition",
    why: "Slate is holding somebody out of the pool for redistribute and Twilio holds no worker for their address, so nothing can say whether the tag went or the worker did. It stays true until the worker is restored or somebody turns them back on.",
  },
  {
    key: "salesforce_user_id_conflicts",
    kind: "condition",
    why:
      "Part of the roster cannot be given a Salesforce user id (a disagreement, a " +
      "shared email, or an id another row holds), or a deactivation was refused " +
      "because a shared address could not be settled (#2387); it stays true until " +
      "somebody fixes those records, and the hourly sync re-measures it.",
  },
  {
    key: "salesforce_manager_ambiguous",
    kind: "condition",
    why:
      "A manager name in the Agent_Manager picklist answers to more than one " +
      "Salesforce user, so those reps have no settled approver; it stays true until " +
      "somebody makes the name unique in Salesforce, and the hourly sync re-measures " +
      "it. Its own key rather than a fold into salesforce_user_id_conflicts, which " +
      "is about the stored id column: sharing one would give two independent checks " +
      "one status field, so clearing either would clear both.",
  },
  {
    key: "salesforce_roster_divergence",
    kind: "condition",
    why:
      "A BOOKABLE agent is still being routed leads while the hourly roster query " +
      "no longer returns them, so Slate is offering their times on the last values " +
      "Salesforce gave it (#1833). It stays true until Salesforce matches them " +
      "again or somebody takes them out of the pool, and the hourly sync " +
      "re-measures it. Only the bookable ones page: an unconfirmed row nobody can " +
      "be routed to is a stale admin display, and an hourly page about one is how " +
      "the whole family stops being read.",
  },
  {
    key: "offered_nobody_free",
    kind: "condition",
    why: "A stored row is serving a time nobody in its pool is free for by the confirm's own candidate read, and has gone on serving it past the recompute lane's freshness window (#3381); it ends when every remembered time has been taken off or found free, which the monitor lane re-judges on its next pass.",
  },
  {
    key: "availability_drift:*",
    kind: "condition",
    suffix: "bounded",
    why: "A bucket is offering times that are not really free; it ends when the cache reconverges with the calendars, and the probe re-measures that bucket on every rotation.",
  },
  {
    key: "sync_staleness",
    kind: "condition",
    why:
      "Agents have dropped out of the calendar sync rotation, so their availability " +
      "is going stale; they re-enter the rotation and the same gauge re-measures it.",
  },
  {
    key: "google_calendar_breaker_open",
    kind: "condition",
    why:
      "Google Calendar calls are being held back after repeated failures (#3134); it ends " +
      "when the breaker's probe call is answered, which is what posts the all-clear.",
  },
  {
    key: "availability_booked_solid",
    kind: "condition",
    why:
      "Every lead landing on that tier is being turned away right now; coverage is " +
      "added and the same scan sees the tier offering times again (#1412). Not a " +
      "fault, which is why it reads oddly as a page, and still the moment to act.",
  },
  {
    key: "availability_data_anomaly",
    kind: "condition",
    why:
      "A bucket's cached slots disagree with a live recompute; the recompute " +
      "reconverges and the scan sees it on the next tick.",
  },
  {
    key: "migration_version_lag",
    kind: "condition",
    why:
      "Shipped code is ahead of the applied schema; a human runs the migration, and " +
      "the drift check sees the applied version catch up.",
  },
  {
    key: "hydration_all_failing",
    kind: "condition",
    why: "The calendar refresh is failing on every calendar, which stays true until the cause is fixed, so the reader needs to be told when it is over (#1544).",
  },
  {
    key: "edge_limiter_unusable",
    kind: "condition",
    why: "The running deployment cannot use its request rate limits, which stays true until a deploy puts them back, so the reader needs to be told when it is over (#1529).",
  },
  {
    key: "public_booking_stopped",
    kind: "condition",
    why: "The kill switch is on, which stays true until a person turns public booking back on; the monitor lane reads the stored flag every tick, so a tick that reads it false is the measured healthy result that ends it (#2366).",
  },
  {
    key: "shared_confirm_line_left_off",
    kind: "condition",
    why: "The shared confirm line was switched on and has been switched off for more than a day, which stays true until a person switches it back on; the monitor lane reads the stored switch every tick, so a tick that reads it on is the measured healthy result that ends it (#3339). A switch nobody has ever turned on is the expected state and says nothing.",
  },
  {
    key: "main_not_deployed",
    kind: "condition",
    why: "Main is merged and not live, which stays true until a deploy carries it; the monitor lane compares the served commit against main's tip every tick, so it ends when they agree again (#2476).",
  },
  {
    key: "ci_runs_refused",
    kind: "condition",
    why: "GitHub is failing jobs without starting them, which stays true until the account can run them again; the next run whose jobs execute steps is the measured healthy reading that ends it (#2229).",
  },
  {
    key: "definer_grants_to_web_roles",
    kind: "condition",
    why: "A database function running with its owner's privileges is executable by a web role, which stays true until somebody revokes the grant, so the reader needs to be told when it is over (#2447).",
  },
  {
    key: "auth_sign_in_beyond_google",
    kind: "condition",
    why: "Supabase Auth in production accepts email sign in or another account creating provider, which stays true until somebody turns it off in the dashboard, so the reader needs to be told when it is over (#3082).",
  },
  {
    key: "audit_log_chain_broken",
    kind: "condition",
    why: "An audit log entry no longer matches the hash chain written with it, which stays true until the trail is put back or re-anchored; the next complete walk from the first entry to the last that finds nothing wrong is the measured healthy reading that ends it (#3090).",
  },
  {
    key: "lane_claim_unreadable",
    kind: "condition",
    why: "The cron lanes cannot write their claim on a tick to lane_runs, which stays true until the table answers again; the monitor lane's next claim that is actually written is the measured healthy reading that ends it. One key for every lane, raised only by the monitor lane (#4222).",
  },
  {
    key: "smoke_canary_failed:*",
    kind: "condition",
    suffix: "bounded",
    why: "A smoke canary pass (dry or full) is failing against production; the workflow hands each failure to the Worker, and a clean run of that pass reports in and ends it, a clean full pass ending both (#3801). Before #3801 the workflow posted it on every failing run.",
  },
  {
    key: "cron_budget_headroom",
    kind: "condition",
    why: "A cron schedule's worst tick in the last day used more than half the CPU ceiling, read from the Worker logs' CPU time, which stays true for a day after the last such tick; the hourly check re-reads the trailing day, so a measured day with every schedule under the line is the healthy result that ends it, and an unread day ends nothing (#3141).",
  },
  {
    key: "agents_on_unset_hours",
    kind: "condition",
    why:
      "A bookable agent has been offered on the seeded week nobody chose for longer " +
      "than the two day grace; it ends when their hours are set or imported, and the " +
      "same daily sweep sees it (#1753).",
  },
  {
    key: "regal_call_unroutable:*",
    kind: "condition",
    suffix: "bounded",
    why:
      "Somebody Slate routes no bookings to is placing calls in Regal; it ends when they are " +
      "routable again (a recovery) or are added to the ignore list, change role, or carry the " +
      "Redistribute tag in Twilio (a suppression, worded as one, #2724), and the monitor lane sees " +
      "either on its next pass (#2090).",
  },
  {
    key: "regal_calls_quiet",
    kind: "condition",
    why:
      "No call by a Slate user reached Slate from Regal across a whole business day; it ends when " +
      "one arrives, and the monitor lane counts the feed every pass (#2090).",
  },
  {
    key: "regal_calls_unreadable",
    kind: "condition",
    why:
      "Regal is posting call events Slate cannot read; it ends after a day of readable events, " +
      "and the monitor lane counts the feed every pass (#2090).",
  },
  {
    key: "regal_call_outcomes_short",
    kind: "condition",
    why:
      "Call outcomes are being stored for under 80% of the completed calls Regal posts; it ends " +
      "when a measured two hour window is back at 80% or more, and the monitor lane compares the " +
      "two counts every pass (#2944).",
  },
  {
    key: "agents_awaiting_activation",
    kind: "condition",
    why:
      "Somebody the roster counts as working has sat outside the booking pool for " +
      "longer than the four hour grace; it ends when the activation succeeds or a " +
      "person decides either way, and the same lane sees it (#2318).",
  },
  {
    key: "agents_stranded_outside_pool",
    kind: "condition",
    why:
      "A signed in Sales hire with a syncing calendar sits outside the pool with no " +
      "pending activation and no recorded hold; it ends when they are made bookable " +
      "or a hold is recorded, and the monitor lane re-reads the roster every pass (#2481).",
  },
  {
    key: "ladder_advisor_unreadable",
    kind: "condition",
    why:
      "A bookable advisor has a row the confirm's ladder read cannot read, so every confirm " +
      "leaves them out; it ends when the row is corrected, and the monitor lane asks the same " +
      "reader every pass and clears only off a read that answered and left nobody out (#3530).",
  },
  {
    key: "schedule_parity_drift",
    kind: "condition",
    why:
      "Slate and cal.com hold a different week, or a different pool, for somebody; " +
      "it ends when one side is corrected and the next daily sweep sees them agree " +
      "again (#2031).",
  },
  {
    key: "webhook_event_no_subscriber",
    kind: "condition",
    why:
      "A booking event Slate sends has no endpoint subscribed to it, so it reaches " +
      "nobody; a person updates the subscription and the same lane re-measures it.",
  },
  {
    key: "handoff_channel_unset",
    kind: "condition",
    why:
      "A booking is waiting on somebody in sales and no handoff channel is set, so " +
      "nobody is told; it ends when the channel is set or nothing is waiting, and the " +
      "monitor lane re-measures both every tick (#2367).",
  },
  {
    // #2436. A CONDITION: owner alerts are being skipped for unreachable calendars
    // across several advisors, which stays true until their accounts are fixed. The
    // monitor re-measures the last week every tick, so it can say when it is over.
    key: "owner_alert_skips",
    kind: "condition",
    why:
      "Too many of the last week's owner alerts could not be written to the owning " +
      "advisor's calendar, across several advisors, because the calendar is gone or was " +
      "never provisioned; it ends when a measured week is back under the share, never " +
      "on a week too quiet to judge.",
  },
  // #2377. Both CONDITIONS: a sustained share of duplicate cancels failing to complete,
  // or refused for a person, stays true until the cause is fixed, and the monitor
  // re-measures the day's window every tick, so each can say when it is over.
  {
    key: "duplicate_cancel_unavailable",
    kind: "condition",
    why:
      "A sustained share of duplicate cancel requests is being answered 503 and told to " +
      "retry, so nothing is cancelled for those leads; it ends when six hours of requests " +
      "measurably complete again, never on a day too quiet to judge.",
  },
  {
    key: "duplicate_cancel_refused",
    kind: "condition",
    why:
      "A sustained share of duplicate cancel requests is refused for a reason a person has " +
      "to look at, which no single handoff shows; it ends when six hours of requests are " +
      "measurably back to an ordinary share.",
  },
  {
    key: "handoff_undelivered",
    kind: "condition",
    why:
      "A booking handoff has waited past its bound without a post landing in the " +
      "handoff channel; it ends once every open handoff has been posted or resolved, " +
      "which the monitor lane re-measures every tick (#2367).",
  },
  {
    key: "low_booking_volume",
    kind: "condition",
    why:
      "Customers have stopped getting through; volume comes back and the same " +
      "lane re-measures it against the floors every 5 minutes.",
  },
  {
    key: "volume_count_unreadable",
    kind: "condition",
    why:
      "The volume monitor cannot read its own count, so it is measuring nothing; " +
      "the read succeeds again and the same lane sees it on the next tick.",
  },
  {
    key: "low_volume_verdict_gap",
    kind: "condition",
    why:
      "The volume alarm has gone an hour of open business time without a verdict " +
      "(#2049), so it is blind while the org is open; the next tick that reaches a " +
      "verdict ends it, and the same lane re-measures every 5 minutes.",
  },
  {
    key: "volume_count_unreadable:*",
    kind: "condition",
    // The suffix is one of the debt tier digits in volume-tiers.ts; Low keeps the bare key.
    suffix: "bounded",
    why:
      "The volume monitor cannot read one tier's own count (#2874), so that tier is " +
      "measured by nothing; the read succeeds again and the same lane sees it on the " +
      "next tick.",
  },
  {
    key: "tier_volume_check_failed:*",
    kind: "condition",
    // The suffix is one of the debt tier digits in volume-tiers.ts.
    suffix: "bounded",
    why:
      "One tier's low volume check could not run (#2874), so that tier is judged by " +
      "nothing; it ends when the same lane next judges that tier, within 5 minutes " +
      "of whatever broke it being fixed.",
  },
  {
    key: "low_tier_volume:*",
    kind: "condition",
    // The suffix is one of the five debt tier digits in volume-tiers.ts.
    suffix: "bounded",
    why:
      "A debt tier judged beside Low has stopped booking (#2874); its bookings come " +
      "back and the same lane re-measures it against the tier's own learned floors " +
      "every 5 minutes.",
  },
  {
    key: "low_page_volume:*",
    kind: "condition",
    // The suffix is one of the fixed Low landing pages in page-volume.ts.
    suffix: "bounded",
    why:
      "One Low landing page has stopped booking while the others carry on (#2738); " +
      "that page's bookings come back and the same lane re-measures it against the " +
      "page's own floors every 5 minutes.",
  },
  {
    key: "page_volume_share_unknown",
    kind: "condition",
    why:
      "The per page low volume alarm cannot read the pilot switch in Salesforce " +
      "(WebsiteConfiguration__c), so it cannot tell whether every Low lead comes to Slate " +
      "and judges no page; the next tick that reads the switch clears it. The key name " +
      "predates the switch and is kept so the earlier share stand down is settled too.",
  },
  {
    key: "booking_failure_rate",
    kind: "condition",
    why: "Bookings are failing right now; it ends when the last 30 minutes hold a measured clean run of attempts (#3275), which the monitor re-measures every 5 minutes, never when the window's share merely dips under the line.",
  },
  {
    // #3275. An INCIDENT: a burst of failed bookings that had already stopped by the
    // time the window first read as over the line. The event is over when the notice
    // is sent, so there is no healthy state left to announce; an all-clear would say
    // that a thing that already ended has ended.
    key: "booking_failure_burst_ended",
    kind: "incident",
    why: "A burst of failed bookings that had already stopped before the window crossed the line; the notice reports a finished event, says nothing has failed since, and is sent once per burst.",
  },
  {
    // #3276. A CONDITION beside the share: ten or more failed attempts in the last 30
    // minutes, whatever share of traffic that is. It ends on the same measured clean
    // run as the share page, which the monitor re-measures every 5 minutes.
    key: "booking_failure_volume",
    kind: "condition",
    why: "Bookings are failing in volume right now (ten or more failed attempts in 30 minutes); it ends when the last 30 minutes hold a measured clean run of attempts, never when the count merely drops under ten as old ticks age out.",
  },
  {
    // #3179. One key per budget (booking success, availability), so each clears on
    // its own.
    key: "booking_budget:*",
    kind: "condition",
    // The suffix is one of the two budget names in slo-budget.ts.
    suffix: "bounded",
    why: "Half of a month's booking error budget is spent, which stays true for the rest of the month unless traffic outgrows it; the monitor re-reads the month every 5 minutes, so a measured month back under half (in practice the first tick of the next one) ends it.",
  },
  {
    // #3267. A CONDITION: confirms are answering the lead and leaving the work after
    // their save to the reservation drain, which stays true while the confirm path
    // is slow and ends when it is not. The monitor re-measures every 5 minutes, so it
    // can say when it is over.
    key: "booking_follow_up_left_to_drain",
    kind: "condition",
    why: "Confirms are leaving the work after their save to the reservation drain at a rate past what one slow save explains; it ends when the last 30 minutes hold a measured clean run of confirms, never when the hour's share merely dips under the line.",
  },
  {
    // #1908. A CONDITION: an upstream page has started building booking links
    // without a routing code, and it stays true until somebody fixes that page.
    // Whoever reads the page needs to know when it is over, and the monitor
    // re-measures the same window every tick, so it can say so.
    key: "catchall_rate",
    kind: "condition",
    why: "An upstream page is sending leads with no routing code, and they are being routed to the Low pool rather than their real tier; it ends when that page starts sending codes again.",
  },
  // #1442 / #1450 / #1709. All three are CONDITIONS: each is an ongoing state
  // somebody ends by changing something (raising a ceiling, fixing a key, the
  // table becoming readable), so each owes an all-clear. Each is hung off a
  // MEASURED clear verdict, never off "we did not page this run", which is why
  // the judge has an `unmeasured` status that is neither (#1134, #1152).
  {
    key: "booking_api_ceiling",
    kind: "condition",
    why: "Our own rate ceiling is turning the booking API's caller away; it ends when the share drops, either because the caller slowed or because the limit was raised.",
  },
  {
    key: "booking_api_credential",
    kind: "condition",
    why: "The booking API is refusing its caller's credential, so every lead it handles is refused; it ends when the key or the secret is fixed and calls are accepted again.",
  },
  {
    key: "booking_api_list_read",
    kind: "condition",
    why: "The bookings list cannot be read, so the caller's sync has stalled; it ends when the table is readable again.",
  },
  // #1727. The embed booker's own three refusals, the same shape on the surface real
  // leads arrive on. CONDITIONS for the same reason: each stays true until a limit
  // is raised, a bot stops, or a field is fixed, and each clears only off a measured
  // clear verdict.
  {
    key: "booking_embed_ip_cap",
    kind: "condition",
    why: "The booker's hourly address limit is refusing several addresses at once, which is a spread bot or the limit wrong for real traffic; it ends when fewer than the floor are locked out.",
  },
  {
    key: "booking_embed_contact_cap",
    kind: "condition",
    why: "The booker's per contact limit is locking out several people at once, so real leads may be turned away by us; it ends when fewer than the floor are locked out.",
  },
  {
    key: "booking_embed_honeypot",
    kind: "condition",
    why: "The booker's hidden bot trap is being filled across many intervals, a campaign or the field reachable by real leads; it ends when the window holds fewer trips than the floor.",
  },
  {
    key: "recompute_headroom",
    kind: "condition",
    why: "Recompute has been behind its budget for longer than the freshness window; keeping up for as long again ends it (#2021).",
  },
  {
    key: "bucket_slots_stale",
    kind: "condition",
    why: "Cached slot rows are going stale; a cycle with none stale ends it.",
  },
  {
    key: "retention_skipped:*",
    kind: "condition",
    suffix: "bounded",
    why: "Retention is STOPPED while the mirror is unusable; a run that proceeds ends it.",
  },
  {
    key: "ooo-digest-unreachable:*",
    kind: "condition",
    suffix: "bounded",
    why: "A manager is not receiving their digest until their Slack DM works; the daily run re-measures.",
  },
  {
    key: "ooo-digest-unrouted-unreachable",
    kind: "condition",
    why: "Requests with no assigned approver are going unnudged until the channel post lands; the daily run re-measures.",
  },
  {
    // #3543: one failed Marcia write, or one Marcia read that went wrong. Every failed
    // write pages, expected refusals included (plan decision 11, decision 39); the key
    // is the operation and the code, a bounded vocabulary, so one outage pages once per
    // kind per cooldown.
    key: "marcia_booking_failed:*",
    kind: "incident",
    suffix: "bounded",
    why: "One of Marcia's booking calls already ended without doing what she asked; there is no healthy state to observe, because the next call is a new attempt, so it carries no all-clear.",
  },
  {
    // #3543: a lead token refused by Slate's verifier, keyed by the refusal code.
    key: "marcia_token_refused:*",
    kind: "incident",
    suffix: "bounded",
    why: "One lead token was refused and nothing was booked; the next token is judged afresh, so a signer that keeps failing pages again after the cooldown rather than resolving.",
  },
  {
    // #3543: the internal booking route met a missing or wrong gateway secret.
    key: "marcia_gateway_refused",
    kind: "incident",
    why: "One call reached Marcia's internal route without the gateway's secret and was refused; it is a finished event, and a deployment still missing the secret pages again on the next call after the cooldown.",
  },
  {
    key: "stale_phone_invite:*",
    kind: "incident",
    suffix: "booking",
    why: "One correction's invite patch failed and nothing re-reads that event, so there is no healthy state to observe; the booking itself is already correct.",
  },
  {
    key: "phone_correction_unsent:*",
    kind: "incident",
    suffix: "booking",
    why:
      "One correction's booking.contact_updated could not be recorded, so nothing retries it; the " +
      "booking itself is correct and no later run re-reads that correction, so there is no healthy " +
      "state to observe (#1512).",
  },
  {
    key: "bookable_trait_unrecorded:*",
    kind: "incident",
    suffix: "bounded",
    why:
      "One agent's change of bookable state was saved and the delivery that tells Regal was never " +
      "recorded, so nothing retries it; there is no healthy state to observe, because the next " +
      "change to that agent records its own trait and the backfill repairs this one (#2085).",
  },
  {
    key: "sign_in_google_account_mismatch:*",
    kind: "incident",
    suffix: "bounded",
    why:
      "One sign in was refused because its Google account is not the one the Slate account belongs to, " +
      "and nothing was handed over, so the event is over when the page is sent. There is no healthy " +
      "state to observe: the next sign in by the right account simply works, and an admin relinking a " +
      "rehire (Link a new Google account, on their page) is a decision, not a recovery (#3526).",
  },
  {
    key: "webhook_dead:*",
    kind: "condition",
    suffix: "bounded",
    why: "An endpoint is dead-lettering every delivery; a delivery that succeeds ends it.",
  },
  {
    key: "booking_below_lead_tier:*",
    kind: "incident",
    suffix: "booking",
    why:
      "One upcoming call is with a team below the tier Salesforce gives the lead " +
      "today (#2593). The page asks for one action on one call, and whoever " +
      "reassigns it already knows it is done, so an all clear per booking was noise " +
      "(Dan, 2026-10-07). The monitor still re-measures every tick and settles the " +
      "state SILENTLY once the call agrees or is gone, keeping the booking's hold. " +
      "It posts once per booking and never again, whatever changes and even after the " +
      "call comes right and goes wrong again (`CHANGE_ONLY_KEYS`, Dan 2026-10-26).",
  },
  {
    key: "cross_system_booking:*",
    kind: "condition",
    suffix: "booking",
    why:
      "One lead holds an upcoming call in Slate and another in cal.com; it ends when " +
      "either call is cancelled or its time comes, re-measured hourly against both " +
      "systems, and is closed when cal.com is marked retired (#2933).",
  },
  {
    key: "empty_tier:*",
    kind: "condition",
    suffix: "bounded",
    why: "A debt tier is offering no booking time on any of the days the booker shows (#3559), and stays that way until somebody is staffed onto it or its agents free up; the monitor re-measures every tick.",
  },
  {
    key: "outbox_drain_stuck",
    kind: "condition",
    why: "Outbox rows are backing off past the attempt cap until they drain; the sweep re-measures.",
  },
  {
    key: "outbox_all_handed_off",
    kind: "condition",
    why:
      "The drain is standing every row it leases down, so nothing is being delivered and no row " +
      "is being charged an attempt; a tick that completes a row ends it.",
  },
  {
    key: "reservation_drain_stuck",
    kind: "condition",
    why: "Reservations are backing off past the attempt cap until they drain; the sweep re-measures.",
  },
  {
    key: "reservation_created_owed",
    kind: "condition",
    why:
      "Bookings committed over a day ago are still owed booking.created and retention is keeping " +
      "their reservations (#3847) until somebody sends it or removes them; every retention sweep re-measures.",
  },
  {
    key: "pending_event_deletions",
    kind: "condition",
    why: "Calendar deletions are stuck failing until they succeed or are cleared; the sweep re-measures.",
  },
  {
    key: "inactive_agent_bookings",
    kind: "condition",
    why: "Customers hold appointments with an agent who has left the pool that no coverage sweep has picked up, until someone reassigns them; a call a sweep holds is left to coverage_needs_human. The monitor lane re-measures every 5 minutes.",
  },
  {
    key: "booking_buffer_breach",
    kind: "condition",
    why: "Two upcoming calls on one advisor sit closer than the call type's buffer, and neither was stacked there on purpose (#3040). It stays true until one call of each pair is moved, cancelled or passes, and the monitor lane re-measures every 5 minutes.",
  },
  {
    key: "demoted_agent_bookings",
    kind: "condition",
    why:
      "A customer holds an appointment with an agent moved off the pool it needs, and the automatic " +
      "reroute could not move it, until it is moved, reassigned or has passed; the monitor lane " +
      "re-measures every 5 minutes. Each call is named once, new ones at most every 3 hours unless " +
      "one starts sooner, and never as a reminder; the all clear still posts (`CHANGE_ONLY_KEYS`, " +
      "Dan 2026-10-26).",
  },
  {
    key: "ooo_protection_lost",
    kind: "condition",
    why: "An approved time off has stopped blocking its window, so a lead can be booked into hours the agent is away. It stays true until someone retries the calendar updates, and the monitor lane re-measures every 5 minutes.",
  },
  {
    key: "ooo_event_mismatch:*",
    kind: "condition",
    // The suffix is the agent's user id, so the family is bounded by the roster.
    suffix: "bounded",
    why:
      "An agent's Google Calendar no longer matches an approved time off (#3360). Slate " +
      "keeps blocking the approved window meanwhile, and only a person can say which side " +
      "is right. The agent and then their manager are told first, by Slack DM; this pages " +
      "only once neither has fixed it, or nobody else could be told (#3372). It stays true until somebody makes the request and the event agree, or " +
      "the request is changed or cancelled, or its window passes; the monitor lane " +
      "re-measures every 5 minutes and is the only place it clears.",
  },
  {
    key: "coverage_needs_human",
    kind: "condition",
    why: "A coverage sweep gave up on appointments that are still with an absent agent; they stay stranded until a person places them or they pass, and the monitor lane re-measures every 5 minutes.",
  },
  {
    key: "ooo_coverage_gap",
    kind: "condition",
    why: "An agent on approved time off is holding an appointment inside 48 hours that no coverage sweep ever saw, so that customer is booked with someone who will not be there. It stays true until a person places it or it passes, and the monitor lane re-measures every 5 minutes.",
  },
  {
    key: "calendar_window_uncovered",
    kind: "condition",
    why: "A bookable agent's calendar is no longer refreshed far enough ahead to cover the days the booker offers, so a lead can book an hour that calendar already has taken. It stays true until the refresh rotation reaches the calendar again, and the monitor lane re-measures every 5 minutes.",
  },
  {
    key: "busy_cache_drift",
    kind: "condition",
    why: "An agent's Google calendar has held busy time for at least 30 minutes that the busy cache still lacks, so the booker can offer a time that agent already has taken (#1591). It stays true until the sync picks the time up, and the sampler re-measures every 5 minutes; it clears after a full pass of the roster with every calendar read and none drifting.",
  },
  {
    key: "ooo_calcom",
    kind: "condition",
    why:
      "An approved absence is missing its cal.com block, so that agent stays " +
      "bookable while away; the retry sweep lands the override and re-measures it " +
      "every monitor tick (#1280). It was an incident until that sweep existed.",
  },
  {
    key: "booking_reminders_failing",
    kind: "condition",
    why: "A SHARE of the reminder emails in a rolling window did not go out, which is a broken send path rather than one lead's address: a refused mailbox delegation or a Gmail outage goes on costing every lead their reminder until somebody repairs it. Its sibling `booking_reminder_failed` is the incident about one booking and rightly has no recovery; this one has a healthy state to observe, and the reader who was paged about a wave needs to know when the wave ended (#2496).",
  },
  {
    key: "reminder_email_unrenderable:*",
    kind: "condition",
    suffix: "bounded",
    why:
      "An enabled reminder email's stored subject or body holds something Slate cannot fill in, so it is " +
      "sent to nobody and every lead due it goes without it (#4298). It holds until the words are fixed or " +
      "the email is switched off, and the reminder lane re-renders every enabled email every 5 minutes; the " +
      "all clear goes out on a tick that rendered it, or in its own words once it is switched off. The suffix " +
      "is the email's slug, a handful of rows an admin creates one at a time.",
  },
  {
    key: "reminder_email_owed:*",
    kind: "condition",
    suffix: "bounded",
    why:
      "A switched on reminder email is owed to leads whose calls are still ahead, its window opened over 15 " +
      "minutes ago, and the lane has recorded nothing for them (no send, no skip with its reason, no failure), " +
      "or it claimed one over 15 minutes ago that never settled (#4300). It holds while any such call is " +
      "still ahead and the monitor lane re-reads every 5 minutes; the all clear goes out on a measured read " +
      "that finds none owed, or in its own words once the email is switched off or removed. The suffix is the " +
      "email's slug, a handful of rows an admin creates one at a time.",
  },
  {
    key: "reminder_email_failing:*",
    kind: "condition",
    suffix: "bounded",
    why:
      "One reminder email's OWN sends are failing over the rolling window (a share past the threshold, or every " +
      "one of at least three failing), which the combined `booking_reminders_failing` share cannot see when " +
      "that email is small beside the others (#4300). It holds until its sends go out again, which the " +
      "reminder lane measures every 5 minutes, or ends in its own words once the email is switched off. The " +
      "suffix is the email's slug, a handful of rows.",
  },
  {
    key: "placeholder_call_unserved:*",
    kind: "condition",
    suffix: "booking",
    why:
      "A call on the placeholder advisor is past its booked end plus 15 minutes and Regal's call feed, " +
      "alive past that time, has no call to the customer's Lead (#4206). It ends when a call to them " +
      "arrives (the recovery), or in its own words when the call is cancelled, moved onto a real advisor " +
      "or moved to a later time, and as a stand down three days after the booked start, before the per " +
      "booking prune would remove it silently. The monitor lane re-judges it every 5 minutes.",
  },
  {
    key: "placeholder_seat_failing",
    kind: "condition",
    why:
      "The placeholder advisor's Google Calendar or Gmail sending is failing while the seat is in use, " +
      "so the invites and reminders of the calls placed on it may not go out (#4206), or its standing " +
      "Gmail auto reply is off, restricted or no longer the decided text (#4265). It ends when every " +
      "probe answers on a measured tick, or as a stand down when the switch is off and no call sits on it.",
  },
  {
    key: "placeholder_missing",
    kind: "condition",
    why:
      "Placing calls on the placeholder is switched on and no usable placeholder advisor exists, so every " +
      "customer a coordinator books while nobody is free is refused (#4206). It ends when one exists again, " +
      "or, worded as a suppression, when the switch is turned off.",
  },
  {
    key: "ooo_calcom_unprotected",
    kind: "condition",
    why: "An agent is on approved time off right now with no cal.com block in place, so cal.com can still book them while they are away; it stays true until a retry lands the override or the absence ends, and the monitor lane re-measures every 5 minutes.",
  },

  // --- Incidents: a finished event, with no healthy state to announce -------
  //
  // The test for every entry below is the same question: if this cleared, what
  // would the all-clear SAY? "The thing that already happened has stopped
  // happening" is not information, and a notice that says it trains people to
  // skim the channel.
  {
    key: "cron_lane_failed:*",
    kind: "incident",
    suffix: "bounded",
    why:
      "One scheduled run of a cron lane threw or answered non-ok. The run is over and the " +
      "next tick is its own attempt; announcing that it ended would cost a read on every " +
      "healthy tick of every lane, and a lane that stays down is reported by its heartbeat " +
      "watchdog. The suffix is mapped onto the scheduled lanes, with anything else as other (#3133). " +
      "Sent only when the lane raised no alert of its own about the failure, so a failure is one " +
      "message, never two (Dan, 2026-10-03).",
  },
  {
    key: "booking_reminder_failed:*",
    kind: "incident",
    suffix: "booking",
    why:
      "That lead's reminder email (the text names it; the 24 hour email's key is the bare booking id, the 1 hour email's ends in :hour, #4282, and any other email's in :<slug>, #4298) did not go out, or may not have, and nothing is set to send it: " +
      "it was too close to the call to try again, Google refused it, Slate could not build it, the " +
      "send cannot say whether Gmail accepted it (a retry could deliver a second copy), or handing " +
      "it back for a retry could not be confirmed. A send that provably did not go out while the " +
      "call is far enough away for the retry to land in time is retried instead and never pages. There is no healthy state to announce, only a call somebody was not reminded " +
      "about (#2359). Keyed per booking, so one lost reminder cannot hold back another's page " +
      "(2026-10-05).",
  },
  {
    key: "busy_block_write_through",
    kind: "incident",
    why: "One cache write failed and the moment has passed; the next sync pass reconverges without a state to announce.",
  },
  {
    key: "booking_event_insert",
    kind: "incident",
    why: "One history row was lost. Nothing later restores it, so there is nothing to clear.",
  },
  {
    key: "audit_write_failed",
    kind: "incident",
    why: "One audit-trail row was lost, and the action it described has already committed. Nothing backfills it, so there is no healthy state to observe and an all-clear would only say the past stopped happening. recordAudit is called per action, not from a lane, so there is no measured sweep to hang a recovery on either.",
  },
  {
    key: "creation_orphan_events",
    kind: "incident",
    why: "Specific calendar events outlived their booking; each is resolved by hand, not by a state flipping back.",
  },
  {
    key: "pending_event_deletions_refused",
    kind: "incident",
    why: "The drain has STOPPED retrying the named deletions because Google refused the calendar for good (gone, or never given Calendar), so nothing observes them again: the rows sit at the give-up count and only a person re-authenticating, removing or provisioning the account changes anything. Distinct from pending_event_deletions, whose stuck rows are still being retried and whose remedy is API health (#2577). Sent only for an owner who is still active, or one Slate could not read; a departed owner's refusals are pending_event_deletions_departed (#1630).",
  },
  {
    key: "reconcile_busy_blocks",
    kind: "incident",
    why: "The sweep already fixed the rows it names; the alert reports work done, not a fault still running.",
  },
  {
    key: "reconcile_missing_busy_blocks",
    kind: "incident",
    why: "Same: it reports slots already re-created, so there is no open state to clear.",
  },
  {
    key: "reschedule_pin_dropped",
    kind: "incident",
    why: "Named bookings did not move and never will on their own; a human re-runs them.",
  },
  {
    // #3924: a crashed in place reschedule left the lead's invite out of step and the
    // abandoned pin sweep could not put it back. The suffix is the booking id and the
    // crashed move's target, so each crashed move posts once.
    key: "reschedule_invite_stranded:*",
    kind: "incident",
    suffix: "booking",
    why: "One crashed move of one booking's invite, which the sweep tried once and could not put back. The sweep frees the lock and never sees it again, and a person moving the call or having the advisor put the invite back is nothing Slate observes, so there is no healthy state to announce.",
  },
  {
    key: "reassign_intent_dropped",
    kind: "incident",
    why: "Named bookings stayed on the original agent; a human re-runs the reassignment.",
  },
  {
    key: "ooo_approvals_digest",
    kind: "incident",
    why: "One day's email failed to send; that send is over and tomorrow's is a separate attempt.",
  },
  {
    key: "booking_offsite_origin:*",
    kind: "incident",
    suffix: "booking",
    why: "One real booking was already made from a host page that is not the production site, and its reminder texts and call task have already gone out. A person cancels it or confirms the lead is real; nothing turns an off site booking into an on site one, so there is no healthy state to announce (#2715).",
  },
  {
    // #3919: an advisor moved a booking's invite in Google Calendar and it was LEFT
    // (a second move, or inside 30 minutes), or Google refused putting it back, or it
    // was put back but the advisor could not be told, or (#3925) a first move was
    // found on a full read of the calendar and reported rather than put back. The
    // suffix is the booking id and the move number, so each move posts once.
    key: "booking_invite_moved:*",
    kind: "incident",
    suffix: "booking",
    why: "One advisor edit of one booking's invite, already handled as far as Slate can: a person moves the call, reassigns it or has the advisor put the invite back, and the next edit is a separate move with its own key. Nothing Slate observes says the person has finished, so there is no healthy state to announce.",
  },
  {
    // #3919: an out of step invite whose check failed (a read refused).
    key: "booking_invite_check_failed:*",
    kind: "incident",
    suffix: "booking",
    why: "One sync pass could not check one booking's changed invite; the invite stays blocked at both times and the next change to it is checked afresh, so there is no state to observe recovering, only the next check.",
  },
  {
    // #3919, decision 1: an end only change, posted so its frequency can be seen.
    key: "booking_invite_resized:*",
    kind: "incident",
    suffix: "booking",
    why: "One advisor changed when one booking's invite ends; Slate leaves it and blocks the time, and nothing needs doing, so there is nothing to clear. Each new end is its own key.",
  },
  {
    // #3919, decision 9: the one launch sweep's report.
    key: "booking_invite_launch_sweep",
    kind: "incident",
    why: "Sent once, by a hand run sweep at launch, listing the invites already out of step; each is handled by a person and the sweep is not run again, so there is no healthy state to announce.",
  },
  {
    key: "call_me_now_failed",
    kind: "incident",
    why: "A lead pressed Call me now and Salesforce failed before the lead was marked for a call (#3718). The lead was already shown the failure and the times to book; whether somebody calls them is a person's decision, and nothing Slate observes afterwards turns that press into a call, so there is no healthy state to announce.",
  },
  {
    key: "call_me_now_hidden",
    kind: "incident",
    why: "The check that shows the Call me now button failed, so it was hidden for a lead who could still book a time (#3718). Its own key so it never silences a press page. Each check is a finished event: the next one reads Salesforce afresh, and a successful check is not evidence anybody missed the button, so there is no all clear worth sending.",
  },
  {
    key: "retired_booking_key:*",
    kind: "incident",
    suffix: "bounded",
    why: "A request presented a retired booking key and was already refused (#2879). Nothing Slate observes can say the holder has stopped: a caller given its own key simply stops presenting the old one, and silence is also what a caller that gave up looks like, so there is no healthy state to announce. The suffix is the retired key's configured label plus one of the four host kinds, so a second retired key from the same kind of host is never silenced behind the first; neither part is text from the request.",
  },
  {
    key: "csp_violation:*",
    kind: "incident",
    suffix: "bounded",
    why: "A browser already refused something on one page load under the enforced content security policy (#2575). Silence afterwards cannot say the cause is gone, since it is also what a page nobody opened looks like, so there is no healthy state to announce. The suffix is the violated directive mapped onto the policy's own directive list plus other, never text from the report.",
  },
  {
    key: "misroute:*",
    kind: "incident",
    suffix: "bounded",
    why: "One booking already went to a non-matching agent; the booking cannot un-happen.",
  },
  {
    key: "internal_error:*",
    kind: "incident",
    // A server route's own context, or `client_error:<surface>` where the surface
    // is Slate's route list plus `other` (#2755), never text from the request.
    suffix: "bounded",
    why:
      "One request already returned a 500, or one browser already reported an error from a page (#2788); there is " +
      "no ongoing state, and the next request or page load is unrelated.",
  },
  {
    key: "boundary_error:*",
    kind: "incident",
    // The surface, from Slate's route list plus `other` (#2755).
    suffix: "bounded",
    why:
      "People already met the error screen on loads that have finished. There is no state that CLEARS: the next load " +
      "either renders or does not, and it reports for itself, counted against its own window. An all-clear here would " +
      "say the screens somebody already saw have stopped having been seen, which is the test this classification " +
      "turns on (#1974).",
  },
  {
    key: "opaque_script_errors:*",
    kind: "incident",
    // The surface, from Slate's route list plus `other` (#2755).
    suffix: "bounded",
    why:
      "Browsers at several different addresses already reported a script error with every detail hidden, on loads " +
      "that have finished (#3323). There is no state that CLEARS: the all clear would have to say no browser has " +
      "reported one since, which is also exactly what a quiet hour with nobody on the page looks like, so it would " +
      "announce something nobody measured. The next burst is counted against its own window and pages for itself.",
  },
  {
    key: "rr_ordering_degraded",
    kind: "incident",
    why: "One assignment may not reflect fair share; that booking is made and the next is judged on its own.",
  },
  {
    key: "verify_on_book_calendars_read",
    kind: "incident",
    why: "One agent was skipped for one slot; the booking path re-decides per attempt and holds no state.",
  },
  {
    key: "verify_on_book_outage",
    kind: "incident",
    why: "One booking attempt could not verify and was refused; the next attempt is judged on its own.",
  },
  {
    key: "reschedule_lock_outage",
    kind: "incident",
    why: "One reschedule could not take its lock; the next attempt is judged on its own.",
  },
  {
    key: "no_eligible_agents:*",
    kind: "incident",
    suffix: "bounded",
    why: "One booking attempt found no agent. It is kept apart from the ongoing empty_tier:* deliberately: that one asks whether a whole DEBT TIER can serve a lead, and this one is a single bucket refusing a single attempt, which happens while the tier around it is healthy.",
  },
  {
    key: "tier_fallback_deep:*",
    kind: "incident",
    suffix: "bounded",
    why: "Same, for a deep fallback: it describes one completed routing decision.",
  },
  {
    key: "booker_unstaffed:*",
    kind: "incident",
    suffix: "bounded",
    why: "One customer opened an unstaffed bucket and was shown nothing; that visit is over and they have gone. There is no ongoing twin for this one bucket: empty_tier:* watches the whole DEBT TIER, which can be perfectly healthy while one bucket inside it is empty, and that is the muting #2505 was opened for.",
  },
  {
    key: "booking_window_extended:*",
    kind: "incident",
    suffix: "bounded",
    why: "One customer on this bucket was offered times past the window of offered open days (the stored setting on the Hours page, #3922) because every tier their cascade may use was full (#2841). They were still offered times, so it is not the dead end booker_unstaffed reports. It records a visit that is over; what to look at is the staffing depth, which /admin/tiers shows.",
  },
  {
    // The suffix is the agent id, or for an advisor the calendar refused pool exit
    // took out (#3700) the agent id and the refusal reason, so each reason is said
    // once per episode. Bounded either way: the reasons are a fixed list.
    key: "bookable_blocked:*",
    kind: "incident",
    suffix: "bounded",
    why: "One activation attempt was refused; the operator retries and the refusal has no ongoing state.",
  },
  {
    // #3700. The suffix is the advisor's user id.
    key: "refused_advisor_left_pool:*",
    kind: "incident",
    suffix: "bounded",
    why:
      "Slate took one advisor out of the pool because Google refused their calendar for the whole " +
      "period; the removal is done, and the wait for their return is the pending activation's own " +
      "state (retried hourly, named by agents_awaiting_activation past its grace), so an all clear " +
      "here would say nothing.",
  },
  {
    key: "bookable_unverified:*",
    kind: "incident",
    suffix: "bounded",
    why: "Same: one activation attempt could not be verified.",
  },
  {
    key: "rate_limit_blocked:*",
    kind: "incident",
    suffix: "bounded",
    why: "A caller was throttled in one window; windows expire on their own and carry no state to clear.",
  },
  {
    key: "rate_limit_unidentified:*",
    kind: "incident",
    suffix: "bounded",
    why:
      "One request arrived with no client address, so a ceiling either did not apply to it or turned it away. It names requests already handled; there is no healthy state to observe, because a limiter reading addresses normally calls nothing. If it becomes an ongoing state, it belongs in its own key rather than folded in here.",
  },
  {
    key: "rate_limit_broken:*",
    kind: "incident",
    suffix: "bounded",
    // Still an incident, and #1529 asked whether it should be a condition. It should not,
    // but only because the ONGOING state was given its own key rather than folded in here.
    // This key reports a fail-open on specific requests already served, per IP and per
    // datacenter, and one colo having a bad minute is a finished event with no healthy
    // state to observe: the limiter succeeding does not call anything, and making it do so
    // would put a database round-trip on the booker's hot path, which is exactly what the
    // edge limiter exists to avoid. So the durable half lives in edge_limiter_unusable,
    // which the monitor lane measures once a minute and CAN clear.
    //
    // #3670: and it no longer pages on ONE request. A single failed count is a log line;
    // the page needs LIMITER_FAIL_OPEN_PAGE_AFTER in one area inside
    // LIMITER_FAIL_OPEN_WINDOW_MS on one isolate, and says that count, never that the limit
    // "has stopped working right now", which only the condition measures.
    why: "A run of requests in one area failed open on one server inside a window, all already served; a later request simply works. The ongoing state, a limiter that is unusable in the running deployment, is a separate condition (edge_limiter_unusable) that resolves.",
  },
  {
    key: "confirm_line_unreachable",
    kind: "incident",
    // #3325. An incident, for the same reason rate_limit_broken is one: it names confirms
    // already served that fell back to their isolate's own line, and a fallback is
    // always safe (the bookings indexes and verify on book still decide). A later
    // confirm reaching the shared line again calls nothing that could clear it, and
    // making it do so would put a database write on every confirm during the outage.
    why: "Confirms already served fell back to their own server's line, which is always safe; the next confirm tries the shared line again by itself, so there is no healthy state for an all clear to observe.",
  },
  {
    key: "shared_line_switch_unreadable",
    kind: "incident",
    // #3339. An incident for confirm_line_unreachable's reason: it names reads already
    // answered (with the last value read, or the deployment default), and a later read
    // that works calls nothing that could clear it without a database write on the
    // confirm path. The ongoing state, a switch nobody can read, is the monitor lane's own
    // read of it every tick, whose failure pages monitor_step_failing with an all clear.
    why: "A run of reads of the shared confirm line switch failed on one server inside a window, each already answered with the last value read or the deployment default; the next read simply tries again, so there is no healthy state for an all clear to observe.",
  },
  {
    key: "rate_limit_refund_broken:*",
    kind: "incident",
    suffix: "bounded",
    // #3670: paged on the same sustained run as rate_limit_broken, never on one refund.
    why: "A run of refunds of counted hits failed on one server inside a window; each counted window expires regardless.",
  },
  {
    key: "ooo_agent_calendar",
    kind: "incident",
    why: "One time-off calendar write failed; the request is already decided and a human fixes that entry.",
  },
  {
    key: "ooo_manager_calendar",
    kind: "incident",
    why: "Same, for the manager's copy of one entry.",
  },
  {
    key: "ooo_calendar_create",
    kind: "incident",
    why: "One time-off event could not be created; that approval has passed.",
  },
  {
    key: "ooo_agent_dm",
    kind: "incident",
    why: "One decision DM did not reach one agent; the message is not resent by any state change.",
  },
  {
    key: "ooo_busy_block_fallback",
    kind: "condition",
    why:
      "An approved time off is being blocked by a Slate written busy block alone, " +
      "with no event on the agent's own calendar, so its protection rests on one " +
      "cached row (#1464). It ends when that event is created or the window passes, " +
      "and the monitor lane clears it off a measured read (#1470).",
  },
  {
    key: "ooo_calcom_stale_unrecorded:*",
    kind: "incident",
    // The suffix is the agent's user id, so the family is bounded by the roster.
    suffix: "bounded",
    why:
      "A time off was cancelled or changed while cal.com was retired and the block " +
      "cal.com still holds for its old dates could not be recorded (#2890). Nothing " +
      "records that window, so no later state can show the block gone: a person " +
      "removes it in cal.com by hand if cal.com is put back.",
  },
  {
    key: "ooo_undo",
    kind: "incident",
    why: "One undo of a time-off decision failed and needs a human; nothing re-attempts it.",
  },
  {
    key: "ooo_undo_unchecked:*",
    kind: "incident",
    // The suffix is the agent's user id, so the family is bounded by the roster.
    suffix: "bounded",
    why:
      "An undo could not read a calendar back for a time off event whose create was " +
      "never confirmed (#3660). The request is already closed and nothing looks again, " +
      "so there is no healthy state to observe: a person checks that calendar by hand.",
  },
  {
    key: "ooo_coverage_stop",
    kind: "incident",
    why:
      "One cancelled or narrowed time off could not have its coverage sweep stopped " +
      "(#1665). The request is already closed and nothing re-attempts it, so there is no " +
      "healthy state to observe: a person opens the coverage panel and stops the rest.",
  },

  // --- Info: never needed action, so never announces recovery ---------------
  {
    key: "client_error_test_bucket",
    kind: "info",
    why:
      "A partner's page threw while on the public test bucket (#2660). The booking it " +
      "stopped was a test one and the page is the partner's to fix, so nobody is woken; the " +
      "full report is in the log. There is no all-clear worth sending: a working staging " +
      "page sends no report at all, and absence of reports is the healthy state.",
  },
  {
    key: "db_saturation_warn",
    kind: "info",
    why:
      "The database's committed memory is elevated but not yet critical (#3588), an early " +
      "warning so somebody can scale proactively. Nothing is broken for leads at this level, so " +
      "nobody is woken, and there is no all-clear worth sending: a healthy database simply stops " +
      "whispering, and absence of the whisper is the healthy state. The critical page (db_saturation) " +
      "is the one that resolves.",
  },
  {
    key: "reminder_emails_all_off",
    kind: "info",
    why:
      "No stored reminder email is switched on, so the reminder lane sends no lead anything before their " +
      "call (#4298). Switching them all off is an admin's decision rather than a fault, so nobody is woken; " +
      "it is said once a day so a decision nobody meant does not go unnoticed, and it never resolves because " +
      "it never claimed anything was broken.",
  },
  {
    key: "cron_cpu_not_configured",
    kind: "info",
    why:
      "The Worker has no CF_ANALYTICS_TOKEN, so cron CPU is not measured (#3141). The token is " +
      "optional and setting it is a decision, not a fault, so nobody is woken; the line says so " +
      "daily rather than leaving the missing check silent, and it never resolves because it never " +
      "claimed anything was wrong.",
  },
  {
    key: "embed_origin_mismatch",
    kind: "info",
    why:
      "An embedding host declared a different origin from the one that framed the " +
      "booker (#2641), so the browser drops the resize and the success message on that " +
      "page. Bookings still complete inside the embed, so nobody is woken, and the fix " +
      "is on the host's side. There is no all-clear worth sending: a correctly " +
      "configured host sends no report at all, and absence of reports is the healthy state.",
  },
  {
    key: "booking_race_contention",
    kind: "info",
    why:
      "The daily share of confirms that lost the overlap race (#2838), handed on to the next " +
      "advisor or refused, when it is above what the busiest measured traffic could produce. " +
      "Nobody has to act tonight: most of those leads were booked with somebody else in the " +
      "same bucket, and a lead refused at the reassign bound has its own page. There is no " +
      "condition to end either; ask what the all-clear would SAY and it is 'fewer leads collided today', " +
      "which is not news, so a day back under the share simply sends nothing.",
  },
  {
    key: "booking_race_bound_hit",
    kind: "incident",
    why:
      "One lead was refused after every advisor they were handed in a row was taken by other " +
      "confirms at the same moment (#2838). That lead has been asked to pick another time and " +
      "the moment is over; there is no healthy state to observe, and the next collision is " +
      "its own event.",
  },
  {
    // #2440. INFO: a weekly count of owner reassign notices not posted because no
    // handoff channel was set. The reassigns happened and are in booking_events; only
    // the courtesy notice is missing, and a handoff a person must act on already
    // pages while the channel is unset (handoff_channel_unset).
    key: "owner_notice_withheld",
    kind: "info",
    why:
      "The week's count of owner reassign notices that never reached the sales side " +
      "because no handoff channel was set (#2440), read off the withheld reason each " +
      "notice step records. Nothing is asked at once: the reassigns went through, and " +
      "a waiting handoff already pages. It is a count over a week that has passed, so " +
      "there is no state to end, and a week with none sends nothing.",
  },
  {
    key: "top_tier_cascade_rate",
    kind: "info",
    why:
      "The daily count of Ultra High and Very High leads taken by a lower tier (#2843), " +
      "which replaced the per booking tier_fallback pages for those leads. Sales ops " +
      "decided on 2026-09-28 that these leads are cascaded rather than booked days out " +
      "(as far as Medium, never to a Low carrier), so a cascade is the rule working and " +
      "nothing is asked of the reader. There is no condition to end: a day with no " +
      "cascade simply sends nothing.",
  },
  {
    key: "ooo_coverage_gap_later",
    kind: "info",
    why:
      "The same gap further out than 48 hours: real, and there is time to place it " +
      "from the coverage panel, so it is a once-a-day worklist rather than something " +
      "to act on tonight. Its page sibling owns the urgent half and clears on its own " +
      "measured zero; this half has nothing to end.",
  },
  {
    key: "pending_event_deletions_departed",
    kind: "info",
    why:
      "Google refused for good the calendar of somebody who has LEFT, so Slate cannot remove the old " +
      "invites the deletion drain was asked to delete (#1630). Offboarding revokes the licence, and Google " +
      "answers a revoked licence exactly as it answers one never granted, so this used to page a " +
      "provisioning request about a departed advisor. No account needs fixing and nobody can act on it, so " +
      "it is put on the record and wakes nobody. There is no condition to end either: the rows are settled " +
      "and stay as the record, and the all-clear would say only that the past stopped happening. An owner " +
      "still active, or one Slate could not read, keeps the pending_event_deletions_refused page.",
  },
  {
    key: "detector_parked",
    kind: "info",
    why:
      "Names the monitoring checks that are deliberately off because they cannot conclude before cutover; it is repeated so the missing cover stays visible, and there is no incident to end. Its page sibling, detector_unpark, owns the half that needs acting on.",
  },
  {
    key: "pool_nearly_full",
    kind: "info",
    why:
      "Fewer than the set share (10% by default) of a debt tier's possible starts across the days " +
      "the booker shows are still open (#1256, #3559, #3637): good news " +
      "and a nudge to add coverage, never something broken. The moment it reaches zero is " +
      "the booked solid page's, so this has nothing of its own to end.",
  },
  {
    key: "thin_tier_staffing",
    kind: "info",
    why:
      "A routing tier is resting on one or two bookable agents: worth knowing so " +
      "staffing can add coverage, never something to act on tonight.",
  },
  {
    key: "agents_without_schedule",
    kind: "info",
    why:
      "Bookable agents the automatic fill could not give working hours to; the " +
      "whisper names them so someone can, and nothing is broken meanwhile.",
  },
  {
    key: "agents_without_routing",
    kind: "info",
    why:
      "Bookable agents with no routing attributes, so no bucket criteria match them; " +
      "an admin adds the attributes, and there is no incident to end.",
  },
  {
    key: "fallback_covered_availability",
    kind: "info",
    why:
      "A tier ran dry and the configured fallback absorbed it, so customers were " +
      "served; it is recorded so the thinness is visible, not acted on.",
  },
  {
    key: "reassign-unknown-reason-code",
    kind: "info",
    why: "A caller sent an unrecognized reason code; recorded as a default and worth knowing, never worth acting on.",
  },
];

const BY_KEY = new Map(ALERT_CATALOG.map((e) => [e.key, e]));

/** The catalog entry for a key, or undefined when it is not classified. */
export function alertEntry(key: string): AlertEntry | undefined {
  return BY_KEY.get(key);
}

/** Keys of a given kind, for the guard and for tests. */
export function alertKeysOfKind(kind: AlertKind): string[] {
  return ALERT_CATALOG.filter((e) => e.kind === kind).map((e) => e.key);
}

/** The catalog entry a SENT key belongs to: its own, or its `prefix:*` family's (#3801). */
export function catalogEntryForSentKey(key: string): AlertEntry | undefined {
  const exact = BY_KEY.get(key);
  if (exact) return exact;
  for (let at = key.lastIndexOf(":"); at > 0; at = key.lastIndexOf(":", at - 1)) {
    const family = BY_KEY.get(`${key.slice(0, at)}:*`);
    if (family) return family;
  }
  return undefined;
}

/**
 * The kind of a key as SENT (#3801). `alertEntry` answers only an exact catalog key,
 * so a send key such as `empty_tier:low` needs this to find `empty_tier:*`. Undefined
 * for a key the catalog does not classify, which the dispatcher treats as having no
 * repeat rule at all, exactly as before #3801.
 */
export function alertKindOf(key: string): AlertKind | undefined {
  return catalogEntryForSentKey(key)?.kind;
}

/**
 * The URGENT conditions: the ones whose meaning is that leads are being lost or
 * turned away right now (#3801, Dan 2026-10-16). Every other condition posts again
 * once a day while unchanged; these keep an hourly repeat, because an hour of a live
 * outage is an hour of leads, and a reader who missed the first message should hear
 * it again inside the same hour. A change still posts at once for these too, exactly
 * as for every other condition.
 *
 * One named set rather than a flag at each send site, so the decision is visible in
 * one place and a send site cannot quietly opt itself in or out (L621).
 * `scripts/test-urgent-conditions.ts` holds every entry to existing in the catalog
 * above and being a condition.
 *
 * Derived from each entry's own `why` by that one criterion:
 *   - booking_failure_rate: bookings are failing right now.
 *   - booking_failure_volume: bookings are failing in volume right now (#3276).
 *   - public_booking_stopped: the kill switch is on, so every public lead is refused.
 *   - hydration_all_failing: named by Dan; the calendar refresh failing everywhere.
 *   - empty_tier:*: a debt tier is offering leads no time at all.
 *   - availability_booked_solid: every lead landing on that tier is turned away.
 *   - low_booking_volume, low_tier_volume:*, low_page_volume:*: customers have stopped
 *     getting through, overall, on one tier, or on one landing page.
 *   - booking_api_credential: every lead the booking API's caller sends is refused.
 *   - booking_api_ceiling: our own ceiling is turning that caller's leads away.
 *
 * `verify_on_book_outage` was named in the same decision and is NOT here: it is an
 * INCIDENT (one refused attempt), so it keeps its own fifteen minute throttle, which
 * is already faster than hourly, and the repeat rule never applies to it.
 */
export const URGENT_CONDITION_KEYS: readonly string[] = [
  "booking_failure_rate",
  "booking_failure_volume",
  "public_booking_stopped",
  "hydration_all_failing",
  "empty_tier:*",
  "availability_booked_solid",
  "low_booking_volume",
  "low_tier_volume:*",
  "low_page_volume:*",
  "booking_api_credential",
  "booking_api_ceiling",
];

const URGENT = new Set(URGENT_CONDITION_KEYS);

/** Whether a SENT key is an urgent condition, family members included. */
export function isUrgentCondition(key: string): boolean {
  const entry = catalogEntryForSentKey(key);
  return entry !== undefined && entry.kind === "condition" && URGENT.has(entry.key);
}

/**
 * The INCIDENTS (and the conditions in `CHANGE_ONLY_CONDITIONS`) that post once and then
 * again only on a change (Dan, 2026-10-26: "I
 * got a ton of this alert and they were all the same. Just page once per call."). A
 * key that names no subjects therefore posts once and never again, which is what the
 * below tier page now does (Dan, 2026-10-26: "a single ping about this per booking").
 *
 * An incident has no repeat rule of its own, so the dispatcher posts it again every
 * time its cooldown runs out. For a page about one call that stays wrong for days,
 * that is the same message every few hours. A key listed here gets #3801's change
 * rule instead, with no reminder at all: it posts when first seen, and again only
 * when its send site names a subject the last post did not (`AlertRepeat.subjects`).
 * What counts as a change is the send site's subject list, so the decision about
 * WHICH facts matter stays beside the copy that states them.
 *
 * One named set, like the urgent one above, so a send site cannot opt itself in or
 * out (L621). `scripts/test-change-only-alerts.ts` holds every entry to existing in
 * the catalog and being an incident, or a condition named in `CHANGE_ONLY_CONDITIONS`.
 *
 *   - booking_below_lead_tier:*: one call booked below the lead's tier. It names no
 *     subjects (`belowLeadTierRepeat`), so it posts once per booking and never again;
 *     a silent settle keeps its hold row for the same reason (`settleAlertsSilently`).
 *   - demoted_agent_bookings: one subject per stuck call, so each is named once; see
 *     `CHANGE_ONLY_CONDITIONS` below.
 */
export const CHANGE_ONLY_KEYS: readonly string[] = ["booking_below_lead_tier:*", "demoted_agent_bookings"];

/**
 * The CONDITIONS in `CHANGE_ONLY_KEYS`, each listed here because dropping a condition's
 * reminder is a decision about that alert, never a default. A condition in the set keeps its
 * all clear (the dispatcher's resolve is untouched); only the reminder goes.
 *
 *   - demoted_agent_bookings: calls the automatic reroute could not move off a demoted agent.
 *     Dan, 2026-10-26, after three posts in two hours that each listed every call again:
 *     "make it so that every call only pages once. i don't need an hourly update about this
 *     unless it resolves". Its subjects are one per call (`demotedAgentBookingsSend`), and new
 *     ones are collected for `changeBatchMs` (repeat-policy.ts).
 */
export const CHANGE_ONLY_CONDITIONS: readonly string[] = ["demoted_agent_bookings"];

const CHANGE_ONLY = new Set(CHANGE_ONLY_KEYS);
const CHANGE_ONLY_CONDITION = new Set(CHANGE_ONLY_CONDITIONS);

/** Whether a SENT key posts only on a change, family members included. */
export function isChangeOnly(key: string): boolean {
  const entry = catalogEntryForSentKey(key);
  if (entry === undefined || !CHANGE_ONLY.has(entry.key)) return false;
  return entry.kind === "incident" || (entry.kind === "condition" && CHANGE_ONLY_CONDITION.has(entry.key));
}
