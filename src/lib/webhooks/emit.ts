import { createHmac } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { buildRegalEvent } from "@/lib/webhooks/regal";
import type { BookingEventPayload } from "@/lib/webhooks/types";
import type { WebhookEndpoint, WebhookEvent } from "@/lib/db/types";

const MAX_ATTEMPTS = 5;

function sign(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Produces the wire request for an endpoint based on its format:
 *  - 'regal'   -> Regal event shape + Authorization header
 *  - 'generic' -> {event, data} body + HMAC signature
 */
function buildRequest(
  endpoint: WebhookEndpoint,
  event: WebhookEvent,
  payload: BookingEventPayload,
): { body: string; headers: Record<string, string> } {
  if (endpoint.format === "regal") {
    return {
      body: JSON.stringify(buildRegalEvent(event, payload)),
      headers: {
        "content-type": "application/json",
        authorization: endpoint.auth_header ?? "",
      },
    };
  }
  const body = JSON.stringify({ event, data: payload });
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-slate-event": event,
      "x-slate-signature": sign(endpoint.secret, body),
    },
  };
}

async function send(
  endpoint: WebhookEndpoint,
  deliveryId: string,
  event: WebhookEvent,
  payload: BookingEventPayload,
  attempt: number,
): Promise<void> {
  const db = supabaseAdmin();
  const { body, headers } = buildRequest(endpoint, event, payload);
  try {
    const res = await fetch(endpoint.url, { method: "POST", headers, body });
    const text = (await res.text().catch(() => "")).slice(0, 1000);
    await db
      .from("webhook_deliveries")
      .update({
        status: res.ok ? "success" : "failed",
        attempts: attempt,
        last_response: `${res.status} ${text}`,
      })
      .eq("id", deliveryId);
  } catch (err) {
    await db
      .from("webhook_deliveries")
      .update({
        status: "failed",
        attempts: attempt,
        last_response: String(err).slice(0, 1000),
      })
      .eq("id", deliveryId);
  }
}

/**
 * Records and fires a webhook to every active endpoint subscribed to `event`.
 * Delivery is best-effort here; failed rows are retried by the cron sweep.
 */
export async function emitWebhook(
  orgId: string,
  event: WebhookEvent,
  payload: BookingEventPayload,
): Promise<void> {
  const db = supabaseAdmin();
  const { data: endpoints } = await db
    .from("webhook_endpoints")
    .select("*")
    .eq("org_id", orgId)
    .eq("active", true)
    .contains("events", [event]);

  await Promise.all(
    ((endpoints ?? []) as WebhookEndpoint[]).map(async (endpoint) => {
      const { data: delivery } = await db
        .from("webhook_deliveries")
        .insert({
          endpoint_id: endpoint.id,
          event,
          payload: payload as unknown as Record<string, unknown>,
          status: "pending",
        })
        .select("id")
        .single();
      if (delivery) {
        await send(endpoint, (delivery as { id: string }).id, event, payload, 1);
      }
    }),
  );
}

/** Cron retry for failed deliveries with attempts left. */
export async function retryFailedDeliveries(): Promise<number> {
  const db = supabaseAdmin();
  const { data: rows } = await db
    .from("webhook_deliveries")
    .select("id, endpoint_id, event, payload, attempts")
    .eq("status", "failed")
    .lt("attempts", MAX_ATTEMPTS)
    .limit(50);

  let retried = 0;
  for (const r of (rows ?? []) as unknown as {
    id: string;
    endpoint_id: string;
    event: WebhookEvent;
    payload: BookingEventPayload;
    attempts: number;
  }[]) {
    const { data: endpoint } = await db
      .from("webhook_endpoints")
      .select("*")
      .eq("id", r.endpoint_id)
      .maybeSingle();
    if (!endpoint) continue;

    await send(
      endpoint as WebhookEndpoint,
      r.id,
      r.event,
      r.payload,
      r.attempts + 1,
    );
    retried++;
  }
  return retried;
}
