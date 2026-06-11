import { supabaseAdmin } from "@/lib/supabase/admin";
import { buildRequest } from "@/lib/webhooks/wire";
import { WEBHOOK_MAX_ATTEMPTS, isDeadLettered, isDueForRetry } from "@/lib/webhooks/retry";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import type { BookingEventPayload } from "@/lib/webhooks/types";
import type { WebhookEndpoint, WebhookEvent } from "@/lib/db/types";

const WEBHOOK_TIMEOUT_MS = 5000;
const DEAD_LETTER_COOLDOWN_MS = 30 * 60 * 1000;

async function send(
  endpoint: WebhookEndpoint,
  deliveryId: string,
  event: WebhookEvent,
  payload: BookingEventPayload,
  attempt: number,
): Promise<void> {
  const db = supabaseAdmin();
  const { body, headers } = buildRequest(endpoint, deliveryId, event, payload);

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

/**
 * Manual resend of one delivery from the admin log: re-fires it immediately
 * (ignoring the retry cap). Scoped to `orgId` so an admin can only resend their
 * own org's deliveries.
 */
export async function resendDelivery(deliveryId: string, orgId: string): Promise<void> {
  const db = supabaseAdmin();
  const { data: d } = await db
    .from("webhook_deliveries")
    .select("id, endpoint_id, event, payload, attempts")
    .eq("id", deliveryId)
    .maybeSingle();
  if (!d) return;
  const row = d as unknown as {
    id: string;
    endpoint_id: string;
    event: WebhookEvent;
    payload: BookingEventPayload;
    attempts: number;
  };

  const { data: endpoint } = await db
    .from("webhook_endpoints")
    .select("*")
    .eq("id", row.endpoint_id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!endpoint) return;

  await send(endpoint as WebhookEndpoint, row.id, row.event, row.payload, row.attempts + 1);
}

/**
 * Batch replay for incident recovery (#33): re-fires every dead-lettered
 * delivery (failed, attempts exhausted - the cron still owns anything under
 * the cap) for the org's active endpoints within the time window. Returns how
 * many deliveries were re-fired; each keeps its row id, so receivers can
 * still dedupe on x-slate-delivery-id.
 */
export async function replayDeadLetteredDeliveries(
  orgId: string,
  sinceIso: string,
  endpointId?: string,
): Promise<number> {
  const db = supabaseAdmin();

  let endpointQuery = db
    .from("webhook_endpoints")
    .select("*")
    .eq("org_id", orgId)
    .eq("active", true);
  if (endpointId) endpointQuery = endpointQuery.eq("id", endpointId);
  const { data: endpoints } = await endpointQuery;
  const byId = new Map(
    ((endpoints ?? []) as WebhookEndpoint[]).map((e) => [e.id, e]),
  );
  if (byId.size === 0) return 0;

  const { data: rows } = await db
    .from("webhook_deliveries")
    .select("id, endpoint_id, event, payload, attempts, status")
    .in("endpoint_id", [...byId.keys()])
    .eq("status", "failed")
    .gte("attempts", WEBHOOK_MAX_ATTEMPTS)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true })
    .limit(200);

  let replayed = 0;
  for (const r of (rows ?? []) as unknown as {
    id: string;
    endpoint_id: string;
    event: WebhookEvent;
    payload: BookingEventPayload;
    attempts: number;
    status: string;
  }[]) {
    if (!isDeadLettered(r.status, r.attempts)) continue;
    const endpoint = byId.get(r.endpoint_id);
    if (!endpoint) continue;
    await send(endpoint, r.id, r.event, r.payload, r.attempts + 1);
    replayed++;
  }
  return replayed;
}
