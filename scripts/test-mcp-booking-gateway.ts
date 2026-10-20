// #3543 / #3544: the carrier between `McpBookingGateway` and Marcia's internal route.
//
//   - the gateway builds the inner Request to the operation's internal path, carrying
//     the lead token and the gateway secret, and answers every ending without throwing;
//   - the public fetch handler refuses every internal MCP path (encoded, cased or
//     doubled slashes included) and strips the carrier headers from every public
//     request, read off worker/index.ts's own source with a positive control;
//   - the internal route checks the secret itself (fails closed with none set), then
//     the token: an unsigned token and one signed with a foreign key are refused and
//     nothing runs, and a correctly signed token without the test claim books nothing.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-mcp-booking-gateway.ts
import { readFileSync } from "node:fs";
import { forwardBookingCall } from "../worker/mcp-booking-gateway.ts";
import {
  CARRIER_HEADERS,
  GATEWAY_SECRET_HEADER,
  LEAD_TOKEN_HEADER,
  LIMIT_ADMITTED_HEADER,
  isInternalMcpPath,
  marciaInternalPath,
  stripCarrierHeaders,
} from "../src/lib/mcp-booking/carrier.ts";
import { handleMarciaInternal, type MarciaRouteDeps } from "../src/lib/mcp-booking/route-handler.ts";
import { signMachineToken } from "../src/lib/mcp-booking/machine-token.ts";
import type { MarciaAnswer } from "../src/lib/mcp-booking/operations.ts";
import { FIXTURE_CLAIMS, FIXTURE_VERIFY_AT_MS } from "./lib/machine-token-fixture-cases.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const SECRET = "gateway-secret-for-the-suite-0000000000000000";
const KEY = "marcia-key-for-the-suite-00000000000000000000";
const silent = { error: () => undefined };
/** An `admit` for calls whose token never verifies, so it must never be asked. */
const noAdmit = async () => {
  throw new Error("admit was called for a token that does not verify");
};

// --- the gateway's inner Request ----------------------------------------------------
{
  const seen: Request[] = [];
  const answer = await forwardBookingCall(
    {
      fetch: async (r) => {
        seen.push(r);
        return Response.json({ ok: true, operation: "find_times", data: { times: [] } }, { status: 200 });
      },
      gatewaySecret: SECRET,
      tokenKeySlots: [KEY, ""],
      nowMs: () => FIXTURE_VERIFY_AT_MS,
      log: silent,
    },
    "a.b.c",
    "find_times",
    { time_zone: "America/Chicago" },
    noAdmit,
  );
  eq(seen.length, 1, "one inner request");
  eq(new URL(seen[0]!.url).pathname, "/api/internal/mcp-booking/find-times", "to the operation's internal path");
  eq(seen[0]!.headers.get(GATEWAY_SECRET_HEADER), SECRET, "carrying the gateway secret");
  eq(seen[0]!.headers.get(LEAD_TOKEN_HEADER), "a.b.c", "and the lead token, as a header of the in process request, never a URL");
  eq(await seen[0]!.json(), { args: { time_zone: "America/Chicago" } }, "with the arguments in the body");
  eq(answer, { status: 200, body: { ok: true, operation: "find_times", data: { times: [] } } }, "the route's answer comes back as it was");
  eq(marciaInternalPath("find_times"), "/api/internal/mcp-booking/find-times", "an operation's path");
}
{
  let called = 0;
  const deps = (over: Partial<Parameters<typeof forwardBookingCall>[0]> = {}) => ({
    fetch: async () => {
      called++;
      return Response.json({});
    },
    gatewaySecret: SECRET,
    tokenKeySlots: [KEY, ""],
    nowMs: () => FIXTURE_VERIFY_AT_MS,
    log: silent,
    ...over,
  });
  eq((await forwardBookingCall(deps(), "a.b.c", "drop_tables", {}, noAdmit)).body.code, "unknown_operation", "an operation that is not one of the five is refused");
  eq((await forwardBookingCall(deps(), "", "book", {}, noAdmit)).body.code, "token_malformed", "no token is refused");
  eq(called, 0, "and none of those reached the app");
  // No secret on the deployment: the gateway does NOT answer for the route. It hands
  // the call on carrying no secret, so the route, which reads the same deployment's
  // secret, refuses it as unconfigured AND pages marcia_gateway_refused. A refusal
  // the gateway made itself was only ever a log line (lessons review on #3874).
  {
    const seen: Request[] = [];
    const unconfigured = await forwardBookingCall(
      deps({
        gatewaySecret: "",
        fetch: async (r: Request) => {
          seen.push(r);
          return Response.json({ ok: false, code: "gateway_unconfigured" }, { status: 503 });
        },
      }),
      "a.b.c",
      "book",
      {},
      noAdmit,
    );
    eq(seen.length, 1, "no gateway secret still reaches the route, which is where it pages");
    eq(seen[0]?.headers.has(GATEWAY_SECRET_HEADER), false, "carrying no secret header at all");
    eq([unconfigured.status, unconfigured.body.code], [503, "gateway_unconfigured"], "and the route's fail closed refusal is the answer");
  }
  const threw = await forwardBookingCall(deps({ fetch: async () => { throw new Error("boom"); } }), "a.b.c", "book", {}, noAdmit);
  eq([threw.status, threw.body.code], [500, "internal"], "an app that throws is an answer, not a throw");
  const html = await forwardBookingCall(deps({ fetch: async () => new Response("<html>", { status: 502 }) }), "a.b.c", "book", {}, noAdmit);
  eq(html.body.code, "gateway_unreadable", "a non JSON answer is named as unreadable, never passed on as data");
}

// --- #3879: Marcia's limit is asked only for a token that verifies, and fails closed -----
{
  const good = await signMachineToken({ ...FIXTURE_CLAIMS }, KEY);
  const forged = await signMachineToken({ ...FIXTURE_CLAIMS }, "a-forged-key-for-the-suite-0000000000000000");
  const run = async (token: string, admit: unknown) => {
    const order: string[] = [];
    const answer = await forwardBookingCall(
      {
        fetch: async (r) => {
          order.push(r.headers.get(LIMIT_ADMITTED_HEADER) === "1" ? "forwarded, marked admitted" : "forwarded");
          return Response.json({ ok: true, operation: "book", data: {} });
        },
        gatewaySecret: SECRET,
        tokenKeySlots: [KEY, ""],
        nowMs: () => FIXTURE_VERIFY_AT_MS,
        log: silent,
      },
      token,
      "book",
      {},
      typeof admit === "function"
        ? async () => {
            order.push("admit");
            return (admit as () => Promise<unknown>)();
          }
        : admit,
    );
    return { answer, order };
  };
  const admitted = await run(good, async () => null);
  eq([admitted.order, admitted.answer.status], [["admit", "forwarded, marked admitted"], 200], "a verified token asks the limit once, BEFORE anything is forwarded, and the inner request says it was admitted");
  const forgedCall = await run(forged, async () => null);
  eq(forgedCall.order, ["forwarded"], "a forged token never asks the limit: it is forwarded uncharged and unmarked, for the route to refuse and page");
  const overLimit = { status: 429, body: { ok: false, code: "marcia_over_limit", class: "expected", message: "too many" } };
  const refused = await run(good, async () => overLimit);
  eq([refused.order, refused.answer], [["admit"], overLimit], "a refusal from the limit is the answer, and nothing is forwarded");
  for (const [label, admit] of [
    ["no admit at all", undefined],
    ["an admit that is not a function", "yes"],
    ["an admit that throws (the stub could not be reached)", async () => { throw new Error("rpc stub gone"); }],
    ["an admit that answers undefined", async () => undefined],
    ["an admit that answers something unreadable", async () => ({ status: "429" })],
  ] as const) {
    const r = await run(good, admit);
    eq([r.order.some((o) => o.startsWith("forwarded")), r.answer.body.code], [false, "marcia_limit_unchecked"], `${label}: refused fail closed, and nothing is forwarded`);
  }
}

// --- the public handler's two walls ----------------------------------------------------
{
  for (const url of [
    "https://slate.trypennie.app/api/internal/mcp-booking/book",
    "https://slate.trypennie.app/api/Internal/MCP-booking/book",
    "https://slate.trypennie.app/api/internal/%6Dcp-booking/book",
    "https://slate.trypennie.app//api//internal//mcp-ops/x",
  ]) {
    assert(isInternalMcpPath(url), `an internal MCP path is recognised: ${url}`);
  }
  assert(!isInternalMcpPath("https://slate.trypennie.app/api/bookings"), "an ordinary path is not");
  assert(isInternalMcpPath("not a url"), "an unreadable URL is refused, never let through");

  const req = new Request("https://slate.trypennie.app/api/bookings", {
    method: "POST",
    headers: { [GATEWAY_SECRET_HEADER]: SECRET, [LEAD_TOKEN_HEADER]: "a.b.c", authorization: "Bearer k", "content-type": "application/json" },
    body: JSON.stringify({ x: 1 }),
  });
  const stripped = stripCarrierHeaders(req);
  for (const h of CARRIER_HEADERS) assert(!stripped.headers.has(h), `a public request arrives without ${h}`);
  eq(stripped.headers.get("authorization"), "Bearer k", "every other header is kept");
  eq(await stripped.json(), { x: 1 }, "and the body is intact");
  const plain = new Request("https://slate.trypennie.app/api/bookings");
  assert(stripCarrierHeaders(plain) === plain, "a request carrying none is passed through untouched");

  // Wiring, read off the entry's source (it imports the build output and cannot be
  // loaded): the refusal comes before the app, and the app is handed the stripped request.
  const entry = readFileSync("worker/index.ts", "utf8");
  const wired = (src: string) => {
    const body = src.slice(src.indexOf("fetch:"), src.indexOf("async scheduled("));
    const refuseAt = body.indexOf("if (isInternalMcpPath(request.url)) return internalMcpRefusal();");
    const stripAt = body.indexOf("request = stripCarrierHeaders(request);");
    const appAt = body.indexOf("app.fetch(request, env, ctx, {");
    return refuseAt !== -1 && stripAt !== -1 && appAt !== -1 && refuseAt < stripAt && stripAt < appAt;
  };
  assert(wired(entry), "the public fetch handler refuses internal MCP paths, then hands the app a stripped request");
  const unwired = entry.replace("request = stripCarrierHeaders(request);", "");
  assert(unwired !== entry && !wired(unwired), "positive control: handing the app the raw request is caught");
  const unrefused = entry.replace("if (isInternalMcpPath(request.url)) return internalMcpRefusal();", "");
  assert(unrefused !== entry && !wired(unrefused), "positive control: dropping the path refusal is caught");
}

// --- the internal route ---------------------------------------------------------------
function routeDeps() {
  const runs: unknown[] = [];
  const tokenAlerts: string[] = [];
  const gatewayAlerts: string[] = [];
  const deps: MarciaRouteDeps = {
    nowMs: () => FIXTURE_VERIFY_AT_MS,
    run: async (op, args, claims): Promise<MarciaAnswer> => {
      runs.push({ op, args, lead: claims.salesforce_id });
      return { ok: true, operation: op, status: 200, data: {} };
    },
    alertToken: async (r) => void tokenAlerts.push(r.code),
    alertGateway: async (why) => void gatewayAlerts.push(why),
    logError: () => undefined,
  };
  return { deps, runs, tokenAlerts, gatewayAlerts };
}
const call = (token: string | null, secret: string | null, admitted = true) =>
  new Request("https://slate.trypennie.app/api/internal/mcp-booking/book", {
    method: "POST",
    headers: {
      ...(secret ? { [GATEWAY_SECRET_HEADER]: secret } : {}),
      ...(token ? { [LEAD_TOKEN_HEADER]: token } : {}),
      ...(admitted ? { [LIMIT_ADMITTED_HEADER]: "1" } : {}),
      cookie: "slate-impersonate=someone",
    },
    body: JSON.stringify({ args: { slot_id: "s1" } }),
  });
const env = { gatewaySecret: SECRET, tokenKeySlots: [KEY, ""] };
{
  const good = await signMachineToken({ ...FIXTURE_CLAIMS }, KEY);
  const r = routeDeps();
  const res = await handleMarciaInternal(call(good, SECRET), "book", env, r.deps);
  eq(res.status, 200, "a gateway call with a good token runs");
  eq(r.runs, [{ op: "book", args: { slot_id: "s1" }, lead: FIXTURE_CLAIMS.salesforce_id }], "with the token's lead and the call's arguments; a cookie changes nothing");

  const noSecret = routeDeps();
  const r1 = await handleMarciaInternal(call(good, SECRET), "book", { ...env, gatewaySecret: "" }, noSecret.deps);
  eq([r1.status, noSecret.runs.length, noSecret.gatewayAlerts], [503, 0, ["unconfigured"]], "no secret on the deployment refuses and alerts, fail closed");

  const wrong = routeDeps();
  const r2 = await handleMarciaInternal(call(good, "not-the-secret"), "book", env, wrong.deps);
  eq([r2.status, wrong.runs.length, wrong.gatewayAlerts], [404, 0, ["mismatch"]], "a wrong secret answers 404, runs nothing, and alerts");
  const missing = routeDeps();
  const r3 = await handleMarciaInternal(call(good, null), "book", env, missing.deps);
  eq([r3.status, missing.runs.length], [404, 0], "no secret header at all is the same refusal");

  // #3544: booking() refuses an unsigned token and a token signed with a foreign key.
  const unsigned = routeDeps();
  const [h, p] = good.split(".");
  const r4 = await handleMarciaInternal(call(`${h}.${p}.`, SECRET), "book", env, unsigned.deps);
  eq([r4.status, ((await r4.json()) as { code: string }).code, unsigned.runs.length], [401, "token_malformed", 0], "an unsigned token is refused and nothing runs");
  const foreign = routeDeps();
  const r5 = await handleMarciaInternal(call(await signMachineToken({ ...FIXTURE_CLAIMS }, "a-foreign-key-000000000000000000000000000"), SECRET), "book", env, foreign.deps);
  eq([r5.status, ((await r5.json()) as { code: string }).code, foreign.runs.length], [401, "token_signature_invalid", 0], "a token signed with a foreign key is refused and nothing runs");
  eq(foreign.tokenAlerts, ["token_signature_invalid"], "and the refusal alerts by name");

  // Kit phase 4.1's named test: correctly signed, no test claim, nothing booked.
  const { test: _t, ...noTest } = FIXTURE_CLAIMS;
  const noTestCall = routeDeps();
  const r6 = await handleMarciaInternal(call(await signMachineToken(noTest, KEY), SECRET), "book", env, noTestCall.deps);
  const body6 = (await r6.json()) as { code: string; claim: string };
  eq([r6.status, body6.code, body6.claim, noTestCall.runs.length], [401, "token_claim_missing", "test", 0], "a correctly signed token without the test claim is refused by name and nothing is booked");
  eq(noTestCall.tokenAlerts, ["token_claim_missing"], "with an alert");

  const noKeys = routeDeps();
  const r7 = await handleMarciaInternal(call(good, SECRET), "book", { ...env, tokenKeySlots: ["", ""] }, noKeys.deps);
  eq([((await r7.json()) as { code: string }).code, noKeys.runs.length], ["token_keys_unconfigured", 0], "no token key configured refuses every token");

  // #3879: a token the route verifies but the gateway did not charge is refused, so a
  // disagreement between the two verifications can never run a call unmetered.
  const uncharged = routeDeps();
  const r8 = await handleMarciaInternal(call(good, SECRET, false), "book", env, uncharged.deps);
  eq([r8.status, ((await r8.json()) as { code: string }).code, uncharged.runs.length], [503, "marcia_limit_unchecked", 0], "a verified token without the gateway's limit mark is refused and nothing runs");
  const unmarkedForged = routeDeps();
  const r9 = await handleMarciaInternal(call(`${h}.${p}.`, SECRET, false), "book", env, unmarkedForged.deps);
  eq([((await r9.json()) as { code: string }).code, unmarkedForged.tokenAlerts], ["token_malformed", ["token_malformed"]], "an unmarked token that does not verify is still refused by its own name, and pages");
}

finish();
