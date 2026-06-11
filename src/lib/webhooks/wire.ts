import { createHmac } from "node:crypto";
import { buildRegalEvent } from "./regal.ts";
import type { BookingEventPayload } from "./types.ts";
import type { WebhookEndpoint, WebhookEvent } from "@/lib/db/types";

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

/**
 * Produces the wire request for an endpoint based on its format:
 *  - 'regal'   -> Regal event shape + Authorization header
 *  - 'generic' -> {event, data} body + HMAC signature over `timestamp.body`
 *                 (with x-slate-timestamp) so subscribers can reject replays
 */
export function buildRequest(
  endpoint: WebhookEndpoint,
  deliveryId: string,
  event: WebhookEvent,
  payload: BookingEventPayload,
  timestamp: string = new Date().toISOString(),
): { body: string; headers: Record<string, string> } {
  if (endpoint.format === "regal") {
    const regalEvent = buildRegalEvent(event, payload);
    regalEvent.properties.slateDeliveryId = deliveryId;
    return {
      body: JSON.stringify(regalEvent),
      headers: {
        "content-type": "application/json",
        authorization: endpoint.auth_header ?? "",
        "x-slate-delivery-id": deliveryId,
      },
    };
  }
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
