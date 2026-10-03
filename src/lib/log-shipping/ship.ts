/**
 * Send redacted records to a Better Stack HTTP source, bounded (#3105).
 *
 * The tail worker is invoked once per Slate invocation (Cloudflare may hand it
 * several trace items at once), so this runs at Slate's own request rate. Two
 * bounds keep that cheap and predictable whatever Slate logs:
 *
 *   - at most `MAX_REQUESTS` POSTs per tail invocation, each at most
 *     `MAX_BATCH_BYTES` of JSON. Records past that are DROPPED and counted, never
 *     queued: a tail worker has nowhere durable to queue them, and a backlog that
 *     grows under a log storm is how a logging bill becomes the incident.
 *   - no retry. A refused or failed POST is counted and reported; the next
 *     invocation brings its own records. Retrying inside the tail invocation would
 *     multiply exactly the traffic that was already failing.
 *
 * It never throws. A tail worker cannot affect Slate's requests (it runs after
 * them, in its own invocation), but a throw here would still lose the drop count,
 * which is the only evidence that something is being lost. So every failure comes
 * back as a counted outcome the worker logs.
 *
 * The plan Better Stack is on (the free 3 day tier first, then a paid retention
 * plan) changes nothing here: the source token and ingest host are the only
 * coupling, and both come from the tail worker's own configuration.
 */
import type { ShippedRecord } from "./records.ts";

/** One tail invocation's ceiling on outbound requests. Two, so a large burst gets
 *  a second chance at fitting and a log storm still costs at most two subrequests. */
export const MAX_REQUESTS = 2;

/** One request's ceiling on body size. Better Stack's HTTP source accepts far more
 *  (10 MiB at the time of writing); this is our bound, not theirs. */
export const MAX_BATCH_BYTES = 1_000_000;

/** How long one POST may take before it is abandoned (review of #3160). With at
 *  most `MAX_REQUESTS` of them in sequence, a Better Stack that accepts the
 *  connection and never answers costs one tail invocation ten seconds at worst,
 *  well inside the runtime's limit, instead of holding it until the runtime kills
 *  it and the drop count is lost with it. */
export const POST_TIMEOUT_MS = 5_000;

/** Why a batch did not go: each reason sends a different person to do a different
 *  thing, so they are never folded together (L11). */
export type DropReason =
  | "no-token"
  | "no-host"
  | "bad-host"
  | "over-budget"
  | "too-large"
  | "refused"
  | "unreachable"
  | "timeout";

export interface ShipConfig {
  token: string | undefined;
  host: string | undefined;
}

export interface ShipOutcome {
  sent: number;
  /** Records that did not reach Better Stack, by reason. Empty when all went. */
  dropped: Partial<Record<DropReason, number>>;
  /** The HTTP status of a refused POST, for the log line that reports it. */
  refusedStatus?: number;
}

/** A bare hostname: letters, digits, dots and hyphens. A scheme, a path or a port
 *  means somebody pasted the wrong thing, and building a URL from it would send the
 *  token somewhere unintended. */
const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;

function add(outcome: ShipOutcome, reason: DropReason, count: number): void {
  if (count <= 0) return;
  outcome.dropped[reason] = (outcome.dropped[reason] ?? 0) + count;
}

/** Pack records into JSON array bodies no bigger than `maxBytes`. A single record
 *  that alone exceeds it is reported back rather than sent. */
export function packBatches(
  records: readonly ShippedRecord[],
  maxBytes: number = MAX_BATCH_BYTES,
): { batches: string[][]; oversized: number } {
  const batches: string[][] = [];
  let current: string[] = [];
  let size = 2; // the brackets
  let oversized = 0;
  for (const record of records) {
    const json = JSON.stringify(record);
    const bytes = new TextEncoder().encode(json).length;
    if (bytes + 2 > maxBytes) {
      oversized++;
      continue;
    }
    const extra = bytes + (current.length > 0 ? 1 : 0);
    if (size + extra > maxBytes) {
      batches.push(current);
      current = [];
      size = 2;
    }
    size += bytes + (current.length > 0 ? 1 : 0);
    current.push(json);
  }
  if (current.length > 0) batches.push(current);
  return { batches, oversized };
}

/** Ship `records`, never throwing. `fetchFn` is injected so the tests can refuse,
 *  fail and count without a network. */
export async function shipRecords(
  records: readonly ShippedRecord[],
  config: ShipConfig,
  fetchFn: typeof fetch,
  limits: { maxRequests?: number; maxBatchBytes?: number; timeoutMs?: number } = {},
): Promise<ShipOutcome> {
  const outcome: ShipOutcome = { sent: 0, dropped: {} };
  if (records.length === 0) return outcome;
  const token = config.token?.trim();
  const host = config.host?.trim();
  if (!token) {
    add(outcome, "no-token", records.length);
    return outcome;
  }
  if (!host) {
    add(outcome, "no-host", records.length);
    return outcome;
  }
  if (!HOST.test(host)) {
    add(outcome, "bad-host", records.length);
    return outcome;
  }

  const { batches, oversized } = packBatches(records, limits.maxBatchBytes ?? MAX_BATCH_BYTES);
  add(outcome, "too-large", oversized);
  const maxRequests = limits.maxRequests ?? MAX_REQUESTS;
  for (const [index, batch] of batches.entries()) {
    if (index >= maxRequests) {
      add(outcome, "over-budget", batch.length);
      continue;
    }
    const signal = AbortSignal.timeout(limits.timeoutMs ?? POST_TIMEOUT_MS);
    try {
      const res = await fetchFn(`https://${host}/`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: `[${batch.join(",")}]`,
        signal,
      });
      if (res.ok) outcome.sent += batch.length;
      else {
        add(outcome, "refused", batch.length);
        outcome.refusedStatus = res.status;
      }
    } catch {
      // Judged on the signal, not the error's name: the runtime and a test double
      // can reject with different shapes, and only the signal knows it fired.
      add(outcome, signal.aborted ? "timeout" : "unreachable", batch.length);
    }
  }
  return outcome;
}

/** Total records dropped across every reason. */
export function droppedCount(outcome: ShipOutcome): number {
  return Object.values(outcome.dropped).reduce((sum, n) => sum + (n ?? 0), 0);
}
