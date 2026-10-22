import type { WebhookEvent } from "@/lib/db/types";
import type { AgentWebhookEvent } from "./types.ts";

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
 * Which family an event belongs to (#2085). The family, not the endpoint's
 * format, is what decides the SHAPE of a delivery: a booking event and an agent
 * trait go to the same Regal endpoint with the same format and carry different
 * bodies, so dispatching on format would be the wrong axis.
 */
export type WebhookEventFamily = "booking" | "agent";

/**
 * Every event and its family, keyed so the TYPE SYSTEM enforces completeness
 * rather than a reviewer noticing (L113): the mapped type fails `tsc` when a union
 * member is missing here, when a key is not in the union, AND when a value does
 * not match the event's own prefix, so the runtime family and the type level one
 * (`BookingWebhookEvent`, `AgentWebhookEvent`) cannot disagree. This is the one
 * place the list is written down.
 */
const EVENT_FAMILY: {
  [E in WebhookEvent]: E extends `booking.${string}` ? "booking" : "agent";
} = {
  "booking.created": "booking",
  "booking.rescheduled": "booking",
  "booking.cancelled": "booking",
  "booking.reassigned": "booking",
  "booking.contact_updated": "booking",
  "agent.bookable_changed": "agent",
};

/** Every event Slate can emit. Order is the declaration order above. */
export const WEBHOOK_EVENTS = Object.keys(EVENT_FAMILY) as WebhookEvent[];

/**
 * Whether Slate still sends this event (#2915). A stored delivery can name an event
 * that has since been removed (`booking.completed`), and the column is plain text,
 * so the row's type says WebhookEvent while its value may not be one. Every send
 * path asks this before a POST.
 */
export function isEmittedEvent(event: string): event is WebhookEvent {
  return Object.prototype.hasOwnProperty.call(EVENT_FAMILY, event);
}

/**
 * The family of one event. Read by prefix for a removed event, so a delivery row
 * written before its event was retired still displays under the family it had.
 */
export function webhookEventFamily(event: WebhookEvent): WebhookEventFamily {
  return EVENT_FAMILY[event] ?? (String(event).startsWith("agent.") ? "agent" : "booking");
}

/** Narrowing form of the family, for the code that builds or refreshes a body. */
export function isAgentEvent(event: WebhookEvent): event is AgentWebhookEvent {
  return webhookEventFamily(event) === "agent";
}

/**
 * Events deliberately left unsubscribed, each with the reason and the issue that
 * will subscribe it.
 *
 * This is the escape hatch, in the shape the repo already uses for `// cap-safe:`
 * and `// error-ok:`: not a ban, a requirement to say why. An entry means "we know
 * this reaches nobody, and the issue named here is what changes that", so both the build
 * guard and the monitor check stay quiet about it. Delete the entry in the change
 * that subscribes the event.
 *
 * An entry here is a debt with a name on it, never a way to silence the check: a
 * deliberately inert path needs the issue that activates it filed in the same
 * change (L65), which is what the issue reference is for.
 */
export const DELIBERATELY_UNSUBSCRIBED: Partial<Record<WebhookEvent, string>> = {
  "booking.contact_updated":
    "#4031: the live Regal endpoint is subscribed once Regal is ready for it and Dan " +
    "has decided whether a manage page number carries opt in (#1512 built the Slate side). " +
    "Until then a lead's phone correction is emitted with no subscriber and reaches nobody.",
};

/** The reason an event is deliberately unsubscribed, or null when it is not. */
export function deliberatelyUnsubscribedReason(event: string): string | null {
  return DELIBERATELY_UNSUBSCRIBED[event as WebhookEvent] ?? null;
}
