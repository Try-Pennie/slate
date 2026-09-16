import type { WebhookEvent } from "@/lib/db/types";

/**
 * The webhook events Slate can emit, as VALUES, plus which of them are
 * deliberately not subscribed by anyone.
 *
 * #1459: `emitWebhook` delivers only to endpoints whose stored `events` array
 * contains the event. So adding a value to the `WebhookEvent` union ships an event
 * that is recorded as a delivery and sent to NOBODY, and nothing says so: no
 * failure, no alert, delivery rows that look normal. The only symptom is a
 * downstream system quietly never hearing about something (L120: a fan out that
 * matches zero recipients reports success; L46: a value written with no reader).
 *
 * The subscription lives in a database column that no code change touches, so the
 * two halves can only be compared by something that holds both. That is what this
 * module exists for: it is the events side, enumerated once.
 *
 * Two consumers, deliberately looking in different places, because neither can
 * see what the other does:
 *
 *  - `scripts/test-webhook-event-subscribers.ts` compares this list against the
 *    migration DEFAULT, so a new event cannot merge without either being added to
 *    the default that new endpoints get, or being declared below.
 *  - the monitor lane's subscriber-coverage check compares it against the LIVE
 *    endpoint rows, which is the only thing that can notice an existing endpoint
 *    was never updated. A migration default says nothing about the row that
 *    already exists, and the one live Regal endpoint predates every event added
 *    from here on.
 */

/**
 * Every event, keyed so the TYPE SYSTEM enforces completeness rather than a
 * reviewer noticing (L113): `Record<WebhookEvent, true>` fails `tsc` when a union
 * member is missing here, and equally when a key is not in the union. This is the
 * one place the list is written down.
 */
const EVENT_PRESENCE: Record<WebhookEvent, true> = {
  "booking.created": true,
  "booking.rescheduled": true,
  "booking.cancelled": true,
  "booking.reassigned": true,
  "booking.completed": true,
};

/** Every event Slate can emit. Order is the declaration order above. */
export const WEBHOOK_EVENTS = Object.keys(EVENT_PRESENCE) as WebhookEvent[];

/**
 * Events deliberately left unsubscribed, each with the reason and the issue that
 * will subscribe it.
 *
 * This is the escape hatch, in the shape the repo already uses for `// cap-safe:`
 * and `// error-ok:`: not a ban, a requirement to say why. An entry means "we know
 * this reaches nobody and that is the intended state for now", so both the build
 * guard and the monitor check stay quiet about it. Delete the entry in the change
 * that subscribes the event.
 *
 * An entry here is a debt with a name on it, never a way to silence the check: a
 * deliberately inert path needs the issue that activates it filed in the same
 * change (L65), which is what the issue reference is for.
 */
export const DELIBERATELY_UNSUBSCRIBED: Partial<Record<WebhookEvent, string>> = {
  // (empty: every event Slate emits is subscribed by the live endpoint)
};

/** The reason an event is deliberately unsubscribed, or null when it is not. */
export function deliberatelyUnsubscribedReason(event: string): string | null {
  return DELIBERATELY_UNSUBSCRIBED[event as WebhookEvent] ?? null;
}
