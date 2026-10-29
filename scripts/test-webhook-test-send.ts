// The test send's target rules, and what its body may carry (#1951).
//
// The destination is a URL somebody typed into a box, so whoever controls it
// sees everything sent. That makes these refusals the whole safety of the
// feature, and every one of them is driven here rather than trusted to the
// server action's ordering.
//
// Run: node --experimental-strip-types scripts/test-webhook-test-send.ts
import { assert, finish } from "./lib/harness.ts";
import {
  TEST_SEND_AUTH,
  TEST_SEND_SECRET,
  TEST_SEND_PAYLOAD,
  TEST_SEND_BODY_LIMIT,
  testSendTargetError,
  summariseTestResponse,
} from "@/lib/webhooks/test-send";
import { buildRequest } from "@/lib/webhooks/wire";
import type { WebhookEndpoint } from "@/lib/db/types";

const LIVE = "https://events.regalvoice.com/events";

/** The refusal message, or "" when the target is accepted. */
const why = (t: string, configured: readonly string[] = [LIVE]) => testSendTargetError(t, configured) ?? "";

// --- a good target is accepted, or every refusal below proves nothing --------
assert(
  why("https://webhook.site/8f3a-4c1e") === "",
  `a public https scratch URL is accepted (got: ${why("https://webhook.site/8f3a-4c1e")})`,
);
assert(why("  https://webhook.site/x  ") === "", "surrounding spaces are trimmed, not refused");

// --- the scheme --------------------------------------------------------------
assert(why("") !== "", "an empty field is refused");
assert(why("webhook.site/x") !== "", "an address with no scheme is refused");
assert(why("http://webhook.site/x") !== "", "http is refused, so the request cannot be read in transit");
// Deliberately stricter than the CONFIGURED endpoint's rule, which allows http
// on localhost in development. This field is typed by an operator and the same
// code serves production.
assert(why("http://localhost:3000/hook") !== "", "http on localhost is refused here");
assert(why("ftp://webhook.site/x") !== "", "a scheme that is not https is refused");
assert(why("file:///etc/passwd") !== "", "a file URL is refused");

// --- credentials in the URL --------------------------------------------------
assert(
  why("https://user:secret@webhook.site/x") !== "",
  "a URL carrying a username and password is refused rather than sent",
);

// --- the addresses an operator supplied fetch must not reach -----------------
const UNREACHABLE = [
  "https://127.0.0.1/x",
  "https://127.1.2.3/x",
  "https://0.0.0.0/x",
  "https://localhost/x",
  "https://something.localhost/x",
  "https://box.local/x",
  "https://svc.internal/x",
  "https://10.0.0.5/x",
  "https://172.16.4.9/x",
  "https://172.31.255.254/x",
  "https://192.168.1.1/x",
  // The one that turns a fetch into a credential read on most cloud providers.
  "https://169.254.169.254/latest/meta-data/",
  "https://metadata.google.internal/x",
  "https://100.64.0.1/x",
  "https://239.1.1.1/x",
  "https://[::1]/x",
  "https://[fe80::1]/x",
  "https://[fc00::1]/x",
];
const reachable = UNREACHABLE.filter((u) => why(u) === "");
assert(
  reachable.length === 0,
  `every private, local or metadata address is refused:\n    ${reachable.join("\n    ")}`,
);

// And the neighbours of those ranges are NOT refused, or the rule is just a
// blanket no and the list above proves nothing about it (L104).
const PUBLIC = [
  "https://172.15.0.1/x",
  "https://172.32.0.1/x",
  "https://192.167.1.1/x",
  "https://11.0.0.1/x",
  "https://100.63.0.1/x",
  "https://126.0.0.1/x",
  "https://128.0.0.1/x",
  "https://169.253.0.1/x",
  "https://8.8.8.8/x",
];
const wronglyRefused = PUBLIC.filter((u) => why(u) !== "");
assert(
  wronglyRefused.length === 0,
  `an address just outside each range is still accepted:\n    ${wronglyRefused.join("\n    ")}`,
);

// --- the live endpoint cannot be targeted ------------------------------------
//
// The whole safety of sending at a typed URL is that nothing reaches Regal.
assert(why(LIVE) !== "", "the configured endpoint is refused");
assert(
  why("https://events.regalvoice.com/somewhere-else") !== "",
  "a different path on the live host is refused too, since the host IS the destination",
);
assert(
  why("https://EVENTS.REGALVOICE.COM/events") !== "",
  "the host match ignores case, which a URL's host is anyway",
);
assert(
  why("https://webhook.site/x", []) === "",
  "with no endpoint configured there is nothing to collide with",
);
// #4381: an org can hold a second live endpoint (the dialer's lead sender), and
// its host is a real destination too, so it is refused like the primary.
assert(
  why("https://queues.example.com/scratch", [LIVE, "https://queues.example.com/sender"]) !== "",
  "the host of ANY live endpoint is refused, not only the primary one",
);
// A malformed stored URL is accepted rather than refused, deliberately: a URL
// `new URL()` cannot read is not a reachable destination either, since `emit`
// builds its request from the same string, so there is nothing for the collision
// rule to protect and refusing would leave a dead control.
assert(
  why("https://webhook.site/x", "not a url") === "",
  "an unreadable configured URL does not break the target check",
);
// It must not throw, and it must still apply every OTHER rule: a fallback that
// skipped the whole check would let a private address through on the same input.
assert(
  why("https://10.0.0.1/x", "not a url") !== "",
  "an unreadable configured URL does not switch off the address rules",
);
assert(
  why("http://webhook.site/x", "not a url") !== "",
  "an unreadable configured URL does not switch off the scheme rule",
);

// --- the body carries no real data, and no real credential -------------------
const sample = JSON.stringify(TEST_SEND_PAYLOAD);
assert(
  /example\.invalid/.test(sample),
  "the sample contact details use an unresolvable domain, so nothing can be delivered to them",
);
assert(
  !/trypennie\.com/.test(sample.replace(/slate\.trypennie\.app/g, "")),
  "no real agent address is in the sample payload",
);
assert(
  TEST_SEND_AUTH.includes("not-a-real-key"),
  "the Authorization value says in its own text that it is not the real key",
);
assert(
  TEST_SEND_SECRET.includes("not-the-real"),
  "the signing secret says in its own text that it is not the real one",
);

// The SHAPE has to be the real one, or the test proves nothing about what
// ships. Built through the real builder, with every field present.
const missing = (
  ["booking_id", "bucket_code", "event_type", "starts_at", "ends_at", "timezone",
   "status", "agent", "attendee", "prefill", "manage_url", "routing"] as const
).filter((k) => !(k in TEST_SEND_PAYLOAD));
assert(missing.length === 0, `the sample carries every field the live payload does: ${missing.join(", ")}`);

const regal = buildRequest(
  { id: "ep", format: "regal", url: LIVE, auth_header: TEST_SEND_AUTH, secret: TEST_SEND_SECRET } as unknown as WebhookEndpoint,
  "delivery-1",
  "booking.created",
  TEST_SEND_PAYLOAD,
  "2026-01-05T14:00:00.000Z",
);
assert(
  regal.headers.authorization === TEST_SEND_AUTH,
  "a regal test send carries the placeholder key, so #600's refusal is satisfied without the real one",
);
const generic = buildRequest(
  { id: "ep", format: "generic", url: LIVE, auth_header: null, secret: TEST_SEND_SECRET } as unknown as WebhookEndpoint,
  "delivery-1",
  "booking.created",
  TEST_SEND_PAYLOAD,
  "2026-01-05T14:00:00.000Z",
);
assert(
  typeof generic.headers["x-slate-signature"] === "string" &&
    generic.headers["x-slate-signature"].startsWith("sha256="),
  "a generic test send is really signed, so the mechanism is what gets inspected",
);

// --- the response is reported, not merely judged -----------------------------
const ok = summariseTestResponse(200, '{"echo":true}');
assert(ok.ok && ok.status === 200 && ok.body === '{"echo":true}', "a 200 reports its own body back");
const bad = summariseTestResponse(500, "boom");
assert(!bad.ok && bad.status === 500 && bad.body === "boom", "a failure reports the status AND the body");
assert(
  summariseTestResponse(204, "   ").body.length > 0,
  "an empty body is said in words rather than rendered as nothing",
);
const long = summariseTestResponse(200, "x".repeat(TEST_SEND_BODY_LIMIT + 500));
assert(
  long.truncated && long.body.length === TEST_SEND_BODY_LIMIT,
  "a long body is cut and SAYS it was cut, so nobody reads a half response as the whole one",
);
assert(!ok.truncated, "a short body is not reported as truncated");
// A 3xx is not a success: a receiver that redirects has not accepted anything.
assert(!summariseTestResponse(302, "").ok, "a redirect is not reported as a successful delivery");

finish();
