/**
 * The booking MCP server's protocol handling (#3541): MCP over Streamable HTTP,
 * stateless, answered as `application/json` (the transport allows a JSON answer in
 * place of an event stream), with no session id because there is no session to keep:
 * every call carries the lead's signed token and stands on its own.
 *
 * Handled: `initialize`, `notifications/initialized` (and any notification: 202, no
 * body), `ping`, `tools/list`, `tools/call`. Anything else is JSON-RPC's method not
 * found. A batch is refused, as protocol 2025-06-18 removed batching.
 *
 * WHO MAY CALL: anyone who can reach the hostname, so nothing here trusts the caller:
 * the lead token is shape checked here (no secret), VERIFIED by Slate, and the JSON-RPC
 * id is never an identity (two sessions sending the same id with two nonces are two
 * attempts). WHOSE DATA: the lead the token names, as Slate decides.
 *
 * Pure: takes the gateway and the limiter as arguments, so
 * `scripts/test-mcp-booking-worker.ts` drives it with no Worker.
 */
import { describeTokenRefusal, parseMachineTokenShape } from "../../src/lib/mcp-booking/token-shape.ts";
import { BOOKING_TOOLS, bookingTool } from "./registry.ts";

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;
export const SERVER_INFO = { name: "slate-booking", version: "0.1.0" } as const;

/** The overall limit Marcia's calls share (decision 12), stated in its refusal. */
export const MARCIA_LIMIT_PERIOD_SEC = 60;

export interface GatewayAnswer {
  status: number;
  body: Record<string, unknown>;
}

export interface ProtocolDeps {
  nowMs(): number;
  /** `McpBookingGateway.booking` over the `SLATE` binding. */
  booking(signedToken: string, operation: string, args: unknown): Promise<GatewayAnswer>;
  /** True when the call may go ahead under Marcia's overall limit. */
  withinLimit(): Promise<boolean>;
  logError(msg: string, fields: Record<string, string | number | boolean | null>): void;
}

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

const rpcError = (id: JsonRpcId, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** The lead token, read from the connection's `Authorization: Bearer` header. */
export function leadTokenOf(request: Request): string | null {
  const h = request.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") && h.length > 7 ? h.slice(7) : null;
}

function isRequest(v: unknown): v is JsonRpcRequest {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return r.jsonrpc === "2.0" && typeof r.method === "string";
}

/** A tool answer: the gateway's JSON as text, and an error flag a model can read. */
function toolResult(answer: GatewayAnswer) {
  const ok = answer.body.ok === true;
  return {
    content: [{ type: "text", text: JSON.stringify(answer.body) }],
    structuredContent: answer.body,
    isError: !ok,
  };
}

export async function handleMcp(request: Request, deps: ProtocolDeps): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("This endpoint answers MCP over POST only.", { status: 405, headers: { allow: "POST" } });
  }
  // The token comes first, for every method: an endpoint that lists its tools to a
  // caller with no lead is answering somebody Marcia did not send.
  const token = leadTokenOf(request);
  const shape = parseMachineTokenShape(token, deps.nowMs());
  if (!shape.ok) {
    return json(rpcError(null, -32001, describeTokenRefusal(shape.refusal)), 401, {
      "www-authenticate": `Bearer error="invalid_token", error_description="${shape.refusal.code}"`,
    });
  }
  let message: unknown;
  try {
    message = await request.json();
  } catch {
    return json(rpcError(null, -32700, "The body is not JSON."), 400);
  }
  if (Array.isArray(message)) return json(rpcError(null, -32600, "Batches are not supported."), 400);
  if (!isRequest(message)) return json(rpcError(null, -32600, "Not a JSON-RPC 2.0 request."), 400);
  // A notification carries no id and gets no answer.
  if (message.id === undefined) return new Response(null, { status: 202 });
  const id = message.id;

  switch (message.method) {
    case "initialize": {
      const asked = message.params?.protocolVersion;
      const version = (SUPPORTED_PROTOCOL_VERSIONS as readonly unknown[]).includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0];
      return json(rpcResult(id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO }));
    }
    case "ping":
      return json(rpcResult(id, {}));
    case "tools/list":
      return json(
        rpcResult(id, {
          tools: BOOKING_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        }),
      );
    case "tools/call": {
      const tool = bookingTool(message.params?.name);
      if (!tool) return json(rpcError(id, -32602, "No such tool."));
      let within: boolean;
      try {
        within = await deps.withinLimit();
      } catch {
        // A limiter that cannot answer refuses, the same as one that says no: Marcia is
        // never run unmetered, and the caller gets an answer rather than a bare 500.
        deps.logError("Marcia's overall limit could not be checked, so the call was refused", { tool: tool.name });
        return json(
          rpcResult(id, {
            content: [{ type: "text", text: "Slate could not check Marcia's call limit just now. Try again in a minute." }],
            isError: true,
          }),
        );
      }
      if (!within) {
        return json(
          rpcResult(id, {
            content: [{ type: "text", text: `Marcia has made too many booking calls just now; try again within ${MARCIA_LIMIT_PERIOD_SEC} seconds.` }],
            isError: true,
          }),
        );
      }
      try {
        // `token` is the shape checked header value; Slate verifies it.
        const answer = await deps.booking(token as string, tool.name, message.params?.arguments ?? {});
        return json(rpcResult(id, toolResult(answer)));
      } catch {
        // Logged without the token, the arguments or the answer (L222).
        deps.logError("the Slate booking gateway could not be reached", { tool: tool.name });
        return json(
          rpcResult(id, {
            content: [{ type: "text", text: "Slate could not be reached just now. Try again in a minute." }],
            isError: true,
          }),
        );
      }
    }
    default:
      return json(rpcError(id, -32601, "Method not found."));
  }
}
