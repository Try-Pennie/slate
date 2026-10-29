/**
 * How many advisors are free to take a live transfer, read from Pennie's transfer queue
 * endpoint, and whether the coordinator page offers "Transfer now" on it (#4380).
 *
 * The endpoint is a Pennie worker that reads Regal's queue API for a queue set on the
 * worker's side and answers `200 application/json` like
 * `{"queue":"boomsource-inbound-transfer","queueId":"…","availableAgents":19}`. No key:
 * it says only a count. The count is approximate and reserves nothing, so the page asks
 * when the customer is found and again when Transfer now is pressed, and offers only at or
 * above a threshold (`booking_settings.transfer_offer_threshold`).
 *
 * THE PARSE IS STRICT. Anything but that one shape, a non 2xx, or a timeout is a failure
 * with its own reason, never a count of 0: a 0 would read as "nobody is free", and an
 * endpoint that had broken would look exactly like a busy afternoon (L90, L10). Slate's
 * SERVER asks it (the coordinator page's server action and the monitor lane's probe); the
 * agents' browsers never do, so their allow list does not grow.
 *
 * Pure: the fetch is handed in, so scripts/test-transfer-queue.ts drives every branch.
 */

export const TRANSFER_QUEUE_URL = "https://queues.trypennie.app/boomsource-inbound-transfer";

/**
 * How long the endpoint gets to answer. The coordinator has the customer on the line, so
 * a slow answer is no answer: past this the page says live transfer can't be checked and
 * booking carries on as it always has.
 */
export const TRANSFER_QUEUE_TIMEOUT_MS = 3_000;

/** The answer is about a hundred bytes; a body far past that is not the answer. */
const MAX_BODY_CHARS = 64_000;

export type TransferQueueFailure = "timeout" | "network" | "status" | "not-json" | "shape";

export type TransferQueueReading =
  | { ok: true; free: number }
  | { ok: false; why: TransferQueueFailure; detail: string };

const refuse = (why: TransferQueueFailure, detail: string): TransferQueueReading => ({ ok: false, why, detail });

/** The endpoint's answer, read strictly. */
export function parseTransferQueue(status: number, contentType: string | null, body: string): TransferQueueReading {
  if (status < 200 || status > 299) return refuse("status", `answered ${status}`);
  if (!/^application\/json\b/i.test((contentType ?? "").trim())) {
    return refuse("not-json", `answered ${contentType ?? "no content type"}`);
  }
  if (body.length > MAX_BODY_CHARS) return refuse("shape", `answered ${body.length} characters`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return refuse("not-json", "answered a body that is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refuse("shape", "answered JSON that is not an object");
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.queue !== "string" || o.queue === "") return refuse("shape", "answered no queue");
  if (typeof o.queueId !== "string" || o.queueId === "") return refuse("shape", "answered no queueId");
  const free = o.availableAgents;
  if (typeof free !== "number" || !Number.isSafeInteger(free) || free < 0) {
    return refuse("shape", "answered no whole availableAgents");
  }
  return { ok: true, free };
}

/** What the fetch is handed: the deadline's signal and the JSON accept header. */
export type TransferQueueFetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<Response>;

const isAbort = (err: unknown) =>
  err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");

/**
 * Ask the endpoint once, inside `timeoutMs` for the whole exchange, body included. Never
 * throws: every way it can fail is a reading that says which.
 */
export async function readTransferQueue(
  fetchImpl: TransferQueueFetch,
  timeoutMs: number = TRANSFER_QUEUE_TIMEOUT_MS,
): Promise<TransferQueueReading> {
  const signal = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(TRANSFER_QUEUE_URL, { signal, headers: { accept: "application/json" } });
  } catch (err) {
    if (isAbort(err)) return refuse("timeout", `no answer within ${timeoutMs}ms`);
    return refuse("network", err instanceof Error ? err.message : String(err));
  }
  let body: string;
  try {
    body = await res.text();
  } catch (err) {
    if (isAbort(err)) return refuse("timeout", `no whole answer within ${timeoutMs}ms`);
    return refuse("network", err instanceof Error ? err.message : String(err));
  }
  return parseTransferQueue(res.status, res.headers.get("content-type"), body);
}

/** The two settings the offer reads (`booking_settings`, migration 0212). */
export interface TransferOfferSettings {
  /** Free advisors at or above which the page offers the transfer. */
  threshold: number;
  /** The line the partner agent transfers the customer to, as 786-504-0671. */
  line: string;
}

/** The column defaults in migration 0212, for an org whose settings row does not exist yet. */
export const TRANSFER_OFFER_DEFAULTS: TransferOfferSettings = { threshold: 3, line: "786-504-0671" };

/** The bounds the settings form and the column's check share. */
export const TRANSFER_THRESHOLD_MIN = 1;
export const TRANSFER_THRESHOLD_MAX = 100;

/** A transfer line as the page shows it and the column's check holds it: 786-504-0671. */
export function isTransferLine(s: string): boolean {
  return /^[0-9]{3}-[0-9]{3}-[0-9]{4}$/.test(s);
}

/**
 * What the page draws: the offer with its line, nothing (too few free), or the plain line
 * that live transfer can't be checked, saying whether the count or the settings failed.
 */
export type TransferOffer =
  | { kind: "offer"; line: string }
  | { kind: "busy" }
  | { kind: "unreadable"; why: "count" | "settings" };

export function decideTransferOffer(reading: TransferQueueReading, settings: TransferOfferSettings | null): TransferOffer {
  if (settings === null) return { kind: "unreadable", why: "settings" };
  if (!reading.ok) return { kind: "unreadable", why: "count" };
  return reading.free >= settings.threshold ? { kind: "offer", line: settings.line } : { kind: "busy" };
}
