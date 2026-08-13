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

export interface AlertEntry {
  /** The key, or a `prefix:*` family. */
  key: string;
  kind: AlertKind;
  /** Why it is that kind. For an incident, what healthy state does NOT exist. */
  why: string;
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
    why: "The org advertises hours nobody is rostered for; a schedule or the business hours are edited and the monitor lane sees it on its next pass.",
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
    why: "A cron lane is not running; it stamps a heartbeat again and the watchdog can see it.",
  },
  {
    key: "completion_sweep_saturated",
    kind: "condition",
    why: "The completion sweep cannot drain its backlog; a tick under the cap ends it.",
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
    key: "snowflake_purge_sql_broken",
    kind: "condition",
    why: "The purge SQL stays broken until someone fixes it; the 6h probe re-runs it against the warehouse.",
  },
  {
    key: "agent_sync_failures",
    kind: "condition",
    why: "The Salesforce roster sync is failing on consecutive runs; a successful run ends it.",
  },
  {
    key: "availability_drift:*",
    kind: "condition",
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
    key: "booking_failure_rate",
    kind: "condition",
    why: "Customers are being turned away right now; it ends when bookings start completing again, and the monitor re-measures the window every 5 minutes.",
  },
  {
    key: "recompute_headroom",
    kind: "condition",
    why: "Recompute is falling behind its budget; a cycle that keeps up ends it.",
  },
  {
    key: "bucket_slots_stale",
    kind: "condition",
    why: "Cached slot rows are going stale; a cycle with none stale ends it.",
  },
  {
    key: "retention_skipped:*",
    kind: "condition",
    why: "Retention is STOPPED while the mirror is unusable; a run that proceeds ends it.",
  },
  {
    key: "ooo-digest-unreachable:*",
    kind: "condition",
    why: "A manager is not receiving their digest until their Slack DM works; the daily run re-measures.",
  },
  {
    key: "webhook_dead:*",
    kind: "condition",
    why: "An endpoint is dead-lettering every delivery; a delivery that succeeds ends it.",
  },
  {
    key: "empty_buckets:*",
    kind: "condition",
    why: "A bucket has no eligible agent until staffing changes; the monitor re-measures every tick.",
  },
  {
    key: "outbox_drain_stuck",
    kind: "condition",
    why: "Outbox rows are backing off past the attempt cap until they drain; the sweep re-measures.",
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
    key: "ooo_calcom",
    kind: "condition",
    why:
      "An approved absence is missing its cal.com block, so that agent stays " +
      "bookable while away; the retry sweep lands the override and re-measures it " +
      "every monitor tick (#1280). It was an incident until that sweep existed.",
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
    why: "Two specific bookings already overlap; a person reschedules one, and no code path observes that.",
  },
  {
    key: "misroute:*",
    kind: "incident",
    why: "One booking already went to a non-matching agent; the booking cannot un-happen.",
  },
  {
    key: "internal_error:*",
    kind: "incident",
    why: "One request already returned a 500; there is no ongoing state, and the next request is unrelated.",
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
    why: "One booking attempt found no agent. The ONGOING version of this is empty_buckets:*, which the monitor watches and does clear.",
  },
  {
    key: "tier_fallback:*",
    kind: "incident",
    why: "One booking fell back a tier; it is a routing breadcrumb about a booking already made.",
  },
  {
    key: "tier_fallback_deep:*",
    kind: "incident",
    why: "Same, for a deep fallback: it describes one completed routing decision.",
  },
  {
    key: "bookable_blocked:*",
    kind: "incident",
    why: "One activation attempt was refused; the operator retries and the refusal has no ongoing state.",
  },
  {
    key: "bookable_unverified:*",
    kind: "incident",
    why: "Same: one activation attempt could not be verified.",
  },
  {
    key: "rate_limit_blocked:*",
    kind: "incident",
    why: "A caller was throttled in one window; windows expire on their own and carry no state to clear.",
  },
  {
    key: "rate_limit_broken:*",
    kind: "incident",
    why: "The limiter failed open for specific requests already served; a later request simply works.",
  },
  {
    key: "rate_limit_refund_broken:*",
    kind: "incident",
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
    kind: "incident",
    why: "One approval fell back to a busy-block write; that approval is complete.",
  },
  {
    key: "ooo_undo",
    kind: "incident",
    why: "One undo of a time-off decision failed and needs a human; nothing re-attempts it.",
  },

  // --- Info: never needed action, so never announces recovery ---------------
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
