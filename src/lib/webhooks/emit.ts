import { supabaseAdmin } from "@/lib/supabase/admin";
import { buildRequest } from "@/lib/webhooks/wire";
import { WEBHOOK_MAX_ATTEMPTS, isDeadLettered, isDueForRetry } from "@/lib/webhooks/retry";
import { parseStampMs } from "@/lib/date/stamp";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { log } from "@/lib/log";
import type { BookingEventPayload } from "@/lib/webhooks/types";
import type { WebhookEndpoint, WebhookEvent } from "@/lib/db/types";

const WEBHOOK_TIMEOUT_MS = 5000;
const DEAD_LETTER_COOLDOWN_MS = 30 * 60 * 1000;

/** Stamped on a delivery that was recorded but deliberately never sent (#459). */
const SUPPRESSED_RESPONSE = "suppressed: is_test bucket, external POST skipped (#459)";

/**
 * Load-test short-circuit (#440): under SLATE_LOADTEST the delivery row is still
 * inserted (so the 200-agent soak exercises the dedupe unique index), but the
 * external POST is skipped and the delivery recorded a success: a dead sink
 * would otherwise turn every notify into a timeout + failed-retry, polluting the
 * lane timings. Returns null off the flag so production does the real send.
 * Inert anywhere the flag isn't set. Exported for testing.
 */
export function loadtestDeliveryResult(): { ok: boolean; lastResponse: string } | null {
  if (process.env.SLATE_LOADTEST !== "true") return null;
  return { ok: true, lastResponse: "loadtest: external POST skipped" };
}

async function send(
  endpoint: WebhookEndpoint,
  deliveryId: string,
  event: WebhookEvent,
  payload: BookingEventPayload,
  attempt: number,
): Promise<void> {
  const db = supabaseAdmin();

  // #600: buildRequest REFUSES to build a Regal delivery with no API key, rather than
  // posting an unauthenticated event. That refusal must not escape into the booking path:
  // emitWebhook is awaited by the booking flow, so throwing here would fail real bookings
  // over a webhook misconfiguration, and the outbox would retry the throw forever. Treat
  // it as a failed attempt instead. It lands in the webhook log, the retry sweep picks it
  // up once an admin sets the key, and the existing dead-letter alert fires if it doesn't.
  let body: string;
  let headers: Record<string, string>;
  let configError: string | null = null;
  try {
    ({ body, headers } = buildRequest(endpoint, deliveryId, event, payload));
  } catch (err) {
    body = "";
    headers = {};
    configError = String(err).slice(0, 1000);
  }

  let ok = false;
  let lastResponse = "";
  const stub = loadtestDeliveryResult();
  if (configError) {
    lastResponse = configError;
  } else if (stub) {
    ok = stub.ok;
    lastResponse = stub.lastResponse;
  } else {
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
      // AbortError (timeout) or network error, both count as a failed attempt.
      lastResponse = String(err).slice(0, 1000);
    } finally {
      clearTimeout(timer);
    }
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
 * Schedules the deferred outbound send. A user-facing caller (the booking create
 * confirm, cancel, reschedule) passes Next `after()` (via `deferWebhookSend`) so
 * the response returns without waiting on the Regal/Cadence round-trip; the cron
 * drains pass none and send inline, keeping their bounded fan-out in charge of
 * simultaneous connections.
 */
export type WebhookSendScheduler = (work: () => Promise<void>) => void;

/**
 * Records and fires a webhook to every active endpoint subscribed to `event`.
 * The send is bounded by a timeout so a slow subscriber can't block the booking;
 * any failure is retried with backoff by the cron sweep.
 *
 * `dedupeKey` makes the call idempotent (#436): the row is written under the
 * partial UNIQUE (endpoint_id, event, dedupe_key), so a re-enqueue of the same
 * logical event hits a 23505 and we skip both the second row and the second POST
 * (exactly-once to Regal/Cadence). A null `dedupeKey` opts out of dedup (the
 * partial index ignores nulls) and behaves exactly as before (at-least-once).
 *
 * The durable pending row is ALWAYS written synchronously, so the retry sweep is
 * the backstop for a send that never lands. `deferSend` (#884) only moves the
 * outbound POST off the response's critical path: when supplied, the POST is
 * handed to the scheduler (Next after()) instead of awaited; when omitted the
 * send stays inline, unchanged.
 */
export async function emitWebhook(
  orgId: string,
  event: WebhookEvent,
  payload: BookingEventPayload,
  dedupeKey: string | null = null,
  suppressed = false,
  deferSend?: WebhookSendScheduler,
): Promise<void> {
  const db = supabaseAdmin();
  const { data: endpoints, error: endpointsError } = await db
    .from("webhook_endpoints")
    .select("*")
    .eq("org_id", orgId)
    .eq("active", true)
    .contains("events", [event]);
  // Fail loud (#1036). A swallowed read error here yielded null -> zero endpoints
  // -> the outbox step (booking notify) marked done with nothing queued -> the
  // booking event permanently lost to Regal/Cadence with no signal. Throw so the
  // outbox/drain step is marked failed and retries (and alerts once stuck),
  // instead of silently dropping the emission.
  if (endpointsError) {
    log.error("webhook-emit", { msg: "endpoints read failed", org_id: orgId, event }, endpointsError);
    throw new Error(`webhook endpoints read failed: ${endpointsError.message}`);
  }

  await Promise.all(
    ((endpoints ?? []) as WebhookEndpoint[]).map(async (endpoint) => {
      const { data: delivery, error } = await db
        .from("webhook_deliveries")
        .insert({
          endpoint_id: endpoint.id,
          event,
          payload: payload as unknown as Record<string, unknown>,
          // A suppressed delivery lands in a TERMINAL state, so the retry sweep
          // (which picks up pending/failed) can never send it after the fact.
          status: suppressed ? "success" : "pending",
          dedupe_key: dedupeKey,
          suppressed,
          last_response: suppressed ? SUPPRESSED_RESPONSE : null,
        })
        .select("id")
        .single();
      if (error) {
        // 23505 = this (endpoint, event, dedupe_key) was already enqueued by a
        // prior call: the original delivery owns the send/retry, so skip (never
        // double-fire).
        if (error.code === "23505") return;
        // Any OTHER insert error left no durable row (#1036): marking the outbox
        // step done here would drop the event silently. Fail loud so the step
        // retries instead.
        log.error("webhook-emit", { msg: "delivery insert failed", endpoint_id: endpoint.id, event }, error);
        throw new Error(`webhook delivery insert failed: ${error.message}`);
      }
      if (!delivery) return;
      // #459: the row is recorded (so the exactly-once dedupe stays observable on
      // the smoke bucket) but nothing goes out the door.
      if (suppressed) return;
      // #884: the durable pending row is written above, so a dropped send is
      // recoverable by the retry sweep. On a user-facing path the scheduler
      // hands the POST to Next after() so the response isn't blocked on it; the
      // cron drains send inline (deferSend undefined) under their fan-out cap.
      const doSend = () => send(endpoint, (delivery as { id: string }).id, event, payload, 1);
      if (deferSend) deferSend(doSend);
      else await doSend();
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
  // error-ok: best-effort retry sweep; a read error yields no due rows this tick
  // and the cron re-runs next minute (the durable rows are untouched).
  const { data: rows } = await db
    .from("webhook_deliveries")
    .select("id, endpoint_id, event, payload, attempts, updated_at")
    .in("status", ["failed", "pending"])
    // Belt and braces (#459): a suppressed row is already terminal ('success'), so
    // it can't match the status filter, but never sweep one into a POST.
    .eq("suppressed", false)
    .eq("payload_erased", false) // #1073: never sweep a blanked ({}) payload
    .lt("attempts", WEBHOOK_MAX_ATTEMPTS)
    .limit(100);

  const now = Date.now();
  // #1169: fail closed. An unparseable updated_at reads as "last attempted at
  // epoch 0" (due now), never NaN, which compared false on every sweep and left
  // the delivery stuck forever: never retried, never dead-lettered.
  const due = ((rows ?? []) as unknown as {
    id: string;
    endpoint_id: string;
    event: WebhookEvent;
    payload: BookingEventPayload;
    attempts: number;
    updated_at: string;
  }[]).filter((r) => isDueForRetry(r.attempts, parseStampMs(r.updated_at) ?? 0, now));
  if (due.length === 0) return 0;

  // One endpoints query per sweep (#623): batch-load the distinct endpoints the
  // due rows reference instead of a lookup per row.
  const endpointIds = [...new Set(due.map((r) => r.endpoint_id))];
  // error-ok: best-effort retry sweep; a read error leaves byId empty so every
  // due row is skipped (no endpoint) and the cron re-runs next minute.
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
 * Outcome of a manual resend, so the caller can tell a real send from a
 * deliberate refusal instead of a silent no-op (#1073).
 */
export type ResendResult =
  | "sent"
  | "not-found"
  | "suppressed"
  | "payload-erased"
  | "deduped";

/**
 * Manual resend of one delivery from the admin log: re-fires it immediately
 * (ignoring the retry cap). Scoped to `orgId` so an admin can only resend their
 * own org's deliveries.
 */
export async function resendDelivery(
  deliveryId: string,
  orgId: string,
): Promise<ResendResult> {
  const db = supabaseAdmin();
  // error-ok: a manual admin resend; a read error surfaces as "not-found" so the
  // admin retries, and nothing is sent or lost (no automatic side effect).
  const { data: d } = await db
    .from("webhook_deliveries")
    .select("id, endpoint_id, event, payload, attempts, suppressed, payload_erased")
    .eq("id", deliveryId)
    .maybeSingle();
  if (!d) return "not-found";
  const row = d as unknown as {
    id: string;
    endpoint_id: string;
    event: WebhookEvent;
    payload: BookingEventPayload;
    attempts: number;
    suppressed: boolean;
    payload_erased: boolean;
  };
  // #459: a suppressed delivery (an is_test bucket's booking) must never leave the
  // building, so the admin resend button can't leak a smoke booking into Regal.
  if (row.suppressed) return "suppressed";
  // #1073: the payload was blanked for PII retention. Refuse rather than POST an
  // empty {} body (a fake success on a generic endpoint, a throw on Regal).
  if (row.payload_erased) return "payload-erased";

  // error-ok: a manual admin resend; a read error surfaces as "not-found" so the
  // admin retries, and nothing is sent or lost (no automatic side effect).
  const { data: endpoint } = await db
    .from("webhook_endpoints")
    .select("*")
    .eq("id", row.endpoint_id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!endpoint) return "not-found";

  // Claim the attempt (#623) so a resend that races the cron retry sweep (or a
  // duplicate resend) can't double-POST the same attempt.
  if (!(await claimDeliveryAttempt(db, row.id, row.attempts))) return "deduped";
  await send(endpoint as WebhookEndpoint, row.id, row.event, row.payload, row.attempts + 1);
  return "sent";
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

  // error-ok: an operator-triggered incident replay. A read error replays nothing
  // and the durable rows are untouched, so re-running is safe and loses nothing.
  // Note what it does NOT do: the caller discards the count, so a read error looks
  // identical to "there was nothing to replay". That is only tolerable because
  // nothing is displayed either way; giving the operator a real result (and
  // distinguishing the two) is #1076.
  const { data: rows } = await db
    .from("webhook_deliveries")
    .select("id, endpoint_id, event, payload, attempts, status")
    .in("endpoint_id", [...byId.keys()])
    .eq("status", "failed")
    .eq("suppressed", false) // #459: never replay a suppressed (is_test) delivery
    .eq("payload_erased", false) // #1073: never replay an erased ({}) payload
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
