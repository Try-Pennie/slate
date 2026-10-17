// #3541 / #3543 / #3544: Marcia's booking MCP server (`worker/mcp-booking`) and its
// config, driven with no Worker and no network.
//
//   - the protocol: initialize, tools/list (the registry's five tools), tools/call
//     forwarding the CONNECTION's token, notifications, errors;
//   - the plan's test: the same JSON-RPC id from two sessions with different nonces
//     acts twice (the id is never an identity), and a call refused by the shape check
//     never reaches Slate;
//   - Marcia's overall limit refuses with the period named, and fails closed;
//   - the config: no workers.dev, no preview URLs, invocation logs off, exactly one
//     service binding (to McpBookingGateway), no vars or secrets, the limiter claimed;
//   - the Worker's imports stay inside its folder and the import free modules, so the
//     booking service can never be bundled into it.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-mcp-booking-worker.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { unstable_readConfig } from "wrangler";
import { handleMcp, MARCIA_LIMIT_PERIOD_SEC, type GatewayAnswer, type ProtocolDeps } from "../worker/mcp-booking/protocol.ts";
import { BOOKING_TOOLS } from "../worker/mcp-booking/registry.ts";
import { MARCIA_OPERATIONS } from "../src/lib/mcp-booking/operation-names.ts";
import { signMachineToken } from "../src/lib/mcp-booking/machine-token.ts";
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
    booking: async (token, operation, args): Promise<GatewayAnswer> => {
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
{
  const { d, calls } = deps({ withinLimit: async () => false });
  const res = (await (await handleMcp(rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "book", arguments: {} } }), d)).json()) as {
    result: { isError: boolean; content: { text: string }[] };
  };
  assert(res.result.isError && res.result.content[0]!.text.includes(`try again within ${MARCIA_LIMIT_PERIOD_SEC} seconds`), "over the limit, the refusal names the period");
  eq(calls.length, 0, "and Slate is not called");
  const entry = readFileSync("worker/mcp-booking/index.ts", "utf8");
  assert(/if \(!env\.MARCIA_LIMITER\) \{[\s\S]*?return false;/.test(entry), "a deployment without its limiter refuses every call (fail closed)");
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
    ratelimits?: { name: string; namespace_id: string }[];
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
