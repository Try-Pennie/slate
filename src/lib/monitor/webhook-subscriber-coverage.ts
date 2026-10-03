/**
 * #1459: does every webhook event Slate can emit actually reach someone?
 *
 * `emitWebhook` delivers only to endpoints whose stored `events` array contains
 * the event. Zero matches is not an error: the map over the endpoint list is
 * empty, the call resolves, the outbox step is marked done, and the event is gone
 * with no failure, no alert, and delivery rows that look normal. So a value added
 * to the `WebhookEvent` union ships INERT, and stays inert until somebody
 * remembers a database update that lives nowhere in the repo (L120 on the sending
 * side, L46 on the reading side).
 *
 * This is the half that needs live data. `scripts/test-webhook-event-subscribers.ts`
 * compares the code's events against the migration DEFAULT, which is what a NEW
 * endpoint gets; it can say nothing about the endpoint that already exists, and
 * the one live Regal endpoint predates every event added from here on. Only a read
 * of the actual rows can tell.
 *
 * Fail-safe, and specifically NOT by guessing: an unreadable endpoint list reports
 * `measured: false`, which neither pages nor clears. Both of the tempting
 * fallbacks are defects. An empty list would say every event reaches nobody, which
 * pages falsely on a bad minute at PostgREST. "No findings" would say everything
 * is subscribed, which is the blindness the whole class is about (L11, L90).
 */

import { logAlertSendFailure, logResolveFailure } from "../notify/send-failure.ts";
import type { AlertResolve, ThrottledNotify } from "./alert-deps";

/** The columns this check needs off an ACTIVE endpoint row. */
export interface SubscriberEndpoint {
  url: string;
  events: string[];
}

export interface SubscriberCoverage {
  /**
   * Whether the endpoint list was actually read. False means the answer below is
   * "we could not tell", never "nothing is wrong".
   */
  measured: boolean;
  /** Events no active endpoint subscribes and nothing declares. */
  unsubscribed: string[];
  /** Events deliberately unsubscribed, reported rather than hidden. */
  declared: string[];
  /** How many active endpoints were read (0 is a real, measurable answer). */
  endpointCount: number;
}

/** alert_state key for the throttle, shared by the cron and the settings screen. */
export const WEBHOOK_SUBSCRIBERS_KEY = "webhook_event_no_subscriber";

/**
 * Which events reach nobody.
 *
 * `endpoints` is the ACTIVE endpoint rows, or null when the read failed. The
 * caller applies the `active` filter, so an empty array here genuinely means
 * nothing subscribes anything, which is a measurable finding and is reported as
 * one.
 */
export function subscriberCoverage(input: {
  events: string[];
  endpoints: SubscriberEndpoint[] | null;
  unsubscribedReason: (event: string) => string | null;
}): SubscriberCoverage {
  if (input.endpoints === null) {
    return { measured: false, unsubscribed: [], declared: [], endpointCount: 0 };
  }
  const subscribed = new Set<string>();
  for (const endpoint of input.endpoints) {
    for (const event of endpoint.events ?? []) subscribed.add(event);
  }
  const unsubscribed: string[] = [];
  const declared: string[] = [];
  for (const event of input.events) {
    if (subscribed.has(event)) continue;
    if (input.unsubscribedReason(event)) declared.push(event);
    else unsubscribed.push(event);
  }
  return {
    measured: true,
    unsubscribed,
    declared,
    endpointCount: input.endpoints.length,
  };
}

/**
 * The Slack text, or "" when there is nothing to say (covered, declared-only, or
 * unmeasured). Held as a pure builder so `pnpm preview:alerts` renders exactly
 * what ships rather than a second copy of the wording (L41).
 */
export function formatUnsubscribedEventsAlert(coverage: SubscriberCoverage): string {
  if (!coverage.measured || coverage.unsubscribed.length === 0) return "";
  const list = coverage.unsubscribed.join(", ");
  const subject =
    coverage.unsubscribed.length === 1
      ? `The booking event ${list} reaches nobody`
      : `${coverage.unsubscribed.length} booking events reach nobody: ${list}`;
  // Name the remedy, because the reader cannot act on the fact alone: the fix is a
  // row update, not a deploy, and nothing in the codebase will do it (L80, L111).
  // Each sentence is written out whole rather than glued from fragments, because
  // the singular and plural halves do not share a grammar and stitching them is
  // how "the one active endpoint will ever be told" gets shipped.
  const target = coverage.unsubscribed.length === 1 ? "it" : "them";
  let where: string;
  let remedy: string;
  if (coverage.endpointCount === 0) {
    where = "There are no active webhook endpoints at all, so no downstream system is receiving anything.";
    // With no endpoint to edit, "add the event to the endpoint" names an action
    // nobody can take, which leaves the reader exactly where they were (L111).
    remedy = "Add an active webhook endpoint, or check whether the existing one was deactivated.";
  } else {
    where =
      coverage.endpointCount === 1
        ? `The one active endpoint does not subscribe ${target}, so nothing will ever be delivered.`
        : `None of the ${coverage.endpointCount} active endpoints subscribe ${target}, so nothing will ever be delivered.`;
    const one = coverage.unsubscribed.length === 1;
    remedy =
      `Add ${one ? "the event" : "the events"} to the subscribed events of whichever endpoint ` +
      `should receive ${target} (the webhook_endpoints.events array), or declare ` +
      `${target} in DELIBERATELY_UNSUBSCRIBED (src/lib/webhooks/events.ts) with the issue ` +
      `that will subscribe ${target}.`;
  }
  return (
    `${subject}. ${where} Slate records the delivery and sends it to no one, which looks ` +
    `identical to a delivered event. ${remedy}`
  );
}

/**
 * The all-clear. A builder rather than a literal at the send site, so
 * `pnpm preview:alerts` renders the text that actually ships (L41).
 */
export function formatUnsubscribedEventsRecovery(): string {
  // Names Regal because it is the only endpoint today (Dan chose this over a
  // generic "a webhook endpoint", 2026-09-30); revisit if a second one is added.
  return "Resolved: every booking event is reaching Regal again.";
}

/**
 * The monitor-cron step. IO is injected so every branch, including the unreadable
 * one, is exercised offline.
 *
 * The all-clear hangs off a MEASURED healthy result, never off "we did not alert
 * this run" (#1134, #1152): a tick that could not read the endpoints clears
 * nothing, because it learned nothing.
 */
export async function runWebhookSubscriberCheck(deps: {
  events: string[];
  loadEndpoints: () => Promise<SubscriberEndpoint[] | null>;
  unsubscribedReason: (event: string) => string | null;
  notify: ThrottledNotify;
  // Promise<unknown>: resolveAlert reports whether it actually settled anything,
  // and this check does not branch on that, so the dep accepts either shape.
  resolve: AlertResolve<unknown>;
  cooldownMs: number;
  log?: (msg: string) => void;
}): Promise<SubscriberCoverage> {
  // A throwing read is the same case as one that returns null: unmeasured. It is
  // caught here rather than left to the step boundary so the check still returns a
  // typed verdict the lane can report, instead of the step's own fallback.
  const endpoints = await deps.loadEndpoints().catch(() => null);
  const coverage = subscriberCoverage({
    events: deps.events,
    endpoints,
    unsubscribedReason: deps.unsubscribedReason,
  });

  if (!coverage.measured) {
    deps.log?.("monitor webhook-subscribers: endpoints unreadable, no verdict this tick");
    return coverage;
  }
  if (coverage.unsubscribed.length > 0) {
    await deps
      .notify(WEBHOOK_SUBSCRIBERS_KEY, deps.cooldownMs, formatUnsubscribedEventsAlert(coverage))
      .catch(logAlertSendFailure(WEBHOOK_SUBSCRIBERS_KEY));
  } else {
    await deps
      .resolve(WEBHOOK_SUBSCRIBERS_KEY, formatUnsubscribedEventsRecovery())
      .catch(logResolveFailure(WEBHOOK_SUBSCRIBERS_KEY));
  }
  deps.log?.(
    `monitor webhook-subscribers: ${coverage.unsubscribed.length} unsubscribed, ` +
      `${coverage.declared.length} declared, ${coverage.endpointCount} active endpoint(s)`,
  );
  return coverage;
}
