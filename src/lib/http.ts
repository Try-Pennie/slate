export interface PostJsonResult<T> {
  /** True when the server responded 2xx. */
  ok: boolean;
  /** HTTP status, or 0 when the request never completed (network failure). */
  status: number;
  /** Parsed JSON body; `{}` when the body wasn't JSON or the request failed. */
  data: T;
}

/**
 * POST a JSON body from a client component and ALWAYS resolve with
 * `{ ok, status, data }`. A network rejection (flaky mobile, offline) or an
 * unparseable body becomes `{ ok: false, status: 0, data: {} }` rather than a
 * thrown rejection. Callers branch on the result and clear their busy state in
 * a `finally`, so a failed action surfaces an error and re-enables its control
 * instead of freezing forever (#625).
 */
export async function postJson<T = Record<string, unknown>>(
  url: string,
  body: unknown,
): Promise<PostJsonResult<T>> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as T;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: {} as T };
  }
}
