/**
 * The durable record of an owner reassign notice that was NOT posted (#2440).
 *
 * The notice (#2372) posts to `monitor_alert_config.handoff_channel`. With no channel
 * set the step completes without posting, on purpose: it must not page (the handoff
 * check owns "nothing to post to", #2367) and it must not retry for ever. Until #2440
 * the only trace was a `tag=owner-notice` log line, which Cloudflare keeps for seven
 * days, so after a blank channel stretch nobody could say which reassigns went
 * unannounced (L13).
 *
 * The record lives ON THE OUTBOX STEP, as a `withheld` reason beside its `done`
 * state, rather than in a new table or a new `booking_events` action:
 *
 *  - `booking_outbox.steps` is jsonb, so it needs no migration, and every outbox row
 *    is already one reassign, keyed the same way the notice's exactly once rule is.
 *  - Delivered rows are kept 30 days and pruned only once the Snowflake mirror holds
 *    them (prune-bookings-pii), so the weekly count always has its week, and the
 *    warehouse keeps the record past that.
 *  - The erasure function (migration 0093) nulls only a step's `error`, so a lead's
 *    erasure leaves the reason in place. It names no person.
 *
 * No `@/` imports, so the orchestration module and the monitor store both reach it.
 */

/** The outbox step the notice runs as. One constant for the step list, the handler
 *  and the count, so the count cannot ask about a step name nothing writes. */
export const OWNER_NOTICE_STEP = "reassign:owner_notice";

/** Why a notice was withheld. Three reasons, because they send a reader to three
 *  places: the alert settings page, the deployment's Slack token, or nowhere at all. */
export const OWNER_NOTICE_WITHHELD = {
  /** No handoff channel is set, so there was nowhere to post. */
  noChannel: "no_handoff_channel",
  /** This deployment holds no Slack bot token at all. */
  noSlack: "no_slack_token",
  /** An admin switched the notice off on /admin/alerts (migration 0188). Recorded
   *  for a person reading the row and never counted: the weekly report is about a
   *  notice somebody wanted and did not get, and this one nobody wanted. */
  switchedOff: "switched_off",
} as const;

export type OwnerNoticeWithheld = (typeof OWNER_NOTICE_WITHHELD)[keyof typeof OWNER_NOTICE_WITHHELD];
