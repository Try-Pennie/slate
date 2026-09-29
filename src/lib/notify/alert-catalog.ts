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
      "measures the step on every tick, so it ends when the step completes again (#2382).",
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
    key: "twilio_sync_failures",
    kind: "condition",
    why: "The roster sync cannot read Twilio, so the Redistribute tag is not being acted on; it stays true until a run reads Twilio successfully, which is the recovery.",
  },
  {
    key: "twilio_write_failures",
    kind: "condition",
    why: "The roster sync can read Twilio and cannot finish acting on it: a flip, a coverage move or a routing attribute write keeps throwing. It stays true until a run lands them all, which is the recovery.",
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
    key: "agents_awaiting_activation",
    kind: "condition",
    why:
      "Somebody the roster counts as working has sat outside the booking pool for " +
      "longer than the four hour grace; it ends when the activation succeeds or a " +
      "person decides either way, and the same lane sees it (#2318).",
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
    key: "booking_failure_rate",
    kind: "condition",
    why: "Customers are being turned away right now; it ends when bookings start completing again, and the monitor re-measures the window every 5 minutes.",
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
    key: "stale_phone_invite:*",
    kind: "incident",
    suffix: "booking",
    why: "One correction's invite patch failed and nothing re-reads that event, so there is no healthy state to observe; the booking itself is already correct.",
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
    key: "webhook_dead:*",
    kind: "condition",
    suffix: "bounded",
    why: "An endpoint is dead-lettering every delivery; a delivery that succeeds ends it.",
  },
  {
    key: "booking_below_lead_tier:*",
    kind: "condition",
    suffix: "booking",
    why:
      "One upcoming call is with a team below the tier Salesforce gives the lead " +
      "today; it ends when the call moves to a team that works the tier, the score " +
      "comes down, or the call is cancelled or its time passes, and the monitor " +
      "re-measures every booking every tick (#2593).",
  },
  {
    key: "empty_tier:*",
    kind: "condition",
    suffix: "bounded",
    why: "A debt tier is offering no booking time inside the next open business day, and stays that way until somebody is staffed onto it or its agents free up; the monitor re-measures every tick.",
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
    key: "pending_event_deletions",
    kind: "condition",
    why: "Calendar deletions are stuck failing until they succeed or are cleared; the sweep re-measures.",
  },
  {
    key: "inactive_agent_bookings",
    kind: "condition",
    why: "Customers hold appointments with an agent who has left the pool until someone reassigns them; the monitor lane re-measures every 5 minutes.",
  },
  {
    key: "ooo_protection_lost",
    kind: "condition",
    why: "An approved time off has stopped blocking its window, so a lead can be booked into hours the agent is away. It stays true until someone retries the calendar updates, and the monitor lane re-measures every 5 minutes.",
  },
  {
    key: "coverage_needs_human",
    kind: "condition",
    why: "A coverage sweep gave up on appointments that are still with an absent agent; they stay stranded until a person places them or they pass, and the monitor lane re-measures every 5 minutes.",
  },
  {
    key: "ooo_coverage_gap",
    kind: "condition",
    why: "An agent on approved time off is holding an appointment inside 48 hours that no coverage sweep ever saw, so that customer meets nobody. It stays true until a person places it or it passes, and the monitor lane re-measures every 5 minutes.",
  },
  {
    key: "calendar_window_uncovered",
    kind: "condition",
    why: "A bookable agent's calendar is no longer refreshed far enough ahead to cover the days the booker offers, so a lead can book an hour that calendar already has taken. It stays true until the refresh rotation reaches the calendar again, and the monitor lane re-measures every 5 minutes.",
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
    key: "booking_reminder_failed",
    kind: "incident",
    why: "That lead's 24 hour reminder did not go out and will not: the send is deliberately not retried, because a retry after a timeout can deliver a second copy. There is no healthy state to announce, only a call somebody was not reminded about (#2359).",
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
    why: "The drain has STOPPED retrying the named deletions because Google refused the calendar for good (gone, or never given Calendar), so nothing observes them again: the rows sit at the give-up count and only a person re-authenticating, removing or provisioning the account changes anything. Distinct from pending_event_deletions, whose stuck rows are still being retried and whose remedy is API health (#2577).",
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
    key: "external_double_book:*",
    kind: "incident",
    suffix: "bounded",
    why: "Two specific bookings already overlap; a person reschedules one, and no code path observes that.",
  },
  {
    key: "booking_offsite_origin:*",
    kind: "incident",
    suffix: "booking",
    why: "One real booking was already made from a host page that is not the production site, and its reminder texts and call task have already gone out. A person cancels it or confirms the lead is real; nothing turns an off site booking into an on site one, so there is no healthy state to announce (#2715).",
  },
  {
    key: "retired_booking_key:*",
    kind: "incident",
    suffix: "bounded",
    why: "A request presented a retired booking key and was already refused (#2879). Nothing Slate observes can say the holder has stopped: a caller given its own key simply stops presenting the old one, and silence is also what a caller that gave up looks like, so there is no healthy state to announce. The suffix is the retired key's configured label plus one of the four host kinds, so a second retired key from the same kind of host is never silenced behind the first; neither part is text from the request.",
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
    key: "tier_fallback:*",
    kind: "incident",
    suffix: "bounded",
    why: "One booking fell back a tier; it is a routing breadcrumb about a booking already made.",
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
    why: "One customer on this bucket was offered times past the offered window of open days (OFFERED_OPEN_DAYS) because every tier their cascade may use was full (#2841). They were still offered times, so it is not the dead end booker_unstaffed reports. It records a visit that is over; what to look at is the staffing depth, which /admin/tiers shows.",
  },
  {
    key: "bookable_blocked:*",
    kind: "incident",
    suffix: "bounded",
    why: "One activation attempt was refused; the operator retries and the refusal has no ongoing state.",
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
    why: "The limiter failed open for specific requests already served; a later request simply works. The ongoing state, a limiter that is unusable in the running deployment, is a separate condition (edge_limiter_unusable) that resolves.",
  },
  {
    key: "rate_limit_refund_broken:*",
    kind: "incident",
    suffix: "bounded",
    why: "One refund of a counted hit failed; the window expires regardless.",
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
    key: "ooo_undo",
    kind: "incident",
    why: "One undo of a time-off decision failed and needs a human; nothing re-attempts it.",
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
    key: "beyond_overflow_rate",
    kind: "info",
    why:
      "The daily count of Beyond leads taken by an Achieve agent (#2228), which " +
      "replaced the per booking tier_fallback_overflow page. Beyond is being retired " +
      "as a backend service (Dan, 2026-09-13), so a two person pool is what winding a " +
      "service down looks like and the overflow is the ladder working: nothing is " +
      "being asked of the reader, which is what makes it info rather than a page. " +
      "There is no condition to end either. Ask what the all-clear would SAY and the " +
      "answer is 'the expected thing stopped happening for a day', which is not news; " +
      "a day with no overflow simply sends nothing.",
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
    key: "detector_parked",
    kind: "info",
    why:
      "Names the monitoring checks that are deliberately off because they cannot conclude before cutover; it is repeated so the missing cover stays visible, and there is no incident to end. Its page sibling, detector_unpark, owns the half that needs acting on.",
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
