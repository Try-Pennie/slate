// #3541 / #3543 / #3544: Marcia's booking MCP server (`worker/mcp-booking`) and its
// config, driven with no Worker and no network.
//
//   - the protocol: initialize, tools/list (the registry's five tools), tools/call
//     forwarding the CONNECTION's token, notifications, errors;
//   - the plan's test: the same JSON-RPC id from two sessions with different nonces
//     acts twice (the id is never an identity), and a call refused by the shape check
//     never reaches Slate;
//   - Marcia's overall limit refuses with the period named, and fails closed, driven
//     through the Worker's own entry with its binding missing and with one that throws;
//   - #3879: the limit is spent ONLY by a call whose token Slate verified, so a burst of
//     forged tokens past the limit leaves a correctly signed call still going through,
//     driven through the protocol, the real gateway and the real internal route;
//   - the limit's period is written once: the constant agrees with the config, and the
//     refusal's words are built from it;
//   - the config: no workers.dev, no preview URLs, invocation logs off, exactly one
//     service binding (to McpBookingGateway), no vars or secrets, the limiter claimed;
//   - the Worker's imports stay inside its folder and the import free modules, so the
//     booking service can never be bundled into it.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-mcp-booking-worker.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { unstable_readConfig } from "wrangler";
import { handleMcp, MARCIA_LIMIT_PERIOD_SEC, marciaOverLimitText, type GatewayAnswer, type ProtocolDeps } from "../worker/mcp-booking/protocol.ts";
import mcpWorker, { type BookingMcpEnv } from "../worker/mcp-booking/index.ts";
import { BOOKING_TOOLS } from "../worker/mcp-booking/registry.ts";
import { forwardBookingCall, type GatewayDeps } from "../worker/mcp-booking-gateway.ts";
import { marciaInternalPath } from "../src/lib/mcp-booking/carrier.ts";
import { MARCIA_OPERATIONS } from "../src/lib/mcp-booking/operation-names.ts";
import { signMachineToken } from "../src/lib/mcp-booking/machine-token.ts";
import { handleMarciaInternal } from "../src/lib/mcp-booking/route-handler.ts";
import { FIXTURE_CLAIMS, FIXTURE_VERIFY_AT_MS } from "./lib/machine-token-fixture-cases.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const KEY = "any-key-the-worker-never-sees-000000000000000";
const tokenA = await signMachineToken({ ...FIXTURE_CLAIMS, nonce: "session-a-nonce-00000001" }, KEY);
const tokenB = await signMachineToken({ ...FIXTURE_CLAIMS, nonce: "session-b-nonce-00000002" }, KEY);

function deps(over: Partial<ProtocolDeps> = {}) {
  const calls: { token: string; operation: string; args: unknown }[] = [];
  const logs: string[] = [];
  const d: ProtocolDeps = {
    nowMs: () => FIXTURE_VERIFY_AT_MS,
    // As the gateway treats a token that verifies: it asks the limit first, and a
    // refusal from it is the answer.
    booking: async (token, operation, args, admit): Promise<GatewayAnswer> => {
      const refused = await admit();
      if (refused !== null) return refused;
      calls.push({ token, operation, args });
      return { status: 200, body: { ok: true, operation, data: {} } };
    },
    withinLimit: async () => true,
    logError: (msg) => void logs.push(msg),
    ...over,
  };
  return { d, calls, logs };
}
const rpc = (body: unknown, token: string | null = tokenA, method = "POST") =>
  new Request("https://slate-booking-mcp.trypennie.dev/mcp", {
    method,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });

// --- the protocol --------------------------------------------------------------------
{
  const { d } = deps();
  const init = (await (await handleMcp(rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }), d)).json()) as {
    result: { protocolVersion: string; capabilities: { tools: unknown } };
  };
  eq(init.result.protocolVersion, "2025-06-18", "initialize answers the version asked for when supported");
  assert(init.result.capabilities.tools !== undefined, "and offers tools");
  const old = (await (await handleMcp(rpc({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }), d)).json()) as { result: { protocolVersion: string } };
  eq(old.result.protocolVersion, "2025-06-18", "an unknown version is answered with the newest supported one");
  const note = await handleMcp(rpc({ jsonrpc: "2.0", method: "notifications/initialized" }), d);
  eq([note.status, await note.text()], [202, ""], "a notification gets 202 and no body");
  const list = (await (await handleMcp(rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }), d)).json()) as { result: { tools: { name: string }[] } };
  eq(list.result.tools.map((t) => t.name), [...MARCIA_OPERATIONS], "tools/list offers exactly the five operations");
  const none = (await (await handleMcp(rpc({ jsonrpc: "2.0", id: 4, method: "resources/list" }), d)).json()) as { error: { code: number } };
  eq(none.error.code, -32601, "anything else is method not found");
  const batch = await handleMcp(rpc([{ jsonrpc: "2.0", id: 5, method: "ping" }]), d);
  eq(batch.status, 400, "a batch is refused");
  eq((await handleMcp(rpc(null, tokenA, "GET"), d)).status, 405, "only POST is answered");
  // No tool takes the lead: nothing in any schema names a lead identity.
  const schemas = JSON.stringify(BOOKING_TOOLS.map((t) => t.inputSchema));
  for (const field of ["salesforce_id", "email", "phone", "name\"", "bucket"]) {
    assert(!schemas.includes(field), `no tool argument names the lead (${field})`);
  }
  // Every schema forbids extra arguments, so an argument the operation reads must be
  // declared here or the model never sends it.
  const findTimes = BOOKING_TOOLS.find((t) => t.name === "find_times")?.inputSchema.properties ?? {};
  eq(Object.keys(findTimes).sort(), ["from", "near", "time_zone"], "find_times declares from, near and time_zone");
}

// --- tools/call -------------------------------------------------------------------------
{
  const { d, calls } = deps();
  const res = (await (await handleMcp(rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "book", arguments: { slot_id: "s1" } } }), d)).json()) as {
    result: { isError: boolean; structuredContent: { ok: boolean } };
  };
  eq(calls, [{ token: tokenA, operation: "book", args: { slot_id: "s1" } }], "a tool call hands Slate the connection's token, the operation and the arguments");
  eq([res.result.isError, res.result.structuredContent.ok], [false, true], "and answers with Slate's body");

  // The plan's test: the same JSON-RPC id from two sessions with different nonces acts twice.
  const two = deps();
  await handleMcp(rpc({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "book", arguments: { slot_id: "s1" } } }, tokenA), two.d);
  await handleMcp(rpc({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "book", arguments: { slot_id: "s1" } } }, tokenB), two.d);
  eq(two.calls.map((c) => c.token), [tokenA, tokenB], "the same JSON-RPC id from two sessions reaches Slate twice, each with its own token");

  const refused = deps({ booking: async () => ({ status: 409, body: { ok: false, code: "slot_taken" } }) });
  const r = (await (await handleMcp(rpc({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "book", arguments: {} } }), refused.d)).json()) as { result: { isError: boolean } };
  eq(r.result.isError, true, "a refusal from Slate is a tool error the model can read");

  const down = deps({ booking: async () => { throw new Error("binding down"); } });
  const t = (await (await handleMcp(rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "lookup" } }), down.d)).json()) as { result: { isError: boolean; content: { text: string }[] } };
  assert(t.result.isError && t.result.content[0]!.text.includes("could not be reached"), "a gateway that throws is a tool error, never a crash");
  eq(down.logs, ["the Slate booking gateway could not be reached"], "and is logged without the token");

  const unknown = deps();
  const u = (await (await handleMcp(rpc({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "drop_tables" } }), unknown.d)).json()) as { error: { code: number } };
  eq([u.error.code, unknown.calls.length], [-32602, 0], "an unknown tool is refused before Slate");
}

// --- the token is shape checked first, for every method ---------------------------------------
for (const [label, token] of [
  ["no token", null],
  ["garbage", "not-a-token"],
  ["expired", await signMachineToken({ ...FIXTURE_CLAIMS, iat: FIXTURE_CLAIMS.iat - 900, exp: FIXTURE_CLAIMS.iat }, KEY)],
] as const) {
  const { d, calls } = deps();
  const res = await handleMcp(rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "book", arguments: {} } }, token), d);
  eq([res.status, calls.length], [401, 0], `${label}: refused 401 and Slate is never called`);
  assert((res.headers.get("www-authenticate") ?? "").startsWith("Bearer"), `${label}: with a Bearer challenge`);
}

// --- the overall limit -------------------------------------------------------------------------
type ToolAnswer = {
  result: { isError: boolean; content: { text: string }[]; structuredContent?: { ok?: boolean; code?: string; message?: string } };
};
{
  const { d, calls } = deps({ withinLimit: async () => false });
  const res = (await (await handleMcp(rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "book", arguments: {} } }), d)).json()) as ToolAnswer;
  eq(
    [res.result.isError, res.result.structuredContent?.code, res.result.structuredContent?.message],
    [true, "marcia_over_limit", marciaOverLimitText()],
    "over the limit, the call is refused in words built from the period",
  );
  eq(calls.length, 0, "and Slate is not called");
  const broken = deps({ withinLimit: async () => { throw new Error("limiter outage"); } });
  const b = await handleMcp(rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "book", arguments: {} } }), broken.d);
  const bb = (await b.json()) as ToolAnswer;
  assert(b.status === 200 && bb.result.isError && bb.result.content[0]!.text.includes("could not check"), "a limiter that throws refuses with an answer, never a bare 500");
  eq([broken.calls.length, broken.logs.length], [0, 1], "and Slate is not called, and it is logged");
  // #3879 part 3: the words come from the period they are given, so they can only name
  // the constant, which the config section below holds equal to wrangler's period.
  assert(marciaOverLimitText(37).includes("within 37 seconds"), "the refusal names whatever period it is built from");
  eq(marciaOverLimitText(), marciaOverLimitText(MARCIA_LIMIT_PERIOD_SEC), "and is built from MARCIA_LIMIT_PERIOD_SEC by default");
}

// The calls below that run on the real clock use the fixture claims re-dated to now.
const nowSec = Math.floor(Date.now() / 1000);
const REAL_KEY = "marcia-key-for-the-worker-suite-000000000000";
const FORGER_KEY = "a-key-somebody-guessed-for-the-suite-0000000";
const GATEWAY_SECRET = "gateway-secret-for-the-worker-suite-00000000";
const silent = { error: () => undefined };

/** The real gateway, handing its inner request to `fetch`, verifying with REAL_KEY. */
const gatewayDeps = (fetch: GatewayDeps["fetch"], nowMs: () => number): GatewayDeps => ({
  fetch,
  gatewaySecret: GATEWAY_SECRET,
  tokenKeySlots: [REAL_KEY, ""],
  nowMs,
  log: silent,
});

// --- #3879 part 2: the ENTRY fails closed on its limiter, driven rather than read (L135) --------
{
  const live = await signMachineToken({ ...FIXTURE_CLAIMS, iat: nowSec, exp: nowSec + 600, nonce: "entry-nonce-000000000001" }, REAL_KEY);
  const viaEntry = async (limiter: BookingMcpEnv["MARCIA_LIMITER"] | "absent") => {
    const reached: string[] = [];
    const env: BookingMcpEnv = {
      SLATE: {
        booking: (t, o, a, admit) =>
          forwardBookingCall(
            gatewayDeps(async (r) => {
              reached.push(new URL(r.url).pathname);
              return Response.json({ ok: true, operation: o, data: {} });
            }, () => Date.now()),
            t,
            o,
            a,
            admit,
          ),
      },
      ...(limiter === "absent" ? {} : { MARCIA_LIMITER: limiter }),
    };
    const res = await mcpWorker.fetch(rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "book", arguments: { slot_id: "s1" } } }, live), env);
    return { res: (await res.json()) as ToolAnswer, reached };
  };
  const ok = await viaEntry({ limit: async () => ({ success: true }) });
  eq([ok.res.result.isError, ok.reached.length], [false, 1], "positive control: through the entry with a limiter that admits, the call reaches Slate");
  const over = await viaEntry({ limit: async () => ({ success: false }) });
  eq([over.res.result.isError, over.res.result.structuredContent?.code, over.reached.length], [true, "marcia_over_limit", 0], "through the entry, a limiter that says no refuses and Slate's app is never reached");
  const missing = await viaEntry("absent");
  eq([missing.res.result.isError, missing.reached.length], [true, 0], "a deployment without its MARCIA_LIMITER binding refuses the call (fail closed), and Slate's app is never reached");
  const throws = await viaEntry({ limit: async () => { throw new Error("limiter outage"); } });
  eq([throws.res.result.isError, throws.reached.length], [true, 0], "a MARCIA_LIMITER whose limit() throws refuses the call (fail closed), and Slate's app is never reached");
}

// --- #3879 part 1: forged tokens never spend Marcia's limit ---------------------------------------
// The whole path but the operation: the protocol, the real gateway, and the real internal
// route with the real verifier. The limiter counts like the binding, against the limit
// wrangler.mcp-booking.jsonc configures.
{
  type Ratelimit = { name: string; simple: { limit: number; period: number } };
  const configured = (unstable_readConfig({ config: "wrangler.mcp-booking.jsonc" }) as unknown as { ratelimits?: Ratelimit[] }).ratelimits?.[0];
  const LIMIT = configured?.simple.limit ?? 0;
  assert(LIMIT > 0, "the configured limit is read from wrangler.mcp-booking.jsonc");
  let charged = 0;
  const runs: string[] = [];
  const opAt = new Map(MARCIA_OPERATIONS.map((op) => [marciaInternalPath(op), op] as const));
  const route = (req: Request) =>
    handleMarciaInternal(
      req,
      opAt.get(new URL(req.url).pathname)!,
      { gatewaySecret: GATEWAY_SECRET, tokenKeySlots: [REAL_KEY, ""] },
      {
        nowMs: () => FIXTURE_VERIFY_AT_MS,
        run: async (op, _args, claims) => {
          runs.push(claims.nonce);
          return { ok: true, operation: op, status: 200, data: {} };
        },
        alertToken: async () => undefined,
        alertGateway: async () => undefined,
        logError: () => undefined,
      },
    );
  const { d } = deps({
    withinLimit: async () => ++charged <= LIMIT,
    booking: (t, o, a, admit) => forwardBookingCall(gatewayDeps(route, () => FIXTURE_VERIFY_AT_MS), t, o, a, admit),
  });
  const book = async (token: string, id: number) =>
    (await (await handleMcp(rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "book", arguments: { slot_id: "s1" } } }, token), d)).json()) as ToolAnswer;

  const forgedOutcomes = new Set<string>();
  for (let i = 0; i < LIMIT + 20; i++) {
    const forged = await signMachineToken({ ...FIXTURE_CLAIMS, nonce: `forged-${String(i).padStart(18, "0")}` }, FORGER_KEY);
    const r = await book(forged, 100 + i);
    forgedOutcomes.add(r.result.isError ? String(r.result.structuredContent?.code) : "ran");
  }
  eq([...forgedOutcomes], ["token_signature_invalid"], `${LIMIT + 20} forged tokens are each refused by Slate's verifier`);
  eq([charged, runs.length], [0, 0], "and none of them spent Marcia's limit or ran anything");

  const signed = await signMachineToken({ ...FIXTURE_CLAIMS, nonce: "marcia-real-000000000001" }, REAL_KEY);
  const after = await book(signed, 1);
  eq([after.result.isError, runs, charged], [false, ["marcia-real-000000000001"], 1], "after the forged burst, Marcia's correctly signed call still goes through, spending one");

  // Positive control: the limit still bites, on verified calls.
  for (let i = 2; i <= LIMIT; i++) {
    await book(await signMachineToken({ ...FIXTURE_CLAIMS, nonce: `marcia-real-${String(i).padStart(12, "0")}` }, REAL_KEY), i);
  }
  const past = await book(await signMachineToken({ ...FIXTURE_CLAIMS, nonce: "marcia-real-past-the-limit" }, REAL_KEY), 999);
  eq([past.result.structuredContent?.code, runs.length], ["marcia_over_limit", LIMIT], `verified calls past the limit of ${LIMIT} are refused, and exactly ${LIMIT} ran`);
}

// --- the config --------------------------------------------------------------------------------
{
  type Resolved = {
    name?: string;
    main?: string;
    workers_dev?: boolean;
    preview_urls?: boolean;
    observability?: { enabled?: boolean; logs?: { invocation_logs?: boolean } };
    services?: { binding: string; service: string; entrypoint?: string }[];
    vars?: Record<string, unknown>;
    ratelimits?: { name: string; namespace_id: string; simple?: { limit: number; period: number } }[];
    routes?: unknown[];
  };
  const c = unstable_readConfig({ config: "wrangler.mcp-booking.jsonc" }) as unknown as Resolved;
  eq(c.name, "slate-booking-mcp", "the server deploys under its own name");
  assert(String(c.main).endsWith("worker/mcp-booking/index.ts"), "from its own entry");
  eq([c.workers_dev, c.preview_urls], [false, false], "no workers.dev address and no preview URLs");
  eq(c.observability?.logs?.invocation_logs, false, "invocation logs are off: the Authorization header is the lead token");
  eq(c.services, [{ binding: "SLATE", service: "slate", entrypoint: "McpBookingGateway" }], "exactly one binding, to McpBookingGateway");
  eq(Object.keys(c.vars ?? {}), [], "no vars: the server holds no key");
  eq((c.ratelimits ?? []).map((r) => [r.name, r.namespace_id]), [["MARCIA_LIMITER", "1008"]], "Marcia's overall limit on its own namespace");
  // #3879 part 3: the period is configured here and named in the refusal; the two agree.
  eq(c.ratelimits?.[0]?.simple?.period, MARCIA_LIMIT_PERIOD_SEC, "MARCIA_LIMIT_PERIOD_SEC is the period wrangler.mcp-booking.jsonc configures");
  const slate = unstable_readConfig({ config: "wrangler.jsonc" }) as unknown as Resolved;
  const slateLoadtest = unstable_readConfig({ config: "wrangler.jsonc", env: "loadtest" }) as unknown as Resolved;
  const taken = new Set([...(slate.ratelimits ?? []), ...(slateLoadtest.ratelimits ?? [])].map((r) => r.namespace_id));
  assert(!taken.has("1008"), "and no Slate limiter, production or load test, shares it");
  const raw = readFileSync("wrangler.mcp-booking.jsonc", "utf8");
  assert(!/MARCIA_TOKEN_KEY|MCP_BOOKING_GATEWAY_SECRET/.test(raw.replace(/\/\/.*$/gm, "")), "no secret name is configured on it");
}

// --- the Worker reaches only its folder and the import free modules ----------------------------
{
  const ALLOWED = new Set([
    "../../src/lib/mcp-booking/token-shape.ts",
    "../../src/lib/mcp-booking/operation-names.ts",
    "../../src/lib/mcp-booking/carrier.ts",
    "../../src/lib/log.ts",
  ]);
  const files = readdirSync("worker/mcp-booking").filter((f) => f.endsWith(".ts"));
  const strays: string[] = [];
  for (const f of files) {
    for (const m of readFileSync(join("worker/mcp-booking", f), "utf8").matchAll(/^import[^"']*["']([^"']+)["']/gm)) {
      const spec = m[1]!;
      if (spec.startsWith("./") || ALLOWED.has(spec)) continue;
      strays.push(`${f}: ${spec}`);
    }
  }
  eq(strays, [], "the booking MCP Worker imports nothing but its own folder and the import free token, operation, carrier and log modules");
  for (const mod of ALLOWED) {
    const src = readFileSync(join("worker/mcp-booking", mod), "utf8");
    eq([...src.matchAll(/^import .* from ["']([^"']+)["']/gm)].map((m) => m[1]).filter((s) => !s!.startsWith("./")), [], `${mod} imports nothing outside its folder`);
  }
}

finish();
