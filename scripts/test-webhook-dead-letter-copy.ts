// What the webhook dead letter page is allowed to say about a subscriber's reply
// (#2418).
//
// The page used to carry `${res.status} ${body.slice(0, 1000)}`, so when a WAF or
// CDN in front of the subscriber blocked Slate's shared Workers egress address and
// answered 403 with an HTML block page, the person on call got a kilobyte of
// `<!DOCTYPE html>...` cut mid tag. The Ray ID their firewall log can be searched
// by was somewhere inside it or past the cut, and nothing said the API had never
// seen the request. A 401 from the API itself read exactly the same way, so the
// reader could not tell "our key is wrong" from "we never reached them", which are
// two different people's problems (L11).
//
// Both halves are pure, so this is a node script rather than a vitest file: the
// classifier takes a reply it is handed and the builder takes what the classifier
// decided. Nothing here touches the network, the clock, or a module mock.
//
// Run: node --experimental-strip-types scripts/test-webhook-dead-letter-copy.ts
import { summarizeWebhookReply } from "../src/lib/webhooks/response-summary.ts";
import { webhookDeadAlert } from "../src/lib/monitor/cron-alert-copy.ts";
import { shortFailureReason } from "../src/lib/notify/error-text.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const URL = "https://hooks.regal.io/slate/bookings";
const EVENT = "booking.created";
const ATTEMPT = 5;
const RAY = "8f2c1a9b4d5e6f70-EWR";

/** Exactly what `send()` does with a summary, so this measures the shipped path. */
function pageFor(reply: Parameters<typeof summarizeWebhookReply>[0]): string {
  const summary = summarizeWebhookReply(reply);
  return webhookDeadAlert(URL, EVENT, ATTEMPT, shortFailureReason(summary.lastResponse) ?? "no detail", {
    intermediary: summary.intermediary,
  });
}

// --- an intermediary's block page ---------------------------------------------
//
// The real shape: Cloudflare's own 403 interstitial, far longer than any alert.

const BLOCK_PAGE =
  '<!DOCTYPE html><html lang="en-US"><head><title>Attention Required! | Cloudflare</title>' +
  '<meta charset="UTF-8" /><style>body{margin:0}</style></head><body>' +
  "<h1>Sorry, you have been blocked</h1><p>You are unable to access regal.io</p>" +
  "<p>Ray ID: 8f2c1a9b4d5e6f70</p>".repeat(20) +
  "</body></html>";

const blocked = summarizeWebhookReply({
  status: 403,
  contentType: "text/html; charset=UTF-8",
  cfRay: RAY,
  body: BLOCK_PAGE,
});
assert(blocked.intermediary, "an HTML block page is classified as an intermediary");

const blockedPage = pageFor({
  status: 403,
  contentType: "text/html; charset=UTF-8",
  cfRay: RAY,
  body: BLOCK_PAGE,
});

// Both directions, because a message that merely omits a forbidden word is not a
// message that makes the right claim (L347).
assert(!blockedPage.includes("<"), "the block page's markup is absent from the alert");
assert(
  !blockedPage.includes("Cloudflare") && !blockedPage.includes("you have been blocked"),
  "the block page's own text is absent from the alert",
);
assert(
  /never saw the request/.test(blockedPage),
  "the alert SAYS the subscriber's API never saw the request",
);
assert(blockedPage.includes("403"), "the alert carries the status the intermediary answered with");
assert(blockedPage.includes(RAY), "the cf-ray reaches the alert, so the partner can search their log");
assert(
  blockedPage.length < 400,
  `the alert stays readable on a phone (was ${blockedPage.length} characters)`,
);

// A body the intermediary served WITHOUT a declaring content type is still caught,
// because the leading `<` is the signal that this is a page and not an API answer.
eq(
  summarizeWebhookReply({ status: 403, contentType: null, cfRay: null, body: "<html><body>no</body></html>" })
    .intermediary,
  true,
  "a body starting with < is an intermediary even with no content type",
);

// And a content type that says HTML is caught even where the body does not start
// with a tag, because the header is the API's own statement about what it sent.
eq(
  summarizeWebhookReply({ status: 502, contentType: "text/html", cfRay: null, body: "  upstream connect error" })
    .intermediary,
  true,
  "a text/html content type is an intermediary whatever the body starts with",
);

// --- a genuine error FROM the API ---------------------------------------------

const jsonReply = summarizeWebhookReply({
  status: 401,
  contentType: "application/json",
  cfRay: RAY,
  body: '{"error":"invalid api key"}',
});
eq(jsonReply.intermediary, false, "a JSON error from the API is not labelled an intermediary");

const jsonPage = pageFor({
  status: 401,
  contentType: "application/json",
  cfRay: RAY,
  body: '{"error":"invalid api key"}',
});
assert(jsonPage.includes("401"), "a genuine API error keeps its status");
assert(jsonPage.includes("invalid api key"), "a genuine API error keeps its short reason");
assert(
  !/never saw the request/.test(jsonPage),
  "a genuine API error is NOT told to the reader as an intermediary block",
);

const textReply = summarizeWebhookReply({
  status: 500,
  contentType: "text/plain",
  cfRay: null,
  body: "queue writer unavailable",
});
eq(textReply.intermediary, false, "a plain text error from the API is not labelled an intermediary");
assert(
  pageFor({ status: 500, contentType: "text/plain", cfRay: null, body: "queue writer unavailable" }).includes(
    "queue writer unavailable",
  ),
  "a plain text error keeps its short reason",
);

// --- no body at all (a HEAD, a 204) -------------------------------------------

const empty = summarizeWebhookReply({ status: 204, contentType: null, cfRay: null, body: "" });
eq(empty.intermediary, false, "an empty reply is not guessed to be an intermediary");
const emptyPage = pageFor({ status: 204, contentType: null, cfRay: null, body: "" });
assert(emptyPage.includes("204"), "a reply with no body still names its status");
assert(
  /no reply body|no body/i.test(emptyPage),
  "a reply with no body SAYS there was no body rather than trailing off",
);
assert(
  !/no detail|undefined|null/.test(empty.lastResponse),
  "an empty body does not fall back to a placeholder that means something else",
);

// --- a body that could not be read at all -------------------------------------

const unreadable = summarizeWebhookReply({ status: 502, contentType: null, cfRay: RAY, body: null });
const unreadablePage = pageFor({ status: 502, contentType: null, cfRay: RAY, body: null });
assert(unreadablePage.includes("502"), "an unreadable reply still names its status");
assert(
  /could not be read/i.test(unreadablePage),
  "an unreadable reply says the body could not be read",
);
assert(unreadablePage.includes(RAY), "an unreadable reply hands the reader its cf-ray");

// Each of the four states must be distinguishable, or one answers for another and
// a reader is sent to the wrong place (L11).
const reasons = [blocked.lastResponse, jsonReply.lastResponse, empty.lastResponse, unreadable.lastResponse];
eq(new Set(reasons).size, reasons.length, "the four reply states each read differently");
assert(
  empty.lastResponse !== unreadable.lastResponse.replace("502", "204"),
  "no body and an unreadable body are different sentences, not the same one",
);

// --- the copy rules the repo enforces everywhere -------------------------------

for (const [name, text] of [
  ["intermediary", blockedPage],
  ["api error", jsonPage],
  ["no body", emptyPage],
  ["unreadable", unreadablePage],
] as const) {
  assert(!/^Slate\b/.test(text), `${name}: the alert does not open with the word Slate`);
  assert(
    !/[\u2014\u2013]/.test(text),
    `${name}: the alert carries no em dash or en dash`,
  );
  assert(
    !/undefined|NaN|\[object Object\]/.test(text),
    `${name}: nothing leaks into the alert`,
  );
}

finish();
