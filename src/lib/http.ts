export interface PostJsonResult<T> {
  /** True when the server responded 2xx. */
  ok: boolean;
  /** HTTP status, or 0 when the request never completed (network failure). */
  status: number;
  /** Parsed JSON body; `{}` when the body wasn't JSON or the request failed. */
  data: T;
}

/**
 * Client-side abort ceiling for booking-flow POSTs (#626). A request still in
 * flight this long is wedged, not slow; aborting converts it to the retryable
 * `{ ok:false, status:0 }` result. Paired with the ~10s `useStalledAfter`
 * "still working" cue, this gives the three distinct states every time-taking
 * action must have (started / still-alive / failed).
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
}

/**
 * POST a JSON body from a client component and ALWAYS resolve with
 * `{ ok, status, data }`. A network rejection (flaky mobile, offline), an
 * unparseable body, or a `timeoutMs` abort all become
 * `{ ok: false, status: 0, data: {} }` rather than a thrown rejection. Callers
 * branch on the result and clear their busy state in a `finally`, so a failed
 * action surfaces an error and re-enables its control instead of freezing
 * forever (#625, #626).
 */
export async function postJson<T = Record<string, unknown>>(
  url: string,
  body: unknown,
  options: PostJsonOptions = {},
): Promise<PostJsonResult<T>> {
  return sendJson<T>("POST", url, body, options);
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
    return { ok: false, status: 0, data: {} as T };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
    return { ok: false, status: 0, data: {} as T };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
