/**
 * Webhook endpoint URL validation (#1032). Every booking event (lead name,
 * email, phone) and, for a Regal endpoint, the API key in the Authorization
 * header are POSTed to this URL (src/lib/webhooks/wire.ts). An http:// endpoint
 * would send all of it in plaintext, so require https. http is allowed only for
 * a localhost receiver in development.
 *
 * Returns a human-readable error message, or null when the URL is acceptable.
 * Pure (no imports beyond the global URL), so it is unit-tested off the network.
 */
export function webhookUrlError(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Enter a valid webhook URL, including https://.";
  }
  if (parsed.protocol === "https:") return null;

  const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol === "http:" && isLocalhost && process.env.NODE_ENV !== "production") {
    return null;
  }
  return "Webhook URL must use https. http would send booking contact details and the API key in plaintext.";
}

/**
 * The trail's record of an endpoint change (#3089): the HOST before and after and the
 * format before and after. Never the path or the query, which can carry a token, and
 * never a credential. `key_changed` is stated rather than left out, because the issue
 * the trail answers ("did somebody change where the Regal key goes, and the key?") asks
 * it; since #3091 the key is a Worker secret and this form cannot change it, so it is
 * always false here and a key change is a deploy step instead.
 */
export function webhookEndpointAuditDetails(
  before: { url: string; format: string } | null,
  after: { url: string; format: string },
): { host: { from: string | null; to: string | null }; format: { from: string | null; to: string }; key_changed: false } {
  return {
    host: { from: before ? webhookUrlHost(before.url) : null, to: webhookUrlHost(after.url) },
    format: { from: before?.format ?? null, to: after.format },
    key_changed: false,
  };
}

/** The host of a webhook URL, or null when it cannot be parsed. */
export function webhookUrlHost(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}
