// The two outbound webhook credentials are Worker secrets (#3091). This pins the
// contract half: the Worker secret is the only source, a value left in (or written
// back to) the old columns is ignored rather than becoming the credential again,
// the endpoint handed to the wire builder is a COPY carrying the resolved values,
// and an unset secret makes the builders refuse.
//
// Every value here is a fixture. No real key or secret appears in this file.
// Run: node --experimental-strip-types scripts/test-webhook-credentials.ts
import { credentialSourcesFor, resolveWebhookCredentials } from "../src/lib/webhooks/credentials.ts";
import { buildRequest } from "../src/lib/webhooks/wire.ts";
import type { WebhookEndpoint } from "../src/lib/db/types.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const row = {
  id: "ep-1",
  org_id: "o1",
  url: "https://events.regalvoice.com/events",
  format: "regal",
  events: ["booking.created"],
  active: true,
  created_at: "2026-01-01T00:00:00Z",
  auth_header: null,
  secret: null,
} as WebhookEndpoint;

const none = { regalKey: "", signingSecret: "" };
const both = { regalKey: "fixture-worker-key", signingSecret: "fixture-worker-signing" };

{
  const r = resolveWebhookCredentials(row, both);
  eq(r.endpoint.auth_header, "fixture-worker-key", "the Worker key is used");
  eq(r.endpoint.secret, "fixture-worker-signing", "the Worker signing secret is used");
  eq(r.sources, { key: "worker", signing: "worker" }, "both sources say worker");
  eq(row.auth_header, null, "the original row is not mutated");
  eq(r.endpoint.events, row.events, "every other field is carried over unchanged");
}

// The column is never a fallback any more: a value somebody wrote back is ignored.
{
  const stale = { ...row, auth_header: "fixture-db-key", secret: "fixture-db-signing" } as WebhookEndpoint;
  const r = resolveWebhookCredentials(stale, none);
  eq(r.sources, { key: "missing", signing: "missing" }, "a column value is not a source");
  eq(r.endpoint.auth_header, null, "the column key is not carried into the request");
  eq(r.endpoint.secret, null, "the column signing secret is not carried into the request");
  const winning = resolveWebhookCredentials(stale, both);
  eq(winning.endpoint.auth_header, "fixture-worker-key", "the Worker key wins over a stale column");
}

// A whitespace only Worker value is not a value.
eq(
  resolveWebhookCredentials(row, { regalKey: "  ", signingSecret: "\n" }).sources,
  { key: "missing", signing: "missing" },
  "a blank Worker secret is missing",
);

// Unset: the builders refuse rather than send unauthenticated or unsigned.
{
  const r = resolveWebhookCredentials(row, none);
  let regalRefused = false;
  try {
    buildRequest(r.endpoint, "d-1", "booking.created", {} as never);
  } catch {
    regalRefused = true;
  }
  assert(regalRefused, "a Regal request with no Worker key is refused (#600)");
  let genericRefused = false;
  try {
    buildRequest({ ...r.endpoint, format: "generic" }, "d-1", "booking.created", {} as never);
  } catch (err) {
    genericRefused = /signing secret/i.test(String(err));
  }
  assert(genericRefused, "a generic request with no signing secret is refused, never signed with an empty key");
}

eq(
  credentialSourcesFor({ regalKeySet: true, signingSecretSet: false }),
  { key: "worker", signing: "missing" },
  "presence alone decides the source, one credential at a time",
);

finish();
