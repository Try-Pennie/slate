import { pauseBeforeResend, resendOnce } from "@/lib/resend-once";

export interface PostJsonResult<T> {
  /** True when the server responded 2xx. */
  ok: boolean;
  /** HTTP status, or 0 when the request never completed (a network failure, or the `timeoutMs` abort). */
  status: number;
  /** Parsed JSON body; `{}` when the body wasn't JSON or the request failed. */
  data: T;
  /**
   * Present, and true, only when this helper's own `timeoutMs` cut the request off
   * (#3307). The server may still finish the work after the client stops waiting:
   * the reroute search answered 200 after 24 seconds, having held an advisor, while
   * its panel had given up at 20 and said the server was unreachable. So a caller
   * can tell "no answer in time" from "the network failed" and say which. Absent on
   * every other result, so a caller that does not read it behaves exactly as before.
   */
  timedOut?: true;
}

/**
 * Client-side abort ceiling for booking-flow POSTs (#626). A request still in
 * flight this long is treated as failed, which turns a wedged one into the
 * retryable `{ ok:false, status:0 }` result rather than an endless wait. It is not
 * proof the server gave up: a slow one can still finish, which is why the result
 * says `timedOut` (#3307). Paired with the ~10s `useStalledAfter` "still working"
 * cue, this gives the three distinct states every time-taking action must have
 * (started / still-alive / failed).
 */
export const REQUEST_TIMEOUT_MS = 20000;

export interface GetJsonOptions extends PostJsonOptions {
  /**
   * Passed straight to `fetch` (#1364). The availability reads must not be served
   * from a cache: a lead pressing "see our next available days" is asking what is
   * free NOW, and a cached answer would offer a slot that has since gone. Kept as
   * an option on the shared helper rather than having the caller hand-roll its own
   * fetch, which is how it ended up without a timeout in the first place.
   */
  cache?: RequestCache;
}

export interface PostJsonOptions {
  /**
   * Abort the request after this many ms so a wedged connection (server accepted
   * but never responds) becomes the retryable `{ ok:false, status:0 }` result
   * instead of awaiting forever (#626). Omit to wait indefinitely (default).
   */
  timeoutMs?: number;
  /**
   * Extra request headers (#2666: the public test bucket's pass). Undefined sends
   * the request exactly as before, so a caller with nothing to add is unchanged.
   */
  headers?: Record<string, string>;
  /**
   * #3566: send a request whose connection dropped (no reply of any kind, and not
   * this helper's own timeout) ONCE more after a short pause, through the one rule
   * the load driver shares (`resendOnce`). Only for a request the server collapses
   * onto the first when both arrive, as a booking confirm does by its idempotency
   * key; anything else could act twice. Undefined sends it once, as before.
   */
  resendOnDrop?: true;
}

/**
 * POST a JSON body from a client component and ALWAYS resolve with
 * `{ ok, status, data }`. A network rejection (flaky mobile, offline) or a
 * `timeoutMs` abort becomes `{ ok: false, status: 0, data: {} }` (the abort also
 * carries `timedOut: true`), and an unparseable body keeps its status with
 * `data: {}`, rather than a thrown rejection. Callers
 * branch on the result and clear their busy state in a `finally`, so a failed
 * action surfaces an error and re-enables its control instead of freezing
 * forever (#625, #626).
 */
export async function postJson<T = Record<string, unknown>>(
  url: string,
  body: unknown,
  options: PostJsonOptions = {},
): Promise<PostJsonResult<T>> {
  const send = () => sendJson<T>("POST", url, body, options);
  if (!options.resendOnDrop) return send();
  return (await resendOnce(send, droppedConnection, pauseBeforeResend)).result;
}

/** A request that got no reply and was not cut off by this helper's own timeout. */
function droppedConnection(r: PostJsonResult<unknown>): boolean {
  return r.status === 0 && !r.timedOut;
}

/**
 * DELETE from a client component, on the same always-resolves contract as
 * `postJson` (#3250: releasing a reroute hold). No request body.
 */
export async function deleteJson<T = Record<string, unknown>>(
  url: string,
  options: PostJsonOptions = {},
): Promise<PostJsonResult<T>> {
  return sendJson<T>("DELETE", url, undefined, options);
}

/** The one body behind `postJson` and `deleteJson`; `undefined` sends no body. */
async function sendJson<T>(
  method: "POST" | "DELETE",
  url: string,
  body: unknown,
  options: PostJsonOptions,
): Promise<PostJsonResult<T>> {
  const controller = options.timeoutMs != null ? new AbortController() : null;
  const timer =
    controller && options.timeoutMs != null
      ? setTimeout(() => controller.abort(), options.timeoutMs)
      : null;
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? options.headers : { ...options.headers, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller?.signal,
    });
    const data = (await res.json().catch(() => ({}))) as T;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return failedRequest<T>(controller);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * GET JSON from a client component with the SAME always-resolve contract as
 * `postJson` (#974): a network rejection or a `timeoutMs` abort becomes
 * `{ ok:false, status:0, data:{} }` (the abort marked `timedOut`), and an
 * unparseable body keeps its status with `data: {}`, rather than a throw, so an
 * imperative preview/poll caller can branch on the result and show a distinct
 * failed state instead of hanging. `useFetchList` is the declarative list hook;
 * this is for one-off / polled reads.
 */
export async function getJson<T = Record<string, unknown>>(
  url: string,
  options: GetJsonOptions = {},
): Promise<PostJsonResult<T>> {
  const controller = options.timeoutMs != null ? new AbortController() : null;
  const timer =
    controller && options.timeoutMs != null
      ? setTimeout(() => controller.abort(), options.timeoutMs)
      : null;
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller?.signal,
      ...(options.cache ? { cache: options.cache } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    });
    const data = (await res.json().catch(() => ({}))) as T;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return failedRequest<T>(controller);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The result for a request that never completed. Marked `timedOut` only when this
 * helper's own timer aborted it, judged by that timer's signal rather than by the
 * error's name, so an abort from anywhere else is never reported as a slow server.
 */
function failedRequest<T>(controller: AbortController | null): PostJsonResult<T> {
  if (controller?.signal.aborted) return { ok: false, status: 0, data: {} as T, timedOut: true };
  return { ok: false, status: 0, data: {} as T };
}
