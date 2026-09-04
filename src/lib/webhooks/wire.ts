import { createHmac } from "node:crypto";
import { buildRegalEvent } from "./regal.ts";
import type { BookingEventPayload } from "./types.ts";
import type { WebhookEndpoint, WebhookEvent, WebhookFormat } from "@/lib/db/types";

/**
 * Pure wire-request builder for outbound webhooks, split from emit.ts so the
 * exact headers/body/signature are unit-testable (scripts/test-webhook-wire.ts).
 *
 * Every delivery carries x-slate-delivery-id (#32): retries resend the same
 * event up to WEBHOOK_MAX_ATTEMPTS times, and the webhook_deliveries row id is
 * stable across those attempts, so receivers can dedupe on it. The Regal shape
 * also gets it as properties.slateDeliveryId, since Regal journeys see
 * properties, not transport headers.
 */

export function sign(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

/** Everything a format needs to turn one event into one HTTP request. */
type WireContext = {
  endpoint: WebhookEndpoint;
  deliveryId: string;
  event: WebhookEvent;
  payload: BookingEventPayload;
  timestamp: string;
};

/** What one format produces. */
type WireRequest = { body: string; headers: Record<string, string> };

/**
 * One builder per format, keyed on the union (#1952).
 *
 * This was `if (endpoint.format === "regal") { ... }` followed by the generic
 * body, so an unhandled format took the GENERIC branch. A default branch is
 * indistinguishable from a deliberate choice, which means a third destination
 * would have received the wrong payload shape with no error raised anywhere,
 * and its subscriber would have been the thing that noticed (L113).
 *
 * As a `Record<WebhookFormat, ...>` the compiler names the omission instead. The
 * dropdown's labels are keyed on the same union in
 * `src/lib/webhooks/formats.ts`, so a new format cannot ship half wired.
 */
const FORMAT_BUILDERS: Record<WebhookFormat, (ctx: WireContext) => WireRequest> = {
  regal: buildRegalRequest,
  generic: buildGenericRequest,
};

/**
 * Produces the wire request for an endpoint based on its format.
 *
 * The lookup REFUSES a format it has no builder for rather than falling back to
 * one. The column carries a check constraint, so a value outside the union can
 * only arrive from a migration that widened it without widening the code, and in
 * that case sending the wrong shape is worse than sending nothing: the delivery
 * is recorded as failed and shows in the webhook log, which is the same choice
 * #600 made for a Regal endpoint with no key.
 */
export function buildRequest(
  endpoint: WebhookEndpoint,
  deliveryId: string,
  event: WebhookEvent,
  payload: BookingEventPayload,
  timestamp: string = new Date().toISOString(),
): WireRequest {
  const build = FORMAT_BUILDERS[endpoint.format];
  if (!build) {
    throw new Error(
      `Webhook endpoint has an unknown format (${String(endpoint.format)}); refusing to guess a payload shape (#1952).`,
    );
  }
  return build({ endpoint, deliveryId, event, payload, timestamp });
}

function buildRegalRequest({
  endpoint,
  deliveryId,
  event,
  payload,
}: WireContext): WireRequest {
  // #600: the API key IS the authentication on this path. The old `?? ""` posted an
  // unauthenticated event that Regal rejects, and did it quietly, so a webhook saved
  // without a key looked like a normal delivery attempt instead of the misconfiguration
  // it is. Refuse to build the request at all: the delivery is recorded as failed and
  // shows up in the webhook log, rather than every booking event silently 401ing.
  const key = endpoint.auth_header?.trim();
  if (!key) {
    throw new Error(
      "Regal webhook endpoint has no API key (auth_header). Set it in /admin; refusing to send an unauthenticated delivery (#600).",
    );
  }
  const regalEvent = buildRegalEvent(event, payload);
  regalEvent.properties.slateDeliveryId = deliveryId;
  return {
    body: JSON.stringify(regalEvent),
    headers: {
      "content-type": "application/json",
      authorization: key,
      "x-slate-delivery-id": deliveryId,
    },
  };
}

function buildGenericRequest({
  endpoint,
  deliveryId,
  event,
  payload,
  timestamp,
}: WireContext): WireRequest {
  const body = JSON.stringify({ event, data: payload });
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-slate-event": event,
      "x-slate-timestamp": timestamp,
      "x-slate-signature": sign(endpoint.secret, `${timestamp}.${body}`),
      "x-slate-delivery-id": deliveryId,
    },
  };
}
