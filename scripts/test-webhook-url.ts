// Webhook endpoint URL validation (#1032). Every booking event (lead name,
// email, phone) and the Regal API key Authorization header are POSTed to this
// URL, so an http:// endpoint would send all of it in plaintext. The pure check
// lives in src/lib/webhooks/url.ts; this exercises it.
// Run: node --experimental-strip-types scripts/test-webhook-url.ts
import { webhookUrlError } from "../src/lib/webhooks/url.ts";
import { assert, finish } from "./lib/harness.ts";

const prevEnv = process.env.NODE_ENV;

// https is always accepted.
assert(webhookUrlError("https://events.regalvoice.com/events") === null, "https URL accepted");
assert(webhookUrlError("https://x.example/hook?a=1") === null, "https URL with path/query accepted");

// http is rejected (the whole point: plaintext PII + API key).
assert(webhookUrlError("http://events.regalvoice.com/events") !== null, "http URL rejected");
assert(webhookUrlError("http://malicious.example/collect") !== null, "http non-localhost rejected");

// http localhost is allowed ONLY in development (a local receiver).
process.env.NODE_ENV = "development";
assert(webhookUrlError("http://localhost:4000/hook") === null, "http localhost accepted in dev");
assert(webhookUrlError("http://127.0.0.1:4000/hook") === null, "http 127.0.0.1 accepted in dev");
process.env.NODE_ENV = "production";
assert(webhookUrlError("http://localhost:4000/hook") !== null, "http localhost REJECTED in production");
process.env.NODE_ENV = prevEnv;

// Non-http(s) schemes and garbage are rejected.
assert(webhookUrlError("ftp://x.example/hook") !== null, "ftp scheme rejected");
assert(webhookUrlError("not a url") !== null, "unparseable URL rejected");
assert(webhookUrlError("") !== null, "empty string rejected");

finish();
