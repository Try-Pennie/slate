/**
 * The receipt that proves Slate's logs are reaching Better Stack (#3182).
 *
 * The tail worker counts what it drops, but only in its own Cloudflare logs, which
 * nobody is paged from and which expire in 7 days. And the worst failures write
 * nothing there at all: a tail worker Cloudflare stopped invoking, or one detached
 * from Slate's `tail_consumers`, records no drop because it never runs. So a check of
 * the drop counts would read a broken pipe as a quiet one (L98).
 *
 * Detection is therefore by ABSENCE, the same shape as the lane heartbeats. Each
 * time Better Stack accepts every record of an invocation carrying the cron
 * dispatcher's `lane timings` line, the tail worker hands Slate a receipt over a
 * service binding (`SLATE`, entrypoint `LogShippingReceipt` in `worker/index.ts`),
 * Slate stamps the `log-shipping` heartbeat, and the lane watchdog pages when that
 * stamp is older than its bound. A revoked token, a Better Stack outage, a missing
 * secret, a tail worker that is not running and a binding that is gone all end the
 * receipts the same way, which is the point: the check is cause agnostic, and the
 * page sends the reader to the tail worker's own log for the cause.
 *
 * Why the lane timings line and nothing else. Slate writes it once per cron tick,
 * every minute, whatever traffic is doing, so a quiet night still produces receipts
 * and the bound can be minutes rather than hours. And the receipt's OWN invocation in
 * Slate is tailed too: it carries no lane timings line, so shipping it can never ask
 * for another receipt, which is what stops the two Workers invoking each other for
 * ever.
 *
 * Relative imports only: the tail worker bundles this from its own config.
 */
import type { ShippedRecord } from "./records.ts";
import type { ShipOutcome } from "./ship.ts";

/** The Worker whose cron dispatcher writes the line. Another script's line, a load
 *  test deployment's included, vouches for nothing about Slate's logs. */
const SLATE_SCRIPT = "slate";

/** How long a receipt may take before the tail invocation gives up on it. The call
 *  is one in process request and one heartbeat upsert inside Slate. */
export const RECEIPT_TIMEOUT_MS = 5_000;

/** True for the cron dispatcher's `lane timings` line from Slate, judged on the
 *  PARSED fields rather than the text, so prose that mentions it does not count. */
export function isLaneTimingsRecord(record: ShippedRecord): boolean {
  if (record.kind !== "log" || record.script !== SLATE_SCRIPT) return false;
  const fields = record.fields as Record<string, unknown> | undefined;
  return fields?.tag === "cron" && fields?.msg === "lane timings";
}

/**
 * Did this shipment prove the logs are arriving?
 *
 * Only when Better Stack accepted EVERY record and one of them was the lane timings
 * line. A partial shipment is not a receipt even if the line might have been in the
 * batch that went: one missed receipt costs nothing against a bound fifteen ticks
 * wide, while a false one hides the fault this exists to find.
 */
export function shipmentConfirmsDelivery(records: readonly ShippedRecord[], outcome: ShipOutcome): boolean {
  if (outcome.sent === 0 || outcome.sent !== records.length) return false;
  if (Object.values(outcome.dropped).some((n) => (n ?? 0) > 0)) return false;
  if ((outcome.refusedStatuses?.length ?? 0) > 0) return false;
  return records.some(isLaneTimingsRecord);
}

/** What the tail worker can call on Slate. The entrypoint answers whether it stamped. */
export interface ReceiptBinding {
  shipped(): Promise<{ stamped: boolean }>;
}

/** Why a receipt did or did not land: each one sends a reader somewhere different (L11).
 *  `no-binding` is a tail worker deployed without the `SLATE` service binding. */
export type ReceiptResult = "stamped" | "refused" | "no-binding" | "failed" | "timeout";

/**
 * Hand Slate one receipt. Never throws: the tail worker's whole handler is contained,
 * and a receipt that did not land is already the finding, because the heartbeat it
 * would have stamped goes stale and pages.
 */
export async function confirmReceipt(
  binding: ReceiptBinding | undefined,
  timeoutMs: number = RECEIPT_TIMEOUT_MS,
): Promise<ReceiptResult> {
  if (!binding || typeof binding.shipped !== "function") return "no-binding";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const call = binding.shipped();
    // A call that loses the race to the deadline and rejects later is already
    // reported as a timeout. Promise.race subscribes to it, so the late rejection is
    // handled either way (scripts/test-log-shipping-receipt.ts pins that); this says
    // so explicitly rather than leaving it to the reader to know.
    call.catch(() => {});
    const answer = await Promise.race([call, deadline]);
    if (answer === "timeout") return "timeout";
    return answer?.stamped === true ? "stamped" : "refused";
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}
