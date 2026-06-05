import { createHmac } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { buildRegalEvent } from "@/lib/webhooks/regal";
import { WEBHOOK_MAX_ATTEMPTS, isDueForRetry } from "@/lib/webhooks/retry";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import type { BookingEventPayload } from "@/lib/webhooks/types";
import type { WebhookEndpoint, WebhookEvent } from "@/lib/db/types";

const WEBHOOK_TIMEOUT_MS = 5000;
const DEAD_LETTER_COOLDOWN_MS = 30 * 60 * 1000;

function sign(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Produces the wire request for an endpoint based on its format:
 *  - 'regal'   -> Regal event shape + Authorization header
 *  - 'generic' -> {event, data} body + HMAC signature over `timestamp.body`
 *                 (with x-slate-timestamp) so subscribers can reject replays
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
  const timestamp = new Date().toISOString();
  const body = JSON.stringify({ event, data: payload });
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-slate-event": event,
      "x-slate-timestamp": timestamp,
      "x-slate-signature": sign(endpoint.secret, `${timestamp}.${body}`),
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

  let ok = false;
  let lastResponse = "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    const text = (await res.text().catch(() => "")).slice(0, 1000);
    ok = res.ok;
    lastResponse = `${res.status} ${text}`;
  } catch (err) {
    // AbortError (timeout) or network error — both count as a failed attempt.
    lastResponse = String(err).slice(0, 1000);
  } finally {
    clearTimeout(timer);
  }

  await db
    .from("webhook_deliveries")
    .update({
      status: ok ? "success" : "failed",
      attempts: attempt,
      last_response: lastResponse,
    })
    .eq("id", deliveryId);

  // Retries exhausted and still failing: alert (throttled per endpoint).
  if (!ok && attempt >= WEBHOOK_MAX_ATTEMPTS) {
    await sendThrottledAlert(
      `webhook_dead:${endpoint.id}`,
      DEAD_LETTER_COOLDOWN_MS,
      `Slate: webhook delivery to ${endpoint.url} keeps failing (event ${event}, ${attempt} attempts). Last response: ${lastResponse}`,
    );
  }
}

/**
 * Records and fires a webhook to every active endpoint subscribed to `event`.
 * The send is bounded by a timeout so a slow subscriber can't block the booking;
 * any failure is retried with backoff by the cron sweep.
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

/**
 * Cron sweep: redeliver failed (or stuck-pending) deliveries that are due per
 * the exponential backoff, until attempts are exhausted.
 */
export async function retryFailedDeliveries(): Promise<number> {
  const db = supabaseAdmin();
  const { data: rows } = await db
    .from("webhook_deliveries")
    .select("id, endpoint_id, event, payload, attempts, updated_at")
    .in("status", ["failed", "pending"])
    .lt("attempts", WEBHOOK_MAX_ATTEMPTS)
    .limit(100);

  const now = Date.now();
  let retried = 0;
  for (const r of (rows ?? []) as unknown as {
    id: string;
    endpoint_id: string;
    event: WebhookEvent;
    payload: BookingEventPayload;
    attempts: number;
    updated_at: string;
  }[]) {
    if (!isDueForRetry(r.attempts, Date.parse(r.updated_at), now)) continue;

    const { data: endpoint } = await db
      .from("webhook_endpoints")
      .select("*")
      .eq("id", r.endpoint_id)
      .maybeSingle();
    if (!endpoint) continue;

    await send(endpoint as WebhookEndpoint, r.id, r.event, r.payload, r.attempts + 1);
    retried++;
  }
  return retried;
}
