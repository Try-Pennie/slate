/**
 * Send a Google call on a cached delegated token, and survive that token being
 * refused (#3144, L742).
 *
 * `getDelegatedToken` caches a token for most of an hour, so Google can refuse it
 * (401) while the cache still calls it good: a service account key rotated, a
 * token revoked on Google's side, a clock skew. Before this the refusal went
 * straight back to the caller and the cache kept the dead token, so every call on
 * that identity failed until the cached expiry, and each one's work was lost: an
 * insert classed "gone", a digest unsent, a directory read classed as a
 * permission refusal no retry fixes.
 *
 * So a 401 drops THAT token, mints a fresh one and resends the same call, once.
 * A second 401 is handed back as the response, so the caller's own failure path
 * reads it exactly as before and fails loudly: by then the credentials really are
 * bad, and resending again would only loop. Every other status, a 403 included,
 * is returned untouched, because a fresh token cannot fix a permission or a rate
 * limit and a resend would hide it behind a second round trip.
 *
 * Pure apart from the log line: the token source and the send are injected, so
 * `token-retry.test.ts` drives it without Google.
 */
import { log } from "@/lib/log";

/** The one status that says the TOKEN was refused, as opposed to the request. */
export const TOKEN_REFUSED_STATUS = 401;

/**
 * `getToken()` answers the cached token; `getToken(refused)` drops `refused` from
 * the cache (only if it is still the one held) and answers a fresh one.
 * `send` must be safe to call twice: it is, because a 401 means Google refused the
 * request at authentication and acted on none of it.
 */
export async function sendWithTokenRetry(
  getToken: (refused?: string) => Promise<string>,
  send: (token: string) => Promise<Response>,
): Promise<Response> {
  const token = await getToken();
  const first = await send(token);
  if (first.status !== TOKEN_REFUSED_STATUS) return first;
  // swallow-ok: this only releases the body of a refusal that is being replaced
  // by a resend; a cancel that fails changes nothing about either response.
  await first.body?.cancel().catch(() => {});
  log.warn("google-token", { msg: "cached token refused; minting a fresh one and resending once" });
  const fresh = await getToken(token);
  return send(fresh);
}
