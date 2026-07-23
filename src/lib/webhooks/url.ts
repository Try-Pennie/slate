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
