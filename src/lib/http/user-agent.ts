/** How much of a browser's user agent is worth keeping in a log line. */
export const LOGGED_USER_AGENT_MAX = 300;

/**
 * The browser that sent a request, as a log field: the `user-agent` header cut to
 * `LOGGED_USER_AGENT_MAX` characters, or null when the browser sent none (so `log` drops
 * the field rather than writing an empty one).
 *
 * For a public beacon (a CSP report, a client error) it is the first thing to know about a
 * report, which browser sent it, and without it on the line answering that takes a second
 * query of the request records. A user agent names a browser and a platform, never a lead's
 * contact details, and carries no URL. It is a stranger's text, which is why it is cut.
 */
export function loggedUserAgent(headers: Headers): string | null {
  return (headers.get("user-agent") ?? "").slice(0, LOGGED_USER_AGENT_MAX) || null;
}
