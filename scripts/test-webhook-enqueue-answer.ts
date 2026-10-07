// #3495: reading `enqueue_webhook_deliveries`'s answer.
//
// The function is the one place a webhook's deliveries are written, and its answer is
// what the first send goes out from: which deliveries were written, for which
// endpoint, with the payload exactly as stored. A reader that guessed at a shape it
// could not read would send nothing and call it done, which is the silent drop #1036
// and #1459 were opened about. So an answer this cannot read is REFUSED by name, and
// the committed fixture it is tested against is the same one the real database suite
// holds the function's answer to (scripts/verify-webhook-enqueue-sql.ts, L26).
//
// Run: node --experimental-strip-types scripts/test-webhook-enqueue-answer.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readEnqueueAnswer } from "../src/lib/webhooks/enqueue-answer.ts";
import { WEBHOOK_FORMATS } from "../src/lib/webhooks/formats.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** The formats the Worker passes: every one Slate knows. */
const FORMATS = Object.keys(WEBHOOK_FORMATS);
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "webhook-enqueue-answer.json"), "utf8"));

// --- the answer the function gives is read whole -------------------------------------------
{
  const read = readEnqueueAnswer(fixture, FORMATS);
  eq(read.subscribers, 2, "the subscriber count");
  eq(read.deliveries.length, 2, "both deliveries");
  eq(read.deliveries[0]!.id, "6b0f6c2e-5a3d-4a51-9a7e-1f2b3c4d5e01", "each with its id");
  eq(read.deliveries[1]!.suppressed, true, "whether it was suppressed");
  eq(read.deliveries[0]!.endpoint.format, "generic", "the endpoint it is for, whole");
  eq(read.deliveries[0]!.payload.booking_id, "bk-fixture", "and the payload as stored");
}

// --- nobody subscribed reads as zero, never as unreadable ------------------------------------
{
  const read = readEnqueueAnswer({ subscribers: 0, deliveries: [] }, FORMATS);
  eq(read.subscribers, 0, "zero subscribers is an answer");
  eq(read.deliveries.length, 0, "with no deliveries");
}

// --- an answer that cannot be read is refused, naming what was wrong -------------------------
const broken: [string, unknown, RegExp][] = [
  ["no answer at all", null, /answer/],
  ["a string", "ok", /answer/],
  ["no subscriber count", { deliveries: [] }, /subscribers/],
  ["a negative count", { subscribers: -1, deliveries: [] }, /subscribers/],
  ["no deliveries list", { subscribers: 1 }, /deliveries/],
  ["a delivery with no id", { subscribers: 1, deliveries: [{ ...fixture.deliveries[0], id: undefined }] }, /id/],
  ["a delivery with no endpoint", { subscribers: 1, deliveries: [{ ...fixture.deliveries[0], endpoint: null }] }, /endpoint/],
  ["an endpoint with no url", { subscribers: 1, deliveries: [{ ...fixture.deliveries[0], endpoint: { ...fixture.deliveries[0].endpoint, url: undefined } }] }, /url/],
  ["an endpoint with no created_at", { subscribers: 1, deliveries: [{ ...fixture.deliveries[0], endpoint: { ...fixture.deliveries[0].endpoint, created_at: undefined } }] }, /created_at/],
  ["an endpoint of a format Slate does not know", { subscribers: 1, deliveries: [{ ...fixture.deliveries[0], endpoint: { ...fixture.deliveries[0].endpoint, format: "smtp" } }] }, /format/],
  ["a payload that is not an object", { subscribers: 1, deliveries: [{ ...fixture.deliveries[0], payload: "x" }] }, /payload/],
  ["suppressed not a boolean", { subscribers: 1, deliveries: [{ ...fixture.deliveries[0], suppressed: "no" }] }, /suppressed/],
  ["more deliveries than subscribers", { subscribers: 1, deliveries: fixture.deliveries }, /subscribers/],
];
for (const [label, answer, says] of broken) {
  let threw: unknown = null;
  try {
    readEnqueueAnswer(answer, FORMATS);
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof Error && says.test(threw.message), `${label} is refused, naming it (got ${threw instanceof Error ? threw.message : "no refusal"})`);
}

finish();
