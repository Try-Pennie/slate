import type { BookingEventPayload } from "./types.ts";

/**
 * The rules for a test webhook send (#1951).
 *
 * Dan's ask: "there's nothing that makes me confident in the shape of the
 * webhook. I'd want to see an example and have a way to test." His call, over a
 * preview only panel and over firing at the configured endpoint, was a field
 * where he pastes a scratch endpoint (webhook.site or similar) and Slate sends a
 * real POST at it, so the actual request, headers and body can be inspected.
 *
 * Pure, so every refusal is unit-tested off the network.
 *
 * THE WHOLE SAFETY OF THAT CHOICE RESTS ON THE TARGET RULES BELOW, because the
 * destination is a URL somebody typed, and whoever controls it sees everything
 * we send. Three things therefore never leave the system:
 *
 * THE REAL LEAD DATA. A stored payload holds a lead's name, email and phone. The
 * page may SHOW one, because the page is admin gated; a test send may not carry
 * one, because a pasted URL is not. So the body is built from
 * `TEST_SEND_PAYLOAD` below, whose every value is visibly a sample. The shape is
 * real (it goes through the same `buildRequest` the live path uses, so the
 * headers, the signature and the field names are exactly what ships); only the
 * values are invented. That is what makes the request worth inspecting and safe
 * to press repeatedly.
 *
 * THE REAL REGAL KEY. `buildRequest` refuses to build a regal request without
 * one (#600), so a test in that format needs a key, and sending the live one to a
 * scratch URL would hand it over. It carries `TEST_SEND_AUTH` instead, which says
 * what it is in its own value.
 *
 * THE REAL SIGNING SECRET. The generic format signs the body, and a signature
 * made with the live secret is a valid artifact for a body we chose, sent
 * somewhere we do not control. `TEST_SEND_SECRET` signs instead, so the
 * signature demonstrates the mechanism (the header is there, over
 * `timestamp.body`) without being one a real subscriber would accept.
 */

/** The Authorization value a test send carries, in place of the real key. */
export const TEST_SEND_AUTH = "slate-test-send-not-a-real-key";

/** The HMAC secret a test send signs with, in place of the real one. */
export const TEST_SEND_SECRET = "slate-test-send-not-the-real-signing-secret";

/**
 * The body of a test send. Every value is visibly a sample, and that is the
 * point: this leaves the system to an address somebody typed.
 */
export const TEST_SEND_PAYLOAD: BookingEventPayload = {
  booking_id: "00000000-0000-4000-8000-000000000000",
  salesforce_id: "SAMPLE-SF-ID",
  bucket_code: "411",
  event_type: "Senior Loan Advisor Call",
  event_type_slug: "senior-loan-advisor-call",
  event_description: "A sample event, sent by the test button in Slate admin.",
  starts_at: "2026-01-05T14:00:00.000Z",
  ends_at: "2026-01-05T14:20:00.000Z",
  timezone: "America/New_York",
  status: "confirmed",
  agent: {
    id: "00000000-0000-4000-8000-00000000a9e7",
    name: "Sample Agent",
    email: "sample.agent@example.invalid",
  },
  attendee: {
    name: "Sample Lead",
    email: "sample.lead@example.invalid",
    phone: "+10000000000",
  },
  // Every field the live payload carries is present, including the ones a
  // subscriber branches on, because a sample missing a field teaches its reader
  // that the field is optional (L167).
  prefill: { xbc: "411", utm_source: "sample" },
  manage_url: "https://slate.trypennie.app/booking/manage/sample-token",
  reason: null,
  // Null on every event but booking.reassigned (#2368), which is what a sample
  // booking.created carries; the key is present so its absence is never read as
  // the field being optional.
  previous_agent_email: null,
  routing: {
    empty_pool_fallback: false,
    tier_fallback: false,
    requested_tier: "411",
    booked_tier: "411",
    rungs_dropped: 0,
  },
};

/**
 * Hostnames that name the machine running the code, or a cloud instance's own
 * metadata service. `example.invalid` is not here: it is deliberately
 * unresolvable and is what the sample payload uses.
 */
const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
]);

/** Whether a hostname is a literal IPv4 address, and its four octets if so. */
function ipv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? nums : null;
}

/**
 * Whether a literal address is one nobody outside this machine or network can
 * reach, which is the set an operator supplied fetch must not be pointed at.
 *
 * WHAT THIS CANNOT DO, said here rather than left to be assumed: it judges the
 * ADDRESS AS WRITTEN. A hostname that RESOLVES to one of these ranges is not
 * caught, because resolving it would need a DNS lookup this runtime does not
 * offer and the answer could change between the check and the fetch anyway. What
 * limits the damage is where the code runs: the Worker sits on Cloudflare's edge
 * with no private network of ours behind it, so the reachable set is small. The
 * literal ranges are still refused, because they are the ones somebody reaches
 * for, and 169.254.169.254 in particular is the address that turns a fetch into a
 * credential read on most cloud providers.
 */
function isUnreachableAddress(host: string): boolean {
  const lower = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (LOCAL_HOSTNAMES.has(lower)) return true;
  if (lower.endsWith(".localhost") || lower.endsWith(".local") || lower.endsWith(".internal")) {
    return true;
  }
  // IPv6 loopback, unspecified, link-local (fe80::/10) and unique local (fc00::/7).
  if (lower === "::1" || lower === "::") return true;
  if (/^fe[89ab]/.test(lower) || /^f[cd]/.test(lower)) return true;

  const octets = ipv4(lower);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 0 || a === 127) return true; // this host
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link local, and the metadata address
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier grade NAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/**
 * Whether a target is acceptable for a test send, as a message to show or null.
 *
 * Deliberately stricter than `webhookUrlError`, which governs the CONFIGURED
 * endpoint: that one allows http on localhost in development, which is right for
 * a receiver a developer is running and wrong for a field an operator types
 * into, since the same code path serves both in production.
 */
export function testSendTargetError(target: string, configuredUrls: readonly string[]): string | null {
  const raw = target.trim();
  if (!raw) return "Paste a URL to send the test to.";

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "That is not a URL. Paste the whole address, starting with https://.";
  }
  if (url.protocol !== "https:") {
    return "The test can only be sent to an https address, so the request cannot be read in transit.";
  }
  if (url.username || url.password) {
    return "Take the username and password out of the URL. Slate will not send credentials embedded in an address.";
  }
  if (isUnreachableAddress(url.hostname)) {
    return "That address is on a private or local network, which Slate will not fetch. Use a public URL such as a webhook.site address.";
  }

  // Every configured endpoint is refused by HOST, not by exact URL. The reason to
  // refuse one is that the test must not reach a real destination, and a
  // different path on the same host is still that destination. An org can hold
  // more than one live endpoint (#4381: the dialer's lead sender beside Regal), so
  // every one of them is checked, not only the one the page edits.
  for (const configuredUrl of configuredUrls) {
    let configured: URL | null = null;
    try {
      configured = new URL(configuredUrl);
    } catch {
      configured = null;
    }
    // A stored URL `new URL()` cannot read is deliberately NOT a refusal, and the
    // reason is that it is not a reachable destination either: `emit` builds its
    // request from the same string, so nothing is being delivered to it and there
    // is nothing for this rule to protect. Refusing here would leave a dead
    // control with no safety bought, which is the trade the fail closed reading
    // would make.
    if (configured && configured.hostname.toLowerCase() === url.hostname.toLowerCase()) {
      return "That is the host your live endpoint is on. The test is for a scratch URL, so nothing reaches the real destination.";
    }
  }
  return null;
}

/** How much of a response body to show. Enough to read an echo, not a page. */
export const TEST_SEND_BODY_LIMIT = 2000;

/**
 * What the scratch endpoint said, as something readable.
 *
 * The point of the test is confidence, so the STATUS and the BODY are both
 * surfaced: a green tick proves less than a 200 with the echoed body. An empty
 * body is said in words rather than rendered as nothing, because a blank panel
 * beside a 200 reads as a failed read rather than as a receiver that answers
 * with no content (L10).
 */
export function summariseTestResponse(status: number, body: string): {
  ok: boolean;
  status: number;
  body: string;
  truncated: boolean;
} {
  const trimmed = body.trim();
  return {
    ok: status >= 200 && status < 300,
    status,
    body: trimmed.length > TEST_SEND_BODY_LIMIT
      ? trimmed.slice(0, TEST_SEND_BODY_LIMIT)
      : trimmed || "The endpoint answered with an empty body.",
    truncated: trimmed.length > TEST_SEND_BODY_LIMIT,
  };
}
