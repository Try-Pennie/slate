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
 *
 * `dedupeKey` makes the call idempotent (#436): the row is written under the
 * partial UNIQUE (endpoint_id, event, dedupe_key), so a re-enqueue of the same
 * logical event hits a 23505 and we skip both the second row and the second POST
 * — exactly-once to Regal/Cadence. The FIRST call still sends inline (no added
 * latency). A null `dedupeKey` opts out of dedup (the partial index ignores
 * nulls) and behaves exactly as before (at-least-once).
 */
export async function emitWebhook(
  orgId: string,
  event: WebhookEvent,
  payload: BookingEventPayload,
  dedupeKey: string | null = null,
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
      const { data: delivery, error } = await db
        .from("webhook_deliveries")
        .insert({
          endpoint_id: endpoint.id,
          event,
          payload: payload as unknown as Record<string, unknown>,
          status: "pending",
          dedupe_key: dedupeKey,
        })
        .select("id")
        .single();
      // 23505 = this (endpoint, event, dedupe_key) was already enqueued by a
      // prior call: the original delivery owns the send/retry, so skip — never
      // double-fire. Any other insert error leaves no row, same as before.
      if (error) return;
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
/**
 * Compare-and-swap claim on a delivery's attempt counter (#623): bump
 * `attempts` only if it still equals what we read. The row's send bumps attempts
 * too, so a concurrent actor (a manual resend racing the cron sweep, or two
 * sweeps) that has already advanced this attempt loses the CAS and returns
 * false, so the caller skips the send instead of double-POSTing. The winner then
 * sends; `send()` rewrites the same `attempts` value alongside the status.
 */
async function claimDeliveryAttempt(
  db: ReturnType<typeof supabaseAdmin>,
  deliveryId: string,
  currentAttempts: number,
): Promise<boolean> {
  const { data } = await db
    .from("webhook_deliveries")
    .update({ attempts: currentAttempts + 1 })
    .eq("id", deliveryId)
    .eq("attempts", currentAttempts)
    .select("id");
  return (data?.length ?? 0) > 0;
}

export async function retryFailedDeliveries(): Promise<number> {
  const db = supabaseAdmin();
  const { data: rows } = await db
    .from("webhook_deliveries")
    .select("id, endpoint_id, event, payload, attempts, updated_at")
    .in("status", ["failed", "pending"])
    .lt("attempts", WEBHOOK_MAX_ATTEMPTS)
    .limit(100);

  const now = Date.now();
  const due = ((rows ?? []) as unknown as {
    id: string;
    endpoint_id: string;
    event: WebhookEvent;
    payload: BookingEventPayload;
    attempts: number;
    updated_at: string;
  }[]).filter((r) => isDueForRetry(r.attempts, Date.parse(r.updated_at), now));
  if (due.length === 0) return 0;

  // One endpoints query per sweep (#623): batch-load the distinct endpoints the
  // due rows reference instead of a lookup per row.
  const endpointIds = [...new Set(due.map((r) => r.endpoint_id))];
  const { data: endpoints } = await db
    .from("webhook_endpoints")
    .select("*")
    .in("id", endpointIds);
  const byId = new Map(
    ((endpoints ?? []) as WebhookEndpoint[]).map((e) => [e.id, e]),
  );

  let retried = 0;
  for (const r of due) {
    const endpoint = byId.get(r.endpoint_id);
    if (!endpoint) continue;
    // Claim the attempt before sending so a concurrent resend can't double-fire.
    if (!(await claimDeliveryAttempt(db, r.id, r.attempts))) continue;
    await send(endpoint, r.id, r.event, r.payload, r.attempts + 1);
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

  // Claim the attempt (#623) so a resend that races the cron retry sweep (or a
  // duplicate resend) can't double-POST the same attempt.
  if (!(await claimDeliveryAttempt(db, row.id, row.attempts))) return;
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
