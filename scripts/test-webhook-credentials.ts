// The two outbound webhook credentials move out of the database and into Worker
// secrets (#3091), expand then contract. This pins the expand half: the Worker
// secret wins when it is set, the database column answers only while it is not,
// the endpoint handed to the wire builder is a COPY carrying the resolved values,
// and the source is reported for each credential so the monitor can say the move
// is unfinished.
//
// Every value here is a fixture. No real key or secret appears in this file.
// Run: node --experimental-strip-types scripts/test-webhook-credentials.ts
import {
  credentialSourcesFor,
  resolveWebhookCredentials,
} from "../src/lib/webhooks/credentials.ts";
import { buildRequest } from "../src/lib/webhooks/wire.ts";
import type { WebhookEndpoint } from "../src/lib/db/types.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const regalRow = {
  id: "ep-1",
  org_id: "o1",
  url: "https://events.regalvoice.com/events",
  format: "regal",
  events: ["booking.created"],
  active: true,
  created_at: "2026-01-01T00:00:00Z",
  auth_header: "fixture-db-key",
  secret: "fixture-db-signing",
} as WebhookEndpoint;

const none = { regalKey: "", signingSecret: "" };
const both = { regalKey: "fixture-worker-key", signingSecret: "fixture-worker-signing" };

// The Worker secret wins over the column.
{
  const r = resolveWebhookCredentials(regalRow, both);
  eq(r.endpoint.auth_header, "fixture-worker-key", "the Worker key is used when it is set");
  eq(r.endpoint.secret, "fixture-worker-signing", "the Worker signing secret is used when it is set");
  eq(r.sources.key, "worker", "the key source says worker");
  eq(r.sources.signing, "worker", "the signing source says worker");
  // L510: a copy, so the row the caller holds is not rewritten under it.
  eq(regalRow.auth_header, "fixture-db-key", "the original row is not mutated");
  eq(r.endpoint.url, regalRow.url, "every other field is carried over unchanged");
  eq(r.endpoint.events, regalRow.events, "the subscribed events are carried over unchanged");
}

// Unset Worker secrets fall back to the column, and say so.
{
  const r = resolveWebhookCredentials(regalRow, none);
  eq(r.endpoint.auth_header, "fixture-db-key", "the column key is the fallback");
  eq(r.endpoint.secret, "fixture-db-signing", "the column signing secret is the fallback");
  eq(r.sources.key, "database", "the key source says database");
  eq(r.sources.signing, "database", "the signing source says database");
}

// A whitespace only Worker value is not a value.
{
  const r = resolveWebhookCredentials(regalRow, { regalKey: "  ", signingSecret: "\n" });
  eq(r.sources.key, "database", "a blank Worker key does not shadow the column");
  eq(r.sources.signing, "database", "a blank Worker signing secret does not shadow the column");
}

// Neither place holds it: missing, and the builders refuse rather than send.
{
  const empty = { ...regalRow, auth_header: null, secret: "" } as WebhookEndpoint;
  const r = resolveWebhookCredentials(empty, none);
  eq(r.sources.key, "missing", "no key anywhere is missing");
  eq(r.sources.signing, "missing", "no signing secret anywhere is missing");
  let regalRefused = false;
  try {
    buildRequest(r.endpoint, "d-1", "booking.created", {} as never);
  } catch {
    regalRefused = true;
  }
  assert(regalRefused, "a Regal request with no key anywhere is refused (#600)");
  let genericRefused = false;
  try {
    buildRequest({ ...r.endpoint, format: "generic" }, "d-1", "booking.created", {} as never);
  } catch (err) {
    genericRefused = /signing secret/i.test(String(err));
  }
  assert(genericRefused, "a generic request with no signing secret is refused, never signed with an empty key");
}

// The column being nulled (the contract half) leaves the Worker secret in charge.
{
  const contracted = { ...regalRow, auth_header: null, secret: null } as unknown as WebhookEndpoint;
  const r = resolveWebhookCredentials(contracted, both);
  eq(r.sources.key, "worker", "after the contract the key still resolves from the Worker");
  const req = buildRequest(r.endpoint, "d-2", "booking.created", {
    booking_id: "b",
    starts_at: "2026-06-25T13:00:00.000Z",
    ends_at: "2026-06-25T13:20:00.000Z",
    status: "confirmed",
    attendee: { name: "Dana Lead", email: "dana@example.com", phone: "+12035615295" },
    agent: { name: "A", email: "a@trypennie.com" },
  } as never);
  eq(req.headers.authorization, "fixture-worker-key", "the wire request carries the Worker key");
}

// The presence only form the monitor and the admin page use: booleans in, never values.
{
  eq(
    credentialSourcesFor({ hasDbKey: true, hasDbSigning: true }, { regalKeySet: true, signingSecretSet: false }),
    { key: "worker", signing: "database" },
    "presence alone decides the source, one credential at a time",
  );
  eq(
    credentialSourcesFor({ hasDbKey: false, hasDbSigning: false }, { regalKeySet: false, signingSecretSet: false }),
    { key: "missing", signing: "missing" },
    "nothing anywhere is missing",
  );
}

finish();
