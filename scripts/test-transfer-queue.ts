// The transfer queue reading and the offer it decides (#4380). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-transfer-queue.ts
//
// Pennie's transfer queue endpoint answers how many advisors are free to take a live
// transfer. The coordinator page offers "Transfer now" only at or above a threshold, so a
// reading that is not a number must never be read as one: a non 2xx, a body that is not
// JSON, a field missing or of the wrong kind, a timeout and a network failure are each an
// error with its own reason, and never a count of 0 (which would quietly read as "busy").
// This file pins:
//
//   1. the strict parse, its one accepted shape and every refusal;
//   2. the read: the signal it hands the fetch, a timeout and a network failure;
//   3. the decision: at, above and below the threshold, an unreadable count and
//      unreadable settings each refuse to offer, and say which;
//   4. the transfer line's own shape, which the settings form and the page share.
import {
  decideTransferOffer,
  isTransferLine,
  parseTransferQueue,
  readTransferQueue,
  TRANSFER_QUEUE_URL,
  type TransferQueueReading,
} from "../src/lib/coordinator/transfer-queue.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const GOOD = JSON.stringify({ queue: "boomsource-inbound-transfer", queueId: "bdc38fb5-4f7e-4703-85d7-8f3c85f7e62a", availableAgents: 19 });
const JSON_TYPE = "application/json";

// ---- 1. the parse ---------------------------------------------------------------------------
eq(parseTransferQueue(200, JSON_TYPE, GOOD), { ok: true, free: 19 }, "the endpoint's documented answer reads as 19 free");
eq(parseTransferQueue(200, "application/json; charset=utf-8", GOOD), { ok: true, free: 19 }, "a charset on the content type is fine");
eq(parseTransferQueue(200, JSON_TYPE, JSON.stringify({ queue: "q", queueId: "id", availableAgents: 0 })), { ok: true, free: 0 }, "a real zero is a reading of zero");
eq(
  parseTransferQueue(200, JSON_TYPE, JSON.stringify({ queue: "q", queueId: "id", availableAgents: 4, extra: true })),
  { ok: true, free: 4 },
  "a field the endpoint adds later does not refuse the reading",
);

const refusals: [string, number, string | null, string, string][] = [
  ["a 500", 500, JSON_TYPE, GOOD, "status"],
  ["a 404", 404, JSON_TYPE, GOOD, "status"],
  ["a 204", 204, JSON_TYPE, "", "not-json"],
  ["an HTML error page", 200, "text/html", "<html>oops</html>", "not-json"],
  ["no content type", 200, null, GOOD, "not-json"],
  ["a body that is not JSON", 200, JSON_TYPE, "{availableAgents: 3", "not-json"],
  ["a JSON array", 200, JSON_TYPE, "[3]", "shape"],
  ["a JSON null", 200, JSON_TYPE, "null", "shape"],
  ["a bare number", 200, JSON_TYPE, "3", "shape"],
  ["no availableAgents", 200, JSON_TYPE, JSON.stringify({ queue: "q", queueId: "id" }), "shape"],
  ["availableAgents as text", 200, JSON_TYPE, JSON.stringify({ queue: "q", queueId: "id", availableAgents: "19" }), "shape"],
  ["availableAgents null", 200, JSON_TYPE, JSON.stringify({ queue: "q", queueId: "id", availableAgents: null }), "shape"],
  ["a negative count", 200, JSON_TYPE, JSON.stringify({ queue: "q", queueId: "id", availableAgents: -1 }), "shape"],
  ["a fractional count", 200, JSON_TYPE, JSON.stringify({ queue: "q", queueId: "id", availableAgents: 2.5 }), "shape"],
  ["no queue", 200, JSON_TYPE, JSON.stringify({ queueId: "id", availableAgents: 3 }), "shape"],
  ["an empty queue id", 200, JSON_TYPE, JSON.stringify({ queue: "q", queueId: "", availableAgents: 3 }), "shape"],
];
for (const [label, status, type, body, why] of refusals) {
  const out = parseTransferQueue(status, type, body);
  assert(!out.ok && out.why === why, `${label} is refused as ${why}, never a count (got ${JSON.stringify(out)})`);
}

// ---- 2. the read ----------------------------------------------------------------------------
type Init = { signal: AbortSignal; headers: Record<string, string> };
async function reads() {
  let seen: { url: string; init: Init } | null = null;
  const ok = await readTransferQueue(async (url, init) => {
    seen = { url, init };
    return new Response(GOOD, { status: 200, headers: { "content-type": JSON_TYPE } });
  }, 3000);
  eq(ok, { ok: true, free: 19 }, "a good answer is read through the parse");
  const s = seen as { url: string; init: Init } | null;
  eq(s?.url, TRANSFER_QUEUE_URL, "it asks Pennie's transfer queue endpoint");
  assert(s?.init.signal instanceof AbortSignal, "it hands the fetch a signal, so a hung endpoint is cut off");
  eq(s?.init.headers.accept, JSON_TYPE, "it asks for JSON");

  const abort = (name: string) => async () => {
    throw Object.assign(new Error("aborted"), { name });
  };
  const timedOut = await readTransferQueue(abort("TimeoutError"), 3000);
  assert(!timedOut.ok && timedOut.why === "timeout", "a timeout is its own failure");
  const aborted = await readTransferQueue(abort("AbortError"), 3000);
  assert(!aborted.ok && aborted.why === "timeout", "an abort from the signal reads as the timeout it is");
  const down = await readTransferQueue(async () => {
    throw new TypeError("fetch failed");
  }, 3000);
  assert(!down.ok && down.why === "network", "a refused connection is a network failure");
  const bodyFails = await readTransferQueue(async () => {
    const r = new Response(GOOD, { status: 200, headers: { "content-type": JSON_TYPE } });
    Object.defineProperty(r, "text", { value: async () => { throw Object.assign(new Error("body cut"), { name: "TimeoutError" }); } });
    return r;
  }, 3000);
  assert(!bodyFails.ok && bodyFails.why === "timeout", "a body cut off by the timeout is the timeout, never a parse of nothing");
  const huge = await readTransferQueue(async () => new Response(" ".repeat(70_000) + GOOD, { status: 200, headers: { "content-type": JSON_TYPE } }), 3000);
  assert(!huge.ok && huge.why === "shape", "a body far larger than the answer is refused rather than parsed");
}

// ---- 3. the decision ------------------------------------------------------------------------
function decides() {
  const settings = { threshold: 3, line: "786-504-0671" };
  const reading = (free: number): TransferQueueReading => ({ ok: true, free });
  eq(decideTransferOffer(reading(3), settings), { kind: "offer", line: "786-504-0671" }, "exactly the threshold offers the transfer");
  eq(decideTransferOffer(reading(19), settings), { kind: "offer", line: "786-504-0671" }, "above the threshold offers it");
  eq(decideTransferOffer(reading(2), settings), { kind: "busy" }, "one under the threshold does not");
  eq(decideTransferOffer(reading(0), settings), { kind: "busy" }, "nobody free does not");
  eq(decideTransferOffer(reading(5), { threshold: 6, line: "786-504-0671" }), { kind: "busy" }, "the threshold is the setting's, never a constant");
  eq(
    decideTransferOffer({ ok: false, why: "timeout", detail: "x" }, settings),
    { kind: "unreadable", why: "count" },
    "a failed reading is unreadable, never busy",
  );
  eq(decideTransferOffer(reading(19), null), { kind: "unreadable", why: "settings" }, "unreadable settings offer nothing, whatever the count");
}

// ---- 4. the line's shape --------------------------------------------------------------------
for (const good of ["786-504-0671", "212-555-0100"]) assert(isTransferLine(good), `${good} is a transfer line`);
for (const bad of ["7865040671", "(786) 504-0671", "786-504-067", "786-504-06712", "", " 786-504-0671", "abc-def-ghij"]) {
  assert(!isTransferLine(bad), `${JSON.stringify(bad)} is not`);
}

await reads();
decides();
finish();
